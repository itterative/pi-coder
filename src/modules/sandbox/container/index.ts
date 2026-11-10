import path from "node:path";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import config, {
    resolveProjectConfigPath,
    updateSandboxConfigField,
    type SandboxConfig,
} from "../../../common/config";
import { getUserMemoryDirectory, getUserSessionsDirectory } from "../../../common/constants";
import { getScratchpadPath } from "../../scratchpad";
import { envEntriesToRecord, resolveContainerEnv } from "../env";
import { ContainerSession } from "./client";
import { checkContainerHost, containerShell } from "./config";
import { buildRecipeImage } from "./build";
import { registerSandboxCommand } from "./command";
import {
    decideSessionImage,
    planSandboxImage,
    type ImagePlan,
    type SessionImage,
} from "./image-plan";
import { createPodmanImageRunner } from "./image";
import { containerBashTool } from "./bash-tool";
import { registerContainerFileTools } from "./file-tools";
import { readHostGitIdentity } from "./git-identity";
import { gitSupportMounts } from "./git-mounts";
import { createContainerBashOperations } from "./operations";
import { askAboutSandboxImage, canPromptForSandboxImage, type SandboxImageAnswer } from "./prompt";
import {
    inspectContainerReadiness,
    planSessionBackend,
    selectBackend,
    type ContainerReadiness,
    type SessionBackendPlan,
} from "./selection";
import { createContainerState, containerStatePaths, type ContainerState } from "./state";
import {
    resolveSandboxPosture,
    runtimeRootsFor,
    type SandboxPosture,
    type SandboxRole,
} from "../posture";
import { agentResourceRoots } from "../resource-roots";

/**
 * Container sandbox backend: the whole `bash` surface of a session runs inside one long-lived rootless
 * container, mounted at the checkout's real paths so `.git` worktree pointers and host file tools stay
 * coherent with what runs inside.
 *
 * The seam is pi's, not a wrapper script: registering `bash` with the built-in tool built over
 * `BashOperations` means timeouts, truncation, streaming, and rendering are pi's own, and the
 * extension's permission hook keeps deciding *whether* a command runs. This backend only changes *where*.
 */
export default function registerContainerSandbox(pi: ExtensionAPI): ContainerState {
    // The backend resolves per session now, not per process, so the state it writes is the only thing the
    // bash hook needs from it: the hook has to know whether a sandboxed verdict still needs `bwrap`.
    const state = createContainerState();
    const handle = registerContainerBackend(pi, {
        state,
        notify: true,
        eagerStart: true,
        prompt: true,
    });

    // Registered always: `/sandbox status` and `/sandbox backend` are useful even when bash is on bubblewrap,
    // and `/sandbox build` is the one step that must run on the host rather than inside the sandbox.
    registerSandboxCommand(pi, {
        state,
        onImageBuilt: handle.adoptImage,
        onConfigChanged: handle.reloadConfig,
    });

    return state;
}

/**
 * Options that differ between the interactive parent and a delegated child runtime.
 *
 * A child runs the same backend so that "host" keeps meaning "no extra sandbox" there too — otherwise a
 * command the gates allowed directly would execute on the literal host while the parent's copy of the same
 * command ran in a container. What differs is presentation: a child must not announce containers into the
 * parent's transcript, and it should not pay a container start for a run that never executes a command.
 */
export interface ContainerBackendOptions {
    /**
     * Shared with the runtime's bash hook. The backend sets it when the container becomes active; the hook
     * reads it to decide whether a sandboxed verdict still needs the `bwrap` wrapper, and whether a host
     * without that binary has any sandbox at all.
     */
    state: ContainerState;
    /** Report the container and shell at session start. The parent's transcript wants this; a child's does not. */
    notify?: boolean;
    /** Start the session container on `session_start` instead of on the first command. */
    eagerStart?: boolean;
    /**
     * Whether a session may offer to build a missing image. The interactive parent may; a child runtime must
     * never put a dialog in front of the user in the middle of a delegated run.
     */
    prompt?: boolean;
    /** The readiness probe, injectable so tests never ask a real podman for its storage. */
    inspect?: (projectDir: string) => Promise<ContainerReadiness>;
    /**
     * What this runtime may write. A child that holds no mutating capability is `readonly`: its checkout is
     * mounted read-only, its memory directory too, and it gets no network — enforcement the kernel provides,
     * rather than another gate for it to pass.
     */
    role?: SandboxRole;
}

