import type { Usage } from "@earendil-works/pi-ai";
import {
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    createAgentSession,
    getAgentDir,
    isToolCallEventType,
    type AgentSession,
    type AgentSessionEvent,
    type ExtensionAPI,
    type ExtensionContext,
    type FindToolInput,
    type GrepToolInput,
    type LsToolInput,
    type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { SandboxConfigCwdConfinement } from "../../common/config";
import { getPathConfinementPermission } from "../../modules/sandbox/heuristics";
import { askUser } from "../../tui/ask-user";
import type { AgentTraceData } from "./trace";
import {
    ZERO_USAGE,
    type ChildAgentFactoryContext,
    type ChildAgentHandle,
    type ChildProgress,
    type ParentQuestion,
} from "./runtime";

const MAX_RECENT_ACTIVITY = 8;
const UPDATE_THROTTLE_MS = 100;

const CHILD_CONFINEMENT: SandboxConfigCwdConfinement = {
    enabled: true,
    permission: "allow",
    resolveSymlinks: true,
};

const CHILD_PROTOCOL_PROMPT = `You are a read-only subagent working for a parent coding agent. You cannot run commands or modify files.

Use ask_user when you need a preference, clarification, or decision directly from the end user, and call it alone in its tool batch so later work can incorporate the answer. The answer returns in the same turn, so continue your work afterward. Use ask_parent instead when the parent can answer, investigate, or decide; make reasonable progress first, include evidence and a recommendation, and call ask_parent alone in its tool batch. Do not ask questions only in prose when either interaction tool applies.

When the task is complete, provide a self-contained final report to the parent.`;

interface ProgressTracker {
    progress: ChildProgress;
    pendingQuestion?: ParentQuestion;
    lastUpdateAt: number;
}

export function isChildPathAllowed(filePath: string | undefined, cwd: string): boolean {
    const effectivePath = filePath?.trim() || cwd;
    return getPathConfinementPermission(effectivePath, cwd, CHILD_CONFINEMENT) !== undefined;
}

export interface ChildUserQuestion {
    title: string;
    description?: string;
    options: Array<{ label: string; description?: string }>;
}

export interface ChildUserAnswerDetails {
    unavailable?: boolean;
    canceled?: boolean;
    answer?: string;
    isCustom?: boolean;
    optionIndex?: number;
}

export interface ChildUserAnswerResult {
    content: Array<{ type: "text"; text: string }>;
    details: ChildUserAnswerDetails;
}

export async function askChildUser(
    question: ChildUserQuestion,
    parentContext: ExtensionContext,
    agentName: string,
    signal?: AbortSignal,
): Promise<ChildUserAnswerResult> {
    if (!parentContext.hasUI || parentContext.mode !== "tui") {
        return {
            content: [{
                type: "text" as const,
                text: "Direct user interaction is unavailable in this mode. Use ask_parent for guidance instead.",
            }],
            details: { unavailable: true },
        };
    }

    const result = await askUser({
        title: `${agentName} asks: ${question.title}`,
        description: question.description,
        options: question.options,
    }, parentContext, signal);

    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new Error("Child user question was aborted.");
    }
    if (!result) {
        return {
            content: [{
                type: "text" as const,
                text: "The user cancelled the question. Continue with a reasonable default or use ask_parent if guidance is required.",
            }],
            details: { canceled: true },
        };
    }

    const responseText = result.isCustom
        ? `User replied with custom message: ${result.answer}`
        : `User selected: ${result.answer}`;
    return {
        content: [{ type: "text" as const, text: responseText }],
        details: {
            answer: result.answer,
            isCustom: result.isCustom,
            optionIndex: result.optionIndex,
        },
    };
}

