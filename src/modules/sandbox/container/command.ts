import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import config, {
    GPU_DEVICE_PATHS,
    resolveProjectConfigPath,
    updateSandboxConfigField,
    type SandboxBackendChoice,
    type SandboxConfig,
    type SandboxConfigMountValue,
    type SandboxConfigNetwork,
    type SandboxConfigNetworkMode,
    type SandboxConfigPatch,
} from "../../../common/config";
import { buildRecipeImage, type RecipePlan } from "./build";
import { planSandboxImage } from "./image-plan";
import { inspectContainerReadiness, selectBackend, type ContainerReadiness } from "./selection";
import { describeSandboxSettings, type SandboxSettingsSummary } from "./settings";
import type { ContainerState } from "./state";
import { normalizePublishSpec, resolveConfiguredMounts } from "../posture";

/**
 * `/sandbox` — the visible half of the container backend.
 *
 * Everything here is shaped for a user, not for debugging: which backend is running, whether the image is
 * ready, and how to move between the two. Internal paths (the generated Containerfile, the tag's provenance)
 * stay out of the transcript; they are available by reading the config and `podman images`.
 */
export interface SandboxCommandDependencies {
    state: ContainerState;
    /**
     * Called after an image was built, so the live session can move onto it. A rebuild changes the tag, so
     * the running container is on the old image by construction and has to be replaced, not reused.
     */
    onImageBuilt?: (ctx: ExtensionContext) => Promise<void>;
    /** The readiness probe, injectable for the same reason the backend's is: no test needs podman. */
    inspect?: (projectDir: string) => Promise<ContainerReadiness>;
    /**
     * Config access for completions, which receive no context and so cannot know the session's cwd. Injectable
     * so suggestions are deterministic under test instead of following the config beside the test runner.
     */
    configForCompletions?: () => SandboxConfig;
    /**
     * Applied after a settings edit (mounts, network, devices).
     *
     * The mount set is frozen at container create, so an edit that took effect "next session" would look like
     * a broken setting. The backend replaces the container instead; a session without one ignores it.
     */
    onConfigChanged?: (ctx: ExtensionContext) => Promise<void>;
}

/**
 * One word `/sandbox` accepts at a given position, and what it does.
 *
 * `more` records that the word is followed by further input (another word, or a free-form path). Selecting it
 * leaves a trailing space so the next Tab continues at the next level instead of ending the command.
 */
interface CompletionWord {
    word: string;
    description: string;
    more?: boolean;
}

const TOP_LEVEL: readonly CompletionWord[] = [
    {
        word: "status",
        description: "Which backend runs bash, and whether the image is built",
    },
    {
        word: "build",
        description: "Build the image from .pi/Containerfile (runs on this host)",
    },
    {
        word: "mounts",
        description: "Show, add, or remove the paths the sandbox mounts",
        more: true,
    },
    {
        word: "network",
        description: "Show or set network mode, and publish container ports",
        more: true,
    },
    {
        word: "devices",
        description: "Show, add, or remove host devices (GPU) passed to the sandbox",
        more: true,
    },
    {
        word: "backend",
        description: "Choose container, bubblewrap, or auto",
        more: true,
    },
];

const BACKENDS: readonly CompletionWord[] = [
    { word: "auto", description: "Ask once, then decide by image readiness" },
    { word: "container", description: "Use the sandbox container for this project" },
    { word: "bwrap", description: "Use bubblewrap for this project" },
];

const MOUNT_ACTIONS: readonly CompletionWord[] = [
    { word: "show", description: "Show the paths the sandbox mounts" },
    { word: "add", description: "Mount a host path, read-only unless told otherwise", more: true },
    { word: "remove", description: "Stop mounting a configured path", more: true },
];

const MOUNT_ADD_OPTIONS: readonly CompletionWord[] = [
    { word: "readonly", description: "Read-only access (alias: ro)" },
    { word: "readwrite", description: "Read-write access (alias: rw)" },
    { word: "create", description: "Create the host path when it is missing" },
    { word: "target=", description: "Mount it at a different path inside the sandbox" },
];

const NETWORK_ACTIONS: readonly CompletionWord[] = [
    { word: "show", description: "Show the network mode and published ports" },
    { word: "egress", description: "Outbound network only (NAT), the default" },
    { word: "none", description: "No route and no resolver" },
    { word: "host", description: "Share the host network namespace" },
    { word: "port", description: "Publish a container port to the host", more: true },
];

