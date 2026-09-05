import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AssistantMessage, Context, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
    ExtensionUIContext,
    SessionBeforeCompactEvent,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionExtension } from "../../../src/modules/compaction";
import type { ContextMessage } from "../../../src/modules/compaction/types";
import {
    assistantMessage,
    compactEvent,
    compactionPreparation,
    fileOperations,
    messageChain,
    summaryResponse,
    toolCallResponse,
    toolResultMessage,
    userMessage,
} from "../../helpers/compaction-doubles";
import {
    createPiStub,
    stubContext,
    stubModel,
    stubModelRegistry,
    stubSessionManager,
    stubToolInfo,
    stubUi,
} from "../../helpers/pi-stub";

const SESSION_ID = "session-1";
const SYSTEM_PROMPT = "the live system prompt";

/** A body long enough that the fallback's per-result cap bites, so the two strategies visibly differ. */
const READ_BODY = "export const registerCompactionExtension = () => {};\n".repeat(40);

/** The turns compaction is about to discard. */
const SPAN: ContextMessage[] = [
    userMessage("fix the compaction module"),
    assistantMessage({
        thinking: "reasoning the fallback must not carry",
        text: "reading the module",
        calls: [{ id: "c1", name: "read", arguments: { path: "src/modules/compaction/index.ts" } }],
    }),
    toolResultMessage({ callId: "c1", tool: "read", text: READ_BODY }),
    assistantMessage({ text: "the read gave me what I needed" }),
];

/** What stays in context verbatim after compaction. */
const KEPT: ContextMessage[] = [
    userMessage("and keep this turn in context"),
    assistantMessage({ text: "acknowledged" }),
];

interface CapturedCall {
    context: Context;
    options: unknown;
}

function textOf(content: string | (TextContent | ImageContent)[]): string {
    if (typeof content === "string") {
        return content;
    }
    return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");
}

/** pi's `complete` options are a per-API union, so one field is read at a time and this fails when absent. */
function optionField(options: unknown, key: string): unknown {
    if (!options || typeof options !== "object") {
        throw new TypeError(`captured options are not an object: ${String(options)}`);
    }
    return (options as Record<string, unknown>)[key];
}

function sentText(context: Context): string {
    return context.messages
        .filter((message) => message.role !== "assistant")
        .map((message) => textOf(message.content as string | (TextContent | ImageContent)[]))
        .join("\n");
}

function trailingInstruction(context: Context): string {
    const last = context.messages[context.messages.length - 1];
    if (!last || last.role !== "user") {
        throw new TypeError("expected the request to end with a user message");
    }
    return textOf(last.content);
}

function preparation(): CompactionPreparationLike {
    return compactionPreparation({
        firstKeptEntryId: "kept-1",
        messagesToSummarize: SPAN,
        fileOps: fileOperations({
            read: new Set(["src/index.ts"]),
            edited: new Set(["src/modules/compaction/index.ts"]),
        }),
    });
}

type CompactionPreparationLike = ReturnType<typeof compactionPreparation>;

function branchEntries() {
    return messageChain([
        ...SPAN.map((message, index) => ({ id: `span-${String(index)}`, message })),
        ...KEPT.map((message, index) => ({
            id: index === 0 ? "kept-1" : `kept-${String(index + 1)}`,
            message,
        })),
    ]);
}

function event(overrides: Partial<SessionBeforeCompactEvent> = {}): SessionBeforeCompactEvent {
    return compactEvent({
        preparation: preparation(),
        branchEntries: branchEntries(),
        ...overrides,
    });
}

