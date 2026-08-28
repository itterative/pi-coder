import { chmod, lstat, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ScratchpadRuntime {
    /** Private temporary directory for one parent or child runtime. */
    path: string;
}

export const SCRATCHPAD_MARKER_TYPE = "pi-coder:scratchpad";

interface ScratchpadMarker {
    version: 1;
    path: string;
}

const SCRATCHPAD_SYSTEM_TAG = "<scratchpad_system>";
const SCRATCHPAD_SYSTEM_END_TAG = "</scratchpad_system>";
const SCRATCHPAD_PREFIX = "pi-coder-scratchpad-";

// SessionManager instances identify a parent or child runtime. The marker in
// the session transcript bridges reloads; the WeakMap holds only live handles.
const runtimes = new WeakMap<object, ScratchpadRuntime>();

export function getScratchpadRuntime(
    sessionManager: object | undefined,
): ScratchpadRuntime | undefined {
    if (!sessionManager) return undefined;
    return runtimes.get(sessionManager);
}

export function getScratchpadPath(
    sessionManager: object | undefined,
): string | undefined {
    return getScratchpadRuntime(sessionManager)?.path;
}

export function scratchpadPrompt(pathname: string): string {
    return [
        "## Temporary Scratchpad",
        "",
        "A private temporary scratchpad is available at:",
        "",
        `\`${pathname}\``,
        "",
        "Use it for notes, intermediate artifacts, generated reports, and other "
            + "work that should not modify the project checkout.",
        "Use this directory with the tools available in this runtime; access "
            + "remains subject to the runtime's capability policy.",
        "It is an additional confined root, equivalent to the current working "
            + "directory for path safety.",
        "Scratchpad contents are temporary and are not managed or deleted by "
            + "pi-coder; the operating system owns eventual cleanup of the /tmp "
            + "directory.",
        "When returning to this session, the recorded scratchpad path is reused while the directory still exists; do not rely on contents surviving OS cleanup or manual deletion.",
    ].join("\n");
}

function appendScratchpadPrompt(systemPrompt: string, pathname: string): string {
    if (systemPrompt.includes(SCRATCHPAD_SYSTEM_TAG)) {
        return systemPrompt;
    }

    const scratchpadBlock = `${SCRATCHPAD_SYSTEM_TAG}\n${scratchpadPrompt(pathname)}\n${SCRATCHPAD_SYSTEM_END_TAG}`;
    const projectContextEnd = "</project_context>";
    const index = systemPrompt.indexOf(projectContextEnd);
    if (index === -1) {
        return `${systemPrompt}\n\n${scratchpadBlock}`;
    }

    return systemPrompt.slice(0, index + projectContextEnd.length)
        + "\n\n"
        + scratchpadBlock
        + "\n"
        + systemPrompt.slice(index + projectContextEnd.length);
}

async function createScratchpad(): Promise<ScratchpadRuntime> {
    const pathname = await mkdtemp(path.join(os.tmpdir(), SCRATCHPAD_PREFIX));
    await chmod(pathname, 0o700);
    return { path: pathname };
}

function markerFromSession(ctx: ExtensionContext): ScratchpadMarker | undefined {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (const entry of [...branch].reverse()) {
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
        if (candidate.type !== "custom" || candidate.customType !== SCRATCHPAD_MARKER_TYPE) continue;
        if (!candidate.data || typeof candidate.data !== "object") return undefined;
        const data = candidate.data as { version?: unknown; path?: unknown };
        if (data.version !== 1 || typeof data.path !== "string" || !path.isAbsolute(data.path)) {
            return undefined;
        }
        return { version: 1, path: data.path };
    }
    return undefined;
}

async function isReusableScratchpad(pathname: string): Promise<boolean> {
    const lexicalPath = path.resolve(pathname);
    const lexicalRoot = path.resolve(os.tmpdir());
    if (!lexicalPath.startsWith(`${lexicalRoot}${path.sep}${SCRATCHPAD_PREFIX}`)) return false;

    try {
        const entry = await lstat(lexicalPath);
        if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o700) return false;
        const [realPath, realRoot] = await Promise.all([
            realpath(lexicalPath),
            realpath(lexicalRoot),
        ]);
        return path.dirname(realPath) === realRoot
            && path.basename(realPath).startsWith(SCRATCHPAD_PREFIX);
    } catch {
        return false;
    }
}

async function restoreOrCreateScratchpad(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
): Promise<ScratchpadRuntime> {
    const marker = markerFromSession(ctx);
    if (marker && await isReusableScratchpad(marker.path)) return { path: marker.path };

    const runtime = await createScratchpad();
    pi.appendEntry<ScratchpadMarker>(SCRATCHPAD_MARKER_TYPE, {
        version: 1,
        path: runtime.path,
    });
    return runtime;
}

/**
 * Register one temporary scratchpad for each parent or child runtime.
 *
 * A session marker lets the runtime reuse its directory across reloads and
 * session switches. The directory is intentionally never removed by this
 * extension; the host OS owns /tmp cleanup according to its normal policy.
 */
export default function registerScratchpadExtension(pi: ExtensionAPI): void {
    pi.on("session_start", async (_event, ctx) => {
        const runtime = await restoreOrCreateScratchpad(pi, ctx);
        runtimes.set(ctx.sessionManager, runtime);
    });

    pi.on("before_agent_start", (event, ctx) => {
        const pathname = getScratchpadPath(ctx.sessionManager);
        if (!pathname) return;

        return {
            systemPrompt: appendScratchpadPrompt(event.systemPrompt, pathname),
        };
    });

    pi.on("session_shutdown", (_event, ctx) => {
        runtimes.delete(ctx.sessionManager);
    });
}
