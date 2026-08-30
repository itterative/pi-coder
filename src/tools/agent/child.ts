import {
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
    createAgentSession,
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    agentAdditionalPaths,
    agentCanEdit,
    agentCanRunCommands,
    agentTools,
    hasAgentCapability,
    READ_ONLY_AGENT_TOOLS,
} from "./definitions/discovery";
import registerMemoryExtension from "../../modules/memory";
import registerScratchpadExtension from "../../modules/scratchpad";
import registerTodoListExtension from "../../modules/todolist";
import { createChildModelRuntime, resolveChildModel } from "./child/model-runtime";
import { childProtocolPrompt, registerChildExtension } from "./child/extension";
import { renderAgentSystemPrompt } from "./prompts/renderer";
import {
    materializePersistentSession,
    repairInterruptedToolCalls,
    selectChildSessionLeaf,
} from "./child/transcript";
import {
    aggregateUsage,
    childError,
    reportProgress,
    textFromAssistantMessage,
    traceSessionEvent,
    updateTracker,
    type ChildProgressTracker as ProgressTracker,
} from "./child/progress";

export {
    askChildUser,
    getSafeBashAssessment,
    getScoutBashAssessment,
    guardSafeBashCommand,
    isChildPathAllowed,
    isSafeBashAllowed,
    isScoutBashAllowed,
    type ChildExtensionOptions,
    type ChildPathOptions,
    type ChildProtocolPromptOptions,
    type ChildUserAnswerDetails,
    type ChildUserAnswerResult,
    type ChildUserQuestion,
    type SafeBashGuardOptions,
    type SafeBashOptions,
} from "./child/extension";
export { createChildModelRuntime, shouldCopyParentApiKey } from "./child/model-runtime";
export {
    materializePersistentSession,
    repairInterruptedToolCalls,
    selectChildSessionLeaf,
} from "./child/transcript";
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

    const initialMutation: WorkerMutationReport = context.initialMutationReport ?? {
        changedFiles: [],
        bashApproved: false,
    };
    const tracker: ProgressTracker = {
        progress: context.initialProgress
            ? {
                  ...context.initialProgress,
                  recentActivity: [...context.initialProgress.recentActivity],
                  ...(context.initialProgress.toolCounts
                      ? { toolCounts: { ...context.initialProgress.toolCounts } }
                      : {}),
                  ...(context.initialProgress.todo
                      ? { todo: { ...context.initialProgress.todo } }
                      : {}),
              }
            : { output: "", recentActivity: [], toolCounts: {} },
        lastUpdateAt: 0,
        changedFiles: new Set(initialMutation.changedFiles),
        readFiles: new Set(initialMutation.readFiles ?? []),
        bashApproved: initialMutation.bashApproved,
        interrupted: initialMutation.interrupted === true || context.repairInterrupted === true,
    };
    const cwd = context.cwd;
    const tools = agentTools(context.definition);
    const canEdit = agentCanEdit(context.definition);
    const canRunCommands = agentCanRunCommands(context.definition);
    const safeBash = hasAgentCapability(context.definition, "safe-bash");
    const hasMemories = hasAgentCapability(context.definition, "memories");
    const hasScratchpad = hasAgentCapability(context.definition, "scratchpad");
    const hasTodolist = hasAgentCapability(context.definition, "todolist");
    const additionalPaths = agentAdditionalPaths(context.definition);
    const safeBashCommands = context.definition.safeBashCommands ?? [];
    const allowUserInteraction = context.definition.allowUserInteraction !== false;
    const canAskUser =
        allowUserInteraction && parentContext.hasUI === true && parentContext.mode === "tui";
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
    // SessionManager.open() points at the latest physical leaf by default.
    // Restoration must replace that unsafe default before building context.
    if (context.childSessionFile && context.childSessionLeafId !== undefined) {
        selectChildSessionLeaf(sessionManager, context.childSessionLeafId);
    }
    context.onSessionCreated?.(sessionManager.getSessionFile(), sessionManager.getLeafId());
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
        extensionFactories: [
            {
                name: canEdit
                    ? "pi-coder-worker-child"
                    : canRunCommands
                      ? "pi-coder-command-child"
                      : "pi-coder-readonly-child",
                hidden: true,
                factory: registerChildExtension(tracker, parentContext, cwd, {
                    agentName: context.definition.name,
                    background: context.background === true,
                    canEdit,
                    safeBash,
                    runId: context.runId ?? context.definition.name,
                    runTitle: context.runTitle ?? context.runId ?? context.definition.name,
                    onProgress: context.onProgress,
                    onFileChanged: context.onFileChanged,
                    onTrace: context.onTrace,
                    events: context.events,
                    allowUserInteraction: canAskUser,
                    workspaceId: context.workspaceId,
                    isolated: context.isolated,
                    commandRunner: canRunCommands,
                    additionalPaths,
                    safeBashCommands,
                }),
            },
            ...(hasMemories
                ? [
                      {
                          name: "pi-coder-memory-child",
                          hidden: true,
                          factory: registerMemoryExtension,
                      },
                  ]
                : []),
            ...(hasScratchpad
                ? [
                      {
                          name: "pi-coder-scratchpad-child",
                          hidden: true,
                          factory: registerScratchpadExtension,
                      },
                  ]
                : []),
            ...(hasTodolist
                ? [
                      {
                          name: "pi-coder-todolist-child",
                          hidden: true,
                          factory: (pi: ExtensionAPI) =>
                              registerTodoListExtension(pi, {
                                  onTodoProgress: (todo) => {
                                      tracker.progress.todo = todo ? { ...todo } : undefined;
                                      reportProgress(tracker, context.onProgress);
                                  },
                              }),
                      },
                  ]
                : []),
        ],
        appendSystemPrompt: [
            renderAgentSystemPrompt(
                context.definition,
                childProtocolPrompt({
                    background: context.background === true,
                    canEdit,
                    safeBash,
                    allowUserInteraction: canAskUser,
                    isolated: context.isolated === true || context.workspaceId !== undefined,
                    commandRunner: canRunCommands,
                    hasScratchpad,
                    hasBashOutputAccess: safeBash || canRunCommands,
                    additionalPaths,
                    safeBashCommands,
                }),
            ),
        ],
    });
    await resourceLoader.reload();
    const interactionToolCount = canAskUser ? 2 : 1;
    context.onTrace?.("resources.loaded", {
        readOnlyToolCount: canEdit ? READ_ONLY_AGENT_TOOLS.length : tools.length,
        directUserUI: canAskUser,
        background: context.background === true,
        ...(canEdit ? { configuredToolCount: tools.length, mutating: true } : {}),
    });

    const restoredContext = context.childSessionFile
        ? sessionManager.buildSessionContext()
        : undefined;
    const restoredModelSpec = restoredContext?.model
        ? `${restoredContext.model.provider}/${restoredContext.model.modelId}`
        : undefined;
    const requestedModel = resolveChildModel(
        parentContext,
        restoredModelSpec ?? context.definition.model,
    );
    context.onTrace?.("model.resolved", {
        provider: requestedModel.provider,
        model: requestedModel.id,
        thinkingLevel: restoredContext?.thinkingLevel ?? parentContext.thinkingLevel ?? "default",
        restored: context.childSessionFile !== undefined,
    });
    const modelRuntime = await createChildModelRuntime(parentContext, requestedModel);
    const model =
        modelRuntime.getModel(requestedModel.provider, requestedModel.id) ?? requestedModel;
    const { session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        thinkingLevel: context.childSessionFile ? undefined : parentContext.thinkingLevel,
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager,
        tools: [...tools, ...(canAskUser ? ["ask_user"] : []), "ask_parent"],
    });
    // Worker mutation permission is implemented in beforeToolCall. The SDK
    // preflights every tool in a parallel batch before executing any of them;
    // waiting for a previous tool_result from that hook would therefore
    // deadlock a batch containing multiple mutations. Run worker batches
    // sequentially so each approval can reach execution and release its gate.
    // TODO(agent): Consider moving permission/queue handling into tool execution
    // wrappers so read-only worker calls can remain parallel.
    if (canEdit || canRunCommands) {
        session.agent.toolExecution = "sequential";
    }

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
        prompt: (text) =>
            session.prompt(text, { expandPromptTemplates: false, source: "extension" }),
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
                ...(tracker.progress.lastAssistantMessage
                    ? { lastAssistantMessage: tracker.progress.lastAssistantMessage }
                    : {}),
                recentActivity: [...tracker.progress.recentActivity],
                ...(tracker.progress.phase ? { phase: tracker.progress.phase } : {}),
                ...(tracker.progress.lastToolActivity
                    ? { lastToolActivity: tracker.progress.lastToolActivity }
                    : {}),
                ...(tracker.progress.toolCounts
                    ? { toolCounts: { ...tracker.progress.toolCounts } }
                    : {}),
                ...(tracker.progress.failedToolCalls !== undefined
                    ? { failedToolCalls: tracker.progress.failedToolCalls }
                    : {}),
                permissionPending: tracker.progress.permissionPending,
                ...(tracker.progress.todo ? { todo: { ...tracker.progress.todo } } : {}),
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
        getSessionLeafId: () => sessionManager.getLeafId(),
        repairInterrupted: () => {
            const repaired = repairInterruptedToolCalls(sessionManager);
            context.onTrace?.("session.repaired", { unmatchedToolCalls: repaired });
            return repaired;
        },
        getMutationReport: () => ({
            changedFiles: [...tracker.changedFiles].sort(),
            ...(tracker.readFiles.size ? { readFiles: [...tracker.readFiles].sort() } : {}),
            bashApproved: tracker.bashApproved,
            ...(tracker.interrupted ? { interrupted: true } : {}),
        }),
        sessionFile: sessionManager.getSessionFile(),
    };
}