const PORT_ACTIONS: readonly CompletionWord[] = [
    {
        word: "add",
        description: "Publish a port (3000, 8080:80, or 127.0.0.1:8080:80)",
        more: true,
    },
    { word: "remove", description: "Stop publishing a port", more: true },
];

const DEVICE_ACTIONS: readonly CompletionWord[] = [
    { word: "show", description: "Show the devices passed to the sandbox" },
    { word: "gpu", description: "Pass the host GPU nodes (/dev/kfd and /dev/dri)" },
    { word: "none", description: "Pass no devices" },
    { word: "add", description: "Pass an explicit host device path", more: true },
    { word: "remove", description: "Stop passing a device", more: true },
];

/**
 * Completions receive the whole argument text (`"mounts add /opt "`), and the chosen item's `value` replaces
 * all of it, so every item is a complete argument string rather than just the next word.
 */
export function completeSandboxArguments(
    prefix: string,
    loadConfig: () => SandboxConfig = currentSandboxConfig,
): AutocompleteItem[] {
    const text = prefix.trimStart();
    const trailingSpace = text.length > 0 && /\s$/.test(text);
    const trimmed = trailingSpace ? text.trimEnd() : text;
    const words = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
    const path = trailingSpace ? words : words.slice(0, -1);
    const partial = trailingSpace ? "" : (words.at(-1) ?? "");

    return argumentWords(path, loadConfig)
        .filter((candidate) => candidate.word.startsWith(partial))
        .map((candidate) => {
            const completed = [...path, candidate.word].join(" ");

            return {
                value: candidate.more === true ? `${completed} ` : completed,
                label: candidate.word,
                description: candidate.description,
            };
        });
}

function argumentWords(
    path: readonly string[],
    loadConfig: () => SandboxConfig,
): readonly CompletionWord[] {
    const [head, action] = path;

    if (head === undefined) {
        return TOP_LEVEL;
    }

    if (head === "backend") {
        return path.length === 1 ? BACKENDS : [];
    }

    if (head === "mounts" || head === "mount") {
        return mountWords(path, action, loadConfig);
    }

    if (head === "network") {
        return networkWords(path, action, loadConfig);
    }

    if (head === "devices") {
        return deviceWords(path, action, loadConfig);
    }

    return [];
}

function mountWords(
    path: readonly string[],
    action: string | undefined,
    loadConfig: () => SandboxConfig,
): readonly CompletionWord[] {
    if (path.length === 1) {
        return MOUNT_ACTIONS;
    }

    if (action === "add") {
        const used = new Set(path.slice(2));

        return MOUNT_ADD_OPTIONS.filter((option) => !used.has(option.word));
    }

    if ((action === "remove" || action === "rm") && path.length === 2) {
        return mountSources(loadConfig());
    }

    return [];
}

function networkWords(
    path: readonly string[],
    action: string | undefined,
    loadConfig: () => SandboxConfig,
): readonly CompletionWord[] {
    if (path.length === 1) {
        return NETWORK_ACTIONS;
    }

    if (action !== "port" && action !== "ports") {
        return [];
    }

    if (path.length === 2) {
        return PORT_ACTIONS;
    }

    if ((path[2] === "remove" || path[2] === "rm") && path.length === 3) {
        return publishedPorts(loadConfig());
    }

    return [];
}

function deviceWords(
    path: readonly string[],
    action: string | undefined,
    loadConfig: () => SandboxConfig,
): readonly CompletionWord[] {
    if (path.length === 1) {
        return DEVICE_ACTIONS;
    }

    if ((action === "remove" || action === "rm") && path.length === 2) {
        return declaredDevicePaths(loadConfig()).map((device) => ({
            word: device,
            description: "passed through to the sandbox",
        }));
    }

    return [];
}

function mountSources(loaded: SandboxConfig): readonly CompletionWord[] {
    return Object.entries(loaded.sandbox.mounts)
        .map(([source, value]) => ({ word: source, description: describeMount(value) }))
        .toSorted((left, right) => left.word.localeCompare(right.word));
}

function publishedPorts(loaded: SandboxConfig): readonly CompletionWord[] {
    return declaredPorts(loaded).map((port) => ({
        word: String(port),
        description: "published to the host",
    }));
}

function describeMount(value: SandboxConfigMountValue): string {
    const mode = typeof value === "string" ? value : (value.mode ?? "readonly");

    return mode === "readwrite" || mode === "rw" ? "read-write mount" : "read-only mount";
}

