import type { Context, Message, Tool, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";

import { estimateTextTokens } from "./text";
import type { EstimateSource } from "./types";

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

/**
 * Enough of a message to charge for it, in whatever shape the transcript happened to keep it. Structural on
 * purpose: the session's `AgentMessage` union includes rows like `bashExecution` that have no `content` field at
 * all, and a projector typed as `Message` could not be handed them.
 */
type ChargeableMessage = { role?: unknown; content?: unknown; toolCallId?: unknown };

/**
 * The projection a provider actually receives: its role, its content, and the id that ties a tool result to
 * its call.
 *
 * A stored transcript row also carries harness bookkeeping the wire never sees - `details` (for a truncated
 * `read`, a *second full copy* of the output), `usage`, `timestamp`, `responseId`, `api`, `provider`, `model`,
 * `stopReason` - and `convertToLlm` keeps all of it, so stringifying a message as stored charges every byte at
 * chars/4. Measured on a recorded session: a tail the provider counted at 13,289 tokens charged 26,294 from
 * storage against 13,237 through this projection. pi's own per-message estimator walks content by role for the
 * same reason (`compaction.js:188-227`), which is why a stored-row estimate can exceed the provider's count of
 * a context that is a strict subset of it.
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

/** chars/4 over each message's wire shape, summed - never over the stored row. */
function estimateWireMessages(messages: ChargeableMessage[]): number {
    let tokens = 0;
    for (const message of messages) {
        tokens += estimateTextTokens(JSON.stringify(wireShaped(message)) ?? "");
    }
    return tokens;
}

/**
 * chars/4 over the payload being assembled, charged as the payload will be sent.
 *
 * Deliberately *not* pi's heuristic, which this used to share: a whole-array `JSON.stringify` also charges the
 * harness fields `wireShaped` drops, and on a session that had read one large file that doubled the number.
 */
export function estimateRequestTokens(context: Context): number {
    const system = context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0;
    const messages = estimateWireMessages(context.messages);
    const tools = context.tools ? estimateTextTokens(JSON.stringify(context.tools) ?? "") : 0;
    return system + messages + tools;
}

/**
 * Size the span request from the newest provider count inside it, plus chars/4 for what followed that count.
 *
 * Every assistant entry carries the usage of the request that produced it, and that request covered the system
 * prompt, the tool definitions and every message before it - so the newest usable usage inside the span *is* an
 * exact token count for a prefix of the very body stage 1 is about to rebuild, and the reply's own tokens are in
 * every later context, which is why `totalTokens` is the right anchor rather than the prompt half. From there
 * only two things still need guessing: the entries after the anchor, and the instruction we append, which no
 * reference ever sent.
 *
 * Only the *wire* shape of those trailing entries is charged. Reading the stored row instead charges
 * `details`, `usage`, `timestamp` and friends as if the provider had received them, which on a session that had
 * just read one large file priced a 13,289-token tail at 26,294.
 *
 * Returns null when the span holds no usable anchor - a fresh session, one where every reply was aborted or
 * reported no usage, or one where every count predates `boundary` - and the caller then falls back.
 */
export function estimateAnchoredSpanTokens(
    entries: SessionEntry[],
    extraTokens: number,
    boundary = Number.NEGATIVE_INFINITY,
): number | null {
    return anchoredSpanFromNewest(entries, extraTokens, boundary)?.tokens ?? null;
}

/**
 * The same walk, keeping how much of the result was estimated.
 *
 * `tailTokens` separates two numbers computed the same way: a count with an empty tail is a measurement of this
 * whole body, while a count with rows behind it is a measurement plus a guess. Reporting both under one label is
 * what made the cleanest cut there is - `[assistant] | [user]`, where the span ends on the counted reply itself -
 * under-promise the number it produced.
 */
function anchoredSpanFromNewest(
    entries: SessionEntry[],
    extraTokens: number,
    boundary: number,
): { tokens: number; tailTokens: number } | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }

        if (contextIsStale(entry, boundary)) {
            continue;
        }

        const counted = contextTokensFromUsage(entry.message.usage, entry.message.stopReason);
        if (counted === null) {
            continue;
        }

        const tailTokens = estimateEntryTokens(entries.slice(index + 1));

        return { tokens: counted + tailTokens + extraTokens, tailTokens };
    }

    return null;
}

