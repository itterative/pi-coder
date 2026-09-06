import path from "node:path";

import type { StopReason, Usage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";

import type { MessageSample } from "./chain";
import { COMPACTION_TRACE_PATH } from "../../common/constants";
import { createJsonlRecordLog, type RecordLog } from "../../common/record-log";
import { isAgentTraceEnabled, PROCESS_INSTANCE } from "../../common/trace";
import type { CutRejection, MeasureBasis } from "./cut";
import type { CompactionConfig } from "./config";
import type { SummarizationFailureCause } from "./failure";
import type { MeasuredBody } from "./ledger";
import type { SummarizationStrategy } from "./summarize";
import type { EstimateSource, SummarizationReason } from "./types";

/**
 * The compaction trace: one JSONL record per stage, under the extension's gitignored `.state/`.
 *
 * Two questions can only be answered by what actually went over the wire, and neither is answerable from
 * the session transcript: what the model *said* to the summarization request, and what the harness then
 * composed into the `CompactionEntry`. Those are the `model_response` and `final_summary` stages, sharing one
 * `id` per compaction so they read side by side. The `attempt` stage carries the numbers that decided the
 * strategy — the estimated live-context size against the window and output budget, tool and message counts,
 * and for the serialized route the transcript and dropped-block counts — and `usage` on an accepted attempt
 * reports `cacheRead`, which is the only way to tell whether re-sending the live context actually reused
 * the provider's cached prefix.
 *
 * Gated by `isAgentTraceEnabled()`, the same development switch the delegated-agent timelines use, and
 * separately disableable with `COMPACTION_TRACE=0` or relocatable with `COMPACTION_TRACE_PATH`. Writing never
 * throws: a trace that cannot be written must not change what compaction does. The records contain raw
 * summary text, so treat this file with the same care as a session transcript.
 */

const RECORD_VERSION = 1;
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export type CompactionTraceStage =
    "attempt" | "prefix" | "model_response" | "final_summary" | "outcome";

/** How one strategy attempt ended. */
export type CompactionAttemptOutcome = "accepted" | "rejected" | "skipped";

/** How the compaction as a whole ended. */
export type CompactionTraceOutcome =
    | "two-stage"
    | "native"
    | "serialized"
    | "core-default"
    | "cancelled"
    /**
     * Stopped on purpose: the failure named a cause that no further request can fix (quota, rejected
     * credentials, rate limit), so the cascade and core's default path were both skipped. Distinct from
     * `cancelled`, which is the user pressing the key.
     */
    | "abandoned"
    | "disabled";

export interface CompactionTraceUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
}

/**
 * What the head ledger made of this same request, recorded whether or not its number was the one used.
 *
 * Recorded always, because the point of the fields is to measure the derivation against the provider's own count
 * of the request that actually went out - which is only possible on the runs where another tier won. `tokens` is
 * the number to compare with `usage.input + cacheRead + cacheWrite`; the rest says how much of it was measured,
 * so a skew can be attributed to the head, the rows, or an unbracketed stretch rather than argued about.
 */
export interface CompactionLedgerFields {
    /** Head + rows + the appended instruction: what this request should have cost. */
    tokens: number;
    /** How much of `tokens` is chars/4 rather than counted, across the head, the rows and the instruction. */
    estimatedTokens: number;
    /** The head no row owns: system prompt, tool definitions, and the newest checkpoint. */
    headTokens: number;
    /** Which reply the head was solved from - the session's first, or the first after a fold. */
    headSource: "first-reply" | "after-fold";
    /** How much of the range the head was solved from was chars/4, which is the head's whole error. */
    headEstimatedTokens: number;
    /** Rows covered by a difference of two provider counts. */
    rowsCounted: number;
    /** Rows no pair of counts bracketed. Includes `rowsCheckpoints`. */
    rowsEstimated: number;
    /** Of `rowsEstimated`, what checkpoints riding inside the window cost. */
    rowsCheckpoints: number;
}

