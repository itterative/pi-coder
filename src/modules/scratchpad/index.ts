import { chmod, lstat, mkdir, mkdtemp, realpath, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getScratchpadDirectory } from "../../common/constants";
import {
    DEFAULT_SCRATCHPAD_POLICY,
    formatRetention,
    formatStorageSize,
    measureScratchpad,
    pruneScratchpads,
    SCRATCHPAD_PREFIX,
    type ScratchpadPolicy,
} from "./policy";

export interface ScratchpadRuntime {
    /** Private temporary directory for one parent or child runtime. */
    path: string;
}

export interface ScratchpadOptions {
    /** Store root; defaults to the agent dir's `scratchpad` directory. Tests inject a temporary one. */
    root?: string;
    policy?: ScratchpadPolicy;
}

export const SCRATCHPAD_MARKER_TYPE = "pi-coder:scratchpad";

interface ScratchpadMarker {
    version: 1;
    path: string;
}

interface ScratchpadStore {
    root: string;
    /** True when the durable root is unusable and the legacy temp dir is the store instead. */
    fallback: boolean;
}

interface ScratchpadSizeWatch {
    measuredAt: number;
    warned: boolean;
}

const SCRATCHPAD_SYSTEM_TAG = "<scratchpad_system>";
const SCRATCHPAD_SYSTEM_END_TAG = "</scratchpad_system>";

// SessionManager instances identify a parent or child runtime. The marker in
// the session transcript bridges reloads; the WeakMap holds only live handles.
const runtimes = new WeakMap<object, ScratchpadRuntime>();
const sizeWatches = new WeakMap<object, ScratchpadSizeWatch>();

export function getScratchpadRuntime(
    sessionManager: object | undefined,
): ScratchpadRuntime | undefined {
    if (!sessionManager) return undefined;
    return runtimes.get(sessionManager);
}

export function getScratchpadPath(sessionManager: object | undefined): string | undefined {
    return getScratchpadRuntime(sessionManager)?.path;
}

export function scratchpadPrompt(
    pathname: string,
    policy: ScratchpadPolicy = DEFAULT_SCRATCHPAD_POLICY,
): string {
    return [
        "## Temporary Scratchpad",
        "",
        "A private temporary scratchpad is available at:",
        "",
        `\`${pathname}\``,
        "",
        "Use it for notes, intermediate artifacts, generated reports, and other " +
            "work that should not modify the project checkout.",
        "Use this directory with the tools available in this runtime; access " +
            "remains subject to the runtime's capability policy.",
        "It is an additional confined root, equivalent to the current working " +
            "directory for path safety.",
        `Keep it small: pi-coder warns once it grows past ${formatStorageSize(policy.perScratchpadBytes)}, ` +
            "and it is not a place for large datasets or bulk output.",
        `Scratchpad contents are temporary: pi-coder removes a scratchpad that has been idle for ` +
            `${formatRetention(policy.retentionMs)}. Copy anything you need to keep into the project or memory.`,
        "When returning to this session, the recorded scratchpad path is reused while the directory still " +
            "exists; do not rely on contents surviving pruning or manual deletion.",
    ].join("\n");
}

function appendScratchpadPrompt(
    systemPrompt: string,
    pathname: string,
    policy: ScratchpadPolicy,
): string {
    if (systemPrompt.includes(SCRATCHPAD_SYSTEM_TAG)) {
        return systemPrompt;
    }

    const scratchpadBlock = `${SCRATCHPAD_SYSTEM_TAG}\n${scratchpadPrompt(pathname, policy)}\n${SCRATCHPAD_SYSTEM_END_TAG}`;
    const projectContextEnd = "</project_context>";
    const index = systemPrompt.indexOf(projectContextEnd);
    if (index === -1) {
        return `${systemPrompt}\n\n${scratchpadBlock}`;
    }

    return (
        systemPrompt.slice(0, index + projectContextEnd.length) +
        "\n\n" +
        scratchpadBlock +
        "\n" +
        systemPrompt.slice(index + projectContextEnd.length)
    );
}

function legacyScratchpadRoot(): string {
    return path.resolve(os.tmpdir());
}

/**
 * The durable store, or the OS temp directory when it cannot be prepared.
 *
 * A scratchpad is a convenience, not a requirement: a full disk or a read-only agent dir must not turn
 * `session_start` into a failed session, so the fallback keeps the old temporary behaviour for this runtime.
 */
async function prepareStore(options: ScratchpadOptions): Promise<ScratchpadStore> {
    const root = options.root ?? getScratchpadDirectory();
    try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await chmod(root, 0o700);
        return { root, fallback: false };
    } catch {
        return { root: legacyScratchpadRoot(), fallback: true };
    }
}

async function createScratchpad(root: string): Promise<ScratchpadRuntime> {
    const pathname = await mkdtemp(path.join(root, SCRATCHPAD_PREFIX));
    await chmod(pathname, 0o700);
    return { path: pathname };
}

function markerFromSession(ctx: ExtensionContext): ScratchpadMarker | undefined {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (const entry of [...branch].reverse()) {
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
        if (candidate.type !== "custom" || candidate.customType !== SCRATCHPAD_MARKER_TYPE)
            continue;
        if (!candidate.data || typeof candidate.data !== "object") return undefined;
        const data = candidate.data as { version?: unknown; path?: unknown };
        if (data.version !== 1 || typeof data.path !== "string" || !path.isAbsolute(data.path)) {
            return undefined;
        }
        return { version: 1, path: data.path };
    }
    return undefined;
}

