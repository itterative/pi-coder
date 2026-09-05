import type { Usage } from "@earendil-works/pi-ai";
import type {
    Api,
    AssistantMessage,
    Context,
    ImageContent,
    Model,
    TextContent,
} from "@earendil-works/pi-ai";
import {
    buildContextEntries as piBuildContextEntries,
    type ExtensionContext,
    type ExtensionUIContext,
    type FileOperations,
    type SessionBeforeCompactEvent,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { registerCompactionExtension } from "../../src/modules/compaction";
import type { CompactionPreparation, ContextMessage } from "../../src/modules/compaction/types";
import { zeroUsage } from "./agent-doubles";
import {
    createPiStub,
    stubContext,
    stubModel,
    stubModelRegistry,
    stubSessionManager,
    stubToolInfo,
    stubUi,
    type PiStub,
} from "./pi-stub";

/**
 * Context-message, compaction-preparation, and provider-response doubles for the compaction module.
 *
 * The message shapes come from pi's own union (`AgentMessage` reaches it only through a declaration merge
 * inside pi-coding-agent), so building them literally here means a pi-side field change fails a suite
 * instead of quietly serializing `undefined`.
 */

const ENTRY_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export function userMessage(text: string, timestamp = 0): ContextMessage {
    return { role: "user", content: text, timestamp };
}

export interface AssistantCallFixture {
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
}

export interface AssistantFixture {
    text?: string;
    thinking?: string;
    calls?: AssistantCallFixture[];
    stopReason?: AssistantMessage["stopReason"];
}

export function assistantMessage(fixture: AssistantFixture, timestamp = 0): ContextMessage {
    const content: AssistantMessage["content"] = [];
    if (fixture.thinking) {
        content.push({ type: "thinking", thinking: fixture.thinking });
    }
    if (fixture.text) {
        content.push({ type: "text", text: fixture.text });
    }
    for (const call of fixture.calls ?? []) {
        content.push({
            type: "toolCall",
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? {},
        });
    }
    return {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "stub-model",
        usage: zeroUsage(),
        stopReason: fixture.stopReason ?? "stop",
        timestamp,
    };
}

export function toolResultMessage(input: {
    callId: string;
    tool: string;
    text: string;
    isError?: boolean;
    timestamp?: number;
}): ContextMessage {
    return {
        role: "toolResult",
        toolCallId: input.callId,
        toolName: input.tool,
        content: [{ type: "text", text: input.text }],
        isError: input.isError ?? false,
        timestamp: input.timestamp ?? 0,
    };
}

export function bashExecutionMessage(input: {
    command: string;
    output?: string;
    exitCode?: number;
    cancelled?: boolean;
    excludeFromContext?: boolean;
}): ContextMessage {
    return {
        role: "bashExecution",
        command: input.command,
        output: input.output ?? "",
        exitCode: input.exitCode,
        cancelled: input.cancelled ?? false,
        truncated: false,
        excludeFromContext: input.excludeFromContext,
        timestamp: 0,
    };
}

export function customMessage(customType: string, text: string, display: boolean): ContextMessage {
    return { role: "custom", customType, content: text, display, timestamp: 0 };
}

export function compactionSummaryMessage(summary: string, tokensBefore = 1000): ContextMessage {
    return { role: "compactionSummary", summary, tokensBefore, timestamp: 0 };
}

export function messageEntry(
    id: string,
    message: ContextMessage,
    parentId: string | null = null,
): SessionEntry {
    return { type: "message", id, parentId, timestamp: ENTRY_TIMESTAMP, message };
}

/**
 * A linear branch. pi walks the leaf path through `parentId`, so entries left unlinked read as separate
 * branches and only the last one survives into the context.
 */
export function messageChain(
    items: Array<{ id: string; message: ContextMessage }>,
): SessionEntry[] {
    let parentId: string | null = null;
    return items.map((item) => {
        const entry = messageEntry(item.id, item.message, parentId);
        parentId = item.id;
        return entry;
    });
}

export function fileOperations(overrides: Partial<FileOperations> = {}): FileOperations {
    return {
        read: new Set<string>(),
        written: new Set<string>(),
        edited: new Set<string>(),
        ...overrides,
    };
}

export function compactionPreparation(
    overrides: Partial<CompactionPreparation> = {},
): CompactionPreparation {
    return {
        firstKeptEntryId: "kept-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 190_000,
        fileOps: fileOperations(),
        settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        ...overrides,
    };
}

export function compactEvent(
    overrides: Partial<SessionBeforeCompactEvent> = {},
): SessionBeforeCompactEvent {
    return {
        type: "session_before_compact",
        preparation: compactionPreparation(),
        branchEntries: [],
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
        ...overrides,
    };
}

/** A provider response carrying only summary text. */
export function summaryResponse(text: string, usage?: Usage): AssistantMessage {
    return assistantResponse([{ type: "text", text }], usage);
}

/** A provider response that tried to keep working instead of summarizing. */
export function toolCallResponse(name = "read"): AssistantMessage {
    return assistantResponse([
        { type: "text", text: "let me look" },
        { type: "toolCall", id: "call-1", name, arguments: { path: "src/index.ts" } },
    ]);
}

function assistantResponse(content: AssistantMessage["content"], usage?: Usage): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "stub-model",
        usage: usage ?? zeroUsage(),
        stopReason: "stop",
        timestamp: 0,
    };
}