/** The request-side numbers for one attempt. */
export interface CompactionAttemptFields {
    provider: string;
    model: string;
    maxTokens: number;
    contextWindow: number;
    /**
     * Estimated size of what this strategy sends, so a rejected native attempt explains itself. Comparable with
     * the provider's count for *this request* (`usage.input + cacheRead + cacheWrite`), never with
     * `reportedContextTokens`: once the span is truncated the two describe different bodies. Stage 1 sizes this
     * from the session's own counts when it can - see `estimateSource`.
     */
    estimatedTokens?: number;
    /**
     * Which method produced `estimatedTokens`: the provider's count of the very body being sent, a count
     * anchored inside the span plus a tail estimate, or chars/4 over the whole body. They are not
     * interchangeable - one is a measurement and two are guesses with measured error rates an order of magnitude
     * apart - so a reader has to know which number they are being shown. Absent on records from before the
     * counts existed, which the report prints as its own state.
     */
    estimateSource?: EstimateSource;
    /**
     * Stage 1 only: assistant rows inside or at the span that carried a token count but were rejected because
     * the count predates a compaction or a model/thinking change. Its absence means there was nothing to
     * reject; its presence beside `estimateSource: "chars4"` means the session *was* counted and the numbers
     * expired, which is the state right after a fold with no reply since.
     */
    staleAnchors?: number;
    /**
     * How many folds' own counted numbers rescued an anchor that `staleAnchors` rejected, so the tier's number came
     * from arithmetic over provider counts rather than from chars/4.
     */
    foldCorrected?: number;
    /**
     * `ctx.getContextUsage().tokens`: provider usage up to the last reply plus a chars/4 estimate of what
     * followed it, measured over the whole live context - a hybrid, and larger than any truncated request by the
     * retained tail. What the fit gate falls back to, never its first choice.
     */
    reportedContextTokens?: number;
    toolCount?: number;
    messageCount?: number;
    serializedChars?: number;
    droppedBlocks?: number;
    /** Stage 1 only: transcript entries copied into the in-memory span, and types that could not be. */
    copiedEntries?: number;
    /**
     * Stage 1 only: the boundary actually used, which is core's unless the repair found that one unsendable.
     * Printed against `proposedFirstKeptEntryId`, because a moved cut nobody can see is indistinguishable from
     * one that was never a choice.
     */
    chosenFirstKeptEntryId?: string;
    /** Stage 1 only: the boundary core proposed, kept so a move can be measured after the fact. */
    proposedFirstKeptEntryId?: string;
    skippedEntries?: number;
    /**
     * Stage 1 only: whether pi's `firstKeptEntryId` named an entry on this branch. False means the span came back
     * as the whole transcript - stage 1 re-read the retained tail at full price, and its checkpoint overlaps the
     * messages that survive. Recorded here because no length or depth comparison recovers it later: an uncut span
     * and a merely long one carry the same numbers.
     */
    cutFound?: boolean;
    /**
     * Stage 1 only: rows the walk moved back from core's boundary. Zero means it kept core's choice, which is why
     * absence has to stay reserved for "this record predates the field".
     */
    cutMovedRows?: number;
    /**
     * Stage 1 only: the condition that refused core's own boundary, and therefore the cause of any move. Present
     * exactly when `cutMovedRows` is non-zero - a cut moved for no reason is the invariant the report checks.
     */
    cutProposedRejection?: CutRejection;
    /** Stage 1 only: per-condition tallies, so a run that could not be repaired says what stopped it. */
    cutRejections?: Partial<Record<CutRejection, number>>;
    /**
     * Stage 1 only: retained history at the chosen boundary, and the floor it was weighed against
     * (`preparation.settings.keepRecentTokens`). A tail without its budget is a number nobody can read.
     */
    cutTailTokens?: number;
    cutKeepRecentTokens?: number;
    /** Stage 1 only: the chosen span's size, and which route measured it: a count of that body, or arithmetic. */
    cutSpanTokens?: number;
    cutSpanBasis?: MeasureBasis;
    /**
     * Stage 1 only: which instrument sized the whole live context this tail was subtracted from. `ledger` means
     * both sides of that subtraction are head-plus-rows; `context-usage` means the tail mixes a provider's count
     * of a body that no longer ends where the span does.
     */
    cutLiveTokensSource?: "ledger" | "context-usage";
    /** Stage 2 only: how much of stage 1's checkpoint it was handed. */
    segmentSummaryChars?: number;
    customInstructions?: string;
    previousSummaryChars?: number;
    /**
     * Stage 1 only: the head ledger's size for this same body, present whenever the session could derive one -
     * including when `estimateSource` says another tier answered. Absent means the derivation declined (no
     * counted reply under the current head, a cut naming no row, or too much of the body unbracketed), and a
     * record from before the fields existed looks the same, which is why nothing infers a cause from absence.
     */
    ledger?: CompactionLedgerFields;
}

