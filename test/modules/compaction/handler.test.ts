import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionPreparation } from "../../../src/modules/compaction/types";
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
import { stubModel } from "../../helpers/pi-stub";

const SYSTEM_PROMPT = "the live system prompt";
const SESSION_ID = "session-1";
const KEPT_TEXT = "and keep this turn in context";

/** Long enough that the fallback's per-result cap bites, so the two stages visibly differ. */
const READ_BODY = "export const registerCompactionExtension = () => {};\n".repeat(40);

type ResponseFactory = () => Promise<ReturnType<typeof summaryResponse>>;

describe("compaction stages", () => {
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

    function build(
        input: {
            responses: ResponseFactory[];
            notify?: (message: string, level?: "info" | "warning" | "error") => void;
            hasUI?: boolean;
            contextWindow?: number;
            branch?: SessionEntry[];
            span?: ReturnType<typeof sampleSpan>;
            kept?: ReturnType<typeof sampleKept>;
            preparation?: Partial<CompactionPreparation>;
            config?: Record<string, unknown>;
            signal?: AbortSignal;
            activeTools?: string[];
            branchThrows?: Error;
        } = { responses: [] },
    ) {
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
            span: input.span ?? sampleSpan(READ_BODY),
            kept: input.kept,
            preparation: input.preparation,
            branch: input.branch,
            signal: input.signal,
            activeTools: input.activeTools,
            branchThrows: input.branchThrows,
            model: input.contextWindow
                ? stubModel({ contextWindow: input.contextWindow })
                : undefined,
        });
    }

    const segmentSummary = async () =>
        summaryResponse("## Goal\n\nsegment checkpoint from stage one");
    const reducedSummary = async () => summaryResponse("## Goal\n\nreduced final checkpoint");

    it("stage 1 reads the discarded span and not the retained tail", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(2);
        expect(h.sentText(0)).toContain("fix the compaction module");
        expect(h.sentText(0)).not.toContain(KEPT_TEXT);
        expect(h.trailingInstruction(0)).toContain("retained as-is and are not included here");
        expect(payload?.summary).toContain("reduced final checkpoint");
        expect(payload?.details.route).toBe("two-stage");
    });

    it("stage 1 keeps the parent's system prompt, tools, and session, with calls disabled", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        await h.compact();

        const { context } = h.calls[0];
        expect(context.systemPrompt).toBe(SYSTEM_PROMPT);
        expect(context.tools?.map((tool) => tool.name)).toEqual(["bash", "read"]);
        expect(h.optionField(0, "toolChoice")).toBe("none");
        expect(h.optionField(0, "cacheRetention")).toBeUndefined();
        expect(h.optionField(0, "sessionId")).toBe(SESSION_ID);
        // pi's history budget: 80% of the reserved window, capped by the model's own output limit.
        expect(h.optionField(0, "maxTokens")).toBe(8_192);
        expect(h.trailingInstruction(0)).toContain("Do not call any tool");
        expect(h.trailingInstruction(0)).toContain("## Key Decisions");
    });

    it("sends the real tool call and its untruncated result to stage 1", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
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

    it("stage 2 receives the minimized transcript plus stage 1's checkpoint", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        await h.compact();

        const { context } = h.calls[1];
        expect(context.systemPrompt).not.toBe(SYSTEM_PROMPT);
        expect(context.tools).toBeUndefined();
        expect(h.optionField(1, "cacheRetention")).toBe("none");
        expect(h.optionField(1, "sessionId")).not.toBe(SESSION_ID);

        const request = h.requestText(1);
        expect(request).toContain("[User]: fix the compaction module");
        expect(request).toContain("more characters truncated]");
        expect(request).not.toContain("reasoning the fallback must not carry");
        expect(request).toContain(
            "<segment-checkpoint>\n## Goal\n\nsegment checkpoint from stage one",
        );
        expect(request).toContain("Prefer the transcript where they disagree");
        expect(request).not.toContain("<previous-summary>");
    });

    it("appends the deterministic sections and keeps pi's file-list keys", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
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
        expect(payload?.firstKeptEntryId).toBe("kept-1");
        expect(payload?.tokensBefore).toBe(190_000);
        expect(payload?.usage).toBeDefined();

        expect(payload?.details).toMatchObject({
            route: "two-stage",
            version: 1,
            model: "stub-model",
            provider: "anthropic",
            readFiles: ["src/index.ts"],
            modifiedFiles: ["src/modules/compaction/index.ts"],
            summarizedMessages: 4,
        });
    });

    it("overflow skips stage 1 entirely", async () => {
        const h = build({ responses: [reducedSummary] });
        const payload = await h.compact({ reason: "overflow", willRetry: true });

        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].context.tools).toBeUndefined();
        expect(h.requestText(0)).not.toContain("<segment-checkpoint>");
        expect(payload?.details.route).toBe("serialized");
    });

    it("carries the previous checkpoint into the reduce", async () => {
        const h = build({
            responses: [segmentSummary, reducedSummary],
            preparation: { previousSummary: "## Goal\n\nthe earlier checkpoint" },
        });
        await h.compact();

        const segment = h.trailingInstruction(0);
        expect(segment).toContain("An earlier compaction summary is part of this conversation");

        const request = h.requestText(1);
        expect(request).toContain(
            "<previous-summary>\n## Goal\n\nthe earlier checkpoint\n</previous-summary>",
        );
        expect(request).toContain("Merge everything into it");
    });

    it("reduces without a segment checkpoint when stage 1 answers with a tool call", async () => {
        const h = build({
            responses: [async () => toolCallResponse("read"), reducedSummary],
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(2);
        expect(h.optionField(0, "toolChoice")).toBe("none");
        expect(h.requestText(1)).not.toContain("<segment-checkpoint>");
        expect(payload?.summary).toContain("reduced final checkpoint");
        expect(payload?.details.route).toBe("serialized");
    });

    it("persists stage 1's own checkpoint when the reduce fails", async () => {
        const notices: string[] = [];
        const h = build({
            hasUI: true,
            notify: (message) => notices.push(String(message)),
            responses: [segmentSummary, async () => summaryResponse("   ")],
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(2);
        expect(payload?.summary).toContain("segment checkpoint from stage one");
        expect(payload?.details.route).toBe("native");
        expect(notices[0]).toContain("reduce stage failed");
    });

    it("skips stage 1 when the span plus instruction will not fit", async () => {
        const h = build({
            responses: [reducedSummary],
            contextWindow: 4_000,
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].context.tools).toBeUndefined();
        expect(payload?.details.route).toBe("serialized");
    });

    it("still runs stage 1 when only the retained tail is too large to resend", async () => {
        // A 1.2M-character retained tail estimates at ~300k tokens, so a stage that re-sent the whole live
        // context would skip itself here. Truncating at the cut point is what keeps it runnable.
        const hugeKept = userMessage("k".repeat(1_200_000));
        const branch = messageChain([
            { id: "span-0", message: userMessage("fix the compaction module") },
            { id: "kept-1", message: hugeKept },
        ]);
        const h = build({
            responses: [segmentSummary, reducedSummary],
            branch,
            span: [userMessage("fix the compaction module")],
            kept: [hugeKept],
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(2);
        expect(h.sentText(0)).not.toContain("kkkk");
        expect(payload?.details.route).toBe("two-stage");
    });

    it("reports to pi's default compaction when both stages fail", async () => {
        const notices: Array<{ message: string; level: string | undefined }> = [];
        const h = build({
            hasUI: true,
            notify: (message, level) => notices.push({ message, level }),
            responses: [
                async () => {
                    throw new Error("stage one unavailable");
                },
                async () => summaryResponse("   "),
            ],
        });

        expect(await h.compact()).toBeUndefined();
        expect(h.calls).toHaveLength(2);
        expect(notices[0]?.message).toContain("fell back to pi's default");
        expect(notices[0]?.message).toContain("segment: stage one unavailable");
        expect(notices[0]?.message).toContain("reduce: summarization returned an empty summary");
        expect(notices[0]?.level).toBe("warning");
    });

    it("never lets a defect escape the handler", async () => {
        const notices: string[] = [];
        const h = build({
            hasUI: true,
            notify: (message) => notices.push(String(message)),
            responses: [segmentSummary],
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
        const h = build();
        expect(h.piStub.order).toEqual(["on:before_provider_request", "on:session_before_compact"]);
        expect(h.piStub.handlersFor("session_before_compact")).toHaveLength(1);
    });

    it("stays out of the way when disabled by config", async () => {
        const h = build({ responses: [segmentSummary], config: { enabled: false } });

        expect(await h.compact()).toBeUndefined();
        expect(h.calls).toHaveLength(0);
    });

    it("honors the serialized limits from config", async () => {
        const h = build({
            responses: [segmentSummary, reducedSummary],
            config: { keepThinking: true, serializedToolResultChars: 20, serializedNoteChars: 0 },
        });
        await h.compact();

        const request = h.requestText(1);
        expect(request).toContain("reasoning the fallback must not carry");
        expect(request).toContain("more characters truncated]");
    });

    it("passes manual /compact instructions to both stages", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        await h.compact({ customInstructions: "keep the database migration notes" });

        expect(h.trailingInstruction(0)).toContain(
            "Additional focus: keep the database migration notes",
        );
        expect(h.requestText(1)).toContain("Additional focus: keep the database migration notes");
    });
});

function textOf(content: string | (TextContent | ImageContent)[]): string {
    if (typeof content === "string") {
        return content;
    }
    return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");
}
