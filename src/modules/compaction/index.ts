import type { Api, Message, Model, Usage } from "@earendil-works/pi-ai";
import type {
    CompactionResult,
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
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
import {
    activeToolDefinitions,
    buildNativeContext,
    estimateRequestTokens,
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
    RequestChain,
    type ChainObservation,
    type ChainShape,
} from "./chain";
import { segmentSummaryInstruction, serializedSummarizationRequest } from "./prompt";
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
import { buildSpanSession, skippedEntryCount, spanContextEntries } from "./span-session";
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
    type CompactionTraceOutcome,
    type CompactionTraceRecorder,
} from "./trace";
import { summarizedSpan, type CompactionPreparation } from "./types";
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
 *    `tool_choice: "none"` rather than removed, since removing them would move the prefix.
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
    /** Output budget for the persisted checkpoint (stage 2). */
    maxTokens: number;
    /** Smaller budget for the intermediate: a stage-1 output the reduce has to re-summarize is wasted work. */
    segmentTokens: number;
    signal: AbortSignal;
    trace: CompactionTraceRecorder;
}

/**
 * What one rung produced. `cause` is absent when no reply was ever seen — a request the fit gate skipped has
 * no provider failure to name — and the cascade treats an absent cause as not terminal, since there is nothing
 * it learned that says the next rung would fail too.
 */
type StageResult =
    | { ok: true; text: string; usage?: Usage; retries: number }
    | {
          ok: false;
          detail: string;
          cause?: SummarizationFailureCause;
          retries: number;
      };

/**
 * Resend policy for one compaction: only a cause the provider's own wording calls transient earns a retry.
 *
 * `sleep` is left unset so the production backoff is the real, abort-aware one; tests inject their own.
 */
function retryPolicy(config: CompactionConfig): SummarizationRetryPolicy {
    return { maxRetries: config.retryMaxRetries, baseDelayMs: config.retryBaseDelayMs };
}

/** pi's own budget for a history summary: most of the reserved window, capped by the model's output limit. */
function summaryBudget(reserveTokens: number, modelMaxTokens: number): number {
    const fromReserve = Math.floor(reserveTokens * 0.8);
    if (!Number.isFinite(modelMaxTokens) || modelMaxTokens <= 0) {
        return fromReserve;
    }
    return Math.min(fromReserve, modelMaxTokens);
}

/**
 * The intermediate gets a third of the final budget.
 *
 * Measured before this existed: stage 1 wrote 3,207 tokens and the reduce then produced a longer document
 * than it was handed, because a generous intermediate is a competing summary. A third keeps it a summary of
 * facts rather than a rival draft, and floors at 512 so a tiny session still gets a usable pass.
 */