export interface CompactionAttemptResult {
    outcome: CompactionAttemptOutcome;
    detail?: string;
    usage?: Usage;
    /**
     * The provider's own word for how the reply ended, when a reply arrived. `"length"` on an accepted attempt
     * means the summary is missing its tail, which no amount of text inspection can tell apart from a short
     * complete one.
     */
    stopReason?: StopReason;
    /** Why this attempt failed, and how many resends a `transient` cause bought before it was given up on. */
    cause?: SummarizationFailureCause;
    retries?: number;
}

export interface CompactionFinalFields {
    firstKeptEntryId: string;
    tokensBefore: number;
    summarizedMessages: number;
    droppedBlocks: number;
    readFiles: number;
    modifiedFiles: number;
}

export interface CompactionTraceRecord {
    v: number;
    id: string;
    /** Which extension load wrote this. Two reloads can share a file, and their chains did not survive them. */
    instance: string;
    ts: string;
    stage: CompactionTraceStage;
    cwd: string;
    session: string;
    reason: SummarizationReason;
    willRetry: boolean;
    strategy?: SummarizationStrategy;
    outcome?: CompactionAttemptOutcome | CompactionTraceOutcome;
    detail?: string;
    /** Present on an attempt that received a reply: how the provider said that reply ended. */
    stopReason?: StopReason;
    /** Why an attempt failed, and how many resends a transient cause bought first. */
    cause?: SummarizationFailureCause;
    retries?: number;
    /** The stage payload: the model's answer, then the composed summary. */
    text?: string;
    usage?: CompactionTraceUsage;
    attempt?: CompactionAttemptFields;
    prefix?: CompactionPrefixFields;
    final?: CompactionFinalFields;
}

/**
 * How our rebuilt request compared to what pi actually sent, as answered by `chain.ts`.
 *
 * The reference is a retained hash ladder, not a request body, so two rules follow from that and both matter
 * more than the verdict itself:
 *
 * - `prefixUsable` is **omitted**, never `false`, when no on-branch reference existed. Before the ladder, an
 *   absent reference was reported as an unusable prefix with a `commonPrefixMessages: 0`, and a cold process
 *   after a restart read exactly like a broken rebuild.
 * - `commonPrefixMessages` is the deepest *reference depth* our rebuild agreed with, not a message index of
 *   ours. Pi's depths are dense (one or two messages per request), so the answer is exact, and a shorter
 *   rebuilt span can only be verified down to the depths the reference actually covers: hence
 *   `referenceDepth` and `verifiedThrough`.
 *
 * Because the comparison happens at the reference's own depths, our appended instruction is never inside the
 * window being checked. The "is a tail-only difference a failure?" question that cost a whole debugging pass
 * under the body-to-body diff does not arise here.
 */
/** The two bodies a prefix disagreement was found between, as far as either is still retained. */
export interface PrefixDivergence {
    /** 1-based depth whose running head first differed, i.e. message `depth - 1` is the odd one out. */
    depth: number;
    /** Our request's leading messages, sampled from the body about to be sent. */
    ours: MessageSample[];
    /** The credited reference's leading messages, or null when this process never retained them. */
    theirs: MessageSample[] | null;
    /** How many requests were sampled at all, so a null `theirs` reads as "untracked" and not "nothing wrong". */
    sampledRequests: number;
}