function registerChildExtension(
    tracker: ProgressTracker,
    parentContext: ExtensionContext,
    agentName: string,
    onTrace?: ChildAgentFactoryContext["onTrace"],
) {
    return (pi: ExtensionAPI): void => {
        pi.registerTool({
            name: "ask_user",
            label: "Ask User",
            description:
                "Ask the end user for a preference, clarification, or decision, then continue this child turn. "
                + "Use ask_parent instead when the parent agent can investigate or decide.",
            promptSnippet: "Use ask_user for decisions that require direct end-user input.",
            promptGuidelines: [
                "Use ask_user only when the end user's input materially affects the work, and call it alone in its tool batch",
                "Include a recommendation and an Unsure or You decide option when appropriate",
                "Continue the task after receiving the user's answer",
            ],
            executionMode: "sequential",
            parameters: Type.Object({
                title: Type.String({ minLength: 1, maxLength: 200 }),
                description: Type.Optional(Type.String({ maxLength: 4_000 })),
                options: Type.Array(Type.Object({
                    label: Type.String({ minLength: 1, maxLength: 500 }),
                    description: Type.Optional(Type.String({ maxLength: 2_000 })),
                }, { additionalProperties: false }), { minItems: 2, maxItems: 8 }),
            }, { additionalProperties: false }),
            async execute(_toolCallId, params, signal) {
                onTrace?.("interaction.user.opened", {
                    titleChars: params.title.length,
                    optionCount: params.options.length,
                });
                try {
                    const result = await askChildUser(params, parentContext, agentName, signal);
                    const outcome = result.details.unavailable
                        ? "unavailable"
                        : result.details.canceled
                            ? "canceled"
                            : result.details.isCustom
                                ? "custom_answer"
                                : "option_selected";
                    onTrace?.("interaction.user.closed", {
                        outcome,
                        optionIndex: result.details.optionIndex ?? -1,
                        answerChars: result.details.answer?.length ?? 0,
                    });
                    return result;
                } catch (error) {
                    onTrace?.("interaction.user.aborted", {
                        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
                    });
                    throw error;
                }
            },
        });

        pi.registerTool({
            name: "ask_parent",
            label: "Ask Parent",
            description:
                "Pause this scout and request guidance from the parent agent. "
                + "Use only after making reasonable progress and include evidence and a recommendation.",
            promptSnippet: "Use ask_parent to pause and request guidance from the parent agent.",
            promptGuidelines: [
                "Call ask_parent alone in a tool batch and only when parent guidance materially improves the result",
                "Include relevant evidence, partial findings, and your recommended next step",
                "Use ask_user instead when a decision genuinely requires direct end-user input",
            ],
            executionMode: "sequential",
            parameters: Type.Object({
                question: Type.String({ minLength: 1, maxLength: 4_000 }),
                context: Type.Optional(Type.String({ maxLength: 12_000 })),
                options: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 8 })),
                recommendation: Type.Optional(Type.String({ maxLength: 4_000 })),
            }, { additionalProperties: false }),
            async execute(_toolCallId, params) {
                if (tracker.pendingQuestion) {
                    return {
                        content: [{ type: "text", text: "A parent-guidance request is already pending." }],
                        details: tracker.pendingQuestion,
                        terminate: true,
                    };
                }

                tracker.pendingQuestion = {
                    question: params.question,
                    context: params.context,
                    options: params.options,
                    recommendation: params.recommendation,
                };
                onTrace?.("interaction.parent.requested", {
                    questionChars: params.question.length,
                    optionCount: params.options?.length ?? 0,
                });
                return {
                    content: [{ type: "text", text: "Paused for parent guidance." }],
                    details: tracker.pendingQuestion,
                    terminate: true,
                };
            },
        });

        pi.on("tool_call", (event, ctx) => {
            let filePath: string | undefined;
            if (isToolCallEventType<"read", ReadToolInput>("read", event)) {
                filePath = event.input.path;
            } else if (isToolCallEventType<"grep", GrepToolInput>("grep", event)) {
                filePath = event.input.path;
            } else if (isToolCallEventType<"find", FindToolInput>("find", event)) {
                filePath = event.input.path;
            } else if (isToolCallEventType<"ls", LsToolInput>("ls", event)) {
                filePath = event.input.path;
            } else {
                return;
            }

            if (isChildPathAllowed(filePath, ctx.cwd)) return;
            return {
                block: true,
                reason: "Read-only scout access blocked: path is outside the allowed working directory or is sensitive.",
            };
        });
    };
}

function textFromAssistantMessage(message: unknown): string {
    if (!message || typeof message !== "object" || !("content" in message)) return "";
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((part): part is { type: "text"; text: string } => (
            typeof part === "object"
            && part !== null
            && (part as { type?: unknown }).type === "text"
            && typeof (part as { text?: unknown }).text === "string"
        ))
        .map((part) => part.text)
        .join("");
}

