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
    summaryResponse,
    toolCallResponse,
    userMessage,
} from "../../helpers/compaction-doubles";
import { stubModel } from "../../helpers/pi-stub";

const TRACE_FILE = "compaction-trace.jsonl";

function readRecords(filePath: string): CompactionTraceRecord[] {
    return readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as CompactionTraceRecord);
}

describe("compaction trace", () => {
    let root = "";
    let tracePath = "";

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "pi-coder-compaction-trace-"));
        tracePath = path.join(root, TRACE_FILE);
        vi.stubEnv("COMPACTION_CONFIG_PATH", path.join(root, "absent.json"));
        vi.stubEnv("COMPACTION_CONFIG_PATH_GLOBAL", path.join(root, "absent-global.json"));
        // test/setup.ts disables the trace so no suite can write this checkout's .state; re-enable it here
        // pointed at the suite's own temporary directory.
        vi.stubEnv("COMPACTION_TRACE", "1");
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
        const harness = build({ responses: [async () => summaryResponse("## Goal\n\nstub")] });
        await harness.compact();
        expect(existsSync(tracePath)).toBe(false);
    });

    it("honors traceEnabled false from config when no env switch is set", async () => {
        vi.stubEnv("COMPACTION_TRACE", "");
        const harness = build({
            responses: [async () => summaryResponse("## Goal\n\nstub")],
            config: { traceEnabled: false },
        });
        await harness.compact();
        expect(existsSync(tracePath)).toBe(false);
    });

    it("records the model response and the composed summary under one id", async () => {
        const harness = build({
            responses: [async () => summaryResponse("## Goal\n\nthe model answer")],
        });
        const payload = await harness.compact();

        const records = readRecords(tracePath);
        const stages = records
            .filter((record) => record.stage !== "prefix")
            .map((record) => record.stage);
        expect(stages).toEqual(["attempt", "model_response", "final_summary", "outcome"]);
        expect(new Set(records.map((record) => record.id)).size).toBe(1);

        for (const record of records) {
            expect(record.session).toBe("session-1");
            expect(record.cwd).toBe(root);
            expect(record.reason).toBe("threshold");
            expect(record.willRetry).toBe(false);
            expect(record.v).toBe(1);
        }

        const byStage = new Map(records.map((record) => [record.stage, record]));
        // (a) exactly what the model said, before the harness appended anything.
        expect(byStage.get("model_response")?.text).toBe("## Goal\n\nthe model answer");
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
        expect(byStage.get("outcome")?.outcome).toBe("native");
    });

    it("records the numbers that decided the strategy, including the cache evidence", async () => {
        const harness = build({ responses: [async () => summaryResponse("## Goal\n\nstub")] });
        await harness.compact();

        const attempt = readRecords(tracePath).find((record) => record.stage === "attempt");
        expect(attempt?.strategy).toBe("native");
        expect(attempt?.outcome).toBe("accepted");
        expect(attempt?.attempt).toMatchObject({
            provider: "anthropic",
            model: "stub-model",
            maxTokens: 8_192,
            contextWindow: 200_000,
            toolCount: 2,
            messageCount: 6,
        });
        expect(attempt?.attempt?.estimatedTokens).toBeGreaterThan(0);
        // The usage on the accepted attempt is how a cache hit is read out of this file.
        expect(attempt?.usage).toMatchObject({
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        });
    });

    it("records a rejected native attempt before the serialized one that saved it", async () => {
        const harness = build({
            responses: [
                async () => toolCallResponse("read"),
                async () => summaryResponse("## Goal\n\nsalvaged"),
            ],
        });
        await harness.compact();

        const records = readRecords(tracePath);
        const attempts = records.filter((record) => record.stage === "attempt");
        expect(attempts.map((record) => [record.strategy, record.outcome])).toEqual([
            ["native", "rejected"],
            ["serialized", "accepted"],
        ]);
        expect(attempts[0]?.detail).toContain("does not honor tool_choice none");
        expect(attempts[0]?.usage).toBeDefined();
        // The serialized request still names the tools its transcript describes, it just cannot call them.
        expect(attempts[1]?.attempt).toMatchObject({ toolCount: 2, messageCount: 1 });
        expect(records.find((record) => record.stage === "outcome")?.outcome).toBe("serialized");
    });

    it("records a skipped attempt with the estimate that made it unfit", async () => {
        const thresholdSized = messageChain([
            { id: "big-1", message: userMessage("q".repeat(750_000)) },
            { id: "kept-1", message: sampleKept()[0] },
        ]);
        const harness = build({
            responses: [async () => summaryResponse("## Goal\n\nnarrow")],
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
            responses: [async () => summaryResponse("## Goal\n\nnarrow")],
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
            responses: [async () => summaryResponse("## Goal\n\noverflow")],
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
        expect(outcome?.detail).toContain("native: provider unavailable");
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

    it("compares the rebuilt request against the parent's own request body", async () => {
        const parentBody = {
            model: "stub-model",
            system: "the live system prompt",
            tools: [{ name: "bash", input_schema: { type: "object" } }],
            messages: [{ role: "user", content: "fix the compaction module" }],
        };
        const harness = build({
            responses: [async () => summaryResponse("## Goal\n\nstub")],
            providerPayload: {
                ...parentBody,
                messages: [...parentBody.messages, { role: "user", content: "instruction" }],
            },
        });
        const seed = harness.piStub.requireHandler("before_provider_request", 0);
        await seed({ type: "before_provider_request", payload: parentBody }, harness.ctx);

        const records = (await harness.compact(), readRecords(tracePath));
        const order = records.map((record) => record.stage);
        expect(order).toEqual(["prefix", "attempt", "model_response", "final_summary", "outcome"]);

        const prefix = records[0]?.prefix;
        expect(prefix).toMatchObject({
            prefixUsable: true,
            firstDivergence: "tail",
            parentMessageCount: 1,
            ourMessageCount: 2,
            commonPrefixMessages: 1,
        });
        expect(prefix?.parentRequest).toMatchObject({ model: "stub-model", toolCount: 1 });
    });

    it("says so when the parent request body was never captured", async () => {
        const harness = build({
            responses: [async () => summaryResponse("## Goal\n\nstub")],
            providerPayload: { model: "stub-model", messages: [] },
        });
        await harness.compact();

        const prefix = readRecords(tracePath).find((record) => record.stage === "prefix");
        expect(prefix?.prefix).toMatchObject({
            prefixUsable: false,
            firstDivergence: "no-parent-payload-captured",
        });
    });

    it("rotates the file once it passes the configured size", async () => {
        const harness = build({
            responses: [async () => summaryResponse("## Goal\n\nstub")],
            config: { traceMaxBytes: 1 },
        });
        await harness.compact();
        expect(existsSync(`${tracePath}.1`)).toBe(true);
    });

    it("keeps the trace file readable only by its owner", async () => {
        const harness = build({ responses: [async () => summaryResponse("## Goal\n\nstub")] });
        await harness.compact();
        expect(statSync(tracePath).mode & 0o777).toBe(0o600);
    });
});