/** The loaded config, or the defaults before any config file exists. */
function currentSandboxConfig(): SandboxConfig {
    return config.current ?? config.default;
}

export function registerSandboxCommand(
    pi: ExtensionAPI,
    dependencies: SandboxCommandDependencies,
): void {
    pi.registerCommand("sandbox", {
        description: "Sandbox backend for this project (status, build, backend)",
        getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
            completeSandboxArguments(
                prefix,
                dependencies.configForCompletions ?? currentSandboxConfig,
            ),
        handler: async (args, ctx) => {
            await handleCommand(args.trim(), ctx, dependencies);
        },
    });
}

async function handleCommand(
    args: string,
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
): Promise<void> {
    const [head, ...rest] = args.length === 0 ? ["status"] : args.split(/\s+/);

    if (head === "build") {
        await build(ctx, dependencies);

        return;
    }

    if (head === "backend") {
        await setBackend(rest[0], ctx, dependencies);

        return;
    }

    if (head === "mounts" || head === "mount") {
        await handleMounts(rest, ctx, dependencies);

        return;
    }

    if (head === "network") {
        await handleNetwork(rest, ctx, dependencies);

        return;
    }

    if (head === "devices") {
        await handleDevices(rest, ctx, dependencies);

        return;
    }

    if (head === "status") {
        await reportStatus(ctx, dependencies);

        return;
    }

    ctx.ui.notify(
        `pi-bash-sandbox: unknown /sandbox argument "${args}"; try status, build, backend, mounts, network, devices`,
        "warning",
    );
}

async function reportStatus(
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
): Promise<void> {
    const loaded = loadConfig(ctx.cwd);
    const selection = selectBackend(loaded, process.env);
    const summary = describeSandboxSettings(loaded, ctx.cwd);
    const plan = `\n\n${summary.lines.join("\n")}`;

    const say = (message: string, level: "info" | "warning" | "error"): void => {
        ctx.ui.notify(`${message}${plan}`, level);

        for (const warning of summary.warnings) {
            ctx.ui.notify(`pi-bash-sandbox: ${warning}`, "warning");
        }
    };

    if (dependencies.state.active) {
        say(
            `pi-bash-sandbox: bash runs in the sandbox container (backend ${selection.choice}, ${selection.source})`,
            "info",
        );

        return;
    }

    if (selection.choice === "bwrap") {
        say(
            `pi-bash-sandbox: bash runs under bubblewrap (backend bwrap, ${selection.source})`,
            "info",
        );

        return;
    }

    const inspect =
        dependencies.inspect ?? ((projectDir: string) => inspectContainerReadiness({ projectDir }));
    const readiness = await inspect(ctx.cwd);

    switch (readiness.state) {
        case "ready":
            say(
                `pi-bash-sandbox: image ${readiness.image} is built; the container starts with the next session`,
                "info",
            );

            return;
        case "needs-build":
            say(
                `pi-bash-sandbox: ${readiness.recipePath} has no built image yet; run /sandbox build, ` +
                    "or restart to be asked",
                "warning",
            );

            return;
        case "unavailable":
            say(`pi-bash-sandbox: bash runs under bubblewrap — ${readiness.reason}`, "warning");

            return;
        case "unsupported":
            say(`pi-bash-sandbox: ${readiness.reason}`, "error");

            return;
        case "no-recipe":
            say(
                "pi-bash-sandbox: bash runs under bubblewrap — no .pi/Containerfile in this project",
                "info",
            );
    }
}