/** A span with the shapes the two strategies treat differently: thinking, a tool call, and its result. */
export function sampleSpan(readBody: string): ContextMessage[] {
    return [
        userMessage("fix the compaction module"),
        assistantMessage({
            thinking: "reasoning the fallback must not carry",
            text: "reading the module",
            calls: [
                { id: "c1", name: "read", arguments: { path: "src/modules/compaction/index.ts" } },
            ],
        }),
        toolResultMessage({ callId: "c1", tool: "read", text: readBody }),
        assistantMessage({ text: "the read gave me what I needed" }),
    ];
}

/** The tail compaction keeps verbatim. */
export function sampleKept(): ContextMessage[] {
    return [
        userMessage("and keep this turn in context"),
        assistantMessage({ text: "acknowledged" }),
    ];
}

/** One recorded provider call: the exact context and options the module assembled. */
export interface RecordedCompactionCall {
    context: Context;
    options: unknown;
}

/** The `CompactionResult` pi was handed, narrowed from the handler's `unknown` payload. */
export interface CompactionPayload {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    usage?: Usage;
    details: Record<string, unknown>;
}

export interface CompactionHarness {
    /** Every provider call the module made, in order. */
    readonly calls: RecordedCompactionCall[];
    readonly piStub: PiStub;
    readonly ctx: ExtensionContext;
    /** Drive the registered `session_before_compact` handler once. */
    compact(
        eventOverrides?: Partial<SessionBeforeCompactEvent>,
    ): Promise<CompactionPayload | undefined>;
    /** The raw handler result, for suites that assert `undefined` or `{ cancel: true }` directly. */
    invoke(eventOverrides?: Partial<SessionBeforeCompactEvent>): Promise<unknown>;
    /** Read one field of the options object pi's registry was called with. */
    optionField(callIndex: number, key: string): unknown;
    /** The trailing user message of a recorded request, which is where the instruction goes. */
    trailingInstruction(callIndex: number): string;
    /** Text of every non-assistant message in a recorded request, joined. */
    sentText(callIndex: number): string;
    /** Text of the single user message a serialized request consists of. */
    requestText(callIndex: number): string;
}

export interface CompactionHarnessInput {
    cwd: string;
    responses: Array<() => Promise<AssistantMessage>>;
    span?: ContextMessage[];
    kept?: ContextMessage[];
    preparation?: Partial<CompactionPreparation>;
    model?: Model<Api>;
    notify?: ExtensionUIContext["notify"];
    hasUI?: boolean;
    systemPrompt?: string;
    sessionId?: string;
    activeTools?: string[];
    configuredTools?: string[];
    /**
     * The body to hand the request's `onPayload` inspector, if the module supplied one. The double calls it
     * the way a provider adapter would, and fails if it tries to replace the payload.
     */
    providerPayload?: unknown;
    /** What `ctx.getContextUsage()` reports: the provider's own live-context token count. */
    contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
    /** Override the branch the module reads, or make it fail. */
    branch?: SessionEntry[];
    branchThrows?: Error;
    signal?: AbortSignal;
}

/**
 * A wired compaction module: registered against a recording `pi`, driven by a recording model registry,
 * over a `ctx.sessionManager` double that answers exactly the two members production calls.
 *
 * Suites pass fixtures and read `calls`; they never hand-build an `ExtensionContext` or a registry.
 */
