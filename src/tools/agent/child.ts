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

Use ask_parent only when parent guidance can materially improve the result. Make reasonable progress first, explain the evidence and your recommended next step, and call ask_parent alone in its tool batch. Do not address questions directly to the end user; the parent decides whether to answer, investigate, or ask the user.

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

function registerChildExtension(tracker: ProgressTracker) {
    return (pi: ExtensionAPI): void => {
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
                "Do not ask the end user directly; all questions route through the parent agent",
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
            factory: registerChildExtension(tracker),
        }],
        appendSystemPrompt: [context.definition.systemPrompt, CHILD_PROTOCOL_PROMPT].filter(Boolean),
    });
    await resourceLoader.reload();

    const requestedModel = resolveChildModel(parentContext, context.definition.model);
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
        tools: [...context.definition.tools, "ask_parent"],
    });

    const unsubscribe = session.subscribe((event) => {
        updateTracker(event, tracker, context.onProgress);
    });
    try {
        await session.bindExtensions({ mode: "print" });
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
