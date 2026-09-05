import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PI_CODER_EXTENSION_DIR } from "../../src/common/constants";
import type { SummarizationStrategy } from "../../src/modules/compaction/summarize";
import {
    createCompactionTraceRecorder,
    type CompactionAttemptFields,
    type CompactionAttemptResult,
    type CompactionFinalFields,
    type CompactionPrefixFields,
    type CompactionTraceRecorder,
    type CompactionTraceTarget,
} from "../../src/modules/compaction/trace";

const SCRIPT = path.join(PI_CODER_EXTENSION_DIR, "scripts", "compaction-report.mjs");

/**
 * A real llama.cpp trimmed run. It exists so "what a healthy run looks like" is pinned
 * down rather than argued from a live log - and so a flag that starts firing on absent
 * data, which one of these did, fails a test instead of costing an afternoon.
 */
const HEALTHY_FIXTURE = path.join(
    PI_CODER_EXTENSION_DIR,
    "test",
    "fixtures",
    "compaction-trace.healthy.jsonl",
);

interface ReportFlag {
    key: string;
    detail: string;
}

interface ReportAttempt {
    strategy: SummarizationStrategy;
    outcome: "accepted" | "rejected" | "skipped";
    detail?: string;
    messageCount?: number;
    segmentSummaryChars?: number;
    droppedBlocks?: number;
}

interface ReportPrefix {
    usable?: boolean;
    truncated?: boolean;
    divergences: string[];
    reference?: string;
    verifiedTo?: number;
    comparableDepth?: number;
    referenceDepth?: number;
    observations?: number;
    verifiedThrough?: boolean;
}

interface ReportRun {
    id: string;
    session: string;
    reason: string;
    route?: string;
    reuse: number | null;
    freshTokens: number;
    cachedTokens: number;
    checkpointChars: number;
    finalChars: number;
    observations?: number;
    texts?: Record<string, string>;
    attempts: ReportAttempt[];
    prefix?: ReportPrefix;
    flags: ReportFlag[];
}

interface ReportJson {
    total: number;
    skipped: number;
    suspects: number;
    runs: ReportRun[];
    aggregates: {
        routes: Record<string, number>;
        failures: Record<string, number>;
        flags: Record<string, number>;
        causes: Record<string, number>;
        parameters: Record<string, number>;
        divergences: Record<string, number>;
        models: Record<string, number>;
    };
}

interface ScriptResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

let workspace = "";
let logPath = "";

function usage(input: number, output: number, cacheRead = 0): Usage {
    return {
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        totalTokens: input + output + cacheRead,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

/**
 * Records are written by the production recorder, so the fixture cannot drift from the trace schema the way
 * a hand-written JSON literal would. Only the schema-drift case bypasses it, deliberately.
 */
function recorder(session: string, reason = "manual"): CompactionTraceRecorder {
    const target: CompactionTraceTarget = {
        enabled: true,
        filePath: logPath,
        maxBytes: 64 * 1024 * 1024,
    };

    return createCompactionTraceRecorder(
        { cwd: workspace, session, reason: reason as never, willRetry: false },
        target,
    );
}

function nativeFields(overrides: Partial<CompactionAttemptFields> = {}): CompactionAttemptFields {
    return {
        provider: "test-provider",
        model: "test-model",
        maxTokens: 13107,
        contextWindow: 200000,
        estimatedTokens: 8000,
        reportedContextTokens: 7800,
        toolCount: 6,
        messageCount: 42,
        copiedEntries: 60,
        previousSummaryChars: 0,
        ...overrides,
    };
}

function finalFields(overrides: Partial<CompactionFinalFields> = {}): CompactionFinalFields {
    return {
        firstKeptEntryId: "keptentryid000000000000",
        tokensBefore: 8000,
        summarizedMessages: 42,
        droppedBlocks: 0,
        readFiles: 2,
        modifiedFiles: 1,
        ...overrides,
    };
}

function healthyPrefix(overrides: Partial<CompactionPrefixFields> = {}): CompactionPrefixFields {
    return {
        reference: "chain",
        prefixUsable: true,
        firstDivergence: "verified",
        divergences: [],
        truncated: true,
        parameters: ["+tool_choice"],
        ourMessageCount: 43,
        commonPrefixMessages: 42,
        comparableDepth: 42,
        referenceDepth: 43,
        verifiedThrough: true,
        referenceLeafId: "leaf-43",
        currentLeafId: "leaf-43",
        observations: 3,
        historyTruncated: false,
        modelDivergence: null,
        ...overrides,
    };
}

function accepted(overrides: Partial<CompactionAttemptResult> = {}): CompactionAttemptResult {
    return { outcome: "accepted", ...overrides };
}

function checkpoint(text: string, size: number): string {
    return `${text}\n`.padEnd(size, "x");
}

/** A run in which every stage did its job: prefix reused, both stages wrote real checkpoints. */
function writeHealthyRun(session: string): void {
    const trace = recorder(session);
    const summary = checkpoint("## Goal", 4000);
    trace.prefix(healthyPrefix());
    trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 1500, 30000) }));
    trace.modelResponse("native", summary);
    trace.attempt(
        "serialized",
        nativeFields({ toolCount: 0, messageCount: 1, segmentSummaryChars: summary.length }),
        accepted({ usage: usage(1500, 1200) }),
    );
    trace.modelResponse("serialized", summary);
    trace.final("serialized", summary, finalFields());
    trace.outcome("two-stage");
}

