import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    createCompactionHarness,
    messageChain,
    sampleKept,
    sampleSpan,
    summaryResponse,
    toolCallResponse,
    userMessage,
} from "../../helpers/compaction-doubles";
import type { CompactionPreparation } from "../../../src/modules/compaction/types";
import { stubModel } from "../../helpers/pi-stub";

const SYSTEM_PROMPT = "the live system prompt";
const SESSION_ID = "session-1";

/** Long enough that the fallback's per-result cap bites, so the two strategies visibly differ. */
const READ_BODY = "export const registerCompactionExtension = () => {};\n".repeat(40);

type ResponseFactory = () => Promise<ReturnType<typeof summaryResponse>>;

describe("compaction handler", () => {
    let root = "";

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "pi-coder-compaction-"));
        // Pin both config locations at paths that do not exist, so no suite can read the developer's own
        // ~/.pi/compaction-config.json or a file left in this checkout.
        vi.stubEnv("COMPACTION_CONFIG_PATH", path.join(root, "absent.json"));
        vi.stubEnv("COMPACTION_CONFIG_PATH_GLOBAL", path.join(root, "absent-global.json"));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
    });

    function build(input: {
        responses: ResponseFactory[];
        notify?: (message: string, level?: "info" | "warning" | "error") => void;
        hasUI?: boolean;
        contextWindow?: number;
        branch?: SessionEntry[];
        span?: ReturnType<typeof sampleSpan>;
        preparation?: Partial<CompactionPreparation>;
        config?: Record<string, unknown>;
        signal?: AbortSignal;
        activeTools?: string[];
        branchThrows?: Error;
    }) {
        if (input.config) {
            const configPath = path.join(root, "compaction-config.json");
            writeFileSync(configPath, JSON.stringify(input.config));
            vi.stubEnv("COMPACTION_CONFIG_PATH", configPath);
        }
        return createCompactionHarness({
            cwd: root,
            responses: input.responses,
            systemPrompt: SYSTEM_PROMPT,
            sessionId: SESSION_ID,
            notify: input.notify,
            hasUI: input.hasUI,
            preparation: input.preparation,
            span: input.span ?? sampleSpan(READ_BODY),
            branch: input.branch,
            signal: input.signal,
            activeTools: input.activeTools,
            branchThrows: input.branchThrows,
            model: input.contextWindow
                ? stubModel({ contextWindow: input.contextWindow })
                : undefined,
        });
    }

    it("sends the live context with the instruction appended and tools disabled", async () => {
        const h = build({ responses: [async () => summaryResponse("## Goal\n\nstub summary")] });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(1);
        const { context } = h.calls[0];
        expect(context.systemPrompt).toBe(SYSTEM_PROMPT);
        expect(context.tools?.map((tool) => tool.name)).toEqual(["bash", "read"]);
        expect(h.optionField(0, "toolChoice")).toBe("none");
        expect(h.optionField(0, "cacheRetention")).toBeUndefined();
        expect(h.optionField(0, "sessionId")).toBe(SESSION_ID);
        // pi's history budget: 80% of the reserved window, capped by the model's own output limit.
        expect(h.optionField(0, "maxTokens")).toBe(8_192);

        expect(h.sentText(0)).toContain("fix the compaction module");
        expect(h.trailingInstruction(0)).toContain("Do not call any tool");
        expect(h.trailingInstruction(0)).toContain("last ~2 messages are retained verbatim");
        expect(h.trailingInstruction(0)).toContain("## Key Decisions");

        expect(payload?.firstKeptEntryId).toBe("kept-1");
        expect(payload?.tokensBefore).toBe(190_000);
        expect(payload?.summary).toContain("stub summary");
        expect(payload?.usage).toBeDefined();
    });

    it("keeps active tool order rather than configured order", async () => {
        const h = build({
            responses: [async () => summaryResponse("## Goal\n\nstub summary")],
            activeTools: ["agent", "read"],
        });
        await h.compact();
        expect(h.calls[0].context.tools?.map((tool) => tool.name)).toEqual(["agent", "read"]);
    });

    it("sends the real tool call and its untruncated result", async () => {
        const h = build({ responses: [async () => summaryResponse("## Goal\n\nstub summary")] });
        await h.compact();

        const sent = h.calls[0].context.messages;
        const withCall = sent.find(
            (message) =>
                message.role === "assistant" &&
                message.content.some((block) => block.type === "toolCall"),
        );
        const result = sent.find((message) => message.role === "toolResult");
        expect(withCall).toBeDefined();
        expect(result?.role === "toolResult" && textOf(result.content)).toBe(READ_BODY);
    });

    it("appends the deterministic sections and keeps pi's file-list keys", async () => {
        const h = build({ responses: [async () => summaryResponse("## Goal\n\nstub summary")] });
        const payload = await h.compact();

        expect(payload?.summary).toContain("## Verbatim Recent Requests");
        expect(payload?.summary).toContain('- "fix the compaction module"');
        expect(payload?.summary).toContain("## Tool Ledger");
        expect(payload?.summary).toContain("read x1");
        expect(payload?.summary).toContain("## Dropped Context");
        expect(payload?.summary).toContain("context resumes at entry kept-1");
        expect(payload?.summary).toContain("<read-files>\nsrc/index.ts\n</read-files>");
        expect(payload?.summary).toContain(
            "<modified-files>\nsrc/modules/compaction/index.ts\n</modified-files>",
        );

        expect(payload?.details).toMatchObject({
            strategy: "native",
            version: 1,
            model: "stub-model",
            provider: "anthropic",
            readFiles: ["src/index.ts"],
            modifiedFiles: ["src/modules/compaction/index.ts"],
            summarizedMessages: 4,
            droppedBlocks: 0,
        });
    });

    it("minimizes the transcript for overflow instead of re-sending a context that just failed", async () => {
        const h = build({
            responses: [async () => summaryResponse("## Goal\n\noverflow summary")],
        });
        const payload = await h.compact({ reason: "overflow" });

        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].context.tools).toBeUndefined();
        expect(h.optionField(0, "cacheRetention")).toBe("none");
        expect(h.optionField(0, "sessionId")).not.toBe(SESSION_ID);
        expect(h.calls[0].context.systemPrompt).not.toBe(SYSTEM_PROMPT);

        const request = h.requestText(0);
        expect(request).toContain("[User]: fix the compaction module");
        expect(request).toContain("[Tool result]: export const registerCompactionExtension");
        expect(request).toContain("more characters truncated]");
        expect(request).not.toContain("reasoning the fallback must not carry");
        expect(request).not.toContain("<previous-summary>");
        expect(request).toContain("No prior summary exists");
        expect(payload?.details.strategy).toBe("serialized");
    });

    it("carries the previous summary into the serialized request", async () => {
        const h = build({
            responses: [async () => summaryResponse("## Goal\n\nmerged summary")],
            preparation: { previousSummary: "## Goal\n\nthe earlier checkpoint" },
        });
        await h.compact({ reason: "overflow" });

        const request = h.requestText(0);
        expect(request).toContain(
            "<previous-summary>\n## Goal\n\nthe earlier checkpoint\n</previous-summary>",
        );
        expect(request).toContain("only NEW messages");
    });

    it("cascades off a provider that answers the native request with a tool call", async () => {
        const h = build({
            responses: [
                async () => toolCallResponse("read"),
                async () => summaryResponse("## Goal\n\nserialized summary"),
            ],
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(2);
        expect(h.optionField(0, "toolChoice")).toBe("none");
        expect(h.calls[1].context.tools).toBeUndefined();
        expect(payload?.summary).toContain("serialized summary");
        expect(payload?.details.strategy).toBe("serialized");
    });

    it("cascades when the live context plus instruction will not fit", async () => {
        const h = build({
            responses: [async () => summaryResponse("## Goal\n\nnarrow summary")],
            contextWindow: 4_000,
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].context.tools).toBeUndefined();
        expect(payload?.details.strategy).toBe("serialized");
    });

    it("goes native on a threshold-sized context, which is the case that triggered compaction", async () => {
        // 750k characters estimates at ~187.5k tokens: above 200_000 - 16_384 = 183_616, where pi's threshold
        // fires, and below 200_000 - 8_192 = 191_808, the room the summary output itself needs. A gate that
        // re-reserved pi's whole `reserveTokens` would reject this request and quietly send every threshold
        // compaction through the serialized path instead.
        const thresholdSized = messageChain([
            { id: "big-1", message: userMessage("q".repeat(750_000)) },
            { id: "kept-1", message: sampleKept()[0] },
        ]);
        const h = build({
            responses: [async () => summaryResponse("## Goal\n\nthreshold summary")],
            branch: thresholdSized,
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].context.tools?.map((tool) => tool.name)).toEqual(["bash", "read"]);
        expect(payload?.details.strategy).toBe("native");
    });

    it("reports to pi's default compaction when both strategies fail", async () => {
        const notices: Array<{ message: string; level: string | undefined }> = [];
        const h = build({
            hasUI: true,
            notify: (message, level) => notices.push({ message, level }),
            responses: [
                async () => {
                    throw new Error("provider unavailable");
                },
                async () => summaryResponse("   "),
            ],
        });

        expect(await h.compact()).toBeUndefined();
        expect(h.calls).toHaveLength(2);
        expect(notices[0]?.message).toContain("fell back to pi's default");
        expect(notices[0]?.message).toContain("native: provider unavailable");
        expect(notices[0]?.message).toContain(
            "serialized: summarization returned an empty summary",
        );
        expect(notices[0]?.level).toBe("warning");
    });

    it("never lets a defect escape the handler", async () => {
        const notices: string[] = [];
        const h = build({
            hasUI: true,
            notify: (message) => notices.push(String(message)),
            responses: [async () => summaryResponse("unused")],
            branchThrows: new Error("session unreadable"),
        });

        expect(await h.compact()).toBeUndefined();
        expect(h.calls).toHaveLength(0);
        expect(notices[0]).toContain("using pi's default");
        expect(notices[0]).toContain("session unreadable");
    });

    it("cancels a compaction whose signal was already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const h = build({
            responses: [
                async () => {
                    throw new TypeError("no provider call is allowed after an abort");
                },
            ],
            signal: controller.signal,
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(h.calls).toHaveLength(0);
    });

    it("installs only the compaction hook plus the payload capture it diffs against", () => {
        const h = build({ responses: [async () => summaryResponse("unused")] });
        // A child lists this extension directly, so what it installs has to stay this small.
        expect(h.piStub.order).toEqual(["on:before_provider_request", "on:session_before_compact"]);
        expect(h.piStub.handlersFor("session_before_compact")).toHaveLength(1);
    });

    it("stays out of the way when disabled by config", async () => {
        const h = build({
            responses: [async () => summaryResponse("unused")],
            config: { enabled: false },
        });

        expect(await h.compact()).toBeUndefined();
        expect(h.calls).toHaveLength(0);
    });

    it("honors the serialized limits from config", async () => {
        const h = build({
            responses: [async () => summaryResponse("## Goal\n\nconfigured summary")],
            config: {
                keepThinking: true,
                serializedToolResultChars: 20,
                serializedNoteChars: 0,
            },
        });
        await h.compact({ reason: "overflow" });

        const request = h.requestText(0);
        expect(request).toContain("reasoning the fallback must not carry");
        expect(request).toContain("more characters truncated]");
    });

    it("passes manual /compact instructions to the model", async () => {
        const h = build({ responses: [async () => summaryResponse("## Goal\n\nfocused summary")] });
        await h.compact({ customInstructions: "keep the database migration notes" });

        expect(h.trailingInstruction(0)).toContain(
            "Additional focus: keep the database migration notes",
        );
    });
});

function textOf(content: string | (TextContent | ImageContent)[]): string {
    if (typeof content === "string") {
        return content;
    }
    return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");
}
