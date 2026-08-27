import { chmod, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ScratchpadRuntime {
    /** Private temporary directory for one parent or child runtime. */
    path: string;
}

const SCRATCHPAD_SYSTEM_TAG = "<scratchpad_system>";
const SCRATCHPAD_SYSTEM_END_TAG = "</scratchpad_system>";
const SCRATCHPAD_PREFIX = "pi-coder-scratchpad-";

// SessionManager instances identify a parent or child runtime. A WeakMap keeps
// parent and child scratchpads separate without introducing persistent state.
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
        "Use it for notes, intermediate artifacts, generated reports, and other work that should not modify the project checkout.",
        "You may use the normal read, write, edit, and bash tools with this directory.",
        "It is an additional confined root, equivalent to the current working directory for path safety.",
        "Scratchpad contents are temporary and are not managed or deleted by pi-coder; the operating system owns eventual cleanup of the /tmp directory.",
        "Do not rely on the contents surviving process termination or a later session.",
    ].join("\\n");
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

/**
 * Register one temporary scratchpad for each parent or child runtime.
 *
 * The directory is intentionally never removed by this extension. Only the
 * in-process registry entry is released at shutdown; the host OS owns /tmp
 * cleanup according to its normal policy.
 */
export default function registerScratchpadExtension(pi: ExtensionAPI): void {
    pi.on("session_start", async (_event, ctx) => {
        const runtime = await createScratchpad();
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