/** Entry types after which no stored token count describes the body a request would carry now. */
const COUNT_BOUNDARY_TYPES = new Set(["compaction", "model_change", "thinking_level_change"]);

/** When an entry landed. An unparseable timestamp can only mean "no boundary here", never "infinitely old". */
function entryTime(entry: SessionEntry): number {
    const raw = (entry as { timestamp?: unknown }).timestamp;

    return typeof raw === "string" ? Date.parse(raw) : Number.NaN;
}

/**
 * The newest event that invalidates every token count older than it.
 *
 * A compaction replaces the summarized rows with a summary message, and a model or thinking-level change
 * replaces the system prompt, the tool definitions, or the templated preamble - so a reply counted before one
 * of those measured a body that no longer exists, and its number is neither this span nor a prefix of it. A
 * fold's reclaim runs to tens of thousands of tokens, which is why this is a boundary rather than a tolerance:
 * believing a stale count inflates the fit gate in the one direction that costs stage 1, and inflates
 * `estimatedTokens` above the provider's count of the request that did go out, which is the shape the report
 * reads as a provider clip.
 *
 * Timestamps and not positions, because `buildContextEntries` moves the compaction entry to index 0 and can drop
 * older shape-change rows, so order in the resolved list says nothing about which rows predate a fold.
 */
export function countBoundary(entries: SessionEntry[]): number {
    let boundary = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
        if (!COUNT_BOUNDARY_TYPES.has(entry.type)) {
            continue;
        }

        const at = entryTime(entry);
        if (!Number.isNaN(at) && at > boundary) {
            boundary = at;
        }
    }

    return boundary;
}

/** A reply counted at or before the boundary measured a body that no longer exists. */
export function contextIsStale(entry: SessionEntry, boundary: number): boolean {
    const at = entryTime(entry);

    return !Number.isNaN(at) && at <= boundary;
}

/**
 * The two counts one row can carry, when it carries any.
 *
 * `prompt` is what the provider charged for the request's input, which is the size of the body that produced the
 * reply; `total` adds the reply itself, which is the size of every body that came after it. Choosing a cut needs
 * both, because an assistant at the cut is measured by the first and an assistant ending the span by the second.
 * An aborted or errored reply is not a measurement of a context that still exists, and a row that reported all
 * zeros reported nothing, so both come back as null rather than as numbers.
 */
export function promptAndTotalTokens(entry: SessionEntry): {
    prompt: number | null;
    total: number | null;
} {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
        return { prompt: null, total: null };
    }

    const usage = entry.message.usage;
    const stopReason = entry.message.stopReason;

    return {
        prompt: promptTokensFromUsage(usage, stopReason),
        total: contextTokensFromUsage(usage, stopReason),
    };
}

export interface SpanCountInput {
    /** The entries stage 1 is about to send, in resolved order, without the appended instruction. */
    spanEntries: SessionEntry[];
    /**
     * The entry at `firstKeptEntryId`, when the caller can vouch for the span it implies: its request body was
     * exactly this span, because the retained tail starts with the reply itself. `undefined` says the caller
     * could not vouch for it, and the anchored tier does the guessing instead.
     */
    keptEntry?: SessionEntry;
    /** `countBoundary()` over the branch. Counts at or before it are rejected rather than believed. */
    boundary?: number;
    /** chars/4 of the instruction we append, which no provider ever counted. */
    extraTokens: number;
}

export type SpanCount =
    | {
          tokens: number;
          source: Extract<EstimateSource, "exact-cut" | "exact-anchor" | "usage-anchor">;
          staleAnchors: number;
      }
    | {
          tokens: null;
          /** Paired with `tokens: null`: the session carried no count that still applies to this body. */
          source: "none";
          /**
           * Counted assistant rows rejected because they predate the boundary. The distinction matters most
           * here: "nothing was ever counted" and "the only counts here are stale" would otherwise read
           * identically, and only the second one says a fold landed with no reply after it.
           */
          staleAnchors: number;
      };

/**
 * How big the span request is, by the best evidence the session itself carries.
 *
 * Two tiers, and the order is not a preference for precision for its own sake: the first needs no estimate of
 * this body at all, while the second still has to guess everything after its anchor. Neither is available in the
 * window right after a fold, before any post-fold reply has landed, and that is the heuristic's case - which is
 * also when the fit gate is most likely to be deciding whether stage 1 runs at all.
 */