function cloneUsage(usage: Usage): Usage {
    return { ...usage, cost: { ...usage.cost } };
}

function aggregateUsage(session: AgentSession): Usage {
    const total = cloneUsage(ZERO_USAGE);
    let sawReasoning = false;
    let sawCacheWrite1h = false;

    for (const entry of session.sessionManager.getBranch()) {
        let usage: Usage | undefined;
        if (entry.type === "message" && "usage" in entry.message) {
            usage = entry.message.usage;
        } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
            usage = entry.usage;
        }
        if (!usage) continue;

        total.input += usage.input;
        total.output += usage.output;
        total.cacheRead += usage.cacheRead;
        total.cacheWrite += usage.cacheWrite;
        total.totalTokens += usage.totalTokens;
        total.cost.input += usage.cost.input;
        total.cost.output += usage.cost.output;
        total.cost.cacheRead += usage.cost.cacheRead;
        total.cost.cacheWrite += usage.cost.cacheWrite;
        total.cost.total += usage.cost.total;
        if (usage.reasoning !== undefined) {
            sawReasoning = true;
            total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
        }
        if (usage.cacheWrite1h !== undefined) {
            sawCacheWrite1h = true;
            total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
        }
    }

    if (!sawReasoning) delete total.reasoning;
    if (!sawCacheWrite1h) delete total.cacheWrite1h;
    return total;
}

function childError(session: AgentSession): string | undefined {
    const assistant = [...session.state.messages]
        .reverse()
        .find((message) => message.role === "assistant");
    if (!assistant || assistant.role !== "assistant") return session.state.errorMessage;

    if (assistant.stopReason === "error") {
        return assistant.errorMessage ?? session.state.errorMessage ?? "Child model request failed.";
    }
    if (assistant.stopReason === "length") return "Child response hit the model output limit.";
    if (assistant.stopReason === "aborted") return "Child model request was aborted.";
    if (assistant.stopReason === "deferred" || assistant.stopReason === "pending") {
        return `Unsupported child response state: ${assistant.stopReason}.`;
    }
    return undefined;
}

function tracePreview(text: string, maxChars = 240): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxChars
        ? normalized
        : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function traceToolArgs(toolName: string, args: unknown): AgentTraceData {
    if (!args || typeof args !== "object") return {};
    const input = args as Record<string, unknown>;
    const pathValue = typeof input.path === "string" ? input.path : "";
    if (toolName === "read") {
        return {
            path: pathValue,
            offset: typeof input.offset === "number" ? input.offset : 0,
            limit: typeof input.limit === "number" ? input.limit : 0,
        };
    }
    if (toolName === "grep" || toolName === "find") {
        const pattern = typeof input.pattern === "string" ? input.pattern : "";
        return { path: pathValue, patternPreview: tracePreview(pattern, 120) };
    }
    if (toolName === "ls") return { path: pathValue };
    if (toolName === "ask_user") {
        return {
            titlePreview: tracePreview(typeof input.title === "string" ? input.title : "", 120),
            optionCount: Array.isArray(input.options) ? input.options.length : 0,
        };
    }
    if (toolName === "ask_parent") {
        return {
            questionPreview: tracePreview(
                typeof input.question === "string" ? input.question : "",
                120,
            ),
            optionCount: Array.isArray(input.options) ? input.options.length : 0,
        };
    }
    return { argumentKeys: Object.keys(input).sort().join(",") };
}

function traceResultChars(result: unknown): number {
    if (!result || typeof result !== "object") return 0;
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return 0;
    return content.reduce((total, part) => {
        if (!part || typeof part !== "object") return total;
        const text = (part as { text?: unknown }).text;
        return total + (typeof text === "string" ? text.length : 0);
    }, 0);
}