describe("compaction handler", () => {
    let root = "";
    let calls: CapturedCall[] = [];

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "pi-coder-compaction-"));
        // Pin both config locations at paths that do not exist, so no suite can read the developer's own
        // ~/.pi/compaction-config.json or a file left in the checkout.
        vi.stubEnv("COMPACTION_CONFIG_PATH", path.join(root, "absent.json"));
        vi.stubEnv("COMPACTION_CONFIG_PATH_GLOBAL", path.join(root, "absent-global.json"));
        calls = [];
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
    });

    function arm(input: {
        responses: Array<() => Promise<AssistantMessage>>;
        event?: SessionBeforeCompactEvent;
        notify?: ExtensionUIContext["notify"];
        contextWindow?: number;
        branch?: SessionEntry[];
    }) {
        const stub = createPiStub();
        registerCompactionExtension(stub.pi);
        stub.toolSurface.all = [stubToolInfo("read"), stubToolInfo("bash"), stubToolInfo("agent")];
        stub.toolSurface.active = ["bash", "read"];

        let index = 0;
        const registry = stubModelRegistry(async (_model, context, options) => {
            calls.push({ context, options });
            const next =
                input.responses[Math.min(index, input.responses.length - 1)] ??
                (async () => summaryResponse("## Goal\n\nunused"));
            index += 1;
            return await next();
        });

        const ctx = stubContext({
            cwd: root,
            model: stubModel({ contextWindow: input.contextWindow ?? 200_000 }),
            modelRegistry: registry,
            hasUI: true,
            ui: stubUi({ notify: (message, level) => input.notify?.(message, level) }),
            getSystemPrompt: () => SYSTEM_PROMPT,
            sessionManager: stubSessionManager({
                getBranch: () => input.branch ?? branchEntries(),
                getSessionId: () => SESSION_ID,
            }),
        });

        const handler = stub.requireHandler("session_before_compact");
        return { handler, event: input.event ?? event(), ctx };
    }

    async function run(input: Parameters<typeof arm>[0]) {
        const { handler, event: compactArgs, ctx } = arm(input);
        const result = (await handler(compactArgs, ctx)) as
            { compaction?: Record<string, unknown> } | undefined;
        return result?.compaction;
    }

    function detailsOf(compaction: Record<string, unknown> | undefined): Record<string, unknown> {
        if (!compaction) {
            throw new TypeError("expected a compaction result");
        }
        return compaction.details as Record<string, unknown>;
    }

    it("sends the live context with the instruction appended and tools disabled", async () => {
        const compaction = await run({
            responses: [async () => summaryResponse("## Goal\n\nstub summary")],
        });

        expect(calls).toHaveLength(1);
        const { context, options } = calls[0];
        expect(context.systemPrompt).toBe(SYSTEM_PROMPT);
        expect(context.tools?.map((tool) => tool.name)).toEqual(["bash", "read"]);
        expect(optionField(options, "toolChoice")).toBe("none");
        expect(optionField(options, "cacheRetention")).toBeUndefined();
        expect(optionField(options, "sessionId")).toBe(SESSION_ID);
        // pi's history budget: 80% of the reserved window, capped by the model's own output limit.
        expect(optionField(options, "maxTokens")).toBe(8_192);

        expect(sentText(context)).toContain("fix the compaction module");
        expect(trailingInstruction(context)).toContain("Do not call any tool");
        expect(trailingInstruction(context)).toContain("last ~2 messages are retained verbatim");
        expect(trailingInstruction(context)).toContain("## Key Decisions");

        expect(compaction?.firstKeptEntryId).toBe("kept-1");
        expect(compaction?.tokensBefore).toBe(190_000);
        expect(String(compaction?.summary)).toContain("stub summary");
        expect(compaction?.usage).toBeDefined();
    });

    it("sends the real tool call and its untruncated result", async () => {
        await run({ responses: [async () => summaryResponse("## Goal\n\nstub summary")] });
        const sent = calls[0].context.messages;
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
        const compaction = await run({
            responses: [async () => summaryResponse("## Goal\n\nstub summary")],
        });
        const summary = String(compaction?.summary);

        expect(summary).toContain("## Verbatim Recent Requests");
        expect(summary).toContain('- "fix the compaction module"');
        expect(summary).toContain("## Tool Ledger");
        expect(summary).toContain("read x1");
        expect(summary).toContain("## Dropped Context");
        expect(summary).toContain("context resumes at entry kept-1");
        expect(summary).toContain("<read-files>\nsrc/index.ts\n</read-files>");
        expect(summary).toContain(
            "<modified-files>\nsrc/modules/compaction/index.ts\n</modified-files>",
        );

        const details = detailsOf(compaction);
        expect(details.strategy).toBe("native");
        expect(details.version).toBe(1);
        expect(details.model).toBe("stub-model");
        expect(details.provider).toBe("anthropic");
        expect(details.readFiles).toEqual(["src/index.ts"]);
        expect(details.modifiedFiles).toEqual(["src/modules/compaction/index.ts"]);
        expect(details.summarizedMessages).toBe(SPAN.length);
    });

    it("minimizes the transcript for overflow instead of re-sending a context that just failed", async () => {
        const compaction = await run({
            event: event({ reason: "overflow", willRetry: true }),
            responses: [async () => summaryResponse("## Goal\n\noverflow summary")],
        });

        expect(calls).toHaveLength(1);
        const { context, options } = calls[0];
        expect(context.tools).toBeUndefined();
        expect(optionField(options, "cacheRetention")).toBe("none");
        expect(optionField(options, "sessionId")).not.toBe(SESSION_ID);
        expect(context.systemPrompt).not.toBe(SYSTEM_PROMPT);

        const request = textOf(context.messages[0].content as (TextContent | ImageContent)[]);
        expect(request).toContain("[User]: fix the compaction module");
        expect(request).toContain("[Tool result]: export const registerCompactionExtension");
        expect(request).toContain("more characters truncated]");
        expect(request).not.toContain("reasoning the fallback must not carry");
        expect(request).not.toContain("<previous-summary>");
        expect(request).toContain("No prior summary exists");
        expect(detailsOf(compaction).strategy).toBe("serialized");
    });

    it("carries the previous summary into the serialized request", async () => {
        await run({
            event: event({
                reason: "overflow",
                preparation: compactionPreparation({
                    previousSummary: "## Goal\n\nthe earlier checkpoint",
                }),
            }),
            responses: [async () => summaryResponse("## Goal\n\nmerged summary")],
        });
        const request = textOf(
            calls[0].context.messages[0].content as (TextContent | ImageContent)[],
        );
        expect(request).toContain(
            "<previous-summary>\n## Goal\n\nthe earlier checkpoint\n</previous-summary>",
        );
        expect(request).toContain("only NEW messages");
    });

    it("cascades off a provider that answers the native request with a tool call", async () => {
        const compaction = await run({
            responses: [
                async () => toolCallResponse("read"),
                async () => summaryResponse("## Goal\n\nserialized summary"),
            ],
        });

        expect(calls).toHaveLength(2);
        expect(optionField(calls[0].options, "toolChoice")).toBe("none");
        expect(calls[1].context.tools).toBeUndefined();
        expect(String(compaction?.summary)).toContain("serialized summary");
        expect(detailsOf(compaction).strategy).toBe("serialized");
    });

    it("cascades when the live context plus instruction will not fit", async () => {
        const compaction = await run({
            contextWindow: 4_000,
            responses: [async () => summaryResponse("## Goal\n\nnarrow summary")],
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].context.tools).toBeUndefined();
        expect(detailsOf(compaction).strategy).toBe("serialized");
    });

    it("goes native on a threshold-sized context, which is the case that triggered compaction", async () => {
        // 750k characters estimates at ~187.5k tokens: above 200_000 - 16_384 = 183_616, where pi's threshold
        // fires, and below 200_000 - 8_192 = 191_808, the room the summary output itself needs. A gate that
        // re-reserved pi's whole `reserveTokens` would reject this request and quietly send every threshold
        // compaction through the serialized path instead.
        const thresholdSized = messageChain([
            { id: "big-1", message: userMessage("q".repeat(750_000)) },
            { id: "kept-1", message: KEPT[0] },
        ]);

        const compaction = await run({
            branch: thresholdSized,
            event: event({ branchEntries: thresholdSized }),
            responses: [async () => summaryResponse("## Goal\n\nthreshold summary")],
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].context.tools?.map((tool) => tool.name)).toEqual(["bash", "read"]);
        expect(detailsOf(compaction).strategy).toBe("native");
    });

    it("reports to pi's default compaction when both strategies fail", async () => {
        const notices: Array<{ message: string; level: string | undefined }> = [];
        const compaction = await run({
            notify: (message, level) => {
                notices.push({ message, level });
            },
            responses: [
                async () => {
                    throw new Error("provider unavailable");
                },
                async () => summaryResponse("   "),
            ],
        });

        expect(calls).toHaveLength(2);
        expect(compaction).toBeUndefined();
        expect(notices[0]?.message).toContain("fell back to pi's default");
        expect(notices[0]?.message).toContain("native: provider unavailable");
        expect(notices[0]?.message).toContain(
            "serialized: summarization returned an empty summary",
        );
        expect(notices[0]?.level).toBe("warning");
    });

    it("never lets a defect escape the handler", async () => {
        const notices: string[] = [];
        const stub = createPiStub();
        registerCompactionExtension(stub.pi);
        stub.toolSurface.all = [stubToolInfo("read")];
        stub.toolSurface.active = ["read"];
        const ctx = stubContext({
            cwd: root,
            model: stubModel(),
            hasUI: true,
            ui: stubUi({ notify: (message) => notices.push(String(message)) }),
            getSystemPrompt: () => SYSTEM_PROMPT,
            sessionManager: stubSessionManager({
                getBranch: () => {
                    throw new Error("session unreadable");
                },
                getSessionId: () => SESSION_ID,
            }),
        });
        const handler = stub.requireHandler("session_before_compact");

        await expect(handler(event(), ctx)).resolves.toBeUndefined();
        expect(notices[0]).toContain("using pi's default");
        expect(notices[0]).toContain("session unreadable");
    });

    it("installs nothing but the compaction handler, which is why a child can list it directly", () => {
        const stub = createPiStub();
        registerCompactionExtension(stub.pi);

        expect(stub.order).toEqual(["on:session_before_compact"]);
        expect(stub.handlersFor("session_before_compact")).toHaveLength(1);
        expect(stub.toolSurface.active).toEqual([]);
    });

    it("cancels a compaction whose signal was already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const stub = createPiStub();
        registerCompactionExtension(stub.pi);
        stub.toolSurface.all = [stubToolInfo("read")];
        stub.toolSurface.active = ["read"];
        const ctx = stubContext({
            cwd: root,
            model: stubModel(),
            modelRegistry: stubModelRegistry(async () => {
                throw new TypeError("no provider call is allowed after an abort");
            }),
            getSystemPrompt: () => SYSTEM_PROMPT,
            sessionManager: stubSessionManager({
                getBranch: () => branchEntries(),
                getSessionId: () => SESSION_ID,
            }),
        });
        const handler = stub.requireHandler("session_before_compact");

        await expect(handler(event({ signal: controller.signal }), ctx)).resolves.toEqual({
            cancel: true,
        });
        expect(calls).toHaveLength(0);
    });

    it("stays out of the way when disabled by config", async () => {
        const configPath = path.join(root, "compaction-config.json");
        writeFileSync(configPath, JSON.stringify({ enabled: false }));
        vi.stubEnv("COMPACTION_CONFIG_PATH", configPath);

        const compaction = await run({ responses: [async () => summaryResponse("unused")] });

        expect(compaction).toBeUndefined();
        expect(calls).toHaveLength(0);
    });

    it("honors the serialized limits from config", async () => {
        const configPath = path.join(root, "compaction-config.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                keepThinking: true,
                serializedToolResultChars: 20,
                serializedNoteChars: 0,
            }),
        );
        vi.stubEnv("COMPACTION_CONFIG_PATH", configPath);

        await run({
            event: event({ reason: "overflow" }),
            responses: [async () => summaryResponse("## Goal\n\nconfigured summary")],
        });

        const request = textOf(
            calls[0].context.messages[0].content as (TextContent | ImageContent)[],
        );
        expect(request).toContain("reasoning the fallback must not carry");
    });
});
