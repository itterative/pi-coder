import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompactionTraceRecord } from "../../../src/modules/compaction/trace";
import {
    createCompactionHarness,
    messageChain,
    sampleKept,
    failedResponse,
    summaryResponse,
    toolCallResponse,
    truncatedResponse,
    userMessage,
} from "../../helpers/compaction-doubles";
import { zeroUsage } from "../../helpers/agent-doubles";
import { stubModel } from "../../helpers/pi-stub";

const TRACE_FILE = "compaction-trace.jsonl";

/**
 * Run records only. The trace file also carries chain rows, which are written per provider request and belong to
 * no run, so a test that asserts on one compaction's stages has to say which records it means.
 */
function readRecords(filePath: string): CompactionTraceRecord[] {
    return readChainRowsSplit(filePath).runs;
}

function readChainRowsSplit(filePath: string): {
    runs: CompactionTraceRecord[];
    chain: Record<string, unknown>[];
} {
    const runs: CompactionTraceRecord[] = [];
    const chain: Record<string, unknown>[] = [];

    for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        const record = JSON.parse(line) as Record<string, unknown>;
        const stage = String(record.stage ?? "");
        if (stage.startsWith("chain_")) {
            chain.push(record);
            continue;
        }

        runs.push(record as unknown as CompactionTraceRecord);
    }

    return { runs, chain };
}

