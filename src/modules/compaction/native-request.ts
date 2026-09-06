import type { Context, Message, Tool, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";

import { estimateTextTokens } from "./text";

/**
 * Rebuilding the request pi is currently sending, so a summarization call can reuse it.
 *
 * The whole point of the native strategy is that the model reads its own conversation instead of a
 * re-typed copy of it. That only pays off when the request is prefix-identical to what already went out:
 * same system prompt string, same tool array in the same order, same message objects. Hence reading the
 * active tool *names* and mapping them back onto definitions rather than taking every configured tool, and
 * hence `ctx.getSystemPrompt()`, which reflects the override `before_agent_start` handlers installed —
 * pi-coder's own memory and scratchpad blocks included.
 */

/** Tools in `agent.state.tools` order, which is the order pi serialized them in. */
export function activeToolDefinitions(pi: ExtensionAPI): Tool[] {
    const byName = new Map<string, ToolInfo>(pi.getAllTools().map((tool) => [tool.name, tool]));
    const tools: Tool[] = [];
    for (const name of pi.getActiveTools()) {
        const info = byName.get(name);
        if (!info) {
            continue;
        }
        tools.push({ name: info.name, description: info.description, parameters: info.parameters });
    }
    return tools;
}

/** Conservative chars/4 estimate over the exact payload being assembled, matching pi's own heuristic. */
export function estimateRequestTokens(context: Context): number {
    const system = context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0;
    const messages = estimateTextTokens(JSON.stringify(context.messages) ?? "");
    const tools = context.tools ? estimateTextTokens(JSON.stringify(context.tools) ?? "") : 0;
    return system + messages + tools;
}

/**
 * Size the span request from what the provider already counted, using the heuristic only for what has no count.
 *
 * Every assistant entry carries the usage of the request that produced it, and that request covered the system
 * prompt, the tool definitions and every message before it - so the newest usable usage inside the span *is* an
 * exact token count for a prefix of the very body stage 1 is about to rebuild, and the reply's own tokens are in
 * every later context, which is why `totalTokens` is the right anchor rather than the prompt half. From there
 * only two things still need guessing: the entries after the anchor, and the instruction we append, which no
 * reference ever sent. Measured against a recorded session's own provider counts, whole-body chars/4 runs +40%
 * mean error (+93% worst) and this runs +2%.
 *
 * Returns null when the span holds no usable anchor - a fresh session, or one where every reply was aborted or
 * reported no usage - and the caller then falls back to the heuristic.
 *
 * One known over-count, deliberately left conservative: if the newest anchor predates a fold that later removed
 * material from the resolved view, its number includes tokens this span no longer carries. That needs an anchor
 * from an older round than any turn since the last compaction, which the 20k-token keep makes rare, and the
 * direction is the safe one - the report's estimate band names it when it happens.
 */
export function estimateAnchoredSpanTokens(
    entries: SessionEntry[],
    extraTokens: number,
): number | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }

        const counted = contextTokensFromUsage(entry.message.usage, entry.message.stopReason);
        if (counted === null) {
            continue;
        }

        return counted + estimateEntryTokens(entries.slice(index + 1)) + extraTokens;
    }

    return null;
}

/**
 * Tokens in the context after that reply landed. An aborted or errored turn's usage is not a measurement of a
 * body that still exists, and a route that reported all zeros reported nothing, so both are skipped as anchors
 * rather than believed.
 */
function contextTokensFromUsage(
    usage: Usage | undefined,
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

/** chars/4 over the messages the anchor's count does not cover. */
function estimateEntryTokens(entries: SessionEntry[]): number {
    const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    if (messages.length === 0) {
        return 0;
    }

    return estimateTextTokens(JSON.stringify(messages) ?? "");
}

export interface NativeContextInput {
    systemPrompt: string;
    tools: Tool[];
    messages: Message[];
    instruction: string;
    timestamp: number;
}

export function buildNativeContext(input: NativeContextInput): Context {
    const instructionMessage: Message = {
        role: "user",
        content: [{ type: "text", text: input.instruction }],
        timestamp: input.timestamp,
    };
    return {
        systemPrompt: input.systemPrompt,
        messages: [...input.messages, instructionMessage],
        tools: input.tools,
    };
}

export interface FitRequirementInput {
    /** The anchored count of the body we are about to send, when the span had an anchor to count from. */
    anchoredRequestTokens?: number | null;
    /** `ctx.getContextUsage().tokens`: provider usage up to the last reply, plus an estimated tail after it. */
    reportedContextTokens?: number | null;
    /** The whole live context is a superset of the span, so counting it is conservative. */
    context: Context;
}

/**
 * How many prompt tokens to believe the request will cost, best evidence first.
 *
 * The anchored count describes the body we are sending, which is what the gate is about. `getContextUsage()`
 * describes the whole live context - the retained tail stage 1 drops included - and is itself a hybrid: last
 * assistant usage plus a chars/4 tail (`compaction.js:148-153`), and `tokens: null` right after a compaction
 * until something has replied since, which is exactly when compaction runs. So it ranks second, not first, and
 * the heuristic last.
 */
export function fitRequirementTokens(input: FitRequirementInput): number {
    const anchored = input.anchoredRequestTokens;
    if (typeof anchored === "number" && anchored > 0) {
        return anchored;
    }

    const reported = input.reportedContextTokens;
    if (typeof reported === "number" && reported > 0) {
        return reported;
    }

    return estimateRequestTokens(input.context);
}

/**
 * Whether the native request can still be sent.
 *
 * The room that matters is the *output* budget, not pi's whole `reserveTokens`: a threshold-triggered
 * compaction runs at exactly `contextWindow - reserveTokens`, so a gate that re-reserved that window would
 * reject every request this strategy exists for. What has to fit alongside the re-sent context is the
 * summary the model is about to write, which is the caller's output budget.
 *
 * Overflow-triggered compaction never reaches this gate: by definition the live context no longer fits, so
 * that reason goes straight to the serialized strategy.
 */
export function nativeRequestFits(
    context: Context,
    contextWindow: number,
    outputBudgetTokens: number,
    reportedContextTokens?: number | null,
    anchoredRequestTokens?: number | null,
): boolean {
    if (contextWindow <= 0) {
        return false;
    }

    const needed = fitRequirementTokens({
        anchoredRequestTokens,
        reportedContextTokens,
        context,
    });

    return needed < contextWindow - outputBudgetTokens;
}