async function build(
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
): Promise<void> {
    const plan = planSandboxImage({ projectDir: ctx.cwd });

    if (plan.kind === "unsupported") {
        ctx.ui.notify(`pi-bash-sandbox: ${plan.reason}`, "error");

        return;
    }

    if (plan.kind === "explicit") {
        ctx.ui.notify(
            `pi-bash-sandbox: nothing to build — PI_SANDBOX_IMAGE names ${plan.image} directly`,
            "info",
        );

        return;
    }

    if (plan.kind === "default") {
        ctx.ui.notify(
            "pi-bash-sandbox: nothing to build — no .pi/Containerfile in this project",
            "info",
        );

        return;
    }

    if (!ctx.hasUI) {
        ctx.ui.notify(
            "pi-bash-sandbox: a build needs an approval prompt, which this mode cannot show",
            "error",
        );

        return;
    }

    const confirmed = await ctx.ui.confirm("Build sandbox image", recipePreview(plan));

    if (!confirmed) {
        return;
    }

    ctx.ui.notify(`pi-bash-sandbox: building ${plan.image}…`, "info");

    try {
        const result = await buildRecipeImage(plan);
        const timing = result.outcome === "built" ? ` in ${result.elapsedMs} ms` : "";
        const pruned = result.pruned.length === 0 ? "" : `; pruned ${result.pruned.length} old`;

        ctx.ui.notify(`pi-bash-sandbox: ${plan.image} is ready${timing}${pruned}`, "info");

        // Housekeeping never fails a build, so a failed pass is a warning on an otherwise good result.
        if (result.pruneError !== undefined) {
            ctx.ui.notify(
                `pi-bash-sandbox: could not prune old images: ${result.pruneError}`,
                "warning",
            );
        }
    } catch (error) {
        ctx.ui.notify(`pi-bash-sandbox: ${describe(error)}`, "error");

        return;
    }

    await dependencies.onImageBuilt?.(ctx);
}

async function setBackend(
    value: string | undefined,
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
): Promise<void> {
    const choice = parseChoice(value);

    if (choice === undefined) {
        ctx.ui.notify("pi-bash-sandbox: use /sandbox backend auto, container, or bwrap", "warning");

        return;
    }

    const configPath = resolveProjectConfigPath(ctx.cwd);

    try {
        updateSandboxConfigField(configPath, { backend: choice, containerDeclinedTag: null });
    } catch (error) {
        ctx.ui.notify(`pi-bash-sandbox: ${describe(error)}`, "error");

        return;
    }

    const effect =
        choice === "container"
            ? "the container is used once its image is built"
            : choice === "auto"
              ? "the image is used when it is ready; otherwise you are asked once"
              : "bash stays on bubblewrap";

    // A containerized runtime cannot give its tools back: pi registers them for the life of the process.
    const when = dependencies.state.active ? "restart pi" : "next session";

    ctx.ui.notify(
        `pi-bash-sandbox: backend set to ${choice} in ${configPath}; ${effect} (${when})`,
        "info",
    );
}

function parseChoice(value: string | undefined): SandboxBackendChoice | undefined {
    return value === "auto" || value === "container" || value === "bwrap" ? value : undefined;
}

/**
 * `/sandbox mounts` — the mount list, editable without hand-editing JSON.
 *
 * A settings edit is written to the project config, reloaded, and handed to the backend so the container is
 * replaced: the mount set is frozen at create, and an edit that only took effect next session would read as a
 * broken setting.
 */
async function handleMounts(
    rest: readonly string[],
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
): Promise<void> {
    const [action, ...args] = rest;

    if (action === undefined || action === "show" || action === "list") {
        await showSettings(ctx);

        return;
    }

    if (action === "add") {
        await addMount(args, ctx, dependencies);

        return;
    }

    if (action === "remove" || action === "rm") {
        await removeMount(args[0], ctx, dependencies);

        return;
    }

    ctx.ui.notify(
        "pi-bash-sandbox: use /sandbox mounts [show | add <path> [ro|rw] [target=<path>] [create] | remove <path>]",
        "warning",
    );
}

async function addMount(
    args: readonly string[],
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
): Promise<void> {
    let source: string | undefined;
    let access: "readonly" | "readwrite" | undefined;
    let target: string | undefined;
    let create = false;

    for (const arg of args) {
        if (arg === "ro" || arg === "readonly") {
            access = "readonly";

            continue;
        }

        if (arg === "rw" || arg === "readwrite") {
            access = "readwrite";

            continue;
        }

        if (arg === "create") {
            create = true;

            continue;
        }

        if (arg.startsWith("target=")) {
            target = arg.slice("target=".length);

            continue;
        }

        if (source === undefined) {
            source = arg;

            continue;
        }

        ctx.ui.notify(`pi-bash-sandbox: unexpected argument "${arg}"`, "warning");

        return;
    }

    if (source === undefined) {
        ctx.ui.notify(
            "pi-bash-sandbox: /sandbox mounts add <path> [ro|rw] [target=<path>] [create]",
            "warning",
        );

        return;
    }

    const mode = access ?? "readonly";
    const value: SandboxConfigMountValue =
        target === undefined && !create
            ? mode
            : {
                  mode,
                  ...(target === undefined ? {} : { target }),
                  ...(create ? { create: true } : {}),
              };

    // Validation is the resolver's own, so the command accepts exactly what the backend will accept: it
    // creates a `create` path, refuses a credential path, and drops a missing source or a relative target.
    const warnings: string[] = [];
    const resolved = resolveConfiguredMounts(
        { sandbox: { mounts: { [source]: value } }, permissions: {} },
        { role: "write", warnings },
    );

    if (resolved.length === 0) {
        for (const warning of warnings) {
            ctx.ui.notify(`pi-bash-sandbox: ${warning}`, "warning");
        }

        return;
    }

    await applyPatch(
        { mounts: [{ source, value }] },
        ctx,
        dependencies,
        `mount ${source} (${mode})`,
    );
}

