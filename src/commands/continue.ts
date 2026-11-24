/**
 * Continue Command Extension
 *
 * Provides `/continue`, which re-issues the last request after pi gave up on it, without adding anything to
 * the model's context.
 *
 * Pi retries transient provider errors itself (`settings.retry`), and its retry is silent: it appends a
 * context edit that omits the failed assistant message and calls `agent.continue()`, so the next request is
 * the same conversation minus the failed attempt. That path is internal, and once the retry budget is
 * exhausted (or the error was classified non-retryable) there is no built-in command to run it again.
 *
 * `agent.continue()` is not on the extension API and `context_edit` entries are only accepted at the
 * `turn_end` and `agent_before_settle` boundaries, so a command cannot append the omission itself. Instead
 * the command sends a hidden trigger message to start a run, and a `context` handler removes that trigger
 * from every request before it reaches the provider. The model therefore sees the transcript exactly as pi's
 * own retry would: the trigger is never part of the conversation, and the provider-side transform drops the
 * failed assistant message.
 *
 * The `turn_end` boundary then omits consumed triggers from model context permanently, the same way pi omits a
 * failed retry attempt. Without that, every `/continue` would leave a hidden entry in the projection for the
 * rest of the session, and the `context` filter would have to strip it on every request.
 *
 * Both hooks would otherwise rescan the branch on every request and every turn, which is quadratic over a
 * session. `triggersMayExist` is a memo, not a count: it makes their common path O(1), `/continue` sets it,
 * and any branch change (`session_start`, `session_tree`) sets it again. A stale `true` costs one scan, while
 * a stale `false` would leak a trigger, so the memo is only ever cleared by a scan that proves there is
 * nothing left.
 */

import type {
    BoundaryResult,
    ContextEvent,
    ContextEventResult,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

type ContextMessage = ContextEvent["messages"][number];

/** The `customType` of the trigger message. It is never model-visible. */
export const CONTINUE_CUSTOM_TYPE = "pi-coder:continue";

/**
 * The trigger's content. It is never sent under normal operation, but if the `context` filter ever misses the
 * message it must read like an ordinary continuation request rather than exposing pi-coder internals.
 */
export const CONTINUE_TRIGGER_CONTENT =
    "<pi_coder_notice>The previous turn ended without a response. The user wants you to continue.</pi_coder_notice>";

/**
 * Whether the current projection may still contain a trigger. Optimistic: set on `/continue` and on every
 * branch change, cleared only by a scan that found nothing. The direction matters - a stale `true` costs a
 * scan, a stale `false` would let a trigger reach the provider - so nothing clears it without looking.
 */
let triggersMayExist = true;

type ResponseState = "error" | "aborted" | "length" | "completed";

interface LastResponse {
    state: ResponseState;
    errorMessage?: string;
}

function isContinueTrigger(message: ContextMessage): boolean {
    return message.role === "custom" && message.customType === CONTINUE_CUSTOM_TYPE;
}

/** Hide every continuation trigger from the provider request. */
export function stripContinueTriggers(event: ContextEvent): ContextEventResult | undefined {
    if (!event.messages.some(isContinueTrigger)) {
        return undefined;
    }

    return { messages: event.messages.filter((message) => !isContinueTrigger(message)) };
}

/** Trigger entry ids still in the model projection, i.e. not already omitted by a context edit. */
function pendingTriggerIds(ctx: ExtensionContext): string[] {
    const branch = ctx.sessionManager.getBranch();
    const omitted = new Set<string>();
    for (const entry of branch) {
        if (entry.type === "context_edit" && entry.replacement === null) {
            omitted.add(entry.targetId);
        }
    }

    const ids: string[] = [];
    for (const entry of branch) {
        if (entry.type !== "custom_message" || entry.customType !== CONTINUE_CUSTOM_TYPE) {
            continue;
        }
        if (!omitted.has(entry.id)) {
            ids.push(entry.id);
        }
    }

    return ids;
}

/**
 * Omit consumed triggers from model context for the rest of the branch, as pi does with a failed retry
 * attempt. `turn_end` is the first boundary after the triggered run has a response, so the omission lands
 * before pi's own auto-retry re-requests, and before any later turn in the same run. A run aborted before
 * its first turn is caught by the next turn boundary; the `context` filter covers the gap until then.
 */
export function omitConsumedTriggers(
    event: TurnEndEvent,
    ctx: ExtensionContext,
): BoundaryResult | undefined {
    const targetIds = pendingTriggerIds(ctx);
    if (targetIds.length === 0) {
        return undefined;
    }

    return {
        entries: [
            ...event.entries,
            ...targetIds.map((targetId) => ({
                type: "context_edit" as const,
                targetId,
                replacement: null,
            })),
        ],
    };
}

/** The newest assistant response on the branch, or undefined before the model has answered at all. */
function lastAssistantResponse(ctx: ExtensionCommandContext): LastResponse | undefined {
    for (const entry of ctx.sessionManager.getBranch().toReversed()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }

        const message = entry.message;
        if (message.stopReason === "error") {
            return { state: "error", errorMessage: message.errorMessage };
        }
        if (message.stopReason === "aborted") {
            return { state: "aborted" };
        }
        if (message.stopReason === "length") {
            return { state: "length" };
        }

        return { state: "completed" };
    }

    return undefined;
}

function continueNotice(response: LastResponse | undefined): string {
    if (response === undefined) {
        return "Continuing the conversation.";
    }

    switch (response.state) {
        case "error":
            return response.errorMessage === undefined
                ? "Retrying after the provider error."
                : `Retrying after the provider error: ${response.errorMessage}`;
        case "aborted":
            return "Resuming after the previous run was aborted.";
        case "length":
            return "Resuming after the response hit the output limit.";
        case "completed":
            return "The previous response completed; asking for the next step.";
    }
}

function noticeType(response: LastResponse | undefined): "info" | "warning" {
    if (response === undefined || response.state === "completed") {
        return "info";
    }

    return "warning";
}

async function handleContinue(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle();

    const response = lastAssistantResponse(ctx);

    // Set before the send so the next request is filtered even if the entry is persisted only after this
    // handler returns.
    triggersMayExist = true;

    // The content only matters if the `context` filter misses the trigger: then the model receives an
    // ordinary continuation request instead of a diagnostic.
    pi.sendMessage(
        { customType: CONTINUE_CUSTOM_TYPE, content: CONTINUE_TRIGGER_CONTENT, display: false },
        { triggerTurn: true },
    );
    ctx.ui.notify(continueNotice(response), noticeType(response));
}

export default function registerContinueCommand(pi: ExtensionAPI) {
    // A navigation, fork, resume, or reload can move the leaf onto a branch that still has an unomitted
    // trigger, so the memo has to become optimistic again before the next request reads it.
    const markBranchChanged = () => {
        triggersMayExist = true;
    };

    pi.on("session_start", markBranchChanged);
    pi.on("session_tree", markBranchChanged);
    pi.on("context", (event) => {
        if (!triggersMayExist) {
            return undefined;
        }

        return stripContinueTriggers(event);
    });
    pi.on("turn_end", (event, ctx) => {
        if (!triggersMayExist) {
            return undefined;
        }

        const result = omitConsumedTriggers(event, ctx);
        triggersMayExist = false;

        return result;
    });
    pi.registerCommand("continue", {
        description: "Re-issue the last request after a provider error, without adding a message",
        handler: async (_args, ctx) => {
            await handleContinue(pi, ctx);
        },
    });
}
