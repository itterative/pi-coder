import {
    DefaultResourceLoader,
    SettingsManager,
    createAgentSession,
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
    type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { READ_ONLY_AGENT_TOOLS } from "../definitions/discovery";
import registerMemoryExtension from "../../../modules/memory";
import registerScratchpadExtension from "../../../modules/scratchpad";
import registerTodoListExtension from "../../../modules/todolist";
import { deriveChildCapabilities, type ChildCapabilities } from "./capabilities";
import {
    createChildModelRuntime,
    resolveChildModel,
    restoreChildSessionModel,
} from "./model-runtime";
import { createChildHandle } from "./handle";
import { childProtocolPrompt, registerChildExtension } from "./extension";
import { renderAgentSystemPrompt } from "../prompts/renderer";
import { bootstrapChildSession } from "./transcript";
import {
    reportProgress,
    seedProgressTracker,
    traceSessionEvent,
    updateTracker,
    type ChildProgressTracker,
} from "./progress";

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
} from "./extension";
export { createChildModelRuntime, shouldCopyParentApiKey } from "./model-runtime";
export {
    materializePersistentSession,
    repairInterruptedToolCalls,
    selectChildSessionLeaf,
} from "./transcript";
import type { ChildAgentFactoryContext, ChildAgentHandle } from "../contracts/runs";

/** What the child's extension set and system prompt are assembled from. */
interface ChildAssemblyRequest {
    context: ChildAgentFactoryContext;
    parentContext: ExtensionContext;
    cwd: string;
    tracker: ChildProgressTracker;
    capabilities: ChildCapabilities;
}

/**
 * The registered name of the child extension. A worker is named for its edit authority even though it
 * also runs commands, so the wider grant decides the label the loader records.
 */
function childExtensionKind({ canEdit, canRunCommands }: ChildCapabilities): string {
    if (canEdit) {
        return "pi-coder-worker-child";
    }
    if (canRunCommands) {
        return "pi-coder-command-child";
    }
    return "pi-coder-readonly-child";
}

/**
 * The extensions a child runs with: the pi-coder child extension, plus one per capability the
 * definition holds. Every entry is `hidden`, because these register the child's own tool surface
 * rather than commands the end user may invoke.
 */
function childExtensionEntries(request: ChildAssemblyRequest): InlineExtension[] {
    const { context, parentContext, cwd, tracker, capabilities } = request;
    const entries: InlineExtension[] = [
        {
            name: childExtensionKind(capabilities),
            hidden: true,
            factory: registerChildExtension(tracker, parentContext, cwd, {
                agentName: context.definition.name,
                background: context.background === true,
                canEdit: capabilities.canEdit,
                safeBash: capabilities.safeBash,
                runId: context.runId ?? context.definition.name,
                runTitle: context.runTitle ?? context.runId ?? context.definition.name,
                onProgress: context.onProgress,
                onFileChanged: context.onFileChanged,
                onTrace: context.onTrace,
                events: context.events,
                allowUserInteraction: capabilities.canAskUser,
                workspaceId: context.workspaceId,
                isolated: context.isolated,
                commandRunner: capabilities.canRunCommands,
                additionalPaths: capabilities.additionalPaths,
                safeBashCommands: capabilities.safeBashCommands,
            }),
        },
    ];

    if (capabilities.hasMemories) {
        entries.push({
            name: "pi-coder-memory-child",
            hidden: true,
            factory: registerMemoryExtension,
        });
    }
    if (capabilities.hasScratchpad) {
        entries.push({
            name: "pi-coder-scratchpad-child",
            hidden: true,
            factory: registerScratchpadExtension,
        });
    }
    if (capabilities.hasTodolist) {
        entries.push({
            name: "pi-coder-todolist-child",
            hidden: true,
            // A todo change is a progress frame like any other: store it on the tracker first, then
            // report the whole frame, so the parent never sees a todo list ahead of its activity.
            factory: (pi: ExtensionAPI) =>
                registerTodoListExtension(pi, {
                    onTodoProgress: (todo) => {
                        tracker.progress.todo = todo ? { ...todo } : undefined;
                        reportProgress(tracker, context.onProgress);
                    },
                }),
        });
    }
    return entries;
}

