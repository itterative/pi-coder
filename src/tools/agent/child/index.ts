import {
    DefaultResourceLoader,
    SettingsManager,
    createAgentSession,
    getAgentDir,
    type ExtensionContext,
    type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { READ_ONLY_AGENT_TOOLS } from "../definitions/discovery";
import { registerCompactionExtension } from "../../../modules/compaction";
import { registerContainerBackend } from "../../../modules/sandbox/container";
import {
    createContainerState,
    type ContainerState,
} from "../../../modules/sandbox/container/state";
import { capabilityExtensions } from "./capabilities";
import { sandboxRoleFor } from "./sandbox-role";
import { registerChildExtension } from "./extension";
import { childProtocolPrompt } from "./prompt";
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
    type ChildUserQuestion,
    type SafeBashGuardOptions,
    type SafeBashOptions,
} from "./extension";
export { createChildModelRuntime, shouldCopyParentApiKey } from "./model-runtime";
export {
    countParentPrompts,
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
/**
 * Per-run container state, shared between the backend extension and the command gate.
 *
 * `containerized` is what the gate asks instead of the environment: only this runtime knows whether its bash
 * tool is the container-backed one, and the switch is process-wide, so the two must not be confused. `close`
 * is how the run reaps the container it started; until the backend installs, it is a no-op.
 */
interface ChildContainerState {
    /** The shared flag the backend sets and the child gate reads; false until a container is running. */
    state: ContainerState;
    close: () => Promise<void>;
}

function createChildContainerState(): ChildContainerState {
    return { state: createContainerState(), close: async () => {} };
}

function childExtensionEntries(
    request: ChildAssemblyRequest,
    container: ChildContainerState,
): InlineExtension[] {
    const { context, parentContext, cwd, tracker, grant } = request;
    const entries: InlineExtension[] = [
        {
            name: grant.extensionKind,
            hidden: true,
            factory: registerChildExtension(tracker, parentContext, cwd, {
                ...grant.extensionOptions,
                containerBash: () => container.state.active,
            }),
        },
        // A child compacts its own transcript, and pi's default serialization costs it exactly what it costs
        // the parent. Not a capability: nothing grants or revokes it, and it registers no tools, so it sits
        // outside the unit registry rather than as another row in it.
        {
            name: "pi-coder-compaction",
            hidden: true,
            factory: registerCompactionExtension,
        },
    ];

    // The sandbox backend runs the same code the parent uses, so "host" keeps meaning "no extra sandbox"
    // here too. It registers before the capability entries because gates install in order and this one owns
    // the tool those gates classify; nothing is announced, and the container starts on the first command.
    // Registered unconditionally; whether this runtime actually containerizes is resolved per session from
    // the same config the parent reads. A child never prompts: a build dialog here would appear in the middle
    // of a delegated run, attributed to whoever is watching.
    entries.push({
        name: "pi-coder-container",
        hidden: true,
        factory: (pi) => {
            const handle = registerContainerBackend(pi, {
                state: container.state,
                notify: false,
                eagerStart: false,
                // A scout's container mounts its checkout read-only and has no network, so its commands
                // fail closed instead of being argued about one prompt at a time.
                role: sandboxRoleFor(grant.authority),
            });

            container.close = handle.close;
        },
    });

    // Each resource capability registers its own extension, so adding one is a unit file rather than
    // another branch here. Order comes from the registry, which is load-bearing: registration order
    // decides which `tool_call` handler runs first.
    entries.push(
        ...capabilityExtensions({ tracker, onProgress: context.onProgress }, context.definition),
    );

    return entries;
}

/**
 * The child's system prompt: its definition's instructions plus the delegated-run protocol.
 *
 * The prompt is rendered straight from the grant, including `isolated`, which the grant reconciles
 * once from the transient flag and the workspace id. Before that reconciliation lived in the grant,
 * the prompt and the extension each spelled isolation their own way and had to be kept in step by
 * hand.
 */
function childSystemPrompt(request: ChildAssemblyRequest): string {
    const { context, grant } = request;
    return renderAgentSystemPrompt(context.definition, childProtocolPrompt(grant));
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
    const container = createChildContainerState();
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: false,
        extensionFactories: childExtensionEntries(request, container),
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
        // The container outlives individual commands but not the run: dispose is the one place every path
        // (success, failure, cancel) passes through.
        onDispose: () => {
            void container.close();
        },
    });
}

// FIXME(capability-refactor): temporary oracle seam, removed with test/tools/tmp-capability-oracle.test.ts.
export { childExtensionEntries, childSystemPrompt };
export type { ChildAssemblyRequest };
