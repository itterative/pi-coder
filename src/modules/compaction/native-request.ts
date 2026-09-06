import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";

import { estimateTextTokens } from "./text";
import type { EstimateSource } from "./types";
import type { MeasuredBody } from "./ledger";
import {
    estimateEntryTokens,
    estimateWireMessages,
    promptTokensOf,
    rowPromptTokens,
    rowTotalTokens,
    totalTokensOf,
} from "./usage";

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
 * chars/4 over the payload being assembled, charged as the payload will be sent.
 *
 * Deliberately *not* pi's heuristic, which this used to share: a whole-array `JSON.stringify` also charges the
 * harness fields the wire projection drops (see `usage.ts`), and on a session that had read one large file that
 * doubled the number.
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

        const counted = totalTokensOf(entry.message.usage, entry.message.stopReason);
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

/**
 * Whether a row changes the basis token counts are taken on.
 *
 * Exported because `ledger.ts`'s range walk has to break its chain at exactly these rows and nowhere else: the
 * set that expires a stored count and the set that invalidates a *difference of two stored counts* are the same
 * quantity, and two definitions of it drift the moment someone adds a type to one.
 */
export function changesCountBasis(entry: SessionEntry): boolean {
    return COUNT_BOUNDARY_TYPES.has(entry.type);
}

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
        if (!changesCountBasis(entry)) {
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

    return { prompt: rowPromptTokens(entry), total: rowTotalTokens(entry) };
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
    /**
     * The head ledger's size for this same body, from `spanBodyTokens`, when the session could derive one.
     *
     * Passed in rather than computed here because the ledger walks the file-order branch and needs the window
     * `stageOneSpanEntries` chose, while this function is handed the window's entries and nothing else. Null and
     * undefined both mean "no ledger number": `spanBodyTokens` declines a body it will not vouch for, and a
     * caller without a branch has nothing to ask.
     */
    ledger?: MeasuredBody | null;
}

export type SpanCount =
    | {
          tokens: number;
          source: Extract<
              EstimateSource,
              "exact-cut" | "exact-anchor" | "usage-anchor" | "head-ledger"
          >;
          staleAnchors: number;
          /** How many folds' own counted numbers turned a rejected anchor into this one. */
          foldCorrected: number;
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
          foldCorrected: 0;
      };

/**
 * How big the span request is, by the best evidence the session itself carries.
 *
 * The order is not a preference for precision for its own own sake: each tier needs less of this body guessed than
 * the one below it. The first needs no estimate of the body at all, the second still guesses everything after its
 * anchor, and the third has no anchor left to use - a fold expired every count in the span - so it solves instead
 * for the head no row owns and brackets the rows between two counts. The two below that are the rescue tiers, and
 * none of them is available in the window right after a fold before any post-fold reply has landed, which is the
 * heuristic's case and also when the fit gate is most likely to be deciding whether stage 1 runs at all.
 */
export function countSpanTokens(input: SpanCountInput): SpanCount {
    const boundary = input.boundary ?? Number.NEGATIVE_INFINITY;
    const staleAnchors =
        countStaleAssistants(input.spanEntries, boundary) +
        countStaleAssistants(input.keptEntry === undefined ? [] : [input.keptEntry], boundary);

    const counted = exactCutTokens(input.keptEntry, boundary);
    if (counted !== null) {
        return {
            tokens: counted + input.extraTokens,
            source: "exact-cut",
            staleAnchors,
            foldCorrected: 0,
        };
    }

    const anchored = anchoredSpanFromNewest(input.spanEntries, input.extraTokens, boundary);
    if (anchored !== null) {
        // An empty tail is not a small tail: with nothing left to charge, the anchor is the body.
        const source = anchored.tailTokens === 0 ? "exact-anchor" : "usage-anchor";

        return { tokens: anchored.tokens, source, staleAnchors, foldCorrected: 0 };
    }

    const ledger = input.ledger;
    if (ledger !== undefined && ledger !== null) {
        // A head solved from a provider count, plus rows bracketed by two of them: the `usage-anchor` error
        // profile without needing a live count inside the span, which is precisely what a fold expired.
        // `spanBodyTokens` already declined the bodies too estimated to gate on, so this tier does not re-check.
        return {
            tokens: ledger.tokens,
            source: "head-ledger",
            staleAnchors,
            foldCorrected: 0,
        };
    }

    const corrected = correctedSpanFromNewest(input.spanEntries, input.extraTokens, boundary);
    if (corrected !== null) {
        // Labelled by what it costs rather than what it used to be: a counted body, counted arithmetic over it,
        // and a chars/4 tail, which is the `usage-anchor` error profile with a better starting point.
        return {
            tokens: corrected.tokens,
            source: "usage-anchor",
            staleAnchors,
            foldCorrected: corrected.folds,
        };
    }

    return { tokens: null, source: "none", staleAnchors, foldCorrected: 0 };
}