export function createCompactionHarness(input: CompactionHarnessInput): CompactionHarness {
    const span = input.span ?? sampleSpan("READ BODY");
    const kept = input.kept ?? sampleKept();
    const branch =
        input.branch ??
        messageChain([
            ...span.map((message, index) => ({ id: `span-${String(index)}`, message })),
            ...kept.map((message, index) => ({
                id: index === 0 ? "kept-1" : `kept-${String(index + 1)}`,
                message,
            })),
        ]);
    const calls: RecordedCompactionCall[] = [];

    const piStub = createPiStub();
    registerCompactionExtension(piStub.pi);
    piStub.toolSurface.all = (input.configuredTools ?? ["read", "bash", "agent"]).map((name) =>
        stubToolInfo(name),
    );
    piStub.toolSurface.active = input.activeTools ?? ["bash", "read"];

    let index = 0;
    const registry = stubModelRegistry(async (_model, context, options) => {
        calls.push({ context, options });
        const inspector = payloadInspector(options);
        if (inspector) {
            const replacement = inspector(input.providerPayload ?? {});
            if (replacement !== undefined) {
                throw new TypeError("compaction must not replace the provider payload it inspects");
            }
        }
        const next =
            input.responses[Math.min(index, input.responses.length - 1)] ??
            (async () => summaryResponse("## Goal\n\nunused\n\n## Progress\n\n- [x] unused"));
        index += 1;
        return await next();
    });

    const ctx = stubContext({
        cwd: input.cwd,
        model: input.model ?? stubModel(),
        modelRegistry: registry,
        hasUI: input.hasUI ?? false,
        ui: stubUi({ notify: input.notify ?? (() => {}) }),
        getSystemPrompt: () => input.systemPrompt ?? "the live system prompt",
        sessionManager: stubSessionManager({
            // The two members the compaction module calls unguarded. `buildContextEntries()` is pi's own
            // resolution of the branch, so a fixture cannot drift from what a real session reports.
            buildContextEntries: () => {
                if (input.branchThrows) {
                    throw input.branchThrows;
                }
                return piBuildContextEntries(branch);
            },
            getBranch: () => {
                if (input.branchThrows) {
                    throw input.branchThrows;
                }
                return branch;
            },
            // pi's leaf is the last entry on the current branch, so a fixture derives it the same way
            // rather than inventing an id the chain could never match.
            getLeafId: () => {
                if (input.branchThrows) {
                    throw input.branchThrows;
                }
                return branch.length > 0 ? branch[branch.length - 1].id : null;
            },
            getSessionId: () => input.sessionId ?? "session-1",
        }),
        getContextUsage: () => input.contextUsage,
    });

    const handler = piStub.requireHandler("session_before_compact");

    function event(overrides: Partial<SessionBeforeCompactEvent> = {}): SessionBeforeCompactEvent {
        return compactEvent({
            preparation: compactionPreparation({
                firstKeptEntryId: "kept-1",
                messagesToSummarize: span,
                fileOps: fileOperations({
                    read: new Set(["src/index.ts"]),
                    edited: new Set(["src/modules/compaction/index.ts"]),
                }),
                ...input.preparation,
            }),
            branchEntries: branch,
            signal: input.signal ?? new AbortController().signal,
            ...overrides,
        });
    }

    async function invoke(overrides: Partial<SessionBeforeCompactEvent> = {}): Promise<unknown> {
        return await handler(event(overrides), ctx);
    }

    function recorded(callIndex: number): RecordedCompactionCall {
        const call = calls[callIndex];
        if (!call) {
            throw new TypeError(`no recorded call at index ${String(callIndex)}`);
        }
        return call;
    }

    return {
        calls,
        piStub,
        ctx,
        compact: async (overrides) => narrowCompactionPayload(await invoke(overrides)),
        invoke,
        optionField(callIndex, key) {
            const { options } = recorded(callIndex);
            if (!options || typeof options !== "object") {
                throw new TypeError(`recorded options are not an object: ${String(options)}`);
            }
            return (options as Record<string, unknown>)[key];
        },
        trailingInstruction(callIndex) {
            const { context } = recorded(callIndex);
            const last = context.messages[context.messages.length - 1];
            if (!last || last.role !== "user") {
                throw new TypeError("expected the request to end with a user message");
            }
            return textOfContent(last.content);
        },
        sentText(callIndex) {
            const { context } = recorded(callIndex);
            return context.messages
                .filter((one) => one.role !== "assistant")
                .map((one) => textOfContent(one.content))
                .join("\n");
        },
        requestText(callIndex) {
            const { context } = recorded(callIndex);
            const first = context.messages[0];
            if (!first || first.role !== "user") {
                throw new TypeError("expected the serialized request to be one user message");
            }
            return textOfContent(first.content);
        },
    };
}

/** Read the `onPayload` inspector out of a recorded options object, if one was passed. */
function payloadInspector(options: unknown): ((payload: unknown) => unknown) | undefined {
    if (!options || typeof options !== "object") {
        return undefined;
    }
    const candidate = (options as Record<string, unknown>).onPayload;
    return typeof candidate === "function"
        ? (candidate as (payload: unknown) => unknown)
        : undefined;
}

function textOfContent(content: string | (TextContent | ImageContent)[]): string {
    if (typeof content === "string") {
        return content;
    }
    return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");
}

/** Narrow the handler's `{ compaction } | { cancel } | undefined` result, failing on any other shape. */
export function narrowCompactionPayload(result: unknown): CompactionPayload | undefined {
    if (result === undefined) {
        return undefined;
    }
    if (!result || typeof result !== "object") {
        throw new TypeError(`unexpected handler result: ${String(result)}`);
    }
    const record = result as Record<string, unknown>;
    if (record.cancel !== undefined) {
        return undefined;
    }
    const compaction = record.compaction as Record<string, unknown> | undefined;
    if (!compaction) {
        throw new TypeError(`handler returned neither compaction nor cancel: ${String(result)}`);
    }
    if (typeof compaction.summary !== "string") {
        throw new TypeError("compaction payload has no summary text");
    }
    return {
        summary: compaction.summary,
        firstKeptEntryId: String(compaction.firstKeptEntryId),
        tokensBefore: Number(compaction.tokensBefore),
        usage: compaction.usage as Usage | undefined,
        details: (compaction.details ?? {}) as Record<string, unknown>,
    };
}