function traceSessionEvent(
    event: AgentSessionEvent,
): { type: string; data?: AgentTraceData } | undefined {
    if (event.type === "agent_start" || event.type === "turn_start" || event.type === "agent_settled") {
        return { type: `session.${event.type}` };
    }
    if (event.type === "agent_end") {
        return {
            type: "session.agent_end",
            data: { messageCount: event.messages.length, willRetry: event.willRetry },
        };
    }
    if (event.type === "turn_end") {
        return {
            type: "session.turn_end",
            data: {
                role: event.message.role,
                toolResultCount: event.toolResults.length,
            },
        };
    }
    if (event.type === "message_start" || event.type === "message_end") {
        const role = event.message.role;
        const text = textFromAssistantMessage(event.message);
        return {
            type: `session.${event.type}`,
            data: {
                role,
                textChars: text.length,
                ...(role === "assistant" && event.type === "message_end"
                    ? { textPreview: tracePreview(text) }
                    : {}),
            },
        };
    }
    if (event.type === "tool_execution_start") {
        return {
            type: "session.tool_start",
            data: { tool: event.toolName, ...traceToolArgs(event.toolName, event.args) },
        };
    }
    if (event.type === "tool_execution_end") {
        const result = event.result as { terminate?: unknown; details?: unknown } | undefined;
        const details = result?.details && typeof result.details === "object"
            ? result.details as Record<string, unknown>
            : undefined;
        return {
            type: "session.tool_end",
            data: {
                tool: event.toolName,
                isError: event.isError,
                terminate: result?.terminate === true,
                resultChars: traceResultChars(event.result),
                canceled: details?.canceled === true,
                unavailable: details?.unavailable === true,
            },
        };
    }
    if (event.type === "compaction_start" || event.type === "compaction_end") {
        return { type: `session.${event.type}`, data: { reason: event.reason } };
    }
    return undefined;
}

function updateTracker(
    event: AgentSessionEvent,
    tracker: ProgressTracker,
    onProgress: (progress: ChildProgress) => void,
): void {
    if (event.type === "message_start" && event.message.role === "assistant") {
        tracker.progress.output = textFromAssistantMessage(event.message);
    } else if (
        event.type === "message_update"
        && event.message.role === "assistant"
        && event.assistantMessageEvent.type === "text_delta"
    ) {
        tracker.progress.output += event.assistantMessageEvent.delta;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
        tracker.progress.output = textFromAssistantMessage(event.message);
    } else if (event.type === "tool_execution_start") {
        tracker.progress.recentActivity.push(`Using ${event.toolName}`);
        tracker.progress.recentActivity = tracker.progress.recentActivity.slice(-MAX_RECENT_ACTIVITY);
    } else {
        return;
    }

    const now = Date.now();
    if (now - tracker.lastUpdateAt >= UPDATE_THROTTLE_MS) {
        tracker.lastUpdateAt = now;
        onProgress({
            output: tracker.progress.output,
            recentActivity: [...tracker.progress.recentActivity],
        });
    }
}

function mergeProviderHeaders(
    configured: Record<string, string> | undefined,
    resolved: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
    const merged = { ...configured };
    for (const [name, value] of Object.entries(resolved ?? {})) {
        if (value === null) delete merged[name];
        else merged[name] = value;
    }
    return Object.keys(merged).length ? merged : undefined;
}

export function shouldCopyParentApiKey(options: {
    childHasAuth: boolean;
    parentHasApiKey: boolean;
    parentUsesOAuth: boolean;
}): boolean {
    return !options.childHasAuth && options.parentHasApiKey && !options.parentUsesOAuth;
}

export async function createChildModelRuntime(
    ctx: ExtensionContext,
    model: NonNullable<ExtensionContext["model"]>,
): Promise<ModelRuntime> {
    const parentAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!parentAuth.ok) throw new Error(parentAuth.error);

    const runtime = await ModelRuntime.create();
    const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
    if (nativeProvider) runtime.registerNativeProvider(nativeProvider);

    const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
    if (providerConfig) {
        runtime.registerProvider(model.provider, {
            ...providerConfig,
            baseUrl: parentAuth.baseUrl ?? providerConfig.baseUrl,
            headers: mergeProviderHeaders(providerConfig.headers, parentAuth.headers),
        });
    }

    let runtimeModel = runtime.getModel(model.provider, model.id) ?? model;
    let childAuth = await runtime.getAuth(runtimeModel);
    const childHasAuth = Boolean(childAuth?.auth.apiKey || childAuth?.auth.headers);
    const parentUsesOAuth = ctx.modelRegistry.isUsingOAuth(model);

    if (shouldCopyParentApiKey({
        childHasAuth,
        parentHasApiKey: Boolean(parentAuth.apiKey),
        parentUsesOAuth,
    })) {
        await runtime.setRuntimeApiKey(model.provider, parentAuth.apiKey!);
        runtimeModel = runtime.getModel(model.provider, model.id) ?? model;
        childAuth = await runtime.getAuth(runtimeModel);
    }

    if (!childAuth?.auth.apiKey && !childAuth?.auth.headers) {
        const authKind = parentUsesOAuth ? "OAuth credentials" : "provider credentials";
        throw new Error(
            `Could not synchronize ${authKind} for child model ${model.provider}/${model.id}.`,
        );
    }
    return runtime;
}