/**
 * The tokens a fold removed from the live context, and the summary that came back in their place.
 *
 * Nothing about a fold says "removed" directly: the persisted number is a provider's count of a whole request,
 * which carries the system prompt and tool definitions the fold leaves alone. So the two persisted fields are
 * subtracted here, where the reader can see both operands, and the summary comes from the fold's own `usage`.
 */
function countedFoldTokens(entry: SessionEntry): { removed: number; summary: number } | null {
    if (entry.type !== "compaction") {
        return null;
    }

    // Every operand or nothing: a request count without its prefix, a prefix without a count, or a summary whose
    // output tokens are missing each turn the arithmetic into a guess with an equals sign in it.
    const details = entry.details as
        { countedBodyTokens?: unknown; fixedPrefixTokens?: unknown } | undefined;
    const counted = details?.countedBodyTokens;
    const prefix = details?.fixedPrefixTokens;
    const summary = entry.usage?.output;
    if (
        typeof counted !== "number" ||
        typeof prefix !== "number" ||
        typeof summary !== "number" ||
        counted <= 0 ||
        prefix < 0 ||
        summary <= 0
    ) {
        return null;
    }

    const removed = counted - prefix;
    if (removed <= 0) {
        return null;
    }

    return { removed, summary };
}

/**
 * The folds in a tail whose own persisted counts vouch for them, plus the rows those counts have now paid for.
 *
 * `paidRows` exists so a summary is charged once: the fold's `usage.output` is a provider count of it, while the
 * tail estimator would charge the same text at chars/4 with pi's `<summary>` wrapper on top. A fold row absent
 * from the set is one nobody vouched for, and it stays in the estimate.
 */
function vouchedFolds(tail: readonly SessionEntry[]): {
    folds: { removed: number; summary: number }[];
    paidRows: Set<string>;
} {
    const folds: { removed: number; summary: number }[] = [];
    const paidRows = new Set<string>();

    for (const entry of tail) {
        const tokens = countedFoldTokens(entry);
        if (tokens === null) {
            continue;
        }

        folds.push(tokens);
        paidRows.add(entry.id);
    }

    return { folds, paidRows };
}

/**
 * The same walk `anchoredSpanFromNewest` makes, allowing an anchor that predates a fold the span can account for.
 *
 * A stale count describes a body that no longer exists, so the first pass rejects it and the caller is left with
 * chars/4 - which is precisely the window right after a fold, before any post-fold reply has landed, and the moment
 * the fit gate decides whether stage 1 runs at all. A fold row that was exactly counted says what left the context
 * (its counted request, net of the fixed prefix inside it) and what came back in its place (`usage.output`), both
 * provider numbers, so the rejection becomes arithmetic.
 *
 * A summary reaches this number exactly once, and which route wins is a choice rather than an accident: a fold the
 * persisted counts vouch for contributes `usage.output` and its row is then excluded from the chars/4 tail, while a
 * fold they refuse - a row written before the fields existed - is charged as the text it now is, wrapper included.
 * The estimator used to answer zero for every fold row, which made the exclusion unnecessary and silently
 * under-charged the folds nobody had vouched for.
 *
 * Refuses rather than approximates: without an exactly-counted fold in range it answers null, and the tier stays
 * `none` as it always was.
 */
function correctedSpanFromNewest(
    entries: SessionEntry[],
    extraTokens: number,
    boundary: number,
): { tokens: number; tailTokens: number; folds: number } | null {
    if (boundary === Number.NEGATIVE_INFINITY) {
        return null;
    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }

        if (!contextIsStale(entry, boundary)) {
            continue;
        }

        const counted = totalTokensOf(entry.message.usage, entry.message.stopReason);
        if (counted === null) {
            continue;
        }

        const tail = entries.slice(index + 1);
        const vouched = vouchedFolds(tail);
        if (vouched.folds.length === 0) {
            continue;
        }

        const removed = vouched.folds.reduce((total, fold) => total + fold.removed, 0);
        const added = vouched.folds.reduce((total, fold) => total + fold.summary, 0);
        const base = counted - removed + added;
        if (base <= 0) {
            continue;
        }

        const tailTokens = estimateEntryTokens(
            tail.filter((entry) => !vouched.paidRows.has(entry.id)),
        );

        return { tokens: base + tailTokens + extraTokens, tailTokens, folds: vouched.folds.length };
    }

    return null;
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

    return promptTokensOf(keptEntry.message.usage, keptEntry.message.stopReason);
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
