import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionPreparation } from "../../../src/modules/compaction/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    createCompactionHarness,
    failedResponse,
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
        // Pin both config locations, so no suite can read the developer's own ~/.pi/compaction-config.json or a
        // file left in this checkout. The project location exists and zeroes the retry budget: the backoff is
        // real time, and a suite that slept on it would be slow and flaky. The schedule itself is pinned in
        // summarize.test.ts, where the sleep is injected.
        const defaults = path.join(root, "test-defaults.json");
        writeFileSync(defaults, JSON.stringify({ retryMaxRetries: 0 }));
        vi.stubEnv("COMPACTION_CONFIG_PATH", defaults);
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
            contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
        } = { responses: [] },
    ) {
        if (input.config) {
            const configPath = path.join(root, "compaction-config.json");
            writeFileSync(configPath, JSON.stringify({ retryMaxRetries: 0, ...input.config }));
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
            contextUsage: input.contextUsage,
            model: input.contextWindow
                ? stubModel({ contextWindow: input.contextWindow })
                : undefined,
        });
    }

    const segmentSummary = async () =>
        summaryResponse(
            "## Goal\n\nsegment checkpoint from stage one\n\n## Progress\n\n- [x] segment checkpoint from stage one",
        );
    const reducedSummary = async () =>
        summaryResponse(
            "## Goal\n\nreduced final checkpoint\n\n## Progress\n\n- [x] reduced final checkpoint",
        );

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
        // Stage 1 gets a third of pi's history budget: it writes an intermediate, not the final draft.
        expect(h.optionField(0, "maxTokens")).toBe(2_730);
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

    it("gives the intermediate a third of the final budget", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        await h.compact();

        expect(h.optionField(0, "maxTokens")).toBe(2_730);
        expect(h.optionField(1, "maxTokens")).toBe(8_192);
        expect(h.trailingInstruction(0)).toContain("This is an intermediate pass");
        expect(h.requestText(1)).toContain("must be no longer than the checkpoint you were given");
    });

    it("lets stage 1 merge the previous checkpoint, so the reduce is not handed it twice", async () => {
        const h = build({
            responses: [segmentSummary, reducedSummary],
            preparation: { previousSummary: "## Goal\n\nthe earlier checkpoint" },
        });
        await h.compact();

        expect(h.trailingInstruction(0)).toContain(
            "An earlier compaction summary is part of this conversation",
        );
        expect(h.requestText(1)).not.toContain("<previous-summary>");
        expect(h.requestText(1)).toContain("<segment-checkpoint>");
    });

    it("hands the previous checkpoint to the reduce when stage 1 did not run", async () => {
        const h = build({
            responses: [reducedSummary],
            preparation: { previousSummary: "## Goal\n\nthe earlier checkpoint" },
        });
        await h.compact({ reason: "overflow" });

        expect(h.calls).toHaveLength(1);
        const request = h.requestText(0);
        expect(request).toContain(
            "<previous-summary>\n## Goal\n\nthe earlier checkpoint\n</previous-summary>",
        );
        expect(request).toContain("Merge everything into it");
        expect(request).not.toContain("<segment-checkpoint>");
    });

    it("gates the fit on the provider's own token count, not the chars/4 estimate", async () => {
        // A 1.2M-character span estimates at ~300k tokens, which would skip stage 1 on a 200k window. The
        // provider reports 40k, which is the truth the gate should use.
        const huge = messageChain([
            { id: "big-1", message: userMessage("q".repeat(1_200_000)) },
            { id: "kept-1", message: userMessage(KEPT_TEXT) },
        ]);
        const trusting = build({
            responses: [segmentSummary, reducedSummary],
            branch: huge,
            contextUsage: { tokens: 40_000, contextWindow: 200_000, percent: 20 },
        });
        await trusting.compact();
        expect(trusting.calls).toHaveLength(2);

        const overflowing = build({
            responses: [reducedSummary],
            branch: huge,
            contextUsage: { tokens: 199_000, contextWindow: 200_000, percent: 100 },
        });
        const payload = await overflowing.compact();
        expect(overflowing.calls).toHaveLength(1);
        expect(payload?.details.route).toBe("serialized");
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

    it("cancels rather than falling back when an abort arrives mid-stage", async () => {
        // The warning this used to emit claimed pi's default had taken over. It had not: the user stopped the
        // compaction, and returning undefined would have let pi fire another summarization call on the same
        // dead controller.
        const controller = new AbortController();
        const notes: string[] = [];
        const h = build({
            responses: [
                async () => {
                    controller.abort();
                    return failedResponse("aborted", "Request was aborted");
                },
                async () => {
                    throw new TypeError("reduce must not run on an aborted controller");
                },
            ],
            signal: controller.signal,
            notify: (message) => notes.push(message),
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        // One provider call, not two: the reduce is skipped once the controller is dead.
        expect(h.calls).toHaveLength(1);
        expect(notes).toEqual([]);
    });

    it("sends no reduce request when stage 1 itself reports an abort", async () => {
        // The cause policy treats an aborted reply as the user stopping, so the cascade ends here rather than
        // putting a second request on a controller that may already be dead. It stays silent: nothing was handed
        // over and nothing went wrong.
        const notes: string[] = [];
        const h = build({
            responses: [
                async () => failedResponse("aborted", "Request was aborted"),
                async () => {
                    throw new TypeError("reduce must not run after an aborted stage 1");
                },
            ],
            notify: (message) => notes.push(message),
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(h.calls).toHaveLength(1);
        expect(notes).toEqual([]);
    });

    it("cancels rather than falling back when the abort arrives during the reduce", async () => {
        // Stage 1 fails on something the policy keeps cascading, so it is the reduce that meets the abort - the
        // case the pre-reduce guard cannot see.
        const controller = new AbortController();
        const notes: string[] = [];
        const h = build({
            responses: [
                async () => toolCallResponse("read"),
                async () => {
                    controller.abort();
                    return failedResponse("aborted", "This operation was aborted");
                },
            ],
            signal: controller.signal,
            notify: (message) => notes.push(message),
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(h.calls).toHaveLength(2);
        expect(notes).toEqual([]);
    });

    /**
     * A quota or rate-limit failure is about the account, not the request, so the whole cascade stops: stage 2
     * would send the same credentials to the same limit, and core's default path a third time. `{ cancel: true }`
     * is the only return value that means stop, and it leaves the session exactly as it was.
     */
    it("stops the cascade when the account is the problem, and says which problem it was", async () => {
        const notes: string[] = [];
        const h = build({
            hasUI: true,
            responses: [
                async () =>
                    failedResponse(
                        "error",
                        "429 insufficient_quota: You exceeded your current quota, please check your plan and billing details",
                    ),
                async () => {
                    throw new TypeError("reduce must not run on a quota limit");
                },
            ],
            notify: (message) => notes.push(message),
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(h.calls).toHaveLength(1);
        // Quota is named even though the status was 429: the block-list is checked before the throttle pattern.
        expect(notes.join("\n")).toContain("compaction stopped: quota");
    });

    it("stops on a bare throttle as well, even though pi would have retried it", async () => {
        const notes: string[] = [];
        const h = build({
            hasUI: true,
            responses: [
                async () => failedResponse("error", "429 Too Many Requests"),
                async () => summaryResponse("## Goal\n\nsalvaged\n\n## Progress\n\n- [x] salvaged"),
            ],
            notify: (message) => notes.push(message),
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(h.calls).toHaveLength(1);
        expect(notes.join("\n")).toContain("compaction stopped: rate-limit");
    });

    it("keeps cascading a transient failure once its retry budget is spent", async () => {
        const h = build({
            responses: [
                async () => failedResponse("error", "500 internal server error"),
                async () => summaryResponse("## Goal\n\nsalvaged\n\n## Progress\n\n- [x] salvaged"),
            ],
        });

        // `retryMaxRetries: 0` comes from the suite's config defaults, so the budget is spent immediately and
        // the cascade is what remains; the schedule itself is pinned in summarize.test.ts.
        const payload = await h.compact();
        expect(payload?.details.route).toBe("serialized");
        expect(h.calls).toHaveLength(2);
    });

    it("abandons rather than handing over when the reduce is stopped by the account", async () => {
        const notes: string[] = [];
        const h = build({
            hasUI: true,
            responses: [
                async () => toolCallResponse("read"),
                async () => failedResponse("error", "401 authentication_error: Invalid API key"),
            ],
            notify: (message) => notes.push(message),
        });

        // Returning undefined here would let core spend its own summarization request on rejected credentials.
        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(notes.join("\n")).toContain("compaction stopped: auth");
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