describe("compaction trace", () => {
    let root = "";
    let tracePath = "";

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "pi-coder-compaction-trace-"));
        tracePath = path.join(root, TRACE_FILE);
        // See the note in handler.test.ts: the retry budget is zeroed so no test waits on a real backoff.
        const configDefaults = path.join(root, "test-defaults.json");
        writeFileSync(configDefaults, JSON.stringify({ retryMaxRetries: 0 }));
        vi.stubEnv("COMPACTION_CONFIG_PATH", configDefaults);
        vi.stubEnv("COMPACTION_CONFIG_PATH_GLOBAL", path.join(root, "absent-global.json"));
        // test/setup.ts disables the trace so no suite can write this checkout's .state; re-enable it here
        // pointed at the suite's own temporary directory.
        vi.stubEnv("COMPACTION_TRACE", "1");
        vi.stubEnv("COMPACTION_CHAIN_TRACE", "1");
        vi.stubEnv("COMPACTION_TRACE_PATH", tracePath);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
    });

    function build(input: {
        responses: Array<() => Promise<ReturnType<typeof summaryResponse>>>;
        config?: Record<string, unknown>;
        contextWindow?: number;
        systemPrompt?: string;
        branch?: SessionEntry[];
        providerPayload?: unknown;
    }) {
        if (input.config) {
            const configPath = path.join(root, "compaction-config.json");
            writeFileSync(configPath, JSON.stringify(input.config));
            vi.stubEnv("COMPACTION_CONFIG_PATH", configPath);
        }
        return createCompactionHarness({
            cwd: root,
            responses: input.responses,
            branch: input.branch,
            providerPayload: input.providerPayload,
            systemPrompt: input.systemPrompt,
            model: input.contextWindow
                ? stubModel({ contextWindow: input.contextWindow })
                : undefined,
        });
    }

    it("writes nothing while disabled, which is how the suites stay out of the repo's .state", async () => {
        vi.stubEnv("COMPACTION_TRACE", "0");
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
        });
        await harness.compact();
        expect(existsSync(tracePath)).toBe(false);
    });

    it("honors traceEnabled false from config when no env switch is set", async () => {
        vi.stubEnv("COMPACTION_TRACE", "");
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
            config: { traceEnabled: false },
        });
        await harness.compact();
        expect(existsSync(tracePath)).toBe(false);
    });

    it("records the model response and the composed summary under one id", async () => {
        const harness = build({
            responses: [
                async () =>
                    summaryResponse(
                        "## Goal\n\nthe model answer\n\n## Progress\n\n- [x] the model answer",
                    ),
            ],
        });
        const payload = await harness.compact();

        const records = readRecords(tracePath);
        const stages = records
            .filter((record) => record.stage !== "prefix")
            .map((record) => record.stage);
        expect(stages).toEqual([
            "attempt",
            "model_response",
            "attempt",
            "model_response",
            "final_summary",
            "outcome",
        ]);
        expect(new Set(records.map((record) => record.id)).size).toBe(1);

        for (const record of records) {
            expect(record.session).toBe("session-1");
            expect(record.cwd).toBe(root);
            expect(record.reason).toBe("threshold");
            expect(record.willRetry).toBe(false);
            expect(record.v).toBe(1);
        }

        const byStage = new Map(records.map((record) => [record.stage, record]));
        const modelResponses = records.filter((record) => record.stage === "model_response");
        // (a) exactly what each model said, before the harness appended anything.
        expect(modelResponses.map((record) => record.text)).toEqual([
            "## Goal\n\nthe model answer\n\n## Progress\n\n- [x] the model answer",
            "## Goal\n\nthe model answer\n\n## Progress\n\n- [x] the model answer",
        ]);
        // (b) what actually goes into the CompactionEntry.
        expect(byStage.get("final_summary")?.text).toBe(payload?.summary);
        expect(byStage.get("final_summary")?.text).toContain("## Tool Ledger");
        expect(byStage.get("final_summary")?.text).toContain("<read-files>");
        expect(byStage.get("final_summary")?.final).toMatchObject({
            firstKeptEntryId: "kept-1",
            tokensBefore: 190_000,
            summarizedMessages: 4,
            droppedBlocks: 0,
            readFiles: 1,
            modifiedFiles: 1,
        });
        expect(byStage.get("outcome")?.outcome).toBe("two-stage");
    });

    it("records the numbers that decided the strategy, including the cache evidence", async () => {
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
        });
        await harness.compact();

        const records = readRecords(tracePath);
        const attempt = records.find((record) => record.stage === "attempt");
        expect(attempt?.strategy).toBe("native");
        expect(attempt?.outcome).toBe("accepted");
        expect(attempt?.attempt).toMatchObject({
            provider: "anthropic",
            model: "stub-model",
            maxTokens: 2_730,
            contextWindow: 200_000,
            toolCount: 2,
            messageCount: 4,
            copiedEntries: 4,
        });
        expect(attempt?.attempt?.estimatedTokens).toBeGreaterThan(0);
        // The usage on the accepted attempt is how a cache hit is read out of this file.
        expect(attempt?.usage).toMatchObject({
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        });

        const reduce = records.filter((record) => record.stage === "attempt")[1];
        expect(reduce?.strategy).toBe("serialized");
        expect(reduce?.attempt).toMatchObject({ messageCount: 1, toolCount: 0 });
        // Both stages are answered by the same stub response in this suite, so the reduce is handed exactly
        // the segment text it should report having received.
        expect(reduce?.attempt?.segmentSummaryChars).toBe(
            "## Goal\n\nstub\n\n## Progress\n\n- [x] stub".length,
        );
    });

    it("records a rejected native attempt before the serialized one that saved it", async () => {
        const harness = build({
            responses: [
                async () => toolCallResponse("read"),
                async () => summaryResponse("## Goal\n\nsalvaged\n\n## Progress\n\n- [x] salvaged"),
            ],
        });
        await harness.compact();

        const records = readRecords(tracePath);
        const attempts = records.filter((record) => record.stage === "attempt");
        expect(attempts.map((record) => [record.strategy, record.outcome])).toEqual([
            ["native", "rejected"],
            ["serialized", "accepted"],
        ]);
        expect(attempts[0]?.detail).toContain("despite the no-tools instruction");
        expect(attempts[0]?.usage).toBeDefined();
        expect(attempts[1]?.attempt).toMatchObject({ toolCount: 0, messageCount: 1 });
        expect(attempts[1]?.attempt?.segmentSummaryChars).toBe(0);
        expect(records.find((record) => record.stage === "outcome")?.outcome).toBe("serialized");
    });

    /**
     * A reply the output limit cut off is indistinguishable from a short complete one by reading it, so this is
     * the whole of the evidence. Stage 1 refuses it because the checkpoint feeds stage 2 and its context is
     * cached anyway; stage 2 keeps it because the alternative is pi re-summarizing the session from scratch.
     */
    it("refuses a truncated stage 1 answer and records the stop reason on both rungs", async () => {
        const checkpoint = "## Goal\n\nstub\n\n## Progress\n\n- [x] stub";
        const harness = build({
            responses: [
                async () => truncatedResponse(checkpoint, { ...zeroUsage(), output: 8000 }),
                async () => truncatedResponse(checkpoint, { ...zeroUsage(), output: 1200 }),
            ],
        });
        await harness.compact();

        const attempts = readRecords(tracePath).filter((record) => record.stage === "attempt");
        expect(
            attempts.map((record) => [record.strategy, record.outcome, record.stopReason]),
        ).toEqual([
            ["native", "rejected", "length"],
            ["serialized", "accepted", "length"],
        ]);
        expect(attempts[0]?.detail).toContain("hit the output limit after 8000 output tokens");
        // The truncated reduce answer still becomes the session's summary, which is the trade being made.
        expect(readRecords(tracePath).find((record) => record.stage === "outcome")?.outcome).toBe(
            "serialized",
        );
    });

    /**
     * The cause is what makes these records mineable: `detail` is a free-text message from some provider's own
     * wording, while `cause` is the one word that says whether the next rung had any chance.
     */
    it("records the cause that decided the cascade, and the rung it stopped", async () => {
        const harness = build({
            responses: [
                async () =>
                    failedResponse("error", "429 insufficient_quota: check your billing details"),
                async () => {
                    throw new TypeError("the reduce must not be attempted");
                },
            ],
        });
        await harness.compact();

        const records = readRecords(tracePath);
        const attempts = records.filter((record) => record.stage === "attempt");
        expect(
            attempts.map((record) => [
                record.strategy,
                record.outcome,
                record.cause,
                record.retries,
            ]),
        ).toEqual([
            ["native", "rejected", "quota", 0],
            // The rung that never ran is recorded as skipped rather than left out, so an absent request cannot
            // be mistaken for an absent budget: the cascade stopped here on purpose.
            ["serialized", "skipped", "quota", 0],
        ]);
        expect(attempts[1]?.detail).toContain("not attempted: quota");
        expect(attempts[1]?.detail).toContain("an account limit");
        expect(records.find((record) => record.stage === "outcome")?.outcome).toBe("abandoned");
    });

    it("records a skipped attempt with the estimate that made it unfit", async () => {
        const thresholdSized = messageChain([
            { id: "big-1", message: userMessage("q".repeat(750_000)) },
            { id: "kept-1", message: sampleKept()[0] },
        ]);
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nnarrow\n\n## Progress\n\n- [x] narrow"),
            ],
            contextWindow: 200_000,
            branch: thresholdSized,
        });
        await harness.compact();

        const records = readRecords(tracePath);
        const native = records.find(
            (record) => record.stage === "attempt" && record.strategy === "native",
        );
        expect(native?.outcome).toBe("accepted");

        const tooNarrow = build({
            responses: [
                async () => summaryResponse("## Goal\n\nnarrow\n\n## Progress\n\n- [x] narrow"),
            ],
            contextWindow: 4_000,
            branch: thresholdSized,
        });
        await tooNarrow.compact({ customInstructions: "narrow the scope" });
        const skipped = readRecords(tracePath)
            .slice(records.length)
            .find((record) => record.strategy === "native" && record.outcome === "skipped");
        expect(skipped?.detail).toContain("does not fit the window");
        expect(skipped?.attempt?.estimatedTokens).toBeGreaterThan(0);
        expect(skipped?.attempt?.customInstructions).toBe("narrow the scope");
    });

    it("records the transcript counts for an overflow compaction", async () => {
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\noverflow\n\n## Progress\n\n- [x] overflow"),
            ],
            systemPrompt: "a prompt long enough to push the estimate past four thousand tokens",
        });
        await harness.compact({ reason: "overflow", willRetry: true });

        const records = readRecords(tracePath);
        const attempt = records.find((record) => record.stage === "attempt");
        expect(attempt?.strategy).toBe("serialized");
        expect(attempt?.attempt?.serializedChars).toBeGreaterThan(0);
        expect(records.find((record) => record.stage === "outcome")?.outcome).toBe("serialized");
        expect(records.some((record) => record.stage === "model_response")).toBe(true);
    });

    it("records the fall-through to pi's default and nothing for the failed attempts' texts", async () => {
        const harness = build({
            responses: [
                async () => {
                    throw new Error("provider unavailable");
                },
                async () => summaryResponse("   "),
            ],
        });
        await harness.compact();

        const records = readRecords(tracePath);
        expect(
            records.filter((record) => record.stage === "attempt").map((r) => r.outcome),
        ).toEqual(["rejected", "rejected"]);
        expect(records.some((record) => record.stage === "model_response")).toBe(false);
        expect(records.some((record) => record.stage === "final_summary")).toBe(false);
        const outcome = records.find((record) => record.stage === "outcome");
        expect(outcome?.outcome).toBe("core-default");
        expect(outcome?.detail).toContain("segment: provider unavailable");
        expect(outcome?.detail).toContain("reduce: summarization returned an empty summary");
    });

    it("records a cancelled compaction without calling the provider", async () => {
        const controller = new AbortController();
        controller.abort();
        const harness = createCompactionHarness({
            cwd: root,
            responses: [async () => summaryResponse("unused")],
            signal: controller.signal,
        });
        await harness.invoke();

        const records = readRecords(tracePath);
        expect(records).toHaveLength(1);
        expect(records[0]?.stage).toBe("outcome");
        expect(records[0]?.outcome).toBe("cancelled");
    });

    it("verifies the rebuilt request against the parent's observed requests", async () => {
        const parentBody = {
            model: "stub-model",
            system: "the live system prompt",
            tools: [{ name: "bash", input_schema: { type: "object" } }],
            messages: [{ role: "user", content: "fix the compaction module" }],
        };
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
            providerPayload: {
                ...parentBody,
                messages: [...parentBody.messages, { role: "user", content: "instruction" }],
            },
        });
        const seed = harness.piStub.requireHandler("before_provider_request", 0);
        await seed({ type: "before_provider_request", payload: parentBody }, harness.ctx);

        const records = (await harness.compact(), readRecords(tracePath));
        // Records name the load that wrote them: a session outlives its reloads, and the chains behind two loads
        // are not the same chain. Without this, cross-process rows in one file are indistinguishable.
        const instances = new Set(
            records.map((entry) => (entry as unknown as { instance: string }).instance),
        );
        expect([...instances]).toEqual([expect.stringMatching(/^[0-9a-f]{8}$/)]);

        const order = records.map((record) => record.stage);
        expect(order).toEqual([
            "prefix",
            "attempt",
            "model_response",
            "attempt",
            "model_response",
            "final_summary",
            "outcome",
        ]);

        const prefix = records[0]?.prefix;
        // Our span is the parent's messages, so it must verify at the only depth the reference covers.
        expect(prefix).toMatchObject({
            reference: "chain",
            prefixUsable: true,
            verifiedThrough: true,
            firstDivergence: "verified",
            ourMessageCount: 2,
            commonPrefixMessages: 1,
            referenceDepth: 1,
            observations: 1,
        });
        // The chain keeps hashes and counts, never bodies. The record names the parent's shape so that a prompt
        // or tool-set difference is visible without a second guess, and still carries no message content from
        // either side of the comparison.
        expect(prefix?.ourRequest).toMatchObject({
            model: "stub-model",
            toolCount: 1,
            messageCount: 2,
        });
        expect(prefix?.parentRequest).toMatchObject({
            model: "stub-model",
            messageCount: 1,
            leafId: "kept-2",
            systemHash: expect.any(String),
        });
        expect(JSON.stringify(prefix ?? {})).not.toContain('"content"');
        // Both sides now hash the whole system text, so an equal pair of hashes really does mean an equal
        // prompt. The recorded hash used to cover a 320-char excerpt, which reported no change across a prompt
        // that had grown from 12817 to 24813 chars.
        expect(prefix?.ourRequest?.systemHash).toBe(prefix?.parentRequest?.systemHash);
        // The funnel, reported at each stage rather than only at the last one.
        expect(prefix?.chainObservations).toBe(1);
        expect(prefix?.branchObservations).toBe(1);
        expect(prefix?.observations).toBe(1);
        expect(prefix?.unknowns).toEqual([]);
    });

    it("names a decode value difference the key set cannot see", async () => {
        // Both bodies carry `enable_thinking`, so `parameters` comes back empty and the record would read as a
        // clean match. Only the values know that pi thought and our rebuild was told not to - the difference that
        // decides whether a templating server can reuse its prefix at all.
        const parentBody = {
            model: "stub-model",
            system: "the live system prompt",
            tools: [{ name: "bash", input_schema: { type: "object" } }],
            enable_thinking: true,
            reasoning_effort: "high",
            messages: [{ role: "user", content: "fix the compaction module" }],
        };
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
            providerPayload: {
                ...parentBody,
                enable_thinking: false,
                messages: [...parentBody.messages, { role: "user", content: "instruction" }],
            },
        });
        const observe = harness.piStub.requireHandler("before_provider_request", 0);
        await observe({ type: "before_provider_request", payload: parentBody }, harness.ctx);

        await harness.compact();

        const prefix = readRecords(tracePath).find((record) => record.stage === "prefix")?.prefix;

        expect(prefix?.divergences).toContain("enable_thinking:true!=false");
        // Keys identical, values not: this is the blind spot, pinned so it cannot come back as a clean verdict.
        expect(prefix?.parameters).toEqual([]);
        expect(prefix?.ourRequest).toMatchObject({
            enableThinking: false,
            maxTokens: null,
        });
        expect(prefix?.parentRequest).toMatchObject({
            enableThinking: true,
            reasoningEffort: "high",
        });
        // An effort our body never sent is unknown, not a second difference: no `reasoning_effort:` line.
        expect(prefix?.divergences ?? []).not.toContain("reasoning_effort:high!=(null)");
        expect(prefix).toMatchObject({
            referenceSource: "observation",
            otherDisagreements: 0,
            firstMismatchDepth: null,
            firstDivergence: "enable_thinking:true!=false",
        });
    });

    it("states the blind spot when the reference predates the decode fields", async () => {
        // A row recorded by an older build carries no values at all. Silence there would read as agreement, so
        // the record has to say it cannot tell - which is the same rule that made an empty chain print as
        // unknown rather than as a cache miss.
        const parentBody = {
            model: "stub-model",
            system: "the live system prompt",
            tools: [{ name: "bash", input_schema: { type: "object" } }],
            messages: [{ role: "user", content: "fix the compaction module" }],
        };
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
            providerPayload: {
                ...parentBody,
                max_completion_tokens: 2048,
                messages: [...parentBody.messages, { role: "user", content: "instruction" }],
            },
        });
        const observe = harness.piStub.requireHandler("before_provider_request", 0);
        await observe({ type: "before_provider_request", payload: parentBody }, harness.ctx);

        await harness.compact();

        const prefix = readRecords(tracePath).find((record) => record.stage === "prefix")?.prefix;

        expect(prefix?.unknowns).toContain(
            "decode values unknown: the credited reference was recorded before these fields existed",
        );
        // Unknown is not a difference: no value may be claimed against a reference that recorded none.
        const claimed = (prefix?.divergences ?? []).filter(
            (text) => text.startsWith("enable_thinking:") || text.startsWith("reasoning_effort:"),
        );
        expect(claimed).toEqual([]);
    });

    it("verifies the first compaction after a restart from the persisted chain alone", async () => {
        // The claim the store exists for. A reload hands the extension a new session manager for the same session
        // id, so the chain in memory is empty; without persistence that first compaction reports an empty chain
        // and the cache question goes unanswered exactly when it is most likely to have been broken.
        const parentBody = {
            model: "stub-model",
            system: "the live system prompt",
            tools: [{ name: "bash", input_schema: { type: "object" } }],
            messages: [{ role: "user", content: "fix the compaction module" }],
        };
        const harnessInput = {
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
            sessionId: "restart-session",
            providerPayload: {
                ...parentBody,
                messages: [...parentBody.messages, { role: "user", content: "instruction" }],
            },
        };

        const before = build(harnessInput);
        const observe = before.piStub.requireHandler("before_provider_request", 0);
        await observe({ type: "before_provider_request", payload: parentBody }, before.ctx);

        const after = build(harnessInput);
        await after.compact();

        const prefix = readRecords(tracePath).find((record) => record.stage === "prefix")?.prefix;
        expect(prefix).toMatchObject({
            reference: "chain",
            chainObservations: 1,
            branchObservations: 1,
            observations: 1,
            commonPrefixMessages: 1,
        });
        expect(prefix?.prefixUsable).toBe(true);
        // The rows came off disk, so they name the load that wrote them rather than this one.
        expect(prefix?.unknowns ?? []).not.toContain(
            "chain empty: no row for this session was found in the retained trace file",
        );
    });

    it("persists the chain into the same file, as rows belonging to no run", async () => {
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
            providerPayload: { model: "stub-model", messages: [] },
        });
        const seed = harness.piStub.requireHandler("before_provider_request", 0);
        await seed(
            {
                type: "before_provider_request",
                payload: {
                    model: "stub-model",
                    system: "base prompt",
                    tools: [{ name: "bash", input_schema: { type: "object" } }],
                    messages: [{ role: "user", content: "a sentence that must never reach disk" }],
                },
            },
            harness.ctx,
        );
        await harness.compact();

        const { chain } = readChainRowsSplit(tracePath);
        const stages = chain.map((row) => row.stage);
        expect(stages).toContain("chain_request");
        expect(stages).toContain("chain_ladder");
        // Persisted rows outlive the process that wrote them, so they name it.
        expect(chain[0]).toHaveProperty("instance");

        const request = chain.find((row) => row.stage === "chain_request");
        expect(request).toMatchObject({
            session: expect.any(String),
            depth: expect.any(Number),
            head: expect.any(String),
            systemHash: expect.any(String),
        });
        // The whole reason the chain may be persisted while bodies are not: this file holds hashes, depths, and
        // entry ids. One leaked message would make that claim false.
        expect(JSON.stringify(chain)).not.toContain("a sentence that must never reach disk");
        expect(JSON.stringify(chain)).not.toContain("base prompt");
    });

    it("leaves the prefix verdict unknown rather than unusable when nothing was observed", async () => {
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
            providerPayload: { model: "stub-model", messages: [] },
        });
        await harness.compact();

        const prefix = readRecords(tracePath).find((record) => record.stage === "prefix");
        expect(prefix?.prefix).toMatchObject({
            reference: "none",
            commonPrefixMessages: -1,
            referenceDepth: -1,
            firstDivergence: "no-reference",
            divergences: ["no-reference"],
        });
        // This is the case that used to read as a broken rebuild: no reference is not evidence of divergence.
        expect((prefix?.prefix ?? {}).prefixUsable).toBeUndefined();
        // And the state that an hour of debugging turned on: an empty chain is not a filtered chain, and the
        // record has to say which one it is because both used to print `observations: 0`.
        expect(prefix?.prefix).toMatchObject({
            chainObservations: 0,
            branchObservations: 0,
            observations: 0,
        });
        expect(prefix?.prefix?.parentRequest).toBeUndefined();
        expect(prefix?.prefix?.unknowns).toContain(
            "chain empty: no row for this session was found in the retained trace file",
        );
    });

    it("rotates the file once it passes the configured size", async () => {
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
            config: { traceMaxBytes: 1 },
        });
        await harness.compact();
        expect(existsSync(`${tracePath}.1`)).toBe(true);
    });

    it("keeps the trace file readable only by its owner", async () => {
        const harness = build({
            responses: [
                async () => summaryResponse("## Goal\n\nstub\n\n## Progress\n\n- [x] stub"),
            ],
        });
        await harness.compact();
        expect(statSync(tracePath).mode & 0o777).toBe(0o600);
    });
});