async function removeMount(
    source: string | undefined,
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
): Promise<void> {
    if (source === undefined) {
        ctx.ui.notify("pi-bash-sandbox: /sandbox mounts remove <path>", "warning");

        return;
    }

    if (loadConfig(ctx.cwd).sandbox.mounts[source] === undefined) {
        ctx.ui.notify(`pi-bash-sandbox: no mount for ${source}`, "warning");

        return;
    }

    await applyPatch(
        { mounts: [{ source, value: null }] },
        ctx,
        dependencies,
        `unmounted ${source}`,
    );

    if (loadConfig(ctx.cwd).sandbox.mounts[source] !== undefined) {
        ctx.ui.notify(
            `pi-bash-sandbox: ${source} is still set by the global config; remove it there to unmount it`,
            "warning",
        );
    }
}

/** `/sandbox network` — the mode, and the ports published to the host. */
async function handleNetwork(
    rest: readonly string[],
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
): Promise<void> {
    const [action, ...args] = rest;

    if (action === undefined || action === "show") {
        await showSettings(ctx);

        return;
    }

    if (action === "port" || action === "ports") {
        await editPort(args, ctx, dependencies);

        return;
    }

    if (action !== "egress" && action !== "none" && action !== "host") {
        ctx.ui.notify(
            "pi-bash-sandbox: use /sandbox network [egress|none|host] or /sandbox network port add <spec>",
            "warning",
        );

        return;
    }

    const loaded = loadConfig(ctx.cwd);
    const ports = declaredPorts(loaded);
    const value: SandboxConfigNetwork = ports.length === 0 ? action : { mode: action, ports };

    await applyPatch({ network: value }, ctx, dependencies, `network ${action}`);
}

async function editPort(
    args: readonly string[],
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
): Promise<void> {
    const [verb, spec] = args;
    const loaded = loadConfig(ctx.cwd);
    const ports = declaredPorts(loaded);
    const mode = networkModeOf(loaded.sandbox.network);

    if (spec === undefined || (verb !== "add" && verb !== "remove" && verb !== "rm")) {
        ctx.ui.notify(
            "pi-bash-sandbox: /sandbox network port add|remove <port> (3000, 8080:80, or 127.0.0.1:8080:80)",
            "warning",
        );

        return;
    }

    if (verb === "add" && normalizePublishSpec(spec) === undefined) {
        ctx.ui.notify(
            `pi-bash-sandbox: "${spec}" is not a valid port ` +
                '(use 3000, "8080:80", or "127.0.0.1:8080:80")',
            "warning",
        );

        return;
    }

    const next =
        verb === "add"
            ? [...ports.filter((port) => String(port) !== spec), storePort(spec)]
            : ports.filter((port) => String(port) !== spec);

    if (verb !== "add" && next.length === ports.length) {
        ctx.ui.notify(`pi-bash-sandbox: no published port "${spec}"`, "warning");

        return;
    }

    await applyPatch(
        { network: next.length === 0 ? mode : { mode, ports: next } },
        ctx,
        dependencies,
        verb === "add" ? `published port ${spec}` : `stopped publishing ${spec}`,
    );
}

