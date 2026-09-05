import fs from "node:fs";
import path from "node:path";

import type { Usage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";

import { COMPACTION_TRACE_PATH } from "../../common/constants";
import { isAgentTraceEnabled } from "../../common/trace";
import type { CompactionConfig } from "./config";
import type { SummarizationStrategy } from "./summarize";
import type { SummarizationReason } from "./types";

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
    "two-stage" | "native" | "serialized" | "core-default" | "cancelled" | "disabled";

export interface CompactionTraceUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
}

/** The request-side numbers for one attempt. */
export interface CompactionAttemptFields {
    provider: string;
    model: string;
    maxTokens: number;
    contextWindow: number;
    /** Estimated size of what this strategy sends, so a rejected native attempt explains itself. */
    estimatedTokens?: number;
    /** The provider's own count for the live context, when known: what the fit gate actually used. */
    reportedContextTokens?: number;
    toolCount?: number;
    messageCount?: number;
    serializedChars?: number;
    droppedBlocks?: number;
    /** Stage 1 only: transcript entries copied into the in-memory span, and types that could not be. */
    copiedEntries?: number;
    skippedEntries?: number;
    /** Stage 2 only: how much of stage 1's checkpoint it was handed. */
    segmentSummaryChars?: number;
    customInstructions?: string;
    previousSummaryChars?: number;
}

export interface CompactionAttemptResult {
    outcome: CompactionAttemptOutcome;
    detail?: string;
    usage?: Usage;
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
    ts: string;
    stage: CompactionTraceStage;
    cwd: string;
    session: string;
    reason: SummarizationReason;
    willRetry: boolean;
    strategy?: SummarizationStrategy;
    outcome?: CompactionAttemptOutcome | CompactionTraceOutcome;
    detail?: string;
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
export interface CompactionPrefixFields {
    /** Which reference answered: retained chain observations, or nothing usable. */
    reference: "chain" | "none";
    /** Undefined when there was no reference to compare against. */
    prefixUsable?: boolean;
    /** `verified` | `messages[<depth>]` | `system` | `tools` | `no-reference`. */
    firstDivergence: string;
    divergences: string[];
    /** True when our span is shorter than the reference: stage 1 truncating at the cut point, by design. */
    truncated?: boolean;
    /** Body keys only one side sent, e.g. `+tool_choice`. Informational, never a verdict. */
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
    /** Leaf id the verdict was taken from, and the leaf we are building for. */
    referenceLeafId: string | null;
    currentLeafId: string | null;
    /** Comparable observations on this branch, i.e. how much of the ladder actually overlapped. */
    observations: number;
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

    const write = (record: Omit<CompactionTraceRecord, "id" | "ts" | "v">): void => {
        if (!target.enabled) {
            return;
        }
        appendRecord({ v: RECORD_VERSION, id, ts: new Date().toISOString(), ...record }, target);
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

function currentSize(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch {
        return 0;
    }
}

/** Keep the file small by rotating it into a single `.1` generation once it passes the cap. */
function rotateIfNeeded(filePath: string, maxBytes: number): void {
    if (currentSize(filePath) <= maxBytes) {
        return;
    }
    try {
        fs.renameSync(filePath, `${filePath}.1`);
    } catch {
        // A failed rotation must not lose the record; appending continues.
    }
}

function appendRecord(record: CompactionTraceRecord, target: CompactionTraceTarget): void {
    try {
        fs.mkdirSync(path.dirname(target.filePath), { recursive: true, mode: 0o700 });
        rotateIfNeeded(target.filePath, target.maxBytes);
        fs.appendFileSync(target.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
        // Best effort, by design: the trace explains compaction, it never gates it.
    }
}