function resolveChildModel(
    ctx: ExtensionContext,
    modelSpec: string | undefined,
): NonNullable<ExtensionContext["model"]> {
    if (!ctx.model) throw new Error("No parent model is selected.");
    if (!modelSpec) return ctx.model;

    const slash = modelSpec.indexOf("/");
    if (slash > 0) {
        const model = ctx.modelRegistry.find(modelSpec.slice(0, slash), modelSpec.slice(slash + 1));
        if (model) return model;
    } else {
        const sameProvider = ctx.modelRegistry.find(ctx.model.provider, modelSpec);
        if (sameProvider) return sameProvider;
        const matches = ctx.modelRegistry.getAll().filter((model) => model.id === modelSpec);
        if (matches.length === 1) return matches[0]!;
    }
    throw new Error(`Agent model is unavailable or ambiguous: ${modelSpec}`);
}

export async function createAgentChild(
    context: ChildAgentFactoryContext,
): Promise<ChildAgentHandle> {
    const parentContext = context.parentContext as ExtensionContext;
    if (!parentContext.model) throw new Error("No parent model is selected.");

    const tracker: ProgressTracker = {
        progress: { output: "", recentActivity: [] },
        lastUpdateAt: 0,
    };
    const cwd = context.cwd;
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [{
            name: "pi-coder-scout-child",
            hidden: true,
            factory: registerChildExtension(
                tracker,
                parentContext,
                context.definition.name,
                context.onTrace,
            ),
        }],
        appendSystemPrompt: [context.definition.systemPrompt, CHILD_PROTOCOL_PROMPT].filter(Boolean),
    });
    await resourceLoader.reload();
    context.onTrace?.("resources.loaded", {
        readOnlyToolCount: context.definition.tools.length,
        directUserUI: parentContext.hasUI && parentContext.mode === "tui",
    });

    const requestedModel = resolveChildModel(parentContext, context.definition.model);
    context.onTrace?.("model.resolved", {
        provider: requestedModel.provider,
        model: requestedModel.id,
        thinkingLevel: parentContext.thinkingLevel ?? "default",
    });
    const modelRuntime = await createChildModelRuntime(parentContext, requestedModel);
    const model = modelRuntime.getModel(requestedModel.provider, requestedModel.id)
        ?? requestedModel;
    const { session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        thinkingLevel: parentContext.thinkingLevel,
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [...context.definition.tools, "ask_user", "ask_parent"],
    });

    context.onTrace?.("session.created", { toolCount: context.definition.tools.length + 2 });
    const unsubscribe = session.subscribe((event) => {
        const traceEvent = traceSessionEvent(event);
        if (traceEvent) context.onTrace?.(traceEvent.type, traceEvent.data);
        updateTracker(event, tracker, context.onProgress);
    });
    try {
        await session.bindExtensions({ mode: "print" });
        context.onTrace?.("session.extensions_bound");
    } catch (error) {
        unsubscribe();
        session.dispose();
        throw error;
    }

    let disposed = false;
    return {
        prompt: (text) => session.prompt(text, { expandPromptTemplates: false, source: "extension" }),
        abort: () => session.abort(),
        dispose() {
            if (disposed) return;
            disposed = true;
            context.onTrace?.("session.dispose_called");
            unsubscribe();
            session.dispose();
        },
        takeParentQuestion() {
            const question = tracker.pendingQuestion;
            tracker.pendingQuestion = undefined;
            return question;
        },
        getProgress() {
            return {
                output: tracker.progress.output,
                recentActivity: [...tracker.progress.recentActivity],
            };
        },
        getFinalOutput() {
            const assistant = [...session.state.messages]
                .reverse()
                .find((message) => message.role === "assistant");
            return textFromAssistantMessage(assistant);
        },
        getError: () => childError(session),
        getUsage: () => aggregateUsage(session),
    };
}
