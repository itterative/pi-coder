import {
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
    createAgentSession,
    getAgentDir,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { agentTools, READ_ONLY_AGENT_TOOLS } from "./definitions/discovery";
import { createChildModelRuntime, resolveChildModel } from "./child/model-runtime";
import { childProtocolPrompt, registerChildExtension } from "./child/extension";
import { materializePersistentSession, repairInterruptedToolCalls } from "./child/transcript";
import {
    aggregateUsage,
    childError,
    textFromAssistantMessage,
    traceSessionEvent,
    updateTracker,
    type ChildProgressTracker as ProgressTracker,
} from "./child/progress";

export {
    askChildUser,
    getScoutBashAssessment,
    isChildPathAllowed,
    isScoutBashAllowed,
    type ChildUserAnswerDetails,
    type ChildUserAnswerResult,
    type ChildUserQuestion,
} from "./child/extension";
export { createChildModelRuntime, shouldCopyParentApiKey } from "./child/model-runtime";
export { materializePersistentSession, repairInterruptedToolCalls } from "./child/transcript";
import type {
    ChildAgentFactoryContext,
    ChildAgentHandle,
    ChildProgress,
    ParentQuestion,
} from "./contracts/runs";
import type { WorkerMutationReport } from "./contracts/mutations";
import { ZERO_USAGE } from "./runs/usage";

export async function createAgentChild(
    context: ChildAgentFactoryContext,
): Promise<ChildAgentHandle> {
    const parentContext = context.parentContext as ExtensionContext;
    if (!parentContext.model) throw new Error("No parent model is selected.");

    const initialMutation: WorkerMutationReport = context.initialMutationReport
        ?? { changedFiles: [], bashApproved: false };
    const tracker: ProgressTracker = {
        progress: context.initialProgress
            ? { ...context.initialProgress, recentActivity: [...context.initialProgress.recentActivity] }
            : { output: "", recentActivity: [] },
        lastUpdateAt: 0,
        changedFiles: new Set(initialMutation.changedFiles),
        readFiles: new Set(initialMutation.readFiles ?? []),
        bashApproved: initialMutation.bashApproved,
        interrupted: initialMutation.interrupted === true || context.repairInterrupted === true,
    };
    const cwd = context.cwd;
    const tools = agentTools(context.definition);
    const agentDir = getAgentDir();
    let sessionManager = context.childSessionFile
        ? SessionManager.open(context.childSessionFile, context.childSessionDir, cwd)
        : context.childSessionDir
            ? materializePersistentSession(
                SessionManager.create(cwd, context.childSessionDir),
                context.childSessionDir,
                cwd,
            )
            : SessionManager.inMemory(cwd);
    if (context.repairInterrupted) {
        const repaired = repairInterruptedToolCalls(sessionManager);
        context.onTrace?.("session.repaired", { unmatchedToolCalls: repaired });
    }
    context.onSessionCreated?.(sessionManager.getSessionFile());
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: false,
        extensionFactories: [{
            name: context.definition.mutating
                ? "pi-coder-worker-child"
                : "pi-coder-readonly-child",
            hidden: true,
            factory: registerChildExtension(
                tracker,
                parentContext,
                cwd,
                context.definition.name,
                context.background === true,
                context.definition.mutating === true,
                context.definition.capabilities.includes("safe-bash"),
                context.runId ?? context.definition.name,
                context.runTitle ?? context.runId ?? context.definition.name,
                context.onProgress,
                context.onTrace,
            ),
        }],
        appendSystemPrompt: [
            context.definition.systemPrompt,
            childProtocolPrompt(
                context.background === true,
                context.definition.mutating === true,
                context.definition.capabilities.includes("safe-bash"),
            ),
        ].filter(Boolean),
    });
    await resourceLoader.reload();
    const interactionToolCount = context.background ? 1 : 2;
    context.onTrace?.("resources.loaded", {
        readOnlyToolCount: context.definition.mutating ? READ_ONLY_AGENT_TOOLS.length : tools.length,
        directUserUI: !context.background && parentContext.hasUI && parentContext.mode === "tui",
        background: context.background === true,
        ...(context.definition.mutating
            ? { configuredToolCount: tools.length, mutating: true }
            : {}),
    });

    const restoredContext = context.childSessionFile
        ? sessionManager.buildSessionContext()
        : undefined;
    const restoredModelSpec = restoredContext?.model
        ? `${restoredContext.model.provider}/${restoredContext.model.modelId}`
        : undefined;
    const requestedModel = resolveChildModel(
        parentContext,
        context.definition.model ?? restoredModelSpec,
    );
    context.onTrace?.("model.resolved", {
        provider: requestedModel.provider,
        model: requestedModel.id,
        thinkingLevel: restoredContext?.thinkingLevel ?? parentContext.thinkingLevel ?? "default",
        restored: context.childSessionFile !== undefined,
    });
    const modelRuntime = await createChildModelRuntime(parentContext, requestedModel);
    const model = modelRuntime.getModel(requestedModel.provider, requestedModel.id)
        ?? requestedModel;
    const { session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        thinkingLevel: context.childSessionFile ? undefined : parentContext.thinkingLevel,
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager,
        tools: [
            ...tools,
            ...(context.background ? [] : ["ask_user"]),
            "ask_parent",
        ],
    });

    context.onTrace?.("session.created", {
        toolCount: tools.length + interactionToolCount,
    });
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
                permissionPending: tracker.progress.permissionPending,
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
        getMutationReport: () => ({
            changedFiles: [...tracker.changedFiles].sort(),
            ...(tracker.readFiles.size ? { readFiles: [...tracker.readFiles].sort() } : {}),
            bashApproved: tracker.bashApproved,
            ...(tracker.interrupted ? { interrupted: true } : {}),
        }),
        sessionFile: sessionManager.getSessionFile(),
    };
}