function runScript(args: string[]): ScriptResult {
    const result = spawnSync(process.execPath, [SCRIPT, "--path", logPath, ...args], {
        encoding: "utf8",
    });

    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Text mode must succeed silently, so any stderr here is a real bug rather than a skip note. */
function runText(args: string[] = []): ScriptResult {
    const result = runScript([...args]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");

    return result;
}

function parseReport(args: string[] = []): ReportJson {
    const result = runScript([...args, "--json"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");

    return JSON.parse(result.stdout) as ReportJson;
}

function flagKeys(report: ReportJson, session: string): string[] {
    const run = report.runs.find((candidate) => candidate.session === session);
    expect(run, `no run for session ${session}`).toBeDefined();

    return (run?.flags ?? []).map((flag) => flag.key);
}

beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "pi-compaction-report-"));
    logPath = path.join(workspace, "compaction-trace.jsonl");
});

afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
});

describe("compaction-report script", () => {
    it("groups records by run and separates cached from fresh prompt tokens", () => {
        writeHealthyRun("sess-healthy");

        const report = parseReport();
        expect(report.total).toBe(1);
        expect(report.aggregates.routes["two-stage"]).toBe(1);
        expect(report.aggregates.models["test-provider/test-model"]).toBe(1);

        const run = report.runs[0];
        // 30000 of a 33500-token prompt came back as a cache read, which is the entire point of stage 1.
        expect(run.freshTokens).toBe(3500);
        expect(run.cachedTokens).toBe(30000);
        expect(run.reuse).toBeCloseTo(0.8955, 3);
        expect(run.checkpointChars).toBe(4000);
        expect(run.finalChars).toBe(4000);
        expect(run.attempts.map((attempt) => attempt.strategy)).toEqual(["native", "serialized"]);
        expect(run.flags).toEqual([]);

        const text = runText();
        expect(text.stdout).toContain("usable=true");
        expect(text.stdout).toContain("reuse=  90%");
        expect(text.stdout).toContain("two-stage");
    });

    it("flags the run where stage 1 answered with a refusal instead of a checkpoint", () => {
        // The real 2026-09-05 failure: stage 1 returned 169 chars of "I have no prior thinking to
        // reproduce", which is non-empty and therefore accepted, after which stage 2 rebuilt the summary.
        const trace = recorder("sess-refusal");
        const refusal = "I don't have any prior thinking to reproduce.";
        trace.prefix(
            healthyPrefix({ referenceDepth: 880, ourMessageCount: 839, commonPrefixMessages: 838 }),
        );
        trace.attempt(
            "native",
            nativeFields({
                messageCount: 837,
                estimatedTokens: 644000,
                reportedContextTokens: 533443,
            }),
            accepted({ usage: usage(509307, 35) }),
        );
        trace.modelResponse("native", refusal);
        trace.attempt(
            "serialized",
            nativeFields({
                toolCount: 0,
                messageCount: 1,
                segmentSummaryChars: refusal.length,
                serializedChars: 47931,
                droppedBlocks: 702,
            }),
            accepted({ usage: usage(15000, 1122) }),
        );
        trace.final("serialized", checkpoint("## Goal", 8291), finalFields({ droppedBlocks: 702 }));
        trace.outcome("two-stage");

        const keys = flagKeys(parseReport(), "sess-refusal");
        expect(keys).toContain("degenerate-native-output");
        expect(keys).toContain("reduce-inflated");
        expect(keys).toContain("cache-read-zero");
        expect(keys).toContain("blocks-dropped");
        expect(keys).toContain("estimate-skew");
        // The prefix itself was fine, so the cost flag must not be misread as an alignment failure.
        expect(keys).not.toContain("prefix-unusable");
        expect(parseReport().aggregates.flags["degenerate-native-output"]).toBe(1);

        const text = runText(["--suspect"]);
        expect(text.stdout).toContain("stage 1 accepted with 45 chars");
        expect(text.stdout).toContain("45 checkpoint chars -> 8291 final chars");
        expect(text.stdout).toContain("702 transcript blocks left out");
    });

    it("separates an absent reference from an unusable one", () => {
        // Before the hash ladder, both of these were written as `prefixUsable: false` with a zero match count,
        // which made a cold process look like a broken rebuild.
        const trace = recorder("sess-no-reference");
        trace.prefix(
            healthyPrefix({
                reference: "none",
                prefixUsable: undefined,
                firstDivergence: "no-reference",
                divergences: ["no-reference"],
                commonPrefixMessages: -1,
                referenceDepth: -1,
                observations: 0,
            }),
        );
        trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 1500, 30000) }));
        const summary = checkpoint("## Goal", 4000);
        trace.modelResponse("native", summary);
        trace.final("native", summary, finalFields());
        trace.outcome("native");

        const keys = flagKeys(parseReport(), "sess-no-reference");
        expect(keys).toContain("no-prefix-reference");
        expect(keys).not.toContain("prefix-unusable");
        expect(runText(["--session", "sess-no-reference"]).stdout).toContain("reference=none");
    });

    it("says so when the reference is real but shallower than the span", () => {
        const trace = recorder("sess-shallow");
        // The chain only reached depth 400 while the span carried 838 messages: matched, but only partly checkable.
        trace.prefix(
            healthyPrefix({ referenceDepth: 400, ourMessageCount: 839, commonPrefixMessages: 400 }),
        );
        trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 1500, 30000) }));
        const summary = checkpoint("## Goal", 4000);
        trace.modelResponse("native", summary);
        trace.final("native", summary, finalFields());
        trace.outcome("native");

        expect(flagKeys(parseReport(), "sess-shallow")).toContain("prefix-reference-shallow");
    });

    /**
     * Stage 2 keeps a truncated answer deliberately, so nothing downstream looks at it twice. The stop reason
     * is the only sign that the summary written into the session is missing its tail, and the text cannot say:
     * a cut-off answer and a brief complete one are the same bytes up to where the cut happened.
     */
    it("flags the run where the persisted summary was cut short by the output limit", () => {
        const trace = recorder("sess-truncated");
        trace.prefix(healthyPrefix());
        trace.attempt("native", nativeFields(), accepted({ usage: usage(4000, 900, 30000) }));
        trace.attempt(
            "serialized",
            nativeFields({ toolCount: 0, messageCount: 1, droppedBlocks: 0 }),
            accepted({ usage: usage(9000, 12800), stopReason: "length" }),
        );
        // Long enough to pass every size threshold: only the stop reason knows this summary was cut.
        trace.final("serialized", checkpoint("## Goal", 4000), finalFields());
        trace.outcome("serialized");

        const keys = flagKeys(parseReport(), "sess-truncated");
        expect(keys).toContain("summary-truncated");
        expect(keys).not.toContain("degenerate-final-summary");
        expect(runText(["--suspect"]).stdout).toContain("stage 2 hit the output limit");
    });

    /**
     * Before classification, an exhausted quota and a context overflow shared a row in ATTEMPT FAILURES because
     * their normalized messages looked alike, and the right response to each is the opposite. These are the rows
     * and flags that keep them apart.
     */
    it("separates the causes that end a cascade from the ones that only redirect it", () => {
        const quota = recorder("sess-quota");
        quota.prefix(healthyPrefix());
        quota.attempt("native", nativeFields(), {
            outcome: "rejected",
            detail: "429 insufficient_quota: check your billing details",
            cause: "quota",
            retries: 0,
            usage: usage(0, 0),
        });
        quota.attempt("serialized", nativeFields({ toolCount: 0, messageCount: 1 }), {
            outcome: "skipped",
            detail: "not attempted: quota (an account limit: every rung would fail the same way)",
            cause: "quota",
            retries: 0,
        });
        quota.outcome("abandoned", "segment: quota");

        const overflow = recorder("sess-overflow");
        overflow.prefix(healthyPrefix());
        overflow.attempt("native", nativeFields(), {
            outcome: "rejected",
            detail: "400 BadRequest: This model's maximum context length is 131072 tokens",
            cause: "overflow",
            retries: 0,
            usage: usage(0, 0),
        });
        overflow.attempt(
            "serialized",
            nativeFields({ toolCount: 0, messageCount: 1 }),
            accepted({}),
        );
        overflow.final("serialized", checkpoint("## Goal", 4000), finalFields());
        overflow.outcome("serialized");

        const report = parseReport();
        expect(flagKeys(report, "sess-quota")).toContain("compaction-abandoned");
        expect(flagKeys(report, "sess-overflow")).not.toContain("compaction-abandoned");
        // A deliberate stop is not a handover: `fell-back` is about core owning the result.
        expect(flagKeys(report, "sess-quota")).not.toContain("fell-back");
        expect(report.aggregates.causes["native rejected quota"]).toBe(1);
        expect(report.aggregates.causes["native rejected overflow"]).toBe(1);
        expect(report.aggregates.routes.abandoned).toBe(1);

        const text = runText();
        expect(text.stdout).toContain("CAUSES");
        expect(text.stdout).toContain("[quota]");
        expect(text.stdout).toContain("[overflow]");
    });

    it("flags a transient failure that spent its whole retry budget", () => {
        const trace = recorder("sess-retries");
        trace.prefix(healthyPrefix());
        trace.attempt("native", nativeFields(), {
            outcome: "rejected",
            detail: "502 upstream connect error",
            cause: "transient",
            retries: 2,
            usage: usage(0, 0),
        });
        trace.attempt("serialized", nativeFields({ toolCount: 0, messageCount: 1 }), {
            outcome: "rejected",
            detail: "502 upstream connect error",
            cause: "transient",
            retries: 2,
            usage: usage(0, 0),
        });
        trace.outcome("core-default", "segment: 502; reduce: 502");

        expect(flagKeys(parseReport(), "sess-retries")).toContain("retry-exhausted");
        expect(runText(["--suspect"]).stdout).toContain("resent 2x and still failed");
    });

    it("applies the text thresholds uniformly across runs", () => {
        writeHealthyRun("sess-healthy");
        const trace = recorder("sess-short");
        trace.prefix(healthyPrefix());
        trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 40, 30000) }));
        trace.modelResponse("native", "## Goal\nshort");
        trace.final("native", "## Goal\nshort", finalFields());
        trace.outcome("native");

        // Only the 12-char answer is below the default floor.
        expect(flagKeys(parseReport(), "sess-short")).toEqual([
            "degenerate-native-output",
            "degenerate-final-summary",
        ]);
        expect(parseReport(["--suspect"]).total).toBe(1);
        expect(parseReport(["--suspect"]).runs[0].session).toBe("sess-short");

        // Lowering the floor below both texts leaves nothing suspect, which is how a flag is a knob and not
        // a verdict.
        expect(parseReport(["--suspect", "--min-chars", "5"]).total).toBe(0);
        // Raising it sweeps the healthy run too, because its persisted summary is 4000 chars.
        expect(parseReport(["--suspect", "--min-chars", "10000"]).total).toBe(2);
    });

    it("keeps a span that never truncated visible as its own failure", () => {
        const trace = recorder("sess-notruncated");
        // The missing-cut-point case: stage 1 sent the whole live context instead of the truncated span.
        trace.prefix(
            healthyPrefix({ truncated: false, ourMessageCount: 880, referenceDepth: 880 }),
        );
        trace.attempt("native", nativeFields(), accepted({ usage: usage(5000, 1500, 30000) }));
        trace.modelResponse("native", checkpoint("## Goal", 4000));
        trace.final("native", checkpoint("## Goal", 4000), finalFields());
        trace.outcome("native");

        expect(flagKeys(parseReport(), "sess-notruncated")).toContain("span-not-truncated");
    });

    it("normalizes rejection details so the same failure groups into one row", () => {
        const first = recorder("sess-quota", "threshold");
        first.prefix(
            healthyPrefix({
                prefixUsable: false,
                firstDivergence: "system",
                divergences: ["system"],
            }),
        );
        first.attempt("native", nativeFields(), {
            outcome: "skipped",
            detail: "segment does not fit the context window",
        });
        first.attempt("serialized", nativeFields({ toolCount: 0 }), {
            outcome: "rejected",
            detail: 'summarization serialized call failed: 429 {"error":"insufficient_quota"}',
        });
        first.outcome("core-default", "both stages failed");

        const second = recorder("sess-cancel");
        second.attempt("native", nativeFields(), {
            outcome: "skipped",
            detail: "segment does not fit the context window",
        });
        second.outcome("cancelled", "user aborted");

        const report = parseReport();
        expect(report.aggregates.routes).toEqual({ "core-default": 1, cancelled: 1 });
        expect(report.aggregates.failures).toEqual({
            "native skipped: segment does not fit the context window": 2,
            "serialized rejected: summarization serialized call failed: <n> <json>": 1,
        });
        expect(report.aggregates.divergences["system"]).toBe(1);
        expect(flagKeys(report, "sess-quota")).toContain("fell-back");
        expect(flagKeys(report, "sess-cancel")).toContain("fell-back");

        expect(runText(["--route", "core-default"]).stdout).toContain("threshold");
        expect(runText(["--route", "core-default"]).stdout).not.toContain("sess-cancel");
        expect(runText(["--session", "sess-c"]).stdout).toContain("cancelled");
    });

    it("tolerates records from older builds and lines from other logs", () => {
        writeHealthyRun("sess-current");

        // A prefix record from before `divergences` and `parameters` existed. Rotation keeps one older
        // generation in the same file, so the reader must treat those fields as unknown rather than crash.
        appendFileSync(
            logPath,
            `${JSON.stringify({
                v: 1,
                id: "run-legacy",
                ts: new Date().toISOString(),
                cwd: workspace,
                session: "sess-legacy",
                reason: "manual",
                willRetry: false,
                stage: "prefix",
                strategy: "native",
                prefix: {
                    prefixUsable: false,
                    firstDivergence: "keys:+tool_choice",
                    referenceDepth: 42,
                    ourMessageCount: 44,
                    commonPrefixMessages: 0,
                },
            })}\n`,
        );
        appendFileSync(logPath, "not json at all\n");
        appendFileSync(
            logPath,
            `${JSON.stringify({ ts: new Date().toISOString(), command: "npm test", surface: "parent" })}\n`,
        );

        // This fixture deliberately contains junk, so stderr carries a skip note: read the JSON directly
        // rather than through the strict `parseReport` helper.
        const junky = runScript(["--json"]);
        expect(junky.status).toBe(0);
        const report = JSON.parse(junky.stdout) as ReportJson;
        expect(report.total).toBe(2);
        // Only the foreign JSON object counts as skipped; an unparsable line is reported on stderr instead.
        expect(report.skipped).toBe(1);

        const legacy = report.runs.find((run) => run.session === "sess-legacy");
        expect(legacy?.prefix?.divergences).toEqual([]);
        expect(legacy?.route).toBeUndefined();
        // A run with no outcome record fell back, because nothing was persisted through us.
        // `truncated` is absent in this old record, so the span flag must not fire on an unknown.
        expect(legacy?.flags.map((flag) => flag.key)).toEqual(["prefix-unusable", "fell-back"]);

        // The unparsable line is reported where it belongs: stderr, not the report body.
        const result = runScript([]);
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("skipping unparsable line");
    });

    it("reads a rotated sibling along with the current log", () => {
        const before = recorder("sess-rotated-out");
        before.outcome("disabled", "compaction is switched off");

        // The writer rotates by renaming the log into `<path>.1`, so mining history needs both files.
        renameSync(logPath, `${logPath}.1`);
        writeHealthyRun("sess-current");

        const report = parseReport();
        expect(report.total).toBe(2);
        expect(report.aggregates.routes).toEqual({ disabled: 1, "two-stage": 1 });
    });

    it("dumps stage text verbatim, unindented and untruncated", () => {
        writeHealthyRun("sess-healthy");

        const all = runText(["--dump", "--session", "sess-healthy"]);
        expect(all.stdout).toContain("run ");
        expect(all.stdout).toContain("stage 1 answer (native), 4000 chars");
        expect(all.stdout).toContain("stage 2 answer (serialized)");
        expect(all.stdout).toContain("persisted summary (4000 chars");
        // The checkpoint is markdown, so it must arrive with its own line breaks and no indent.
        expect(all.stdout).toContain(`\n## Goal\n${"x".repeat(40)}`);
        expect(all.stdout).not.toMatch(/^ {2,}## Goal/m);

        expect(runText(["--dump=final"]).stdout).not.toContain("stage 1 answer");
        expect(runText(["--dump=native"]).stdout).not.toContain("persisted summary");
        expect(runText(["--dump", "--grep", "zzz-not-in-any-text"]).stdout).toContain(
            "no stage text matched",
        );
        expect(runScript(["--dump=bogus"]).status).toBe(2);
    });

    it("finds runs by their stage text", () => {
        writeHealthyRun("sess-healthy");
        const trace = recorder("sess-sandbox-note");
        const summary = "## Goal\n- Keep the bwrap sandbox intact.\n";
        trace.attempt("native", nativeFields(), accepted({ usage: usage(1000, 200, 30000) }));
        trace.modelResponse("native", summary);
        trace.final("native", summary, finalFields());
        trace.outcome("native");

        expect(parseReport(["--grep", "bwrap"]).total).toBe(1);
        expect(parseReport(["--grep", "bwrap"]).runs[0].session).toBe("sess-sandbox-note");
        // Matching is case-insensitive, and a miss selects nothing rather than everything.
        expect(parseReport(["--grep", "BWRA"]).total).toBe(1);
        expect(parseReport(["--grep", "kubernetes"]).total).toBe(0);
    });

    it("renders previews without collapsing a checkpoint into one line", () => {
        writeHealthyRun("sess-healthy");

        const text = runText(["--runs", "1"]);
        expect(text.stdout).toContain('said:   "## Goal… (+');
        // --text 0 hides the preview entirely, which is the compact view.
        expect(runText(["--runs", "1", "--text", "0"]).stdout).not.toContain("said:");
        expect(runText(["--runs", "0"]).stdout).toContain("RUNS (1 matching, showing 1 newest");
    });

    it("reads the captured llama.cpp run as a healthy compaction", () => {
        const result = spawnSync(process.execPath, [SCRIPT, "--path", HEALTHY_FIXTURE, "--json"], {
            encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as ReportJson;

        expect(report.total).toBe(1);
        const [run] = report.runs;
        expect(run.route).toBe("two-stage");
        expect(run.prefix?.reference).toBe("chain");
        expect(run.prefix?.usable).toBe(true);
        // The claim this fixture exists to hold: all 19 span messages verified against the branch's ladder.
        expect(run.prefix?.verifiedTo).toBe(19);
        expect(run.prefix?.comparableDepth).toBe(19);
        // pi's own deepest request on the branch carried 33 messages while the truncated span held 19, so this
        // is truncation plus full verification: every depth the span reached agreed.
        expect(run.prefix?.referenceDepth).toBe(33);
        expect(run.prefix?.verifiedThrough).toBe(true);
        expect(run.prefix?.observations).toBe(13);
        expect(run.cachedTokens).toBeGreaterThan(run.freshTokens);
        expect(run.checkpointChars).toBe(5802);
        expect(run.finalChars).toBe(5411);
        // Only the estimate note survives: chars/4 was 42% under this provider's own count.
        expect(run.flags.map((flag) => flag.key)).toEqual(["estimate-skew"]);

        const text = spawnSync(
            process.execPath,
            [SCRIPT, "--path", HEALTHY_FIXTURE, "--runs", "1"],
            {
                encoding: "utf8",
            },
        );
        expect(text.stdout).toContain("reference=chain  usable=true  verified=19/19");
        expect(text.stdout).not.toContain("degenerate-native-output");
        // The fixture carries no `model_response` records, so nothing reconstructs stage text.
        expect(report.runs[0].texts ?? {}).not.toHaveProperty("native");
    });

    it("rejects unusable arguments before reading the log", () => {
        writeHealthyRun("sess-healthy");

        expect(runScript(["--reason", "nonsense"]).status).toBe(2);
        expect(runScript(["--route", "nonsense"]).status).toBe(2);
        expect(runScript(["--runs", "-1"]).status).toBe(2);
        expect(runScript(["--limit", "0"]).status).toBe(2);
        expect(runScript(["--since", "yesterday"]).status).toBe(2);
        expect(runScript(["--nope"]).status).toBe(2);
        expect(runScript(["--help"]).stdout).toContain("--dump");
        expect(runScript(["--path", path.join(workspace, "absent.jsonl")]).status).toBe(1);
    });
});