/**
 * Whether a marked directory may be reused.
 *
 * The legacy temp root stays accepted so an upgrade does not orphan a scratchpad a live session is still
 * using: the directory is reused as-is until the OS removes it, while new runtimes get the durable store.
 */
async function isReusableScratchpad(pathname: string, roots: readonly string[]): Promise<boolean> {
    const lexicalPath = path.resolve(pathname);
    const matchingRoot = roots
        .map((root) => path.resolve(root))
        .find(
            (root) =>
                path.dirname(lexicalPath) === root &&
                path.basename(lexicalPath).startsWith(SCRATCHPAD_PREFIX),
        );
    if (matchingRoot === undefined) return false;

    try {
        const entry = await lstat(lexicalPath);
        if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o700)
            return false;
        const [realPath, realRoot] = await Promise.all([
            realpath(lexicalPath),
            realpath(matchingRoot),
        ]);
        return (
            path.dirname(realPath) === realRoot &&
            path.basename(realPath).startsWith(SCRATCHPAD_PREFIX)
        );
    } catch {
        return false;
    }
}

/**
 * Keep-alive for the age rule: a live session must not look like an idle scratchpad. Called on
 * `session_start` for a resumed scratchpad and after every settled agent run for the active one.
 */
async function touchScratchpad(pathname: string): Promise<void> {
    const now = new Date();
    await utimes(pathname, now, now).catch(() => undefined);
}

async function pruneStore(
    store: ScratchpadStore,
    activePath: string | undefined,
    policy: ScratchpadPolicy,
): Promise<void> {
    if (store.fallback) {
        return;
    }

    const options = activePath === undefined ? { policy } : { activePath, policy };
    await pruneScratchpads(store.root, options).catch(() => undefined);
}

async function restoreOrCreateScratchpad(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    store: ScratchpadStore,
    policy: ScratchpadPolicy,
): Promise<ScratchpadRuntime | undefined> {
    const marker = markerFromSession(ctx);
    if (marker && (await isReusableScratchpad(marker.path, [store.root, legacyScratchpadRoot()]))) {
        await touchScratchpad(marker.path);
        await pruneStore(store, marker.path, policy);
        return { path: marker.path };
    }

    await pruneStore(store, undefined, policy);

    try {
        const runtime = await createScratchpad(store.root);
        pi.appendEntry<ScratchpadMarker>(SCRATCHPAD_MARKER_TYPE, {
            version: 1,
            path: runtime.path,
        });
        return runtime;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-coder: scratchpad unavailable (${message})`, "warning");
        return undefined;
    }
}

/**
 * Warn once per runtime when the active scratchpad passes its soft cap.
 *
 * Only the size is measured here, never enforced: commands can write into the directory without a pi-coder
 * hook, so the honest guarantee is a bound on the whole store plus a warning the user can act on.
 */
async function watchScratchpadSize(
    ctx: ExtensionContext,
    pathname: string,
    policy: ScratchpadPolicy,
): Promise<void> {
    if (!ctx.sessionManager) {
        return;
    }

    const state = sizeWatches.get(ctx.sessionManager) ?? { measuredAt: 0, warned: false };
    const now = Date.now();
    if (now - state.measuredAt < policy.measureIntervalMs) {
        return;
    }

    state.measuredAt = now;
    sizeWatches.set(ctx.sessionManager, state);

    const measurement = await measureScratchpad(pathname, policy.maxEntries);
    await touchScratchpad(pathname);
    if (state.warned || measurement.bytes <= policy.perScratchpadBytes) {
        return;
    }

    state.warned = true;
    ctx.ui.notify(
        `pi-coder: scratchpad is ${formatStorageSize(measurement.bytes)} ` +
            `(limit ${formatStorageSize(policy.perScratchpadBytes)}) — ` +
            `remove files under ${pathname} to free space.`,
        "warning",
    );
}

/**
 * Register one temporary scratchpad for each parent or child runtime.
 *
 * A session marker lets the runtime reuse its directory across reloads and session switches. The directory
 * lives under the agent dir, so pi-coder owns cleanup: idle scratchpads are pruned on `session_start`, the
 * whole store is evicted down to a budget, and an oversized active scratchpad is warned about once.
 */
export default function registerScratchpadExtension(
    pi: ExtensionAPI,
    options: ScratchpadOptions = {},
): void {
    const policy = options.policy ?? DEFAULT_SCRATCHPAD_POLICY;

    pi.on("session_start", async (_event, ctx) => {
        const store = await prepareStore(options);
        const runtime = await restoreOrCreateScratchpad(pi, ctx, store, policy);
        if (runtime === undefined) return;

        runtimes.set(ctx.sessionManager, runtime);
        await watchScratchpadSize(ctx, runtime.path, policy);
    });

    pi.on("before_agent_start", (event, ctx) => {
        const pathname = getScratchpadPath(ctx.sessionManager);
        if (!pathname) return;

        return {
            systemPrompt: appendScratchpadPrompt(event.systemPrompt, pathname, policy),
        };
    });

    pi.on("agent_settled", async (_event, ctx) => {
        const pathname = getScratchpadPath(ctx.sessionManager);
        if (pathname === undefined) return;
        await watchScratchpadSize(ctx, pathname, policy);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        runtimes.delete(ctx.sessionManager);
        sizeWatches.delete(ctx.sessionManager);
    });
}
