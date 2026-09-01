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
import { childProtocolPrompt, registerChildExtension } from "./extension";
import { resolveChildGrant, type ChildGrant } from "./grant";
import {
    createChildModelRuntime,
    resolveChildModel,
    restoreChildSessionModel,
} from "./model-runtime";
import { createChildHandle } from "./handle";
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
    grant: ChildGrant;
}

/**
 * The extensions a child runs with: the pi-coder child extension, plus one per resource capability the
 * definition holds.
 *
 * Every entry is `hidden`, because these register the child's own tool surface rather than commands
 * the end user may invoke. The child extension receives the option bag the grant already resolved, so
 * the only decision left here is which resource extensions accompany it.
 */
function childExtensionEntries(request: ChildAssemblyRequest): InlineExtension[] {
    const { context, parentContext, cwd, tracker, grant } = request;
    const entries: InlineExtension[] = [
        {
            name: grant.extensionKind,
            hidden: true,
            factory: registerChildExtension(tracker, parentContext, cwd, grant.extensionOptions),
        },
    ];

    if (grant.hasMemories) {
        entries.push({
            name: "pi-coder-memory-child",
            hidden: true,
            factory: registerMemoryExtension,
        });
    }
    if (grant.hasScratchpad) {
        entries.push({
            name: "pi-coder-scratchpad-child",
            hidden: true,
            factory: registerScratchpadExtension,
        });
    }
    if (grant.hasTodolist) {
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
 * The protocol options come straight from the grant, including `isolated`, which the grant reconciles
 * once from the transient flag and the workspace id. Before that reconciliation lived in the grant,
 * the prompt and the extension each spelled isolation their own way and had to be kept in step by
 * hand.
 */
function childSystemPrompt(request: ChildAssemblyRequest): string {
    const { context, grant } = request;
    return renderAgentSystemPrompt(context.definition, childProtocolPrompt(grant.protocolPrompt));
}

export async function createAgentChild(
    context: ChildAgentFactoryContext,
): Promise<ChildAgentHandle> {
    const parentContext = context.parentContext as ExtensionContext;
    if (!parentContext.model) throw new Error("No parent model is selected.");

    const tracker = seedProgressTracker(context);
    const cwd = context.cwd;
    const grant = resolveChildGrant(context, parentContext);

    const agentDir = getAgentDir();
    // The transcript is positioned on the leaf this run owns inside the bootstrap, before anything
    // reads the session context; see `bootstrapChildSession`.
    const sessionManager = bootstrapChildSession(context);
    context.onSessionCreated?.(sessionManager.getSessionFile(), sessionManager.getLeafId());
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const request: ChildAssemblyRequest = { context, parentContext, cwd, tracker, grant };
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
    context.onTrace?.("resources.loaded", {
        readOnlyToolCount:
            grant.authority === "mutate"
                ? READ_ONLY_AGENT_TOOLS.length
                : grant.capabilityTools.length,
        directUserUI: grant.canAskUser,
        background: grant.background,
        ...(grant.authority === "mutate"
            ? { configuredToolCount: grant.capabilityTools.length, mutating: true }
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
        tools: grant.sessionTools,
    });
    if (grant.requiresSequentialToolExecution) {
        session.agent.toolExecution = "sequential";
    }

    context.onTrace?.("session.created", {
        toolCount: grant.sessionTools.length,
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

// FIXME(capability-refactor): temporary oracle seam, removed with test/tools/tmp-capability-oracle.test.ts.
export { childExtensionEntries, childSystemPrompt };
export type { ChildAssemblyRequest };
