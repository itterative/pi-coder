import {
    appendFileSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Usage } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PI_CODER_EXTENSION_DIR } from "../../src/common/constants";
import {
    bundleScript,
    type BundledScript,
    type BundledScriptResult,
} from "../helpers/script-bundle";
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

const SCRIPT = path.join(PI_CODER_EXTENSION_DIR, "scripts", "compaction-report.ts");

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
    parameters?: string[];
    unknowns?: string[];
    ourCount?: number;
    ourSystemChars?: number;
    parentSystemChars?: number;
    /** Attribution: which reference the depths describe, and what the rest of them did. */
    referenceSource?: string | null;
    otherDisagreements?: number;
    firstMismatchDepth?: number | null;
    /** Decode values, paired. `parameters` cannot express that both sides sent a key and meant otherwise. */
    ourEnableThinking?: boolean | null;
    parentEnableThinking?: boolean | null;
    ourReasoningEffort?: string | null;
    parentReasoningEffort?: string | null;
    ourImageBlocks?: number | null;
    parentImageBlocks?: number | null;
    ourMaxTokens?: number | null;
    parentMaxTokens?: number | null;
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
    malformed: number;
    chainRows: number;
    instances: string[];
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
        generations: 10,
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
        // `estimatedTokens` sizes the request this strategy built; `reportedContextTokens` is pi's count for the
        // whole live context. They are different bodies once the span truncates, so the base carries both at the
        // live relationship (a chars/4 estimate ~34% above what the provider counted for the same request, and a
        // context larger than the request) rather than as the near-equal pair the old comparison wanted.
        estimatedTokens: 43_000,
        reportedContextTokens: 48_000,
        toolCount: 6,
        messageCount: 42,
        copiedEntries: 60,
        // The heuristic path, which is what a span with no counted reply inside it produces. Anchored states
        // spell `estimateSource: "usage-anchor"` out at their own call sites, because the two carry different
        // tolerances and a fixture cannot be allowed to imply the tighter one by default.
        estimateSource: "chars4",
        // Only stage 1 has a cut point, and a current-build record always says whether it found one. The report
        // reads `cut=` off the native attempt alone, so the stage-2 sites that reuse this base cannot leak it.
        cutFound: true,
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
        parameters: ["+presence_penalty"],
        ourMessageCount: 43,
        commonPrefixMessages: 42,
        comparableDepth: 42,
        referenceDepth: 43,
        verifiedThrough: true,
        referenceLeafId: "leaf-43",
        currentLeafId: "leaf-43",
        observations: 3,
        chainObservations: 3,
        branchObservations: 3,
        rejectSystemHash: 0,
        rejectToolsHash: 0,
        parentRequest: {
            model: "test-model",
            systemChars: 1200,
            systemHash: "aaaabbbb",
            toolsHash: "ccccdddd",
            messageCount: 43,
            leafId: "leaf-43",
        },
        unknowns: [],
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
        nativeFields({
            toolCount: 0,
            messageCount: 1,
            estimatedTokens: 2_000,
            segmentSummaryChars: summary.length,
        }),
        accepted({ usage: usage(1500, 1200) }),
    );
    trace.modelResponse("serialized", summary);
    trace.final("serialized", summary, finalFields());
    trace.outcome("two-stage");
}

function runScript(args: string[]): BundledScriptResult {
    return script.run(["--path", logPath, ...args]);
}

/** Text mode must succeed silently, so any stderr here is a real bug rather than a skip note. */
function runText(args: string[] = []): BundledScriptResult {
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

function flagDetail(report: ReportJson, session: string, key: string): string {
    const flags = report.runs.find((candidate) => candidate.session === session)?.flags ?? [];
    const flag = flags.find((candidate) => candidate.key === key);
    expect(flag, `no ${key} flag for ${session}`).toBeDefined();

    return String(flag?.detail ?? "");
}

/** A complete native run carrying the prefix record under test. */
function runWithPrefix(session: string, fields: Partial<CompactionPrefixFields>): void {
    const trace = recorder(session);
    const summary = checkpoint("## Goal", 4000);
    trace.prefix(healthyPrefix(fields));
    trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 1500, 30000) }));
    trace.modelResponse("native", summary);
    trace.final("native", summary, finalFields());
    trace.outcome("native");
}