/**
 * The child's system prompt: its definition's instructions plus the delegated-run protocol.
 *
 * `isolated` is derived differently here than in the extension set on purpose. The prompt has to
 * describe a run that owns a workspace even when the transient factory flag was not persisted with
 * the run, so a workspace ID counts; the extension receives the raw flag and reconciles the same
 * rule internally. Keep the two spellings in step if either one changes.
 */
function childSystemPrompt(request: ChildAssemblyRequest): string {
    const { context, capabilities } = request;
    return renderAgentSystemPrompt(
        context.definition,
        childProtocolPrompt({
            background: context.background === true,
            canEdit: capabilities.canEdit,
            safeBash: capabilities.safeBash,
            allowUserInteraction: capabilities.canAskUser,
            isolated: context.isolated === true || context.workspaceId !== undefined,
            commandRunner: capabilities.canRunCommands,
            hasScratchpad: capabilities.hasScratchpad,
            hasBashOutputAccess: capabilities.safeBash || capabilities.canRunCommands,
            additionalPaths: capabilities.additionalPaths,
            safeBashCommands: capabilities.safeBashCommands,
        }),
    );
}

export async function createAgentChild(
    context: ChildAgentFactoryContext,
): Promise<ChildAgentHandle> {
    const parentContext = context.parentContext as ExtensionContext;
    if (!parentContext.model) throw new Error("No parent model is selected.");

    const tracker = seedProgressTracker(context);
    const cwd = context.cwd;
    const capabilities = deriveChildCapabilities(context.definition, parentContext);

    const agentDir = getAgentDir();
    // The transcript is positioned on the leaf this run owns inside the bootstrap, before anything
    // reads the session context; see `bootstrapChildSession`.
    const sessionManager = bootstrapChildSession(context);
    context.onSessionCreated?.(sessionManager.getSessionFile(), sessionManager.getLeafId());
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const request: ChildAssemblyRequest = { context, parentContext, cwd, tracker, capabilities };
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: false,
        extensionFactories: childExtensionEntries(request),
        appendSystemPrompt: [childSystemPrompt(request)],
    });
    await resourceLoader.reload();
    const interactionToolCount = capabilities.canAskUser ? 2 : 1;
    context.onTrace?.("resources.loaded", {
        readOnlyToolCount: capabilities.canEdit
            ? READ_ONLY_AGENT_TOOLS.length
            : capabilities.tools.length,
        directUserUI: capabilities.canAskUser,
        background: context.background === true,
        ...(capabilities.canEdit
            ? { configuredToolCount: capabilities.tools.length, mutating: true }
            : {}),
    });

    const restored = restoreChildSessionModel(sessionManager, context.childSessionFile);
    const requestedModel = resolveChildModel(
        parentContext,
        restored?.modelSpec ?? context.definition.model,
    );
    context.onTrace?.("model.resolved", {
        provider: requestedModel.provider,
        model: requestedModel.id,
        thinkingLevel: restored?.thinkingLevel ?? parentContext.thinkingLevel ?? "default",
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
        tools: [
            ...capabilities.tools,
            ...(capabilities.canAskUser ? ["ask_user"] : []),
            "ask_parent",
        ],
    });
    // Worker mutation permission is implemented in beforeToolCall. The SDK
    // preflights every tool in a parallel batch before executing any of them;
    // waiting for a previous tool_result from that hook would therefore
    // deadlock a batch containing multiple mutations. Run worker batches
    // sequentially so each approval can reach execution and release its gate.
    // TODO(agent): Consider moving permission/queue handling into tool execution
    // wrappers so read-only worker calls can remain parallel.
    if (capabilities.canEdit || capabilities.canRunCommands) {
        session.agent.toolExecution = "sequential";
    }

    context.onTrace?.("session.created", {
        toolCount: capabilities.tools.length + interactionToolCount,
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

    return createChildHandle({
        session,
        sessionManager,
        tracker,
        unsubscribe,
        onTrace: context.onTrace,
    });
}