/** Closes every container this runtime started. Safe to call more than once. */
export interface ContainerBackendHandle {
    close: () => Promise<void>;
    /**
     * Adopt an image that was built after this session started.
     *
     * A rebuild changes the content-addressed tag, so the running container is on the old image by
     * construction: the only honest options are to replace it or to lie about it. This marks the session
     * stale and starts the new image now, which is why a rebuild no longer needs a reload.
     */
    adoptImage: (ctx: ExtensionContext) => Promise<void>;
    /**
     * Apply an edited sandbox config to the live session.
     *
     * The mount set, network, and devices are frozen at `podman run`, so a changed setting means a new
     * container. This marks every session stale and starts the replacement at the next command boundary,
     * which is what keeps "/sandbox mounts add …" from silently doing nothing until a restart.
     */
    reloadConfig: (ctx: ExtensionContext) => Promise<void>;
}

/**
 * The backend: one container per session and cwd, with `bash`, `user_bash`, and the file tools routed through
 * it.
 *
 * The decision that used to live in the environment now lives here, once per session: the configured backend,
 * this host's readiness, and — when a recipe has never been built — one question. Everything after that is
 * the container's own concern, and a runtime that ends up on bubblewrap simply leaves `state.active` false.
 */
export function registerContainerBackend(
    pi: ExtensionAPI,
    options: ContainerBackendOptions,
): ContainerBackendHandle {
    const sessions = new Map<string, SessionEntry>();
    let closed = false;
    // pi registers tools for the life of the process and offers no way to take one back, so a runtime that
    // once installed the container's `bash` stays containerized until pi restarts. Session switches must not
    // pretend otherwise: that would leave the container tool installed while the config says bubblewrap.
    let toolsInstalled = false;

    // The function declaration is hoisted; the state only exposes the resolver once a caller asks for it.
    options.state.sessionFor = sessionFor;

    // Resolution runs before the bash hook's own `session_start` (the parent registers the backend first), so
    // the hook already knows whether this session has a container before it decides about `bwrap`.
    pi.on("session_start", async (_event, ctx) => {
        await resolveSessionBackend(ctx);
    });

    // Fires on a session switch as well as on quit, so the containers are reaped but the runtime keeps its
    // tools: the next session in this process is still containerized.
    pi.on("session_shutdown", async () => {
        await tearDownContainers();
    });

    // Registered always, inert until a container exists: pi's own host shell is the right answer on bubblewrap.
    pi.on("user_bash", async (_event, ctx) => {
        if (!options.state.active) {
            return undefined;
        }

        const session = await sessionFor(ctx);

        return { operations: operationsFor(session, ctx) };
    });

    // Same session, same filesystem: the file tools answer from inside the container too, so a tool call and a
    // command cannot describe two different places.
    const installFileTools = registerContainerFileTools(pi, {
        sessionFor,
        isActive: () => options.state.active,
        onSkip: (ctx, name, reason) => {
            if (options.notify !== true) {
                return;
            }

            ctx.ui.notify(
                `pi-bash-sandbox: ${name} stays host-side (${reason}); its view may differ from bash`,
                "warning",
            );
        },
    });

    /**
     * Decide this session's backend. Never throws: a broken probe must leave the session on bubblewrap rather
     * than fail the session that is starting.
     */
    async function resolveSessionBackend(ctx: ExtensionContext): Promise<void> {
        if (closed) {
            return;
        }

        if (toolsInstalled) {
            // Already containerized in this process: the config answer takes effect on the next start.
            await activate(ctx);

            return;
        }

        const loaded = loadConfig(ctx.cwd);
        const selection = selectBackend(loaded, process.env);

        if (selection.choice === "bwrap") {
            return;
        }

        const inspect = options.inspect ?? defaultInspect;
        const readiness = await inspect(ctx.cwd);
        const plan = planSessionBackend({
            selection,
            readiness,
            interactive: options.prompt === true && canPromptForSandboxImage(ctx),
            declinedTag: loaded.sandbox.containerDeclinedTag,
        });

        if (plan.kind === "container") {
            await activate(ctx);

            return;
        }

        if (plan.kind === "ask") {
            await askAboutBuild(ctx, plan);

            return;
        }

        // Only an explicit request gets a warning: with `auto`, bubblewrap is a normal answer, not a downgrade
        // the user needs to hear about.
        if (plan.reason !== undefined && options.notify === true) {
            ctx.ui.notify(`pi-bash-sandbox: ${plan.reason}; using bubblewrap`, "warning");
        }
    }

    async function askAboutBuild(
        ctx: ExtensionContext,
        plan: Extract<SessionBackendPlan, { kind: "ask" }>,
    ): Promise<void> {
        let answer: SandboxImageAnswer;

        try {
            answer = await askAboutSandboxImage(
                { image: plan.image, recipePath: plan.recipePath },
                ctx,
            );
        } catch (error) {
            // A dialog that cannot be shown must not cost the session its start: fall back to staying quiet
            // and asking again next time.
            if (options.notify === true) {
                ctx.ui.notify(`pi-bash-sandbox: ${describe(error)}`, "warning");
            }

            return;
        }

        if (answer === "bwrap") {
            remember(
                { backend: "bwrap" },
                "pi-bash-sandbox: staying on bubblewrap for this project",
                ctx,
            );

            return;
        }

        if (answer === "later") {
            // Only this recipe state is remembered, so editing the Containerfile asks again.
            remember({ containerDeclinedTag: plan.image }, undefined, ctx);

            return;
        }

        const recipe = planSandboxImage({ projectDir: ctx.cwd });

        if (recipe.kind !== "recipe") {
            ctx.ui.notify("pi-bash-sandbox: the recipe is no longer available", "warning");

            return;
        }

        if (options.notify === true) {
            ctx.ui.notify(`pi-bash-sandbox: building ${recipe.image}…`, "info");
        }

        const built = await buildRecipeImage(recipe).catch((error: unknown) => {
            ctx.ui.notify(`pi-bash-sandbox: ${describe(error)}; staying on bubblewrap`, "error");

            return undefined;
        });

        if (built === undefined) {
            return;
        }

        remember(
            { backend: "container", containerDeclinedTag: null },
            `pi-bash-sandbox: image ${recipe.image} is ready in ${built.elapsedMs} ms; ` +
                "bash runs in the container",
            ctx,
        );

        await activate(ctx);
    }

    /**
     * Persist an answer. A read-only checkout or a malformed config must not cost the session its sandbox, so
     * a failed write is reported and the in-session behaviour continues from the answer just given.
     */
    function remember(
        patch: Parameters<typeof updateSandboxConfigField>[1],
        message: string | undefined,
        ctx: ExtensionContext,
    ): void {
        try {
            updateSandboxConfigField(resolveProjectConfigPath(ctx.cwd), patch);
        } catch (error) {
            if (options.notify === true) {
                ctx.ui.notify(`pi-bash-sandbox: ${describe(error)}`, "warning");
            }
        }

        if (message !== undefined && options.notify === true) {
            ctx.ui.notify(message, "info");
        }
    }

    /** Install the container's tools for this session. Idempotent, so a late build can call it again. */
    async function activate(ctx: ExtensionContext): Promise<void> {
        if (closed) {
            return;
        }

        if (options.state.active) {
            return;
        }

        options.state.active = true;
        toolsInstalled = true;

        pi.registerTool(containerBashTool(sessionFor, operationsFor));
        installFileTools(ctx);

        if (options.eagerStart === true) {
            // Start early so the first command does not pay the container start.
            void sessionFor(ctx).catch((error: unknown) => {
                if (options.notify === true) {
                    ctx.ui.notify(`pi-bash-sandbox: ${describe(error)}`, "warning");
                }
            });
        }
    }

    async function adoptImage(ctx: ExtensionContext): Promise<void> {
        // The tag changed, so every container this runtime started is on an image the recipe no longer
        // describes. Replacing it at the next command boundary is the only honest option.
        for (const entry of sessions.values()) {
            entry.stale = true;
        }

        const wasActive = options.state.active;
        await activate(ctx);

        if (!wasActive || closed) {
            return;
        }

        try {
            await sessionFor(ctx);

            if (options.notify === true) {
                ctx.ui.notify(
                    "pi-bash-sandbox: the session container now runs the rebuilt image",
                    "info",
                );
            }
        } catch (error) {
            if (options.notify === true) {
                ctx.ui.notify(`pi-bash-sandbox: ${describe(error)}`, "warning");
            }
        }
    }

    /** Replace the running container after the config changed; a no-op when this session has no container. */
    async function reloadConfig(ctx: ExtensionContext): Promise<void> {
        // A bubblewrap session has no container to replace: the next command reads the reloaded config itself.
        // Activating here would silently containerize a session that deliberately stayed on bubblewrap.
        if (closed || !options.state.active) {
            return;
        }

        for (const entry of sessions.values()) {
            entry.stale = true;
        }

        try {
            await sessionFor(ctx);

            if (options.notify === true) {
                ctx.ui.notify(
                    "pi-bash-sandbox: sandbox settings applied; the session container was restarted",
                    "info",
                );
            }
        } catch (error) {
            if (options.notify === true) {
                ctx.ui.notify(`pi-bash-sandbox: ${describe(error)}`, "warning");
            }
        }
    }

    /** Reap every container this runtime started, leaving the installed tools in place. */
    async function tearDownContainers(): Promise<void> {
        const pending = [...sessions.values()];
        sessions.clear();

        await Promise.allSettled(
            pending.map(async (entry) => {
                const running = await entry.session;
                await running.close();
            }),
        );
    }

    async function closeAll(): Promise<void> {
        closed = true;
        options.state.active = false;

        await tearDownContainers();
    }

    function sessionFor(ctx: ExtensionContext): Promise<ContainerSession> {
        // After close() a late command must fail rather than start a container nothing will reap: a child
        // disposes its runtime while a call can still be settling.
        if (closed) {
            return Promise.reject(
                new Error("the container backend for this session has been closed"),
            );
        }

        const key = `${ctx.sessionManager.getSessionId()}\u0000${ctx.cwd}`;
        const existing = sessions.get(key);

        if (existing !== undefined) {
            if (!existing.stale) {
                return existing.session;
            }

            sessions.delete(key);

            // Replaced rather than reused: the rebuild produced a different image tag.
            void existing.session.then((session) => session.close()).catch(() => {});
        }

        const created = startSession(ctx);
        const entry: SessionEntry = { session: created, stale: false };
        sessions.set(key, entry);

        // A failed start must not poison the session: the next command retries with a fresh container.
        void created.catch(() => {
            if (sessions.get(key) === entry) {
                sessions.delete(key);
            }
        });

        return created;
    }

    async function startSession(ctx: ExtensionContext): Promise<ContainerSession> {
        const host = await checkContainerHost();

        if (!host.ok) {
            throw new Error(host.reason);
        }

        const sessionId = ctx.sessionManager.getSessionId();
        const scratchpadPath = getScratchpadPath(ctx.sessionManager);
        const role = options.role ?? "write";
        // Skills and pi's docs live outside the checkout. The mount set is frozen at create, so resolve
        // them before the posture is built rather than discovering on the first read that they are absent.
        const resourceRoots = await agentResourceRoots({
            cwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted?.() === true,
        });
        const posture = resolveSandboxPosture({
            cwd: ctx.cwd,
            config: loadSessionConfig(ctx.cwd),
            role,
            ...runtimeRootsFor(role, {
                ...(scratchpadPath === undefined ? {} : { scratchpadPath }),
                memoryDir: getUserMemoryDirectory(),
                sessionsDir: getUserSessionsDirectory(),
                resourceRoots,
            }),
            gitMounts: gitSupportMounts(ctx.cwd),
        });

        reportPostureWarnings(ctx, posture, options);
        const resolved = await resolveSessionImage(
            planSandboxImage({ projectDir: ctx.cwd }),
            host.podmanPath,
        );

        // One home for every session on this machine: it is where a session's caches land, so a per-session
        // directory only ever threw them away and left litter behind. The dispatcher is not copied: the
        // container mounts the extension's own `dispatch.mjs`, so it cannot drift from this build.
        const statePaths = containerStatePaths();
        const session = await ContainerSession.start({
            cwd: ctx.cwd,
            image: resolved.image,
            nodePath: resolved.nodePath,
            sessionId,
            podmanPath: host.podmanPath,
            homeDir: statePaths.home,
            // Every mount comes from the posture: the checkout at its real path (read-only for a read-only
            // runtime), the scratchpad, the memory directory, the git support mounts a worktree or shared
            // clone needs, and whatever `sandbox.mounts` adds.
            mounts: posture.entries,
            network: posture.network.mode,
            publish: posture.network.publish,
            devices: posture.devices.paths,
            keepGroups: posture.devices.keepGroups,
            // The host's git identity, seeded into the sandbox home: commits made inside are attributed
            // the same way as outside, without mounting the host file and its unfindable hooks and LFS
            // filters.
            gitIdentity: await readHostGitIdentity(),
            shell: containerShell(),
        });

        if (options.notify === true) {
            ctx.ui.notify(
                `pi-bash-sandbox: container ${session.containerName} (${resolved.image})`,
                "info",
            );

            if (path.basename(session.shell) !== "bash") {
                ctx.ui.notify(
                    `pi-bash-sandbox: ${resolved.image} has no bash; commands run under ${session.shell}`,
                    "warning",
                );
            }
        }

        return session;
    }

    function operationsFor(session: ContainerSession, ctx: ExtensionContext) {
        const sandboxConfig = loadConfig(ctx.cwd);

        return createContainerBashOperations(session, (env) =>
            envEntriesToRecord(resolveContainerEnv(sandboxConfig, env ?? process.env)),
        );
    }

    return { close: closeAll, adoptImage, reloadConfig };
}

