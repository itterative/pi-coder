import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

import { estimateTextTokens } from "./text";
import type { ContextMessage } from "./types";

/**
 * What a request costs, and what the session's own counts may be believed to mean.
 *
 * Two halves in one module because every sizing tier needs both: the projection that decides which bytes reach a
 * provider, and the read of a stored `usage` that decides whether a number is a measurement or a shrug. They had
 * drifted apart once already - `native-request.ts` kept a private copy of the projection that charged a stored
 * row's `details`, pricing a 13,289-token tail at 26,294 - and a second copy is how the `custom_message` blind
 * spot below survived into the fold ledger.
 */

type ChargeableMessage = { role?: unknown; content?: unknown; toolCallId?: unknown };

/** The halves of a count each reader below actually consults, picked from pi-ai's `Usage`. */
type PromptCounts = Pick<Usage, "input" | "cacheRead" | "cacheWrite">;
type OutputCounts = Pick<Usage, "output">;
type TotalCounts = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">;

/**
 * The projection a provider actually receives: its role, its content, and the id tying a tool result to its call.
 *
 * A stored row also carries harness bookkeeping the wire never sees - `details` (for a truncated `read`, a second
 * full copy of the output), `usage`, `timestamp`, `responseId` - and `convertToLlm` passes a `user`, `assistant`
 * or `toolResult` message through untouched, so hashing a stored message charges every byte. Measured on a
 * recorded session: a tail the provider counted at 13,289 tokens charged 26,294 from storage against 13,237
 * through this projection.
 */
function wireShaped(message: ChargeableMessage): Record<string, unknown> {
    const stored = message as Record<string, unknown>;
    const shaped: Record<string, unknown> = {
        role: stored["role"],
        content: stored["content"],
    };
    if (Object.hasOwn(stored, "toolCallId")) {
        shaped["tool_call_id"] = stored["toolCallId"];
    }

    return shaped;
}

/**
 * chars/4 over the messages a provider actually receives.
 *
 * The projection is pi's own `convertToLlm` rather than a hand-copied one, because the roles it rewrites are
 * exactly the ones a hand-copy forgets: a `bashExecution` becomes derived text ("Ran `cmd`" plus its output) and
 * disappears entirely when `excludeFromContext`, a `custom` message becomes a user message, and a
 * `compactionSummary` or `branchSummary` gains pi's `<summary>` wrapper. It is also idempotent - an
 * already-converted message is one of the three roles it passes through - so stored rows and a built `Context`
 * get the same treatment from one function.
 */
export function estimateWireMessages(messages: readonly ChargeableMessage[]): number {
    // `convertToLlm` types its input as core's `AgentMessage`, which `src/` must not name; `ContextMessage` is
    // that same union derived from pi's exported event type (see `types.ts`). The parameter stays structural
    // because a `bashExecution` row has no `content` field at all, and a projector typed as `Message` could not
    // be handed one.
    const converted = convertToLlm([...messages] as ContextMessage[]);

    let tokens = 0;
    for (const message of converted) {
        tokens += estimateTextTokens(JSON.stringify(wireShaped(message)) ?? "");
    }

    return tokens;
}

/**
 * What pi's `buildContextEntries` makes of one entry, or null when the entry never reaches a request.
 *
 * `custom_message`, `compaction` and `branch_summary` all become real context messages (`session-manager.js:177`,
 * `:182`, `:185`) and `span-session.ts` copies all three into the span, so charging them zero understates every
 * tail they sit in: measured on a live capture, one 208-char `pi-memory` marker was 52 tokens the estimator
 * answered 0 for, and the memory-index marker that module also writes runs to kilobytes. A checkpoint riding
 * along inside a retained stretch is the expensive case, because pi wraps it (`messages.js:103-108`) and the
 * wrapper is part of what the next request pays for.
 *
 * `custom`, `label`, `session_info`, `model_change` and `thinking_level_change` produce no message at all -
 * `buildContextEntries` falls through to `return []` - which is why they stay free.
 */
function contextMessageOf(entry: SessionEntry): ContextMessage | null {
    switch (entry.type) {
        case "message":
            return entry.message;
        case "custom_message":
            return {
                role: "custom",
                customType: entry.customType,
                content: entry.content,
                display: entry.display,
                // pi stamps `new Date(entry.timestamp).getTime()` here (`messages.js:57`); the wire projection
                // drops it, so no value can matter and a parsed one would only suggest that it does.
                timestamp: 0,
            };
        case "compaction":
            return {
                role: "compactionSummary",
                summary: entry.summary,
                tokensBefore: entry.tokensBefore,
                timestamp: 0,
            };
        case "branch_summary":
            return {
                role: "branchSummary",
                summary: entry.summary,
                fromId: entry.fromId,
                timestamp: 0,
            };
        default:
            return null;
    }
}

/** chars/4 over what a range of entries costs as context; an entry no request carries costs nothing. */
export function estimateEntryTokens(entries: readonly SessionEntry[]): number {
    return estimateWireMessages(
        entries.flatMap((entry) => {
            const message = contextMessageOf(entry);

            return message === null ? [] : [message];
        }),
    );
}

/**
 * What the provider counted for the request that produced a reply - the body before it.
 *
 * The prompt half only, which is what makes it a measurement of a range's start rather than its end: an aborted or
 * errored turn counted a body that no longer stands, and an all-zero usage reported nothing at all.
 *
 * Typed by the fields it reads rather than by `Usage`, because two surfaces carry a count and only one of them is
 * a pi-ai `Usage`: a session row's `message.usage`, and the `usage` a trace record copies out of a reply. Both
 * answer the same question, and a reader that named the wider type would leave the trace side summing by hand -
 * which is how the refusal rules get reimplemented, and then forgotten, in a test.
 */
export function promptTokensOf(
    usage: PromptCounts | undefined,
    stopReason: string | undefined,
): number | null {
    if (usage === undefined || stopReason === "aborted" || stopReason === "error") {
        return null;
    }

    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;

    return prompt > 0 ? prompt : null;
}

/**
 * Tokens in the context after that reply landed, which is what every later body carries.
 *
 * Prefers the provider's own total and falls back to summing the parts, because a route that reports `totalTokens`
 * as zero while reporting a prompt is answering a different question than the one asked. Same refusals as the
 * prompt half: an aborted or errored turn is not a measurement of a context that still exists.
 */
export function totalTokensOf(
    usage: TotalCounts | undefined,
    stopReason: string | undefined,
): number | null {
    if (usage === undefined || stopReason === "aborted" || stopReason === "error") {
        return null;
    }

    const total =
        usage.totalTokens > 0
            ? usage.totalTokens
            : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

    return total > 0 ? total : null;
}

/** Tokens of the reply itself, which is what a body gains between one counted row and the next. */
export function outputTokensOf(
    usage: OutputCounts | undefined,
    stopReason: string | undefined,
): number | null {
    if (usage === undefined || stopReason === "aborted" || stopReason === "error") {
        return null;
    }

    return usage.output > 0 ? usage.output : null;
}

/** The prompt count of an assistant row, or null when the row cannot say it. */
export function rowPromptTokens(entry: SessionEntry): number | null {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
        return null;
    }

    return promptTokensOf(entry.message.usage, entry.message.stopReason);
}

/** The total count of an assistant row - the body it saw plus its own reply - or null when it cannot say it. */
export function rowTotalTokens(entry: SessionEntry): number | null {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
        return null;
    }

    return totalTokensOf(entry.message.usage, entry.message.stopReason);
}