/**
 * Schema drift only: a prefix record as a build before the rejection counters wrote it.
 *
 * The recorder cannot produce one, and inventing a cause for those records is the failure this guards.
 */
function stripCounters(session: string): void {
    const lines = readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { session?: string; stage?: string; prefix?: unknown });

    for (const line of lines) {
        if (line.stage !== "prefix" || line.session !== session) {
            continue;
        }
        const prefix = line.prefix as Partial<CompactionPrefixFields>;
        delete prefix.rejectSystemHash;
        delete prefix.rejectToolsHash;
    }

    writeFileSync(logPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

let script: BundledScript;

beforeAll(() => {
    // This suite spawns the script 60+ times, so the ~130ms tsx launcher cost per call would dominate;
    // bundle once and spawn plain node against the bundle (~30ms each) instead.
    script = bundleScript(SCRIPT, "pi-compaction-report-");
});

afterAll(() => {
    script.dispose();
});

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
        // Not estimate-skew, which this state used to assert. The 08:55 run it replays estimated 644k against a
        // provider count of 509k for the same request - 26%, ordinary tokenizer error - and the flag only fired
        // because it was comparing that estimate against pi's count for the *whole* context (533k), two different
        // bodies. A repaired comparison says what the live run was: a refused checkpoint, not a mis-sized request.
        expect(keys).not.toContain("estimate-skew");
        // The prefix itself was fine, so the cost flag must not be misread as an alignment failure.
        expect(keys).not.toContain("prefix-unusable");
        expect(parseReport().aggregates.flags["degenerate-native-output"]).toBe(1);

        const text = runText(["--suspect"]);
        expect(text.stdout).toContain("stage 1 accepted with 45 chars");
        expect(text.stdout).toContain("45 checkpoint chars -> 8291 final chars");
        expect(text.stdout).toContain("702 transcript blocks left out");
    });

    it("names a cut point that named nothing, and lets the inference keep quiet", () => {
        const trace = recorder("sess-uncut");
        const summary = checkpoint("## Goal", 4000);
        // An uncut span is also a span no shorter than its reference, which is the shape `span-not-truncated`
        // reads as "the whole context went out again". Both describe this run; only one of them is a fact rather
        // than an inference from a depth comparison.
        trace.prefix(healthyPrefix({ truncated: false }));
        trace.attempt(
            "native",
            nativeFields({ cutFound: false, messageCount: 84 }),
            accepted({ usage: usage(2000, 1500, 30000) }),
        );
        trace.modelResponse("native", summary);
        trace.final("native", summary, finalFields());
        trace.outcome("native");

        const keys = flagKeys(parseReport(), "sess-uncut");
        expect(keys).toContain("cut-not-found");
        expect(keys).not.toContain("span-not-truncated");
        expect(flagDetail(parseReport(), "sess-uncut", "cut-not-found")).toContain(
            "read all 84 messages",
        );
        expect(runText(["--session", "sess-uncut"]).stdout).toContain("cut=missing");
    });

    it("keeps a record that predates the cut point distinct from one that found it", () => {
        const trace = recorder("sess-oldcut");
        const summary = checkpoint("## Goal", 4000);
        trace.prefix(healthyPrefix());
        trace.attempt(
            "native",
            nativeFields({ cutFound: undefined }),
            accepted({ usage: usage(2000, 1500, 30000) }),
        );
        trace.modelResponse("native", summary);
        trace.final("native", summary, finalFields());
        trace.outcome("native");

        expect(flagKeys(parseReport(), "sess-oldcut")).toEqual([]);
        expect(runText(["--session", "sess-oldcut"]).stdout).toContain("cut=unrecorded");
    });

    it("says which way the estimate and the provider disagree about the same request", () => {
        const clip = recorder("sess-clip");
        clip.prefix(healthyPrefix());
        // We described a 90k-token request and the provider counted 32k for it. Either the endpoint took less
        // than we sent - the silent overflow pi's own docs attribute to z.ai, MiMo and Ollama - or chars/4 badly
        // over-reads this content, and the flag has to say both because the record cannot tell them apart.
        clip.attempt(
            "native",
            nativeFields({ estimatedTokens: 90_000 }),
            accepted({ usage: usage(2000, 1500, 30000) }),
        );
        clip.modelResponse("native", checkpoint("## Goal", 4000));
        clip.final("native", checkpoint("## Goal", 4000), finalFields());
        clip.outcome("native");

        const under = recorder("sess-under");
        under.prefix(healthyPrefix());
        // The other direction has a single meaning: the request was larger than the estimate said, so the fit
        // gate decided on a number too small for what it sent.
        under.attempt(
            "native",
            nativeFields({ estimatedTokens: 8_000 }),
            accepted({ usage: usage(30_000, 1500, 170_000) }),
        );
        under.modelResponse("native", checkpoint("## Goal", 4000));
        under.final("native", checkpoint("## Goal", 4000), finalFields());
        under.outcome("native");

        const report = parseReport();
        expect(flagDetail(report, "sess-clip", "estimate-skew")).toContain(
            "estimate 90.0k (chars/4) vs 32.0k counted for the same request",
        );
        expect(flagDetail(report, "sess-clip", "estimate-skew")).toContain("clipped the input");
        expect(flagDetail(report, "sess-under", "estimate-skew")).toContain(
            "estimate 8000 (chars/4) vs 200k counted for the same request",
        );
        expect(flagDetail(report, "sess-under", "estimate-skew")).toContain("under-counts");
    });

    it("names the method behind an estimate, including on a record that carried none", () => {
        const anchored = recorder("sess-anchor");
        anchored.prefix(healthyPrefix());
        anchored.attempt(
            "native",
            nativeFields({ estimateSource: "usage-anchor", estimatedTokens: 32_500 }),
            accepted({ usage: usage(2000, 1500, 30000) }),
        );
        anchored.modelResponse("native", checkpoint("## Goal", 4000));
        anchored.final("native", checkpoint("## Goal", 4000), finalFields());
        anchored.outcome("native");

        const heuristic = recorder("sess-heuristic");
        heuristic.prefix(healthyPrefix());
        heuristic.attempt(
            "native",
            nativeFields({ estimatedTokens: 38_400 }),
            accepted({ usage: usage(2000, 1500, 30000) }),
        );
        heuristic.modelResponse("native", checkpoint("## Goal", 4000));
        heuristic.final("native", checkpoint("## Goal", 4000), finalFields());
        heuristic.outcome("native");

        const old = recorder("sess-oldest");
        old.prefix(healthyPrefix());
        old.attempt(
            "native",
            nativeFields({ estimateSource: undefined, estimatedTokens: 38_400 }),
            accepted({ usage: usage(2000, 1500, 30000) }),
        );
        old.modelResponse("native", checkpoint("## Goal", 4000));
        old.final("native", checkpoint("## Goal", 4000), finalFields());
        old.outcome("native");

        expect(runText(["--session", "sess-anchor"]).stdout).toContain("est=32.5k src=anchor");
        expect(runText(["--session", "sess-heuristic"]).stdout).toContain("est=38.4k src=chars4");
        expect(runText(["--session", "sess-oldest"]).stdout).toContain("src=unrecorded");
    });

    it("holds a span-anchored estimate to the band its own accuracy supports", () => {
        // Both runs estimated 20% above the provider's count for the same request. That is noise for chars/4,
        // which measures +40% mean error here, and a fact about an anchored count, which measures +2%. One
        // threshold for both would either bury the anchor or cry wolf on the heuristic.
        const state = (session: string, fields: Partial<CompactionAttemptFields>) => {
            const trace = recorder(session);
            trace.prefix(healthyPrefix());
            trace.attempt(
                "native",
                nativeFields(fields),
                accepted({ usage: usage(2000, 1500, 30000) }),
            );
            trace.modelResponse("native", checkpoint("## Goal", 4000));
            trace.final("native", checkpoint("## Goal", 4000), finalFields());
            trace.outcome("native");
        };

        state("sess-anchor-band", {
            estimateSource: "usage-anchor",
            estimatedTokens: 38_400,
        });
        state("sess-heuristic-band", { estimatedTokens: 38_400 });

        const report = parseReport();
        expect(flagKeys(report, "sess-anchor-band")).toContain("estimate-skew");
        expect(flagKeys(report, "sess-heuristic-band")).toEqual([]);
        expect(flagDetail(report, "sess-anchor-band", "estimate-skew")).toContain("(anchored)");
        expect(flagDetail(report, "sess-anchor-band", "estimate-skew")).toContain("band 15%");
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
                // A run with no reference has nothing on its branch either; a fixture that claimed otherwise
                // would contradict the guarantee the invariant section checks.
                chainObservations: 0,
                branchObservations: 0,
                parentRequest: undefined,
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

    it("names which of the three chain states left the reference empty", () => {
        // Held, on-branch, comparable: three different zeros that the record used to render identically, and
        // picking the wrong one sends the reader to the wrong subsystem.
        const states: [string, string, Partial<CompactionPrefixFields>][] = [
            [
                "sess-cold",
                "chain-empty",
                { chainObservations: 0, branchObservations: 0, observations: 0 },
            ],
            [
                "sess-off-branch",
                "chain-off-branch",
                { chainObservations: 9, branchObservations: 0, observations: 0 },
            ],
            [
                "sess-incomparable",
                "chain-incomparable",
                {
                    chainObservations: 9,
                    branchObservations: 4,
                    observations: 0,
                    rejectSystemHash: 4,
                    rejectToolsHash: 0,
                },
            ],
            [
                "sess-partial",
                "chain-incomparable",
                {
                    // Two of four rejected on the prompt and two comparable: the funnel is not empty, so the
                    // suspect stays off and only the counts can tell this story.
                    chainObservations: 9,
                    branchObservations: 4,
                    observations: 2,
                    rejectSystemHash: 2,
                    rejectToolsHash: 0,
                },
            ],
        ];

        for (const [session, , fields] of states) {
            const trace = recorder(session);
            trace.prefix(healthyPrefix({ reference: "chain", prefixUsable: undefined, ...fields }));
            trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 1500, 30000) }));
            const summary = checkpoint("## Goal", 4000);
            trace.modelResponse("native", summary);
            trace.final("native", summary, finalFields());
            trace.outcome("native");
        }

        const report = parseReport();
        expect(flagKeys(report, "sess-cold")).toContain("chain-empty");
        expect(flagKeys(report, "sess-off-branch")).toContain("chain-off-branch");
        expect(flagKeys(report, "sess-incomparable")).toContain("chain-incomparable");
        expect(flagKeys(report, "sess-partial")).not.toContain("chain-incomparable");
        // Which gate rejected, named in the suspect rather than asserted about both halves: the old sentence
        // claimed a tool-set difference on a run whose tool set was identical.
        expect(flagDetail(report, "sess-incomparable", "chain-incomparable")).toBe(
            "4 on-branch entries, 4 rejected by the system prompt and 0 by the tool set",
        );
        // The funnel prints, oldest state first: held / on branch / comparable.
        expect(runText(["--session", "sess-off-branch"]).stdout).toContain("chain=9/0/0");
        expect(runText(["--session", "sess-incomparable"]).stdout).toContain("rej=4sys/0tools");
        expect(runText(["--session", "sess-partial"]).stdout).toContain("chain=9/4/2");
        expect(runText(["--session", "sess-partial"]).stdout).not.toContain("rej=");
    });

    it("flags a prompt difference that no length figure could show", () => {
        const trace = recorder("sess-drift");
        trace.prefix(
            healthyPrefix({
                ourRequest: { systemChars: 1200, systemHash: "ourhash000" },
                parentRequest: {
                    model: "test-model",
                    systemChars: 1200,
                    systemHash: "parent000",
                    toolsHash: "ccccdddd",
                    messageCount: 43,
                    leafId: "leaf-43",
                },
            }),
        );
        trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 1500, 30000) }));
        const summary = checkpoint("## Goal", 4000);
        trace.modelResponse("native", summary);
        trace.final("native", summary, finalFields());
        trace.outcome("native");

        // Equal length, unequal hash: the case where a size would have read as "unchanged".
        expect(flagKeys(parseReport(), "sess-drift")).toContain("system-prompt-drift");
        expect(runText(["--session", "sess-drift"]).stdout).toContain("sys=1200c");
    });

    it("lifts a decode value difference into the line, the suspect list, and the table", () => {
        // `parameters` is empty on purpose: identical key sets over different values is exactly what the value
        // tier exists to catch, and it must not read as a clean prefix verdict.
        const trace = recorder("sess-decode");
        trace.prefix(
            healthyPrefix({
                parameters: [],
                divergences: ["enable_thinking:true!=false"],
                firstDivergence: "enable_thinking:true!=false",
                referenceSource: "ladder",
                otherDisagreements: 2,
                ourRequest: { enableThinking: true, maxTokens: 4096 },
                parentRequest: {
                    model: "test-model",
                    systemChars: 1200,
                    systemHash: "aaaabbbb",
                    toolsHash: "ccccdddd",
                    messageCount: 43,
                    leafId: "leaf-43",
                    enableThinking: false,
                    maxTokens: 4096,
                },
            }),
        );
        const summary = checkpoint("## Goal", 4000);
        trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 1500, 30000) }));
        trace.modelResponse("native", summary);
        trace.final("native", summary, finalFields());
        trace.outcome("native");

        const text = runText().stdout;
        expect(text).toContain("div=enable_thinking:true!=false");
        // Which reference the depths came from, and that others disagreed somewhere without moving them.
        expect(text).toContain("ref=ladder");
        expect(text).toContain("elsewhere=2");
        expect(text).toContain("enable_thinking=ours:true parent:false");
        expect(flagKeys(parseReport(), "sess-decode")).toContain("decode-divergence");
    });

    it("flags a disagreement printed inside the agreement it should have sat below", () => {
        // Heads are cumulative, so a mismatch within one reference is always deeper than that reference's
        // agreement. A record claiming both at once merged two references into one verdict - the bug the
        // credited-reference pass removed, kept dead by this check.
        const trace = recorder("sess-merged");
        trace.prefix(healthyPrefix({ commonPrefixMessages: 42, firstMismatchDepth: 20 }));
        const summary = checkpoint("## Goal", 4000);
        trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 1500, 30000) }));
        trace.modelResponse("native", summary);
        trace.final("native", summary, finalFields());
        trace.outcome("native");

        const text = runText().stdout;
        expect(text).toContain("INVARIANTS");
        expect(text).toContain("mismatch-inside-verified");
    });

    it("separates a reference too shallow for the span from one the shape gate rejected", () => {
        runWithPrefix("sess-depth-gap", {
            prefixUsable: undefined,
            comparableDepth: -1,
            commonPrefixMessages: -1,
            verifiedThrough: false,
            observations: 2,
            referenceDepth: 90,
            ourMessageCount: 12,
        });
        runWithPrefix("sess-shape-gate", {
            prefixUsable: undefined,
            comparableDepth: -1,
            commonPrefixMessages: -1,
            verifiedThrough: false,
            observations: 0,
            chainObservations: 9,
            branchObservations: 3,
            rejectSystemHash: 3,
            rejectToolsHash: 0,
            ourMessageCount: 12,
        });

        const report = parseReport();
        expect(flagKeys(report, "sess-depth-gap")).toContain("prefix-uncomparable");
        expect(flagDetail(report, "sess-depth-gap", "prefix-uncomparable")).toContain(
            "no reference shared a depth with the span",
        );
        // One fact, one flag. The shape gate is `chain-incomparable`'s to name, and printing a depth sentence over
        // it pointed at the cut point on a run where the request body was the cause.
        expect(flagKeys(report, "sess-shape-gate")).not.toContain("prefix-uncomparable");
        expect(flagKeys(report, "sess-shape-gate")).toContain("chain-incomparable");
    });

    it("says a record predates the counters rather than guessing a cause for it", () => {
        runWithPrefix("sess-old-record", {
            prefixUsable: undefined,
            comparableDepth: -1,
            commonPrefixMessages: -1,
            verifiedThrough: false,
            observations: 0,
            chainObservations: 9,
            branchObservations: 3,
        });
        stripCounters("sess-old-record");

        const report = parseReport();
        expect(flagDetail(report, "sess-old-record", "chain-incomparable")).toContain(
            "record predates the rejection counters",
        );
        expect(runText(["--session", "sess-old-record"]).stdout).not.toContain("rej=");
        // Without counters the depth flag stays on, since nothing else in the record can say why it fired.
        expect(flagKeys(report, "sess-old-record")).toContain("prefix-uncomparable");
        expect(flagDetail(report, "sess-old-record", "prefix-uncomparable")).not.toContain(
            "no reference shared a depth",
        );
    });

    it("flags an emptied funnel that no rejection accounts for", () => {
        runWithPrefix("sess-unaccounted", {
            prefixUsable: undefined,
            comparableDepth: -1,
            commonPrefixMessages: -1,
            verifiedThrough: false,
            observations: 0,
            chainObservations: 9,
            branchObservations: 3,
            rejectSystemHash: 0,
            rejectToolsHash: 0,
        });

        // `compareObservation` returns a comparison for every row passing both hashes, so this record describes
        // an instrument that disagrees with itself, which is not a finding about anyone's cache.
        expect(runText().stdout).toContain("incomparable-without-rejection");
    });

    it("reports a broken instrument as an invariant violation, not as a finding", () => {
        const trace = recorder("sess-contradiction");
        // reference=none is only reachable with nothing on the branch, so this record cannot be honest about
        // both fields at once.
        trace.prefix(
            healthyPrefix({ reference: "none", prefixUsable: undefined, branchObservations: 3 }),
        );
        trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 1500, 30000) }));
        const summary = checkpoint("## Goal", 4000);
        trace.modelResponse("native", summary);
        trace.final("native", summary, finalFields());
        trace.outcome("native");

        const text = runText([]).stdout;
        expect(text).toContain("INVARIANTS");
        expect(text).toContain("none-with-branch");
    });

    it("prints what the record cannot answer, apart from what it suspects", () => {
        const trace = recorder("sess-unknowns");
        trace.prefix(
            healthyPrefix({
                reference: "none",
                prefixUsable: undefined,
                divergences: ["no-reference"],
                firstDivergence: "no-reference",
                commonPrefixMessages: -1,
                referenceDepth: -1,
                observations: 0,
                chainObservations: 0,
                branchObservations: 0,
                parentRequest: undefined,
                unknowns: ["cache reuse: this run cannot tell a miss from an unverifiable prefix"],
            }),
        );
        trace.attempt("native", nativeFields(), accepted({ usage: usage(2000, 1500, 30000) }));
        const summary = checkpoint("## Goal", 4000);
        trace.modelResponse("native", summary);
        trace.final("native", summary, finalFields());
        trace.outcome("native");

        expect(runText(["--session", "sess-unknowns"]).stdout).toContain(
            "~ cannot tell: cache reuse: this run cannot tell a miss from an unverifiable prefix",
        );
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
                    firstDivergence: "keys:+presence_penalty",
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

        // This fixture deliberately contains junk: one foreign object and one torn line. Both are counted,
        // separately, and neither is guessed at - so read the JSON directly rather than through `parseReport`.
        const junky = runScript(["--json"]);
        expect(junky.status).toBe(0);
        const report = JSON.parse(junky.stdout) as ReportJson;
        expect(report.total).toBe(2);
        // A record from another tool is `skipped`; a line that cannot be parsed at all is `malformed`.
        expect(report.skipped).toBe(1);
        expect(report.malformed).toBe(1);

        const legacy = report.runs.find((run) => run.session === "sess-legacy");
        expect(legacy?.prefix?.divergences).toEqual([]);
        expect(legacy?.route).toBeUndefined();
        // A run with no outcome record fell back, because nothing was persisted through us.
        // `truncated` is absent in this old record, so the span flag must not fire on an unknown.
        expect(legacy?.flags.map((flag) => flag.key)).toEqual(["prefix-unusable", "fell-back"]);

        // The same counts reach the human report, where a gap has to be visible in the header.
        const result = runScript([]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("(1 foreign skipped) (1 unreadable)");
        expect(result.stderr).not.toContain("unparsable");
    });

    it("counts persisted chain rows apart from run records", () => {
        writeHealthyRun("sess-chain");
        appendFileSync(
            logPath,
            '{"v":1,"stage":"chain_request","ts":"2026-09-05T19:00:00.000Z","session":"sess-chain",' +
                '"cwd":"/tmp","leafId":"leaf-1","depth":9,"head":"aabbccdd","systemHash":"sh",' +
                '"toolsHash":"th","systemChars":10,"model":"m","keys":["messages"]}\n',
        );
        appendFileSync(
            logPath,
            '{"v":1,"stage":"chain_ladder","ts":"2026-09-05T19:00:00.001Z","session":"sess-chain",' +
                '"cwd":"/tmp","leafId":"leaf-1","depth":9,"shapeKey":"sk","heads":["aabbccdd"]}\n',
        );

        const report = parseReport();
        // Rows the recorder wrote per provider request belong to no compaction: they must not open a run, and
        // they must not read as foreign junk either. Both counts are stated, neither is merged.
        expect(report.total).toBe(1);
        expect(report.skipped).toBe(0);
        expect(report.malformed).toBe(0);
        expect(report.chainRows).toBe(2);
        expect(runText().stdout).toContain("2 hash rows");
        // The count describes the report being read, so a session filter applies to it too.
        expect(runText(["--session", "sess-chain"]).stdout).toContain("2 hash rows");
        expect(runText(["--session", "sess-elsewhere"]).stdout).not.toContain("hash rows");
        // Every record names the load that wrote it, and the header says how many loads contributed.
        expect(report.instances).toEqual([expect.stringMatching(/^[0-9a-f]{8}$/)]);
        expect(runText().stdout).toMatch(/instance: [0-9a-f]{8}/);
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
        // Re-recorded 2026-09-06 from a fresh session on the new build, against the local llama.cpp server
        // (provider name normalized to `llamacpp`, as in the fixture this replaced). It is a stricter fixture
        // than the one it
        // replaced: no suspect fires, and it carries chain rows and stage text, so the persisted-chain path and
        // the report's text reconstruction are both exercised against real bytes rather than synthetic ones.
        const result = script.run(["--path", HEALTHY_FIXTURE, "--json"]);
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as ReportJson;

        expect(report.total).toBe(1);
        // 20 records on disk, 1 run: the 13 hash rows belong to no compaction, and counting them as one would
        // inflate every total the report prints.
        expect(report.chainRows).toBe(13);
        const [run] = report.runs;
        expect(run.route).toBe("two-stage");
        expect(run.prefix?.reference).toBe("chain");
        expect(run.prefix?.usable).toBe(true);
        // The claim this fixture exists to hold: every one of the 18 span depths the ladder could reach agreed.
        expect(run.prefix?.verifiedTo).toBe(18);
        expect(run.prefix?.comparableDepth).toBe(18);
        // pi's deepest request on the branch carried 31 messages while the truncated span held 18, so this is
        // truncation plus full verification rather than a short-circuited comparison.
        expect(run.prefix?.referenceDepth).toBe(31);
        expect(run.prefix?.verifiedThrough).toBe(true);
        expect(run.prefix?.observations).toBe(12);
        // Attribution: one credited observation, no disagreement filed anywhere else, nothing unanswerable.
        expect(run.prefix?.referenceSource).toBe("observation");
        expect(run.prefix?.otherDisagreements).toBe(0);
        expect(run.prefix?.firstMismatchDepth).toBeNull();
        expect(run.prefix?.unknowns).toEqual([]);
        // Body parity, which is the whole point of the `tool_choice` and thinking-level work: our rebuild sent
        // no key pi's turn requests lacked, and dropped none they had. The output cap still differs by design
        // (4369 against pi's 128000), which is recorded rather than flagged.
        expect(run.prefix?.parameters).toEqual([]);
        expect(run.prefix?.ourSystemChars).toBe(25543);
        expect(run.prefix?.parentSystemChars).toBe(25543);
        expect(run.cachedTokens).toBeGreaterThan(run.freshTokens);
        expect(run.checkpointChars).toBe(5817);
        expect(run.finalChars).toBe(5333);
        expect(run.flags.map((flag) => flag.key)).toEqual([]);

        const text = script.run(["--path", HEALTHY_FIXTURE, "--runs", "1"]);
        expect(text.stdout).toContain("reference=chain  usable=true  verified=18/18");
        expect(text.stdout).toContain("13 hash rows");
        expect(text.stdout).toContain("records:  7 in 1 run(s)");
        expect(text.stdout).toContain("INVARIANTS (0 distinct");
        // The fixture carries `model_response` records, so stage text is reconstructable rather than inferred.
        expect(report.runs[0].texts).toHaveProperty("native");
        expect(report.runs[0].texts).toHaveProperty("serialized");
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