/** One cached container per session and cwd, plus whether a rebuild has outlived it. */
interface SessionEntry {
    session: Promise<ContainerSession>;
    stale: boolean;
}

/**
 * The image a session runs. A recipe image that was never built fails loudly instead of silently degrading:
 * running in a bare default image looks like a working sandbox and turns every missing tool into an
 * apparent product bug.
 */
async function resolveSessionImage(plan: ImagePlan, podmanPath: string): Promise<SessionImage> {
    const exists =
        plan.kind === "recipe"
            ? await createPodmanImageRunner(podmanPath).exists(plan.image)
            : true;

    const decision = decideSessionImage(plan, exists);

    if (!decision.ok) {
        throw new Error(decision.reason);
    }

    return { image: decision.image, nodePath: decision.nodePath };
}

function loadConfig(cwd: string): SandboxConfig {
    try {
        return config.load(cwd);
    } catch {
        return config.default;
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function defaultInspect(projectDir: string): Promise<ContainerReadiness> {
    return inspectContainerReadiness({ projectDir });
}

/** The session's config, with the shipped defaults when no file loads. */
function loadSessionConfig(cwd: string): SandboxConfig | null {
    try {
        return config.load(cwd);
    } catch {
        return null;
    }
}

/**
 * Tell the user, once per session, about a mount that was dropped or that exposes credentials.
 *
 * Dropping is the honest half: podman would happily create an empty directory for a path that does not
 * exist, producing a mount that looks configured and hides the files it was meant to expose.
 */
function reportPostureWarnings(
    ctx: ExtensionContext,
    posture: SandboxPosture,
    options: ContainerBackendOptions,
): void {
    if (options.notify !== true) {
        return;
    }

    for (const warning of posture.warnings) {
        ctx.ui.notify(`pi-bash-sandbox: ${warning}`, "warning");
    }
}