export function countSpanTokens(input: SpanCountInput): SpanCount {
    const boundary = input.boundary ?? Number.NEGATIVE_INFINITY;
    const staleAnchors =
        countStaleAssistants(input.spanEntries, boundary) +
        countStaleAssistants(input.keptEntry === undefined ? [] : [input.keptEntry], boundary);

    const counted = exactCutTokens(input.keptEntry, boundary);
    if (counted !== null) {
        return { tokens: counted + input.extraTokens, source: "exact-cut", staleAnchors };
    }

    const anchored = anchoredSpanFromNewest(input.spanEntries, input.extraTokens, boundary);
    if (anchored !== null) {
        // An empty tail is not a small tail: with nothing left to charge, the anchor is the body.
        const source = anchored.tailTokens === 0 ? "exact-anchor" : "usage-anchor";

        return { tokens: anchored.tokens, source, staleAnchors };
    }

    return { tokens: null, source: "none", staleAnchors };
}

/**
 * The span size a provider already counted, or null when the kept entry cannot say it.
 *
 * Takes the prompt half only: the reply's own output is not part of the body being re-sent, which is what
 * separates this from the anchored tier's `totalTokens`.
 */
function exactCutTokens(keptEntry: SessionEntry | undefined, boundary: number): number | null {
    if (
        keptEntry === undefined ||
        keptEntry.type !== "message" ||
        keptEntry.message.role !== "assistant"
    ) {
        return null;
    }

    if (contextIsStale(keptEntry, boundary)) {
        return null;
    }

    return promptTokensFromUsage(keptEntry.message.usage, keptEntry.message.stopReason);
}

/** What the provider charged for one request's prompt, or null when the row recorded nothing usable. */
function promptTokensFromUsage(
    usage: Usage | undefined,
    stopReason: string | undefined,
): number | null {
    if (usage === undefined || stopReason === "aborted" || stopReason === "error") {
        return null;
    }

    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;

    return prompt > 0 ? prompt : null;
}

/** Assistant rows carrying a count that the boundary makes unusable. */
function countStaleAssistants(entries: SessionEntry[], boundary: number): number {
    if (boundary === Number.NEGATIVE_INFINITY) {
        return 0;
    }

    let stale = 0;
    for (const entry of entries) {
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }

        if (entry.message.usage === undefined || !contextIsStale(entry, boundary)) {
            continue;
        }

        stale += 1;
    }

    return stale;
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

/** chars/4 over the wire shape of the messages the anchor's count does not cover. */
function estimateEntryTokens(entries: SessionEntry[]): number {
    return estimateWireMessages(
        entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    );
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
    /** A provider's own count of this body (exact or anchored), when the session carried one that still applies. */
    countedRequestTokens?: number | null;
    /** `ctx.getContextUsage().tokens`: provider usage up to the last reply, plus an estimated tail after it. */
    reportedContextTokens?: number | null;
    /** The whole live context is a superset of the span, so counting it is conservative. */
    context: Context;
}

/**
 * How many prompt tokens to believe the request will cost, best evidence first.
 *
 * The counted number describes the body we are sending, which is what the gate is about. `getContextUsage()`
 * describes the whole live context - the retained tail stage 1 drops included - and is itself a hybrid: last
 * assistant usage plus a chars/4 tail (`compaction.js:148-153`), and `tokens: null` right after a compaction
 * until something has replied since, which is exactly when compaction runs. So it ranks second, not first, and
 * the heuristic last.
 */
export function fitRequirementTokens(input: FitRequirementInput): number {
    const counted = input.countedRequestTokens;
    if (typeof counted === "number" && counted > 0) {
        return counted;
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
 * An overflow-triggered compaction does reach it, and that is the point: the live context no longer fits, but a
 * shorter prefix of it might, and the budget this gate charges is now the one the request can actually afford to
 * answer with. It used to skip this rung on the reason alone.
 */
export function nativeRequestFits(
    context: Context,
    contextWindow: number,
    outputBudgetTokens: number,
    reportedContextTokens?: number | null,
    countedRequestTokens?: number | null,
): boolean {
    if (contextWindow <= 0) {
        return false;
    }

    const needed = fitRequirementTokens({
        countedRequestTokens,
        reportedContextTokens,
        context,
    });

    return needed < contextWindow - outputBudgetTokens;
}