/** `/sandbox devices` — GPU and other host device nodes, for either backend. */
async function handleDevices(
    rest: readonly string[],
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
): Promise<void> {
    const [action, value] = rest;

    if (action === undefined || action === "show") {
        await showSettings(ctx);

        return;
    }

    if (action === "gpu") {
        await applyPatch({ devices: "gpu" }, ctx, dependencies, "devices: gpu");

        return;
    }

    if (action === "none" || action === "off") {
        await applyPatch({ devices: null }, ctx, dependencies, "devices: none");

        return;
    }

    if (action !== "add" && action !== "remove" && action !== "rm") {
        ctx.ui.notify(
            "pi-bash-sandbox: use /sandbox devices [show | gpu | none | add <path> | remove <path>]",
            "warning",
        );

        return;
    }

    if (value === undefined || !path.isAbsolute(value)) {
        ctx.ui.notify(`pi-bash-sandbox: /sandbox devices ${action} <absolute-path>`, "warning");

        return;
    }

    if (action === "add" && !fs.existsSync(value)) {
        ctx.ui.notify(`pi-bash-sandbox: ${value} does not exist on this host`, "warning");

        return;
    }

    const current = declaredDevicePaths(loadConfig(ctx.cwd));
    const next =
        action === "add"
            ? [...current.filter((entry) => entry !== value), value]
            : current.filter((entry) => entry !== value);

    if (action !== "add" && next.length === current.length) {
        ctx.ui.notify(`pi-bash-sandbox: ${value} is not configured`, "warning");

        return;
    }

    await applyPatch(
        { devices: next.length === 0 ? null : next },
        ctx,
        dependencies,
        action === "add" ? `added device ${value}` : `removed device ${value}`,
    );
}

async function showSettings(ctx: ExtensionContext): Promise<void> {
    const summary: SandboxSettingsSummary = describeSandboxSettings(loadConfig(ctx.cwd), ctx.cwd);

    ctx.ui.notify(`pi-bash-sandbox: sandbox settings\n${summary.lines.join("\n")}`, "info");

    for (const warning of summary.warnings) {
        ctx.ui.notify(`pi-bash-sandbox: ${warning}`, "warning");
    }
}

/**
 * Write one patch to the project config, reload it, and let the backend replace its container.
 *
 * The reload matters even before the container exists: `config.current` is a module cache, and the bash gate
 * reads it on the next command.
 */
async function applyPatch(
    patch: SandboxConfigPatch,
    ctx: ExtensionContext,
    dependencies: SandboxCommandDependencies,
    message: string,
): Promise<void> {
    const configPath = resolveProjectConfigPath(ctx.cwd);

    try {
        updateSandboxConfigField(configPath, patch);
    } catch (error) {
        ctx.ui.notify(`pi-bash-sandbox: ${describe(error)}`, "error");

        return;
    }

    try {
        config.load(ctx.cwd);
    } catch {
        // A checkout with no config files yet: the defaults already describe it.
    }

    ctx.ui.notify(`pi-bash-sandbox: ${message} (${configPath})`, "info");

    await dependencies.onConfigChanged?.(ctx);
    await showSettings(ctx);
}

/** A bare port is stored as a number so the file reads like a port list, not a string list. */
function storePort(spec: string): string | number {
    return /^\d+$/.test(spec) ? Number(spec) : spec;
}

function networkModeOf(network: SandboxConfigNetwork | undefined): SandboxConfigNetworkMode {
    if (network === undefined) {
        return "egress";
    }

    return typeof network === "string" ? network : (network.mode ?? "egress");
}

/** The ports as written, so removing one matches what the user typed rather than the normalized form. */
function declaredPorts(loaded: SandboxConfig): (string | number)[] {
    const network = loaded.sandbox.network;

    return typeof network === "object" && network !== null ? [...(network.ports ?? [])] : [];
}

/** The paths a `devices` setting names; `gpu` is expanded so add/remove edit the concrete list. */
function declaredDevicePaths(loaded: SandboxConfig): string[] {
    const devices = loaded.sandbox.devices;

    if (devices === "gpu") {
        return [...GPU_DEVICE_PATHS];
    }

    return devices === undefined ? [] : [...devices];
}

/** Long enough to review a typical recipe, short enough to stay a dialog rather than a wall. */
const RECIPE_PREVIEW_LINES = 24;

function recipePreview(plan: RecipePlan): string {
    const lines = plan.recipe.text.trimEnd().split("\n");
    const shown = lines.slice(0, RECIPE_PREVIEW_LINES);
    const omitted = lines.length - shown.length;
    const body = [...shown, ...(omitted > 0 ? [`… ${omitted} more line(s)`] : [])].join("\n");

    return [
        `Recipe: ${plan.recipe.path}`,
        `Image:  ${plan.image}`,
        "",
        body,
        "",
        "RUN steps execute on this host as your user.",
        "Build it?",
    ].join("\n");
}

function loadConfig(cwd: string) {
    try {
        return config.load(cwd);
    } catch {
        return config.default;
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