function segmentBudget(maxTokens: number): number {
    return Math.max(512, Math.floor(maxTokens / 3));
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
    const parent = onBranch[onBranch.length - 1];
    // Fold only the span. `buildNativeContext` appends exactly one instruction message, and pi never sent
    // that one, so leaving it in the ladder would guarantee a mismatch at our own last depth and re-raise the
    // tail artifact the chain exists to avoid.
    const spanMessages = Math.max(0, messages.length - 1);
    const match = chain.match({
        spanLadder: messageLadder(messages.slice(0, spanMessages)),
        pathIds,
        shape,
    });

    // Only depths the reference actually covered *and* our span reached are checkable; pi's deeper requests
    // say nothing about a truncated span.
    const verifiedThrough = match.comparableDepth > 0 && match.verifiedTo >= match.comparableDepth;
    const divergences = shapeDivergences(parent, shape, match);

    if (match.firstMismatchDepth !== null) {
        divergences.push(`messages[${String(match.firstMismatchDepth)}]`);
    }

    const hasReference = match.reference === "chain";
    if (!hasReference) {
        // Stated as a divergence so a reader cannot mistake an empty verdict for a passing one.
        divergences.push("no-reference");
    }

    return {
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
        currentLeafId: sessionManager.getLeafId(),
        observations: match.compared,
        chainObservations: chain.size,
        branchObservations: onBranch.length,
        parentRequest: parentRequestFields(parent),
        historyTruncated: match.truncatedHistory,
        modelDivergence: match.modelDivergence,
        ourRequest: fingerprintSummary(ours),
        unknowns: prefixUnknowns({
            held: chain.size,
            onBranch: onBranch.length,
            compared: match.compared,
            retentionDropped: match.truncatedHistory,
            hydration: chain.hydration,
        }),
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
    };
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
        unknowns.push(
            `${String(input.onBranch)} on-branch requests share neither our system prompt nor tool set: prefix reuse unverifiable`,
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
    fields: Partial<CompactionAttemptFields>;
} {
    const { ctx, preparation } = input;
    const truncated = spanContextEntries(
        ctx.sessionManager.buildContextEntries(),
        preparation.firstKeptEntryId,
    );
    const span = buildSpanSession(truncated, ctx.cwd);
    const messages = convertToLlm(span.sessionManager.buildSessionContext().messages);
    return {
        messages,
        fields: {
            copiedEntries: span.copiedEntries,
            skippedEntries: skippedEntryCount(span.skippedEntries),
        },
    };
}

/** Stage 1: the model reads the span it is about to lose, as real messages, with tools forbidden. */
async function runSegmentStage(input: StageContext, model: Model<Api>): Promise<StageResult> {
    const { pi, ctx, preparation, segmentTokens, signal, trace } = input;
    const span = spanMessages(input);
    const tools = activeToolDefinitions(pi);
    const context = buildNativeContext({
        systemPrompt: ctx.getSystemPrompt(),
        tools,
        messages: span.messages,
        instruction: segmentSummaryInstruction({
            preparation,
            customInstructions: input.customInstructions,
        }),
        timestamp: Date.now(),
    });
    const reportedContextTokens = ctx.getContextUsage()?.tokens ?? null;
    const fields = attemptFields(model, segmentTokens, {
        estimatedTokens: estimateRequestTokens(context),
        reportedContextTokens: reportedContextTokens ?? undefined,
        toolCount: tools.length,
        messageCount: span.messages.length,
        copiedEntries: span.fields.copiedEntries,
        skippedEntries: span.fields.skippedEntries,
        customInstructions: input.customInstructions,
        previousSummaryChars: preparation.previousSummary?.length ?? 0,
    });

    if (!nativeRequestFits(context, model.contextWindow, segmentTokens, reportedContextTokens)) {
        const detail = "segment context plus instruction does not fit the window";
        trace.attempt("native", fields, { outcome: "skipped", detail, retries: 0 });
        return { ok: false, detail, retries: 0 };
    }

    const attempt = await summarizeNatively(
        {
            registry: ctx.modelRegistry,
            model,
            maxTokens: segmentTokens,
            retry: retryPolicy(input.config),
            signal,
            sessionId: ctx.sessionManager.getSessionId(),
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
        return { ok: false, detail, cause: attempt.cause, retries: attempt.retries };
    }

    trace.attempt("native", fields, {
        outcome: "accepted",
        usage: attempt.usage,
        stopReason: attempt.stopReason,
        retries: attempt.retries,
    });
    trace.modelResponse("native", attempt.text, attempt.usage);
    return { ok: true, text: attempt.text, usage: attempt.usage, retries: attempt.retries };
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

/** Stage 2: one bounded text-only call that reconciles the transcript with stage 1's checkpoint. */
async function runReduceStage(
    input: StageContext,
    model: Model<Api>,
    transcript: SerializedConversation,
    segment: StageResult | undefined,
): Promise<StageResult> {
    const { ctx, preparation, maxTokens, signal, trace } = input;
    const segmentText = segment?.ok ? segment.text : undefined;
    const requestText = serializedSummarizationRequest({
        conversationText: transcript.text,
        segmentSummary: segmentText,
        previousSummary: preparation.previousSummary,
        customInstructions: input.customInstructions,
    });
    const fields = reduceFields(model, maxTokens, transcript, segmentText, {
        estimatedTokens: estimateTextTokens(requestText),
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
): CompactionResult {
    const analysis = analyzeSpan(summarizedSpan(preparation));
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const sections = buildSupplementarySections({
        analysis,
        firstKeptEntryId: preparation.firstKeptEntryId,
        droppedBlocks: details.droppedBlocks,
    });
    const summary = `${[text, sections].filter(Boolean).join("\n\n")}${formatFileLists(readFiles, modifiedFiles)}`;
    return {
        summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
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
    const maxTokens = summaryBudget(preparation.settings.reserveTokens, model.maxTokens);
    const span = summarizedSpan(preparation);
    const transcript = serializeConversationMinimal(span, serializerOptions(config));
    const stage: StageContext = {
        pi,
        ctx,
        preparation,
        customInstructions: event.customInstructions,
        config,
        maxTokens,
        segmentTokens: segmentBudget(maxTokens),
        signal: event.signal,
        trace,
    };

    const failures: string[] = [];
    const segment =
        event.reason === "overflow"
            ? undefined
            : await runSegmentStage(stage, model).then((result) => {
                  if (!result.ok) {
                      failures.push(`segment: ${result.detail}`);
                  }
                  return result;
              });
    if (event.reason === "overflow") {
        failures.push("segment: skipped (context overflow)");
    }

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
        trace.attempt(
            "serialized",
            reduceFields(model, maxTokens, transcript, undefined, {
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

    const result = composeResult(preparation, produced.text, produced.usage, {
        version: 1,
        route,
        provider: model.provider,
        model: model.id,
        droppedBlocks: transcript.droppedBlocks,
    });
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
