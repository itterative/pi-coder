import type { Api, Context, Message, Model, Usage } from "@earendil-works/pi-ai";
import type {
    CompactionResult,
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

import { isAgentTraceEnabled } from "../../common/trace";
import { type CompactionConfig, loadCompactionConfig } from "./config";
import {
    chainTraceTarget,
    loadChain,
    recordChainRequest,
    type ChainTraceTarget,
} from "./chain-store";
import { chooseSpanCut, type CutDecision } from "./cut";
import {
    activeToolDefinitions,
    buildNativeContext,
    countBoundary,
    countSpanTokens,
    estimateRequestTokens,
    fitRequirementTokens,
    nativeRequestFits,
} from "./native-request";
import {
    fingerprintPayload,
    fingerprintSummary,
    requestMessages,
    requestShape,
} from "./prefix-diff";
import {
    messageLadder,
    pathIdSet,
    divergenceLine,
    sampleMessages,
    RequestChain,
    type ChainObservation,
    type ChainShape,
} from "./chain";
import {
    SERIALIZATION_SYSTEM_PROMPT,
    segmentSummaryInstruction,
    serializedSummarizationRequest,
} from "./prompt";
import { spanBodyTokens, spanSizer } from "./ledger";
import type { PrefixDivergence } from "./trace";
import {
    serializeConversationMinimal,
    serializerOptions,
    type SerializedConversation,
} from "./serialize";
import {
    analyzeSpan,
    buildSupplementarySections,
    computeFileLists,
    formatFileLists,
} from "./sections";
import {
    buildSpanSession,
    previousFoldWindowStart,
    skippedEntryCount,
    stageOneSpanEntries,
} from "./span-session";
import { type SummarizationFailureCause, causeRationale, isTerminalCause } from "./failure";
import {
    summarizeNatively,
    summarizeSerializedTranscript,
    type SummarizationRetryPolicy,
} from "./summarize";
import {
    type CompactionAttemptFields,
    type CompactionPrefixFields,
    compactionTraceTarget,
    createCompactionTraceRecorder,
    ledgerFields,
    type CompactionTraceOutcome,
    type CompactionTraceRecorder,
} from "./trace";
import { summarizedSpan, type CompactionPreparation, type ThinkingLevel } from "./types";
import { estimateTextTokens } from "./text";

/**
 * Compaction in two stages: read the conversation, then compress what was read.
 *
 * pi's default path serializes the summarized span to text — thinking blocks untruncated, tool results at a
 * fixed 2000 characters, no overall budget — and sends it as a one-off request with caching explicitly
 * disabled, so all of that bulk is billed as fresh input. Here:
 *
 * 1. **segment (native)** — the span the session is about to lose, as real message objects, resolved by pi
 *    from an in-memory transcript truncated at the cut point. The model reads its own tool calls and results
 *    instead of a paraphrase of them, and because the system prompt and tool array are the parent's, the
 *    request stays a strict prefix of what the provider already cached. Tools are forbidden by
 *    forbidden by the instruction text rather than by `tool_choice`, since removing them moves the prefix.
 * 2. **reduce (serialized)** — one bounded, text-only call over the minimized transcript plus stage 1's
 *    checkpoint plus the previous one, producing the summary that gets persisted.
 * 3. **pi's default** — return `undefined` and let core compact the old way.
 *
 * `overflow` skips stage 1: the span by definition no longer fits. If stage 1 fails alone, stage 2 still
 * runs with no segment checkpoint; if stage 2 fails but stage 1 succeeded, stage 1's own text is persisted.
 * The third rung is why nothing here may throw: a defect in this module should cost the quality of a
 * summary, never a session that can no longer be compacted.
 */

/** Which stages produced the persisted summary. */
export type CompactionRoute = "two-stage" | "native" | "serialized";

/**
 * Stored in `CompactionEntry.details`. The file lists keep pi's own key names, because core extracts them
 * from the previous compaction entry to build the cumulative ledger; renaming them would silently break
 * that tracking rather than fail loudly.
 */
interface PiCoderCompactionDetails {
    version: 1;
    /**
     * The boundary reply's own prompt count, and the fixed prefix inside it.
     *
     * Present only when the span was exactly counted. Their difference is what this fold took out of the live
     * context, and `correctedSpanFromNewest` reads both to turn a count this fold expired back into a usable one
     * on the first request after the fold - the window where nothing else is counted.
     */
    countedBodyTokens?: number;
    fixedPrefixTokens?: number;
    route: CompactionRoute;
    provider: string;
    model: string;
    readFiles: string[];
    modifiedFiles: string[];
    summarizedMessages: number;
    droppedBlocks: number;
}

interface StageContext {
    pi: ExtensionAPI;
    ctx: ExtensionContext;
    preparation: CompactionPreparation;
    customInstructions?: string;
    config: CompactionConfig;
    /**
     * The output reserve the cut walk has to leave beside a candidate span: stage 1's budget evaluated against
     * core's *proposed* body. Not a request cap - each stage sizes its own ask from the body it actually sends.
     */
    cutOutputReserveTokens: number;
    signal: AbortSignal;
    trace: CompactionTraceRecorder;
    /**
     * The instruction stage 1 appends, built once by the handler.
     *
     * The cut walk needs its size before it can size the request, and the request needs the cut - building it
     * here is what breaks that circle, because the text depends only on the preparation, never on the boundary.
     */
    instruction: string;
    /** Where the span ends, which may or may not be where core said it did. */
    cut: CutDecision;
    /** Core's whole-live-context estimate, passed through untouched: it describes the context, not the cut. */
    tokensBefore: number;
}

/**
 * What one rung produced. `cause` is absent when no reply was ever seen — a request the fit gate skipped has
 * no provider failure to name — and the cascade treats an absent cause as not terminal, since there is nothing
 * it learned that says the next rung would fail too.
 */
type StageResult = {
    /**
     * What a provider counted for the body this fold sized from, and the fixed prefix inside it.
     *
     * Both, because a fold removes only the span while the count covers the whole request: the reader subtracts
     * one from the other, and the subtraction belongs where a reader can audit it rather than inside a field
     * name. Present whatever the stage then did - a fit-gate skip and a rejected reply still discard the same
     * material, and the fold after this one wants these numbers most when this one was forced short.
     */
    countedBodyTokens?: number;
    fixedPrefixTokens?: number;
} & (
    | { ok: true; text: string; usage?: Usage; retries: number }
    | {
          ok: false;
          detail: string;
          cause?: SummarizationFailureCause;
          retries: number;
      }
);

/**
 * The session's thinking level, or undefined when it cannot be read.
 *
 * Every bound session provides one - `AgentSession` answers it from its own state - so a delegated child has its
 * own level and parity is with that child's turns, not the parent's. What this has to survive is about the build
 * rather than the runtime: an extension compiled against a newer pi than the one running, where the method is
 * absent, or a session whose handler surface refuses the call. A catch covers both, where a presence check would
 * cover only the first - and the stakes are the same either way, since the module's outer catch would otherwise
 * degrade that compaction to core's default over a value that decides nothing but cache reuse.
 */
function sessionThinkingLevel(pi: ExtensionAPI): ThinkingLevel | undefined {
    try {
        return pi.getThinkingLevel();
    } catch {
        return undefined;
    }
}

/**
 * Resend policy for one compaction: only a cause the provider's own wording calls transient earns a retry.
 *
 * `sleep` is left unset so the production backoff is the real, abort-aware one; tests inject their own.
 */
function retryPolicy(config: CompactionConfig): SummarizationRetryPolicy {
    return { maxRetries: config.retryMaxRetries, baseDelayMs: config.retryBaseDelayMs };
}

/** The smallest output allowance that is still a legal provider request. */
const MIN_OUTPUT_TOKENS = 1024;
/** Unbudgeted room, sized to the error in `requestTokens` (~1% on a provider count), not to the window. */
const SUMMARIZATION_MARGIN_TOKENS = 1024;

/**
 * The room one summarization reply may take, for the request that is about to go out.
 *
 * Every caller passes **that request's own body**. One number shared between the two stages was the defect this
 * sentence replaces: stage 1 re-sends the span, while the reduce sends a blob this module serialized and bounds
 * itself, so charging stage 2 with the span left it asking for whatever room a nearly-full window happened to
 * have - see `stageTwoRequest` for what that cost.
 *
 * This replaces two numbers derived from pi's `reserveTokens` (`0.8 * reserve`, then a third of it for stage 1),
 * which capped a live 94-event checkpoint at 4,369 tokens on a route whose model reports 65,536: the reply hit the
 * cap, the truncation check rejected it, and 47.6k fresh input plus 53 seconds bought a discarded document. A cap
 * can only ever bind, so both stages now get the room the request leaves, and the rival-draft risk the fraction
 * protected is carried by the instruction and the report's checkpoint/summary ratio instead.
 *
 * `requestTokens` is the whole request as the fit gate charges it - system prompt, tool schemas, span, instruction.
 * Subtracting only the span overstates the room by the fixed prefix, and the margin keeps the gate falsifiable: at
 * `budget == window - request` it reduces to `needed < needed` and refuses every run.
 */
export function summarizationBudgetTokens(input: {
    modelMaxTokens: number;
    contextWindow: number;
    requestTokens: number;
    /** Overridable so a test can state a case in terms of the margin it is exercising. */
    marginTokens?: number;
}): number {
    const { modelMaxTokens, contextWindow, requestTokens } = input;
    const margin = input.marginTokens ?? SUMMARIZATION_MARGIN_TOKENS;
    // Deliberately unfloored: a floor here grants room the window lacks, which the gate charges back to the run.
    const room = Math.max(0, contextWindow - requestTokens - margin);
    if (!Number.isFinite(modelMaxTokens) || modelMaxTokens <= 0) {
        return room;
    }

    return Math.min(modelMaxTokens, room);
}

/**
 * Stage 2's request, and the cap that follows from it.
 *
 * The reduce sends one message whose size this module controls (`serializedMaxTokens`) plus its own short system
 * prompt, and no tools at all. Deriving its cap from stage 1's request instead floored the ask exactly when
 * compaction matters: the first fill of a 200k window gave it 5,188 tokens against a 10,408-token request, the
 * second floored it at `MIN_OUTPUT_TOKENS`, and that reply came back `length` with 1,024 output tokens and *no
 * text* - a thinking model spends a cap that small before it starts writing, so the failure is an empty summary
 * rather than a truncated one (2026-09-07, runs `01a07cc3` and `01a07cec`). A binding cap costs a section; a
 * floored cap costs the whole reply.
 */
function stageTwoRequest(input: {
    model: Model<Api>;
    transcript: SerializedConversation;
    segmentText?: string;
    previousSummary?: string;
    customInstructions?: string;
}): { requestText: string; maxTokens: number } {
    const requestText = serializedSummarizationRequest({
        conversationText: input.transcript.text,
        segmentSummary: input.segmentText,
        previousSummary: input.previousSummary,
        customInstructions: input.customInstructions,
    });
    const requestTokens =
        estimateTextTokens(requestText) + estimateTextTokens(SERIALIZATION_SYSTEM_PROMPT);

    return {
        requestText,
        maxTokens: Math.max(
            MIN_OUTPUT_TOKENS,
            summarizationBudgetTokens({
                modelMaxTokens: input.model.maxTokens,
                contextWindow: input.model.contextWindow,
                requestTokens,
            }),
        ),
    };
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
    if (!ctx.hasUI) {
        return;
    }
    ctx.ui.notify(message, level);
}

/**
 * The structural view of a session manager this module needs. Declared locally because pi's own subpath
 * types are not importable from an extension bundle, and a fingerprint does not care about the rest.
 */
interface SessionShapeView {
    getLeafId(): string | null;
    getBranch(): { id: string; timestamp?: string }[];
    getSessionId(): string;
}

/**
 * Where the chain persists, resolved on each use.
 *
 * Deliberately not cached by cwd: the trace location is env-overridable and config-editable, and a per-cwd memo
 * would freeze the first answer for the life of the process - which is wrong for tests and wrong for a user who
 * edits the config. Caching buys nothing either: `observe` re-hashes the entire message array on this same path,
 * so a small config read is noise next to the work it would skip.
 */
function chainTargetFor(cwd: string): ChainTraceTarget {
    return chainTraceTarget(loadCompactionConfig(cwd));
}

/**
 * pi's request history per session, as hash ladders rather than bodies.
 *
 * The body pi built is megabytes and one turn deep; a cumulative head is sixty bytes, so this can retain every
 * request in the session and stay branch-correct. Keyed by the session manager, so a delegated child compares
 * against its own history and the entry is released with the session.
 */
const requestChains = new WeakMap<SessionShapeView, RequestChain>();

/**
 * The chain for a session, folded in from disk exactly once per session manager.
 *
 * Hydration belongs here rather than at verdict time so that a chain's own process-written observations can
 * never overlap the rows it restores: everything this process records is written after the read. One walk of the
 * branch per chain buys the session's start timestamp, which is what lets the loader skip whole segments on a
 * stat - and it is once per session, not once per request.
 */
function chainFor(sessionManager: SessionShapeView, cwd: string): RequestChain {
    const existing = requestChains.get(sessionManager);
    if (existing !== undefined) {
        return existing;
    }

    const chain = new RequestChain();
    requestChains.set(sessionManager, chain);

    const oldest = sessionManager.getBranch()[0]?.timestamp;
    const startedMs = typeof oldest === "string" ? Date.parse(oldest) : Number.NaN;

    chain.restore(
        loadChain(
            chainTargetFor(cwd),
            sessionManager.getSessionId(),
            Number.isNaN(startedMs) ? undefined : startedMs,
        ),
    );

    return chain;
}

/** Called for every provider request, including a child's: hash it now, keep nothing else. */
function observeParentRequest(
    sessionManager: SessionShapeView,
    cwd: string,
    payload: unknown,
): void {
    const shape = requestShape(payload);
    const recorded = chainFor(sessionManager, cwd).observe({
        leafId: sessionManager.getLeafId(),
        messages: requestMessages(payload),
        shape,
    });

    recordChainRequest(
        chainTargetFor(cwd),
        { cwd, session: sessionManager.getSessionId(), shape },
        recorded,
    );
}

/**
 * Did our rebuilt request share the prefix the provider already has?
 *
 * Answered by folding our own message ladder against the retained heads, at the reference's depths. Two
 * consequences are load-bearing. A reference only counts when its leaf is on the current branch, so
 * navigating back can no longer produce a confident wrong answer about a forked request. And with no
 * reference at all the record says so and leaves `prefixUsable` undefined, rather than reporting the old
 * `false` plus `commonPrefixMessages: 0` that made a cold process look like a broken rebuild.
 */
/**
 * Name the message the heads disagreed on, from the two bodies' retained leading samples.
 *
 * Ours is sampled fresh from the body about to go out; theirs is whatever this process retained of the credited
 * reference. When nothing was retained - a reference from before this process started - the record says so rather
 * than printing a comparison that did not happen, because a depth alone is the thing that could not be diagnosed
 * after the fact.
 */
function sampledDivergence(
    chain: RequestChain,
    ourMessages: unknown[],
    referenceLeafId: string | null,
    depth: number,
    divergences: string[],
): PrefixDivergence {
    const ours = sampleMessages(ourMessages);
    const theirs = chain.sampleFor(referenceLeafId);
    const line = divergenceLine(depth, ours, theirs);
    if (line !== null) {
        divergences.push(line);
    }

    return { depth, ours, theirs, sampledRequests: chain.sampledRequests };
}

function prefixVerdict(
    sessionManager: SessionShapeView,
    ourPayload: unknown,
    cwd: string,
): CompactionPrefixFields {
    const messages = requestMessages(ourPayload);
    const shape = requestShape(ourPayload);
    const ours = fingerprintPayload(ourPayload);
    const branch = sessionManager.getBranch();
    const pathIds = pathIdSet(branch);
    const chain = chainFor(sessionManager, cwd);
    const onBranch = chain.branchObservations(pathIds);
    const rejects = shapeRejections(onBranch, shape);
    // Fold only the span. `buildNativeContext` appends exactly one instruction message, and pi never sent
    // that one, so leaving it in the ladder would guarantee a mismatch at our own last depth and re-raise the
    // tail artifact the chain exists to avoid.
    const spanMessages = Math.max(0, messages.length - 1);
    const match = chain.match({
        spanLadder: messageLadder(messages.slice(0, spanMessages)),
        pathIds,
        shape,
    });

    // The mirror describes the request the depths were credited to, not merely the newest one on the branch:
    // `parameters`, `modelDivergence` and the value deltas below are all measured against that reference, and a
    // record printing two different parents is the conflation this pass exists to remove. When nothing could be
    // credited - the case `shapeDivergences` explains - the newest on-branch row is the only thing to name.
    const parent = match.referenceObservation ?? onBranch[onBranch.length - 1];

    // Only depths the reference actually covered *and* our span reached are checkable; pi's deeper requests
    // say nothing about a truncated span.
    const verifiedThrough = match.comparableDepth > 0 && match.verifiedTo >= match.comparableDepth;
    const divergences = shapeDivergences(parent, shape, match);

    let divergence: PrefixDivergence | undefined;
    if (match.firstMismatchDepth !== null) {
        const depth = match.firstMismatchDepth;
        divergences.push(`messages[${String(depth)}]`);
        divergence = sampledDivergence(chain, messages, match.referenceLeafId, depth, divergences);
    }

    const hasReference = match.reference === "chain";
    if (!hasReference) {
        // Stated as a divergence so a reader cannot mistake an empty verdict for a passing one.
        divergences.push("no-reference");
    }

    divergences.push(...decodeDivergences(match.referenceObservation, shape));

    const unknowns = prefixUnknowns({
        held: chain.size,
        onBranch: onBranch.length,
        compared: match.compared,
        rejects,
        retentionDropped: match.truncatedHistory,
        hydration: chain.hydration,
    });

    // Every real body carries an output cap, so a reference that recorded none came from a build that recorded
    // none of the decode scalars. Without this statement the absence would read as "no value difference" - the
    // pass-by-silence this module keeps having to design out.
    const reference = match.referenceObservation;
    if (reference !== null && maxTokensUnknown(reference, shape)) {
        unknowns.push(
            "decode values unknown: the credited reference was recorded before these fields existed",
        );
    }

    return {
        divergence,
        reference: match.reference,
        prefixUsable: hasReference && match.comparableDepth > 0 ? verifiedThrough : undefined,
        firstDivergence: divergences[0] ?? (verifiedThrough ? "verified" : "tail"),
        divergences,
        truncated: spanMessages < match.referenceDepth,
        parameters: match.parameters,
        ourMessageCount: messages.length,
        commonPrefixMessages: match.verifiedTo,
        referenceDepth: match.referenceDepth,
        comparableDepth: match.comparableDepth,
        verifiedThrough,
        referenceLeafId: match.referenceLeafId,
        referenceSource: match.referenceSource,
        otherDisagreements: match.disagreeingReferences,
        firstMismatchDepth: match.firstMismatchDepth,
        currentLeafId: sessionManager.getLeafId(),
        observations: match.compared,
        chainObservations: chain.size,
        branchObservations: onBranch.length,
        rejectSystemHash: rejects.system,
        rejectToolsHash: rejects.tools,
        parentRequest: parentRequestFields(parent),
        historyTruncated: match.truncatedHistory,
        modelDivergence: match.modelDivergence,
        ourRequest: fingerprintSummary(ours),
        unknowns,
    };
}

/**
 * Label the shape differences, which a head cannot localize on its own.
 *
 * `compared === 0` with observations present means nothing on this branch was built with this system prompt
 * and tool set - which is a real reason the cache cannot answer, and worth naming as one.
 */
function shapeDivergences(
    newest: ChainObservation | undefined,
    shape: ChainShape,
    match: { reference: "chain" | "none"; compared: number },
): string[] {
    if (match.reference !== "chain" || match.compared > 0 || newest === undefined) {
        return [];
    }

    const out: string[] = [];
    if (newest.systemHash !== shape.systemHash) {
        out.push(`system(${String(newest.systemChars)} -> ${String(shape.systemChars)} chars)`);
    }
    if (newest.toolsHash !== shape.toolsHash) {
        out.push("tools");
    }

    return out;
}

/**
 * Count the on-branch requests each half of the shape filter rejected.
 *
 * `compareObservation` knows which predicate fired but reports only a comparison, so a run with nothing
 * comparable could say no more than "neither our system prompt nor our tool set" - a conjunction that read as a
 * tool-set difference on a run whose tool set was identical. Re-counting here costs two comparisons per row; the
 * alternative was widening `ChainMatch` with a diagnostic the match itself never uses. The count is per gate and
 * deliberately not exclusive: an entry differing in both is counted twice.
 */
function shapeRejections(observations: readonly ChainObservation[], shape: ChainShape) {
    let system = 0;
    let tools = 0;

    for (const observation of observations) {
        if (observation.systemHash !== shape.systemHash) {
            system += 1;
        }
        if (observation.toolsHash !== shape.toolsHash) {
            tools += 1;
        }
    }

    return { system, tools };
}

/** The parent side of the shape comparison, present whenever anything on this branch was observed. */
function parentRequestFields(observation: ChainObservation | undefined) {
    if (observation === undefined) {
        return undefined;
    }

    return {
        model: observation.model,
        systemChars: observation.systemChars,
        systemHash: observation.systemHash,
        toolsHash: observation.toolsHash,
        messageCount: observation.depth,
        leafId: observation.leafId,
        // Values, so the mirror can be compared against `ourRequest` at the level `keys` cannot reach.
        maxTokens: observation.maxTokens,
        enableThinking: observation.enableThinking,
        reasoningEffort: observation.reasoningEffort,
        imageBlocks: observation.imageBlocks,
    };
}

/**
 * Whether the credited reference cannot answer the decode comparison.
 *
 * Our side always fingerprints a live body, so only the reference can be the one that never recorded a value.
 */
function maxTokensUnknown(reference: ChainObservation, shape: ChainShape): boolean {
    return reference.maxTokens === null && shape.maxTokens !== null;
}

/**
 * Decode and image-count differences against the credited reference, where both sides recorded a value.
 *
 * These are the divergences a key set cannot see: both bodies may carry `enable_thinking`, and only their
 * values know that one said `true` while the other said `false`. `max_completion_tokens` is left out on
 * purpose - stage 1 caps its output by design, so it differs on every run, and a flag that fires on every
 * run is noise with a suspect name. Its values are still recorded on both sides for anyone who wants them.
 */
function decodeDivergences(reference: ChainObservation | null, shape: ChainShape): string[] {
    if (reference === null) {
        return [];
    }

    const out: string[] = [];

    if (reference.enableThinking !== null && shape.enableThinking !== null) {
        if (reference.enableThinking !== shape.enableThinking) {
            out.push(
                `enable_thinking:${String(reference.enableThinking)}!=${String(shape.enableThinking)}`,
            );
        }
    }

    if (reference.reasoningEffort !== null && shape.reasoningEffort !== null) {
        if (reference.reasoningEffort !== shape.reasoningEffort) {
            out.push(`reasoning_effort:${reference.reasoningEffort}!=${shape.reasoningEffort}`);
        }
    }

    if (reference.imageBlocks !== null && shape.imageBlocks !== null) {
        if (reference.imageBlocks !== shape.imageBlocks) {
            out.push(`imageBlocks:${String(reference.imageBlocks)}!=${String(shape.imageBlocks)}`);
        }
    }

    return out;
}

/**
 * Name what a prefix verdict cannot answer.
 *
 * `observations: 0` covers three states that have nothing to do with each other - nothing held, held but off the
 * current branch, and on the branch yet incomparable - and a reader who cannot tell them apart will debug the
 * wrong one. That ambiguity cost a full investigation on 2026-09-05, so each state now gets its own sentence.
 */
function prefixUnknowns(input: {
    held: number;
    onBranch: number;
    compared: number;
    rejects: { system: number; tools: number };
    retentionDropped: boolean;
    hydration: { scanComplete: boolean; loadFailed: boolean; malformed: number };
}): string[] {
    const unknowns: string[] = [];

    if (input.hydration.loadFailed) {
        unknowns.push(
            "chain read failed in this process: an empty chain here is evidence of nothing",
        );
    }

    if (input.held === 0) {
        // About the session, not the process: the rows are persisted now, so an empty chain no longer means
        // "this process is young". It means nothing readable survived in the file.
        unknowns.push("chain empty: no row for this session was found in the retained trace file");
    } else if (input.onBranch === 0) {
        unknowns.push(
            `chain holds ${String(input.held)} but none on this branch: prefix reuse unverifiable here`,
        );
    } else if (input.compared === 0) {
        // Both counts print, zeros included: one number per gate, so a run where only the prompt moved cannot be
        // read as a tool-set change. `observations === 0` already means no entry passed both gates, so a pair of
        // zeros here is a contradiction, and the report's invariants name it as one.
        unknowns.push(
            `${String(input.onBranch)} on-branch requests are not comparable to ours: ${String(input.rejects.system)} differ in the system prompt, ${String(input.rejects.tools)} in the tool set: prefix reuse unverifiable`,
        );
    }

    if (input.compared === 0) {
        unknowns.push("cache reuse: this run cannot tell a miss from an unverifiable prefix");
    }

    if (input.retentionDropped) {
        unknowns.push("retention dropped older ladders: shallow depths may be unverifiable");
    }

    if (!input.hydration.scanComplete) {
        unknowns.push(
            `chain scan stopped at ${String(input.held)} rows once a ladder and enough requests were in hand` +
                ": older rows for this session may still be on disk, so the counts above are a floor",
        );
    }

    if (input.hydration.malformed > 0) {
        unknowns.push(
            `${String(input.hydration.malformed)} persisted chain rows were unreadable and were dropped`,
        );
    }

    return unknowns;
}

/** The request-side numbers every attempt record carries, whatever stage ran. */
function attemptFields(
    model: Model<Api>,
    maxTokens: number,
    extra: Partial<CompactionAttemptFields>,
): CompactionAttemptFields {
    return {
        provider: model.provider,
        model: model.id,
        maxTokens,
        contextWindow: model.contextWindow,
        ...extra,
    };
}

/** Entries the span covers, resolved by pi rather than by slicing converted messages by hand. */
function spanMessages(input: StageContext): {
    messages: Message[];
    entries: SessionEntry[];
    /**
     * The branch in pi's own file order, which is what the head ledger walks: the window above is a slice of it,
     * and a head is solved from fold rows and counted replies that sit outside the slice.
     */
    branch: SessionEntry[];
    /** The entry at the chosen boundary, whose own request measured exactly this span. */
    keptEntry: SessionEntry | undefined;
    /** Newest fold or shape change: counts from at or before it describe a body that no longer exists. */
    boundary: number;
    fields: Partial<CompactionAttemptFields>;
} {
    const { ctx, cut, preparation } = input;
    const branch = ctx.sessionManager.getBranch();
    const resolved = ctx.sessionManager.buildContextEntries();
    const contextEntry = resolved.some((entry) => entry.id === cut.firstKeptEntryId);
    // Cutting in the raw branch or in pi's resolved view is not a free choice: the boundary is only already
    // counted by a provider if it survives into the resolved context, which is what stage 1's request is built
    // from. A compaction between them would put a summary message where the count was taken.
    const entries = contextEntry ? resolved : branch;
    // The window, not the resolved list: see `stageOneSpanEntries`. `entries` stays the source of `keptEntry`,
    // because a count is only exact if the boundary survived into the resolved view, and the window's order says
    // nothing about that.
    const span = stageOneSpanEntries(branch, cut.firstKeptEntryId);
    const built = buildSpanSession(span.entries, ctx.cwd);
    const messages = convertToLlm(built.sessionManager.buildSessionContext().messages);

    return {
        messages,
        entries: span.entries,
        branch,
        keptEntry: entries.find((entry) => entry.id === cut.firstKeptEntryId),
        boundary: countBoundary(branch),
        fields: {
            copiedEntries: built.copiedEntries,
            skippedEntries: skippedEntryCount(built.skippedEntries),
            cutFound: span.cutFound,
            // Where the span ends, which is core's id unless the repair found that boundary unsendable.
            chosenFirstKeptEntryId: cut.firstKeptEntryId,
            proposedFirstKeptEntryId: preparation.firstKeptEntryId,
            // The walk's own decision, and not merely its outcome: which condition refused core's boundary, how
            // far back the repair went, what it left as retained history, and which instrument answered. Two ids
            // cannot separate "core's cut was unmeasurable" from "core's cut kept too little", and a run that
            // could not be repaired could not say what stopped it - which is how a moved cut spent a session
            // being explained by hand from the session file.
            cutMovedRows: cut.movedRows,
            cutProposedRejection: cut.proposedRejection ?? undefined,
            cutRejections: Object.keys(cut.rejections).length > 0 ? cut.rejections : undefined,
            cutTailTokens: cut.tailTokens ?? undefined,
            cutKeepRecentTokens: preparation.settings.keepRecentTokens,
            cutSpanTokens: cut.spanTokens ?? undefined,
            cutSpanBasis: cut.spanBasis ?? undefined,
            cutLiveTokensSource: cut.liveTokensSource,
        },
    };
}

/** Stage 1: the model reads the span it is about to lose, as real messages, with its tools left attached. */
async function runSegmentStage(input: StageContext, model: Model<Api>): Promise<StageResult> {
    const { pi, ctx, preparation, signal, trace, cut } = input;
    const span = spanMessages(input);
    const tools = activeToolDefinitions(pi);
    const instruction = input.instruction;
    const context = buildNativeContext({
        systemPrompt: ctx.getSystemPrompt(),
        tools,
        messages: span.messages,
        instruction,
        timestamp: Date.now(),
    });
    const reportedContextTokens = ctx.getContextUsage()?.tokens ?? null;
    const extraTokens = estimateTextTokens(instruction);
    // A row stage 1 could not copy makes our span narrower than the stored rows imply, so every number built
    // from those rows over-sizes the request - the kept reply's own count and a head solved from it alike, since
    // a head anchored on that reply reproduces exactly the count the first tier is disqualified from using. One
    // guard for both, refused for one reason, and `skippedEntries` records it.
    const copiedCleanly = span.fields.skippedEntries === 0;
    // The head ledger sizes this same body from the branch and the window stage 1 actually copies. It is recorded
    // whether or not it wins the tier, because the only way to learn how accurate it is live is to compare it with
    // the provider's count of the request that went out - and on a run where another tier answered, that count is
    // the only ground truth there is.
    const ledger = copiedCleanly
        ? spanBodyTokens(span.branch, {
              windowStartId: previousFoldWindowStart(span.branch),
              cutId: cut.firstKeptEntryId,
              extraTokens,
              boundary: span.boundary,
          })
        : null;
    // The exact-cut tier is only exact if our span really was that reply's body, so an entry stage 1 could not
    // copy rules it out - which `skippedEntries` already records as the reason.
    const counted = countSpanTokens({
        spanEntries: span.entries,
        keptEntry: copiedCleanly ? span.keptEntry : undefined,
        boundary: span.boundary,
        extraTokens,
        ledger,
    });
    // Only an exactly-counted span is worth persisting: it is the one tier where the number is a provider's count
    // rather than a ratio. The instruction estimate `countSpanTokens` folds in comes back out, since no provider
    // ever counted it, leaving the boundary reply's own prompt count - the whole request, fixed prefix included.
    const countedSpan =
        counted.source === "exact-cut"
            ? {
                  countedBodyTokens: counted.tokens - estimateTextTokens(input.instruction),
                  // The same two numbers the request is charged with, measured against the prompt and tools
                  // actually on this wire rather than a caller's recomputation of them.
                  fixedPrefixTokens:
                      estimateTextTokens(ctx.getSystemPrompt()) +
                      estimateTextTokens(JSON.stringify(tools) ?? ""),
              }
            : {};
    // This stage's own request, not the walk's proposal: when the session carries a count of this body, an
    // estimate of it is the wrong input for a cap.
    const requestTokens = fitRequirementTokens({
        countedRequestTokens: counted.tokens,
        reportedContextTokens,
        context,
    });
    const maxTokens = Math.max(
        MIN_OUTPUT_TOKENS,
        summarizationBudgetTokens({
            modelMaxTokens: model.maxTokens,
            contextWindow: model.contextWindow,
            requestTokens,
        }),
    );
    const fields = attemptFields(model, maxTokens, {
        ...span.fields,
        estimatedTokens: counted.tokens ?? estimateRequestTokens(context),
        estimateSource: counted.tokens === null ? "chars4" : counted.source,
        staleAnchors: counted.staleAnchors > 0 ? counted.staleAnchors : undefined,
        foldCorrected: counted.foldCorrected > 0 ? counted.foldCorrected : undefined,
        reportedContextTokens: reportedContextTokens ?? undefined,
        ledger: ledgerFields(ledger),
        toolCount: tools.length,
        messageCount: span.messages.length,
        customInstructions: input.customInstructions,
        previousSummaryChars: preparation.previousSummary?.length ?? 0,
    });

    if (
        !nativeRequestFits(
            context,
            model.contextWindow,
            maxTokens,
            reportedContextTokens,
            counted.tokens,
        )
    ) {
        const detail =
            cut.movedEarlier === false
                ? "segment context plus instruction does not fit the window"
                : "no earlier boundary fits either; segment context plus instruction does not fit";
        trace.attempt("native", fields, { outcome: "skipped", detail, retries: 0 });
        return { ...countedSpan, ok: false, detail, retries: 0 };
    }

    const attempt = await summarizeNatively(
        {
            registry: ctx.modelRegistry,
            model,
            maxTokens,
            retry: retryPolicy(input.config),
            signal,
            sessionId: ctx.sessionManager.getSessionId(),
            thinkingLevel: sessionThinkingLevel(pi),
            onPayload: trace.enabled
                ? (payload) => {
                      trace.prefix(prefixVerdict(ctx.sessionManager, payload, ctx.cwd));
                  }
                : undefined,
        },
        context,
    );

    if (!attempt.ok) {
        const detail = attempt.detail ?? "unusable segment checkpoint";
        trace.attempt("native", fields, {
            outcome: "rejected",
            detail,
            usage: attempt.usage,
            stopReason: attempt.stopReason,
            cause: attempt.cause,
            retries: attempt.retries,
        });
        return {
            ...countedSpan,
            ok: false,
            detail,
            cause: attempt.cause,
            retries: attempt.retries,
        };
    }

    trace.attempt("native", fields, {
        outcome: "accepted",
        usage: attempt.usage,
        stopReason: attempt.stopReason,
        retries: attempt.retries,
    });
    trace.modelResponse("native", attempt.text, attempt.usage);
    return {
        ...countedSpan,
        ok: true,
        text: attempt.text,
        usage: attempt.usage,
        retries: attempt.retries,
    };
}

/**
 * The stage-2 request numbers, built whether or not the request goes out.
 *
 * A rung the cause policy stopped still deserves a record: without one, a report cannot tell "we never had the
 * transcript to send" from "we had it and chose not to ask".
 */
function reduceFields(
    model: Model<Api>,
    maxTokens: number,
    transcript: SerializedConversation,
    segmentText: string | undefined,
    extra: Partial<CompactionAttemptFields>,
): CompactionAttemptFields {
    return attemptFields(model, maxTokens, {
        // Stage 2 sends no tools at all: nothing to call, no prefix to protect.
        toolCount: 0,
        messageCount: 1,
        serializedChars: transcript.text.length,
        droppedBlocks: transcript.droppedBlocks,
        segmentSummaryChars: segmentText?.length ?? 0,
        ...extra,
    });
}

/**
 * The whole live context, sized by whichever instrument can vouch for it.
 *
 * The ledger first: it puts `tail = live - span` on one basis, head and rows arithmetic on both sides, and it
 * answers where pi's own hybrid returns null - which is right after a fold, the window the walk used to abstain
 * in unconditionally. `getContextUsage()` is the fallback rather than the rival: it is a provider count through
 * the last reply plus chars/4 for everything after it, so a tail taken against it mixes two instruments, and
 * `liveTokensSource` exists to keep that visible in the record.
 */
function liveContextSize(
    sizer: ReturnType<typeof spanSizer>,
    ctx: ExtensionContext,
): { tokens: number | null; source: "ledger" | "context-usage" | undefined } {
    const sized = sizer?.live() ?? null;
    if (sized !== null) {
        return { tokens: sized.tokens, source: "ledger" };
    }

    const reported = ctx.getContextUsage()?.tokens ?? null;
    if (reported !== null) {
        return { tokens: reported, source: "context-usage" };
    }

    return { tokens: null, source: undefined };
}

/** Stage 2: one bounded text-only call that reconciles the transcript with stage 1's checkpoint. */
async function runReduceStage(
    input: StageContext,
    model: Model<Api>,
    transcript: SerializedConversation,
    segment: StageResult | undefined,
): Promise<StageResult> {
    const { ctx, preparation, signal, trace } = input;
    const segmentText = segment?.ok ? segment.text : undefined;
    const { requestText, maxTokens } = stageTwoRequest({
        model,
        transcript,
        segmentText,
        previousSummary: preparation.previousSummary,
        customInstructions: input.customInstructions,
    });
    const fields = reduceFields(model, maxTokens, transcript, segmentText, {
        estimatedTokens: estimateTextTokens(requestText),
        // Stage 2's number is always chars/4 over text this module serialized itself, and it has to say so:
        // leaving it unset makes a new record read as "predates the field", which is the one state the report
        // exists to keep apart from a real method. No count can ever apply here - the blob is not a prefix of
        // anything a provider saw.
        estimateSource: "chars4",
        customInstructions: input.customInstructions,
        previousSummaryChars: preparation.previousSummary?.length ?? 0,
    });

    const attempt = await summarizeSerializedTranscript(
        { registry: ctx.modelRegistry, model, maxTokens, retry: retryPolicy(input.config), signal },
        { conversationText: transcript.text, requestText },
    );

    if (!attempt.ok) {
        const detail = attempt.detail ?? "unusable checkpoint";
        trace.attempt("serialized", fields, {
            outcome: "rejected",
            detail,
            usage: attempt.usage,
            stopReason: attempt.stopReason,
            cause: attempt.cause,
            retries: attempt.retries,
        });
        return { ok: false, detail, cause: attempt.cause, retries: attempt.retries };
    }
    trace.attempt("serialized", fields, {
        outcome: "accepted",
        usage: attempt.usage,
        stopReason: attempt.stopReason,
        retries: attempt.retries,
    });
    trace.modelResponse("serialized", attempt.text, attempt.usage);
    return {
        ok: true,
        text: attempt.text,
        usage: attempt.usage ?? (segment?.ok ? segment.usage : undefined),
        retries: attempt.retries,
    };
}

function composeResult(
    preparation: CompactionPreparation,
    text: string,
    usage: Usage | undefined,
    details: Omit<PiCoderCompactionDetails, "readFiles" | "modifiedFiles" | "summarizedMessages">,
    cut: CutDecision,
    tokensBefore: number,
): CompactionResult {
    const analysis = analyzeSpan(summarizedSpan(preparation));
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const sections = buildSupplementarySections({
        analysis,
        firstKeptEntryId: cut.firstKeptEntryId,
        droppedBlocks: details.droppedBlocks,
    });
    const summary = `${[text, sections].filter(Boolean).join("\n\n")}${formatFileLists(readFiles, modifiedFiles)}`;

    return {
        summary,
        // The boundary we chose, not the one proposed: core rebuilds the retained context from this id, so a
        // repaired span and a persisted tail that disagree is the failure mode this whole path exists to avoid.
        firstKeptEntryId: cut.firstKeptEntryId,
        // Core's whole-live-context estimate, unchanged: it sizes the context, not the cut, so repairing the
        // boundary leaves it valid. `tokensBefore` is misnamed in pi and trusting its name here would be the bug.
        tokensBefore,
        usage,
        details: {
            ...details,
            readFiles,
            modifiedFiles,
            summarizedMessages: analysis.messageCount,
        },
    };
}

function routeFor(
    segment: StageResult | undefined,
    reduced: StageResult | undefined,
): CompactionRoute {
    const segmentOk = segment?.ok === true;
    if (reduced?.ok) {
        return segmentOk ? "two-stage" : "serialized";
    }
    return segmentOk ? "native" : "serialized";
}

/**
 * A failure whose cause says no further request would work: the account, the credentials, or the rate limit is
 * the problem, not the bytes we sent.
 *
 * An absent cause is not terminal. A request the fit gate skipped never reached a provider, so it learned
 * nothing about whether the next rung would fare better.
 */
function terminalCause(result: StageResult | undefined): SummarizationFailureCause | undefined {
    if (!result || result.ok || !result.cause) {
        return undefined;
    }

    return isTerminalCause(result.cause) ? result.cause : undefined;
}

async function compactWithPiCoder(
    pi: ExtensionAPI,
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
): Promise<{ cancel: true } | { compaction: CompactionResult } | undefined> {
    const config = loadCompactionConfig(ctx.cwd);
    const trace = createCompactionTraceRecorder(
        {
            cwd: ctx.cwd,
            session: ctx.sessionManager.getSessionId(),
            reason: event.reason,
            willRetry: event.willRetry,
        },
        compactionTraceTarget(config),
    );
    if (!config.enabled) {
        trace.outcome("disabled");
        return undefined;
    }
    if (event.signal.aborted) {
        // The user cancelled this compaction. Say so, rather than letting core run a doomed request
        // against an already-aborted controller.
        trace.outcome("cancelled");
        return { cancel: true };
    }
    const model = ctx.model;
    if (!model) {
        trace.outcome("core-default", "no model selected");
        return undefined;
    }

    const preparation = event.preparation;
    const instruction = segmentSummaryInstruction({
        preparation,
        customInstructions: event.customInstructions,
    });
    // Core's proposed span, which the walk can only shorten: the conservative side of the two-stage split, and a
    // reserve needs an order of magnitude rather than a count.
    const proposedSpan = summarizedSpan(preparation);
    const instructionTokens = estimateTextTokens(instruction);
    // Charged the way the gate charges it: fixed prefix, span, instruction.
    const proposedRequest =
        estimateRequestTokens({ messages: proposedSpan } as Context) +
        estimateTextTokens(ctx.getSystemPrompt()) +
        estimateTextTokens(JSON.stringify(activeToolDefinitions(pi)) ?? "");
    const proposedBudget = summarizationBudgetTokens({
        modelMaxTokens: model.maxTokens,
        contextWindow: model.contextWindow,
        requestTokens: proposedRequest,
    });
    // Floored here rather than in the budget, so a degenerate window is a clean skip and not a zero-token ask.
    const cutOutputReserveTokens = Math.max(MIN_OUTPUT_TOKENS, proposedBudget);
    // Where to cut, decided before the transcript is built: the repair moves the boundary earlier when core's
    // choice would make a request the window cannot take, and the two budgets it weighs are stage 1's output and
    // the instruction it appends, both of which exist at this point.
    const branch = ctx.sessionManager.getBranch();
    const boundary = countBoundary(branch);
    // One walk, every candidate: the cut walk asks for a size at each boundary it considers, and a per-position
    // `spanBodyTokens` call would rescan the window each time. The sizing tier below still uses
    // `spanBodyTokens`, because that route carries the instruction inside its body and its refusals are pinned
    // against provider counts; `ledger.test.ts` proves the two agree position by position.
    const sizer = spanSizer(branch, {
        windowStartId: previousFoldWindowStart(branch),
        boundary,
    });
    const live = liveContextSize(sizer, ctx);
    const cut = chooseSpanCut({
        branch,
        proposedFirstKeptEntryId: preparation.firstKeptEntryId,
        boundary,
        liveTokens: live.tokens,
        liveTokensSource: live.source,
        keepRecentTokens: preparation.settings.keepRecentTokens,
        contextWindow: model.contextWindow,
        outputBudgetTokens: cutOutputReserveTokens,
        instructionTokens,
        sizer,
    });
    // Stage 2's material stays core's span; the walk only narrows what stage 1 re-reads. The one-way dependency
    // this implies is the walk's: it has to weigh a reserve before any stage exists, so the number it weighs comes
    // from the *proposed* span, which the walk only ever shrinks - the conservative direction. Neither stage sends
    // it: stage 1 recomputes its own cap from the counted request, and the reduce from the transcript it was given.
    const span = summarizedSpan(preparation);
    const transcript = serializeConversationMinimal(span, serializerOptions(config));
    const stage: StageContext = {
        pi,
        ctx,
        preparation,
        customInstructions: event.customInstructions,
        config,
        cutOutputReserveTokens,
        signal: event.signal,
        trace,
        instruction,
        cut,
        tokensBefore: preparation.tokensBefore,
    };

    const failures: string[] = [];
    // An overflow-triggered compaction used to skip stage 1 outright, on the reasoning that the live context
    // provably does not fit. That is true of the live context and false of a shorter prefix of it, which is what
    // the cut walk exists to find - so the attempt is made, and the fit gate inside it is the thing that decides.
    const segment = await runSegmentStage(stage, model).then((result) => {
        if (!result.ok) {
            failures.push(`segment: ${result.detail}`);
        }

        return result;
    });

    if (event.signal.aborted) {
        // Stage 1 died on a controller that is already dead, so a second request would only burn another one.
        // Reported as a cancellation rather than a fallback: nothing was handed over, and the session keeps
        // its history intact.
        failures.push("reduce: skipped (aborted)");
        trace.outcome("cancelled", failures.join("; "));
        return { cancel: true };
    }

    // A cause that names the account rather than the request ends the cascade here: stage 2 would send the same
    // credentials to the same rate limit, and core's default path would send them a third time. The session is
    // left exactly as it was, and a threshold-triggered compaction is naturally re-attempted next turn.
    const stopped = terminalCause(segment);
    if (stopped) {
        // An aborted reply is the user stopping, which stays silent like every other cancellation; only a
        // provider-imposed stop gets a warning, because that is the one the session will not otherwise learn
        // about.
        const aborted = stopped === "aborted";
        failures.push(`segment: ${stopped}`);
        // The numbers the reduce would have sent, had the cascade reached it: its own body, never stage 1's reserve.
        const unattempted = stageTwoRequest({
            model,
            transcript,
            previousSummary: preparation.previousSummary,
            customInstructions: event.customInstructions,
        });
        trace.attempt(
            "serialized",
            reduceFields(model, unattempted.maxTokens, transcript, undefined, {
                customInstructions: event.customInstructions,
                previousSummaryChars: preparation.previousSummary?.length ?? 0,
            }),
            {
                outcome: "skipped",
                detail: `not attempted: ${stopped} (${causeRationale(stopped)})`,
                cause: stopped,
                retries: 0,
            },
        );
        trace.outcome(aborted ? "cancelled" : "abandoned", failures.join("; "));
        if (!aborted) {
            notify(
                ctx,
                `pi-coder compaction stopped: ${stopped} - ${causeRationale(stopped)}`,
                "warning",
            );
        }
        return { cancel: true };
    }

    const reduced = await runReduceStage(stage, model, transcript, segment).then((result) => {
        if (!result.ok) {
            failures.push(`reduce: ${result.detail}`);
        }
        return result;
    });

    const route = routeFor(segment, reduced);
    const produced = reduced?.ok ? reduced : segment?.ok ? segment : undefined;

    if (!produced) {
        // An abort that arrived after both stages had already failed is still a cancellation, not a fallback.
        // Returning undefined here would let pi issue its own summarization call on the dead controller, and
        // the warning would claim the session was handed over when the user simply stopped it.
        if (event.signal.aborted) {
            trace.outcome("cancelled", failures.join("; "));
            return { cancel: true };
        }

        // Nothing usable came back and the cause says core's own request would fail the same way, so the
        // handover is skipped too. This is the one place pi-coder declines compaction outright, which is why it
        // warns rather than staying quiet like the cancellation above.
        const givenUp = terminalCause(reduced);
        if (givenUp) {
            trace.outcome("abandoned", `${failures.join("; ")} (${givenUp})`);
            notify(
                ctx,
                `pi-coder compaction stopped: ${givenUp} - ${causeRationale(givenUp)}`,
                "warning",
            );
            return { cancel: true };
        }

        trace.outcome("core-default", failures.join("; "));
        notify(
            ctx,
            `pi-coder compaction fell back to pi's default: ${failures.join("; ")}`,
            "warning",
        );
        return undefined;
    }

    const result = composeResult(
        preparation,
        produced.text,
        produced.usage,
        {
            version: 1,
            route,
            provider: model.provider,
            model: model.id,
            droppedBlocks: transcript.droppedBlocks,
            // Absent, not zero, when the span was never exactly counted: a later fold must be able to tell "no
            // number" from "a number that happened to be zero".
            countedBodyTokens: segment.countedBodyTokens,
            fixedPrefixTokens: segment.fixedPrefixTokens,
        },
        cut,
        stage.tokensBefore,
    );
    const details = result.details as PiCoderCompactionDetails;
    trace.final(reduced?.ok ? "serialized" : "native", result.summary, {
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        summarizedMessages: details.summarizedMessages,
        droppedBlocks: details.droppedBlocks,
        readFiles: details.readFiles.length,
        modifiedFiles: details.modifiedFiles.length,
    });
    trace.outcome(outcomeFor(route));
    if (route === "native" && reduced && !reduced.ok) {
        notify(
            ctx,
            "pi-coder compaction: reduce stage failed, persisted the segment checkpoint",
            "warning",
        );
    }
    if (route === "serialized" && transcript.droppedBlocks > 0) {
        notify(
            ctx,
            `pi-coder compaction: minimized transcript used, ${String(transcript.droppedBlocks)} older blocks dropped`,
        );
    }
    return { compaction: result };
}

function outcomeFor(route: CompactionRoute): CompactionTraceOutcome {
    if (route === "two-stage") {
        return "two-stage";
    }
    return route;
}

/** Registered for the parent session and for every delegated child. */
export function registerCompactionExtension(pi: ExtensionAPI): void {
    // Registered when either consumer wants observations. The launch cwd stands in for per-project config
    // here because registration happens once per load: a child in another worktree whose own config enables
    // chain persistence while bodies are off would go unobserved. `recordChainRequest` still self-gates per
    // cwd, so the reachable mistake is a missing observation, never a wrong one.
    if (isAgentTraceEnabled() || chainTargetFor(process.cwd()).enabled) {
        // Record the hash ladder of the body pi built, so a later stage-1 request can tell a rebuilt-prefix
        // mismatch from a provider that simply will not serve the cache. The ladder is also persisted, which is
        // why this stays registered when body tracing is off.
        pi.on("before_provider_request", (event, ctx) => {
            observeParentRequest(ctx.sessionManager, ctx.cwd, event.payload);
        });
    }

    pi.on("session_before_compact", async (event, ctx) => {
        try {
            return await compactWithPiCoder(pi, event, ctx);
        } catch (error) {
            // Never let a defect here abort the compaction pi is already committed to running.
            const message = error instanceof Error ? error.message : String(error);
            notify(ctx, `pi-coder compaction failed; using pi's default: ${message}`, "warning");
            return undefined;
        }
    });
}