export interface CompactionPrefixFields {
    /** Which reference answered: retained chain observations, or nothing usable. */
    reference: "chain" | "none";
    /**
     * Present only when heads disagreed: both bodies' leading messages, so the record says *what* disagreed.
     *
     * Written on the mismatch and nowhere else, which is the whole reason the chain retains a sample of each
     * request instead of only its hashes.
     */
    divergence?: PrefixDivergence;
    /** Undefined when there was no reference to compare against. */
    prefixUsable?: boolean;
    /** `verified` | `messages[<depth>]` | `system` | `tools` | `no-reference` | `<field>:<a>!=<b>`. */
    firstDivergence: string;
    divergences: string[];
    /** True when our span is shorter than the reference: stage 1 truncating at the cut point, by design. */
    truncated?: boolean;
    /** Body keys only one side sent, e.g. `+presence_penalty`. Informational, never a verdict. */
    parameters: string[];
    ourMessageCount: number;
    /** Deepest reference depth our hashes agreed with. -1 when nothing agreed. */
    commonPrefixMessages: number;
    /** Deepest reference depth available on the current branch. */
    referenceDepth: number;
    /** Deepest reference depth our span was long enough to compare; -1 when none was. */
    comparableDepth: number;
    /** True when every comparable reference depth agreed. */
    verifiedThrough: boolean;
    /**
     * Leaf id the verdict was taken from, and the leaf we are building for.
     *
     * `verifiedThrough`, `comparableDepth`, `firstDivergence` and `parameters` all describe *this* reference and
     * nothing else: an agreement credited to one request used to print beside a mismatch discovered by another.
     */
    referenceLeafId: string | null;
    /** Whether the credited reference was a request pi sent or a retained ladder derived from one. */
    referenceSource?: "observation" | "ladder" | null;
    /**
     * Comparable references that disagreed somewhere, excluding the credited one.
     *
     * Mostly a stale pre-compaction ladder - still on the branch, still the same shape, describing a prefix that
     * no longer exists. Counted so it is visible without letting it move the printed depths.
     */
    otherDisagreements?: number;
    /**
     * The credited reference's own shallowest disagreement, as a depth rather than a `messages[n]` string.
     *
     * The report checks it against `commonPrefixMessages`: heads are cumulative, so a mismatch inside one
     * reference always sits deeper than that reference's agreement, and a record where it does not means two
     * references were merged into one verdict.
     */
    firstMismatchDepth?: number | null;
    currentLeafId: string | null;
    /** Comparable observations on this branch, i.e. how much of the ladder actually overlapped. */
    observations: number;
    /**
     * Chain entries held in this process, before any filter. Zero means no parent request has been observed
     * since the store was created, which is what a restart, a reload, or a freshly built session view looks
     * like from inside a compaction.
     */
    chainObservations: number;
    /** Chain entries whose leaf sits on the current branch, before the shape filter. */
    branchObservations: number;
    /**
     * How many on-branch requests each half of the shape filter rejected.
     *
     * Counted per gate and not exclusive: an entry differing in both prompt and tools is counted twice, so the two
     * can sum above `branchObservations`. `observations` is already the count that passed both gates, which is why
     * there is no third number here - and why a zero on both, with entries on the branch and nothing comparable,
     * is a contradiction the report flags rather than a state it has to explain.
     *
     * The suspects read these rather than restating the filter as a fixed conjunction. The conjunction claimed a
     * tool-set difference on a run where every row on the branch carried the same tool hash.
     */
    rejectSystemHash: number;
    rejectToolsHash: number;
    /**
     * The newest on-branch request as the chain recorded it, comparable or not.
     *
     * Absent when nothing was on the branch. This is the parent side of `ourRequest`, so "did our rebuild carry
     * the same system prompt and tool set as pi's live requests" is a field comparison rather than an inference.
     */
    parentRequest?: {
        model: string;
        systemChars: number;
        systemHash: string;
        toolsHash: string;
        messageCount: number;
        leafId: string | null;
        /** Decode values as the reference carried them; absent in records from before the field existed. */
        maxTokens?: number | null;
        enableThinking?: boolean | null;
        reasoningEffort?: string | null;
        imageBlocks?: number | null;
    };
    /** What this record cannot answer, stated rather than left for the reader to infer from a zero. */
    unknowns: string[];
    /** The retention cap dropped older observations, so shallow depths may be unverifiable. */
    historyTruncated: boolean;
    /** `parent -> ours` when the reference request used a different model. */
    modelDivergence: string | null;
    ourRequest?: Record<string, unknown>;
}

export interface CompactionTraceTarget {
    enabled: boolean;
    filePath: string;
    maxBytes: number;
    /** Rotated copies kept, live file excluded. See `CompactionConfig["traceGenerations"]`. */
    generations: number;
}

