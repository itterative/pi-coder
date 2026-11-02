import {
    createEditToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    type ExtensionAPI,
    type ExtensionContext,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { ContainerSession } from "./client";
import { containerGrepTool } from "./grep-tool";
import { createContainerFileOperations, type ContainerFileOperations } from "./file-operations";

/**
 * pi's own file tools, rebuilt over the container's filesystem.
 *
 * A sandbox is only coherent if a tool call and a command answer from the same place: `bash` runs inside the
 * container, so `read` describing the host's `~/.gitconfig` or `/etc/os-release` while a command sees the
 * sandbox's own would be a lie the model cannot detect. These overrides replace only the storage seam, so
 * truncation, image handling, diff preview, the mutation queue, renderers, and prompts stay pi's.
 *
 * Three deliberate limits:
 *
 * - A tool is taken over only when it is **active**. pi's `ls`, `find`, and `grep` are optional tools, and
 *   registering an override would otherwise activate one the user had turned off.
 * - Only a genuine built-in is taken over (`builtin:<name>`). A tool of the same name from another extension
 *   knows its own backend and must keep it.
 * - Nothing is registered for a runtime without a container: the backend switch and a failed start both keep
 *   the built-ins in place rather than inventing a half-sandbox.
 */
export interface ContainerFileToolOptions {
    /** The container session this runtime's tools run in. */
    sessionFor: (ctx: ExtensionContext) => Promise<ContainerSession>;
    /**
     * Whether this runtime is containerized. The backend is resolved per session (a build may be accepted
     * mid-session), so the answer cannot be captured when this module is loaded.
     */
    isActive?: () => boolean;
    /** Reports a tool left alone, so a mixed view is explainable rather than mysterious. */
    onSkip?: (ctx: ExtensionContext, name: string, reason: string) => void;
}

/** pi names its own tools `builtin:<name>`; anything else is a file path from an extension. */
const BUILTIN_TOOL_PREFIX = "builtin:";

/**
 * What this module rebuilds. `grep` is in the set but registered separately: pi spawns `rg` itself, so its
 * seams cannot route the search and the tool needs its own execute (see `grep-tool.ts`).
 */
const OVERRIDABLE_TOOLS = ["read", "write", "edit", "ls", "find", "grep"] as const;

/**
 * Install the overrides on session start, and return the installer.
 *
 * The return value matters because a container can also become active *after* the session started — the user
 * accepts the build prompt, and this session's tools have to follow the backend that is now running rather
 * than the one that started. Reusing this installer keeps one `takenOver` set, so a second install cannot
 * register the same tool twice.
 */
export function registerContainerFileTools(
    pi: ExtensionAPI,
    options: ContainerFileToolOptions,
): (ctx: ExtensionContext) => void {
    const takenOver = new Set<string>();

    const install = (ctx: ExtensionContext): void => {
        const active = new Set(pi.getActiveTools());
        const infoByName = new Map(pi.getAllTools().map((info) => [info.name, info]));

        for (const name of OVERRIDABLE_TOOLS) {
            if (!active.has(name) || takenOver.has(name)) {
                continue;
            }

            const info = infoByName.get(name);

            if (info === undefined) {
                continue;
            }

            if (!info.sourceInfo.path.startsWith(BUILTIN_TOOL_PREFIX)) {
                options.onSkip?.(ctx, name, `provided by ${info.sourceInfo.path}`);

                continue;
            }

            registerTool(pi, name, options);
            takenOver.add(name);
        }
    };

    pi.on("session_start", (_event, ctx) => {
        if (options.isActive?.() === false) {
            return;
        }

        install(ctx);
    });

    return install;
}

/**
 * One registration per tool, written out rather than looped through a table: each pi factory has its own
 * schema and details type, and this is where that type is inferred instead of erased.
 */
function registerTool(
    pi: ExtensionAPI,
    name: (typeof OVERRIDABLE_TOOLS)[number],
    options: ContainerFileToolOptions,
): void {
    const cwd = process.cwd();

    switch (name) {
        case "grep":
            pi.registerTool(containerGrepTool(options.sessionFor));

            return;
        case "read":
            pi.registerTool(
                overrideTool(
                    createReadToolDefinition(cwd),
                    (base, operations) =>
                        createReadToolDefinition(base, { operations: operations.read }),
                    options,
                ),
            );

            return;
        case "write":
            pi.registerTool(
                overrideTool(
                    createWriteToolDefinition(cwd),
                    (base, operations) =>
                        createWriteToolDefinition(base, { operations: operations.write }),
                    options,
                ),
            );

            return;
        case "edit":
            pi.registerTool(
                overrideTool(
                    createEditToolDefinition(cwd),
                    (base, operations) =>
                        createEditToolDefinition(base, { operations: operations.edit }),
                    options,
                ),
            );

            return;
        case "ls":
            pi.registerTool(
                overrideTool(
                    createLsToolDefinition(cwd),
                    (base, operations) =>
                        createLsToolDefinition(base, { operations: operations.ls }),
                    options,
                ),
            );

            return;
        case "find":
            pi.registerTool(
                overrideTool(
                    createFindToolDefinition(cwd),
                    (base, operations) =>
                        createFindToolDefinition(base, { operations: operations.find }),
                    options,
                ),
            );

            return;
    }
}

/**
 * The prototype carries the metadata (name, description, schema, renderers, system-prompt contribution); only
 * `execute` is replaced, so nothing about how the tool is presented or declared can drift from pi's. The
 * definition is rebuilt per call from `ctx.cwd`, the way the bash override does, because `cwd` decides path
 * resolution and confinement.
 */
function overrideTool<TParams extends ToolDefinition["parameters"], TDetails, TState>(
    prototype: ToolDefinition<TParams, TDetails, TState>,
    rebuild: (
        cwd: string,
        operations: ContainerFileOperations,
    ) => ToolDefinition<TParams, TDetails, TState>,
    options: ContainerFileToolOptions,
): ToolDefinition<TParams, TDetails, TState> {
    return {
        ...prototype,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const operations = createContainerFileOperations(await options.sessionFor(ctx));
            const tool = rebuild(ctx.cwd, operations);

            return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
        },
    };
}