/** Resolve the trace target: the shared switch first, then this feature's own env and config overrides. */
export function compactionTraceTarget(config: CompactionConfig): CompactionTraceTarget {
    const envSwitch = process.env.COMPACTION_TRACE?.trim().toLowerCase();
    const enabled =
        envSwitch !== undefined && envSwitch !== ""
            ? !DISABLED_VALUES.has(envSwitch)
            : isAgentTraceEnabled() && config.traceEnabled;
    const configuredPath =
        nonEmpty(process.env.COMPACTION_TRACE_PATH) ?? nonEmpty(config.tracePath);
    return {
        enabled,
        filePath: configuredPath ? path.resolve(configuredPath) : COMPACTION_TRACE_PATH,
        maxBytes: config.traceMaxBytes,
        generations: config.traceGenerations,
    };
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

export interface CompactionTraceRecorder {
    readonly enabled: boolean;
    /** One record per strategy attempt, written once that attempt is known to be over. */
    attempt(
        strategy: SummarizationStrategy,
        fields: CompactionAttemptFields,
        result: CompactionAttemptResult,
    ): void;
    /** How the rebuilt request compared against the parent's cached prefix, when both payloads were seen. */
    prefix(fields: CompactionPrefixFields): void;
    /** (a) What the model answered with, before the harness appended anything. */
    modelResponse(strategy: SummarizationStrategy, text: string, usage?: Usage): void;
    /** (b) The summary that goes into the `CompactionEntry`, with the counts it was built from. */
    final(strategy: SummarizationStrategy, summary: string, fields: CompactionFinalFields): void;
    /** How the whole compaction ended, including the rungs that never reached a provider call. */
    outcome(outcome: CompactionTraceOutcome, detail?: string): void;
}

interface TraceBase {
    id: string;
    cwd: string;
    session: string;
    reason: SummarizationReason;
    willRetry: boolean;
}

/**
 * A recorder for one compaction run. When tracing is off every method is a no-op, so the cascade reads the
 * same whether or not anyone is watching.
 */
export function createCompactionTraceRecorder(
    base: Omit<TraceBase, "id">,
    target: CompactionTraceTarget,
): CompactionTraceRecorder {
    const id = uuidv7();

    const write = (record: Omit<CompactionTraceRecord, "id" | "ts" | "v" | "instance">): void => {
        if (!target.enabled) {
            return;
        }
        traceLog(target).append({
            v: RECORD_VERSION,
            id,
            instance: PROCESS_INSTANCE,
            ts: new Date().toISOString(),
            ...record,
        });
    };

    return {
        enabled: target.enabled,
        attempt(strategy, fields, result) {
            write({
                ...base,
                stage: "attempt",
                strategy,
                attempt: fields,
                outcome: result.outcome,
                detail: result.detail,
                stopReason: result.stopReason,
                cause: result.cause,
                retries: result.retries,
                usage: usageFields(result.usage),
            });
        },
        prefix(fields) {
            write({ ...base, stage: "prefix", strategy: "native", prefix: fields });
        },
        modelResponse(strategy, text, usage) {
            write({
                ...base,
                stage: "model_response",
                strategy,
                text,
                usage: usageFields(usage),
            });
        },
        final(strategy, summary, fields) {
            write({ ...base, stage: "final_summary", strategy, text: summary, final: fields });
        },
        outcome(outcome, detail) {
            write({ ...base, stage: "outcome", outcome, detail });
        },
    };
}

/**
 * The ledger's numbers as recorded, or nothing when the session could not derive one.
 *
 * Lives beside the type it fills for the reason `usageFields` lives beside `CompactionTraceUsage`: a record's
 * shape and the projection that produces it drift apart silently, and a second surface naming the same quantity
 * differently is how an ambiguity gets reintroduced.
 */
export function ledgerFields(body: MeasuredBody | null): CompactionLedgerFields | undefined {
    if (body === null) {
        return undefined;
    }

    return {
        tokens: body.tokens,
        estimatedTokens: body.estimatedTokens,
        headTokens: body.head.tokens,
        headSource: body.head.source,
        headEstimatedTokens: body.head.estimatedTokens,
        rowsCounted: body.rows.counted,
        rowsEstimated: body.rows.estimated,
        rowsCheckpoints: body.rows.checkpoints,
    };
}

function usageFields(usage: Usage | undefined): CompactionTraceUsage | undefined {
    if (!usage) {
        return undefined;
    }
    return {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
    };
}

/**
 * One log per target, so append and rotation health accumulates across runs rather than per recorder. The key
 * includes the rotation settings because a config change mid-session is a different store, not the same one
 * behaving differently.
 */
const traceLogs = new Map<string, RecordLog<CompactionTraceRecord>>();

function traceLog(target: CompactionTraceTarget): RecordLog<CompactionTraceRecord> {
    const key = `${target.filePath}|${String(target.maxBytes)}|${String(target.generations)}`;
    const existing = traceLogs.get(key);
    if (existing !== undefined) {
        return existing;
    }

    const created = createJsonlRecordLog<CompactionTraceRecord>({
        filePath: target.filePath,
        maxBytes: target.maxBytes,
        generations: target.generations,
    });
    traceLogs.set(key, created);
    return created;
}
