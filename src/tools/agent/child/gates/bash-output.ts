import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isBashToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ChildGate } from "./gate";

interface BashOutputPath {
    lexical: string;
    real: string;
    device: number;
    inode: number;
}

/**
 * The full-output files this child's own Bash results have reported.
 *
 * Truncated Bash output is written to a temp file and its path is returned in the tool result details.
 * Those exact paths are readable by this child and nothing else, so the ledger is a read root rather
 * than a capability. Entries are validated on every read because the file may have been replaced,
 * moved, or re-pointed by a symlink since it was reported; a stale path must not stay usable.
 *
 * Only small path/stat metadata is retained, not output contents or open handles, and the number of
 * entries is naturally bounded by how much work the run performs.
 */
export interface BashOutputLedger {
    /** Records the output path in a Bash tool result's details, if it reports one. */
    remember(details: unknown): void;
    /** Rebuilds the ledger from a restored transcript, so a resumed child keeps its exceptions. */
    rememberFromSession(ctx: ExtensionContext): void;
    /** Currently valid paths, pruning anything that no longer matches what was recorded. */
    active(): string[];
}

export function createBashOutputLedger(): BashOutputLedger {
    const paths = new Map<string, BashOutputPath>();

    const remember = (details: unknown): void => {
        const recorded = validatedPath(details);
        if (!recorded) {
            return;
        }
        // Re-inserting moves the entry to the end, which keeps the newest report last rather than
        // leaving a stale record at the original position.
        paths.delete(recorded.lexical);
        paths.set(recorded.lexical, recorded);
    };

    const rememberFromSession = (ctx: ExtensionContext): void => {
        for (const entry of ctx.sessionManager?.getBranch() ?? []) {
            if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
            if (entry.message.toolName !== "bash") continue;
            remember((entry.message as { details?: unknown }).details);
        }
    };

    return {
        remember,
        rememberFromSession,
        active(): string[] {
            const active: string[] = [];
            for (const [lexical, expected] of paths) {
                const current = inspectOutputPath(lexical);
                if (
                    !current ||
                    current.real !== expected.real ||
                    current.device !== expected.device ||
                    current.inode !== expected.inode
                ) {
                    paths.delete(lexical);
                    continue;
                }
                active.push(lexical);
            }
            return active;
        },
    };
}

function validatedPath(details: unknown): BashOutputPath | undefined {
    if (!details || typeof details !== "object") {
        return undefined;
    }
    return inspectOutputPath((details as { fullOutputPath?: unknown }).fullOutputPath);
}

function inspectOutputPath(value: unknown): BashOutputPath | undefined {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
        return undefined;
    }

    const lexical = path.resolve(value);
    const temporaryDirectory = path.resolve(os.tmpdir());
    if (!isWithinDirectory(lexical, temporaryDirectory)) {
        return undefined;
    }

    try {
        const stat = fs.lstatSync(lexical);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            return undefined;
        }
        const real = fs.realpathSync(lexical);
        if (!isWithinDirectory(real, fs.realpathSync(temporaryDirectory))) {
            return undefined;
        }
        return { lexical, real, device: stat.dev, inode: stat.ino };
    } catch {
        return undefined;
    }
}

function isWithinDirectory(filePath: string, directory: string): boolean {
    const relative = path.relative(directory, filePath);
    return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
}

/**
 * Keeps the ledger warm across a restored transcript and every new Bash result.
 *
 * Installed for every child rather than only bash-capable ones: the hooks are two cheap checks, and
 * a resumed child's transcript may carry results from before the run was interrupted.
 */
export const BASH_OUTPUT_GATE: ChildGate = {
    id: "bash-output",
    install(runtime) {
        runtime.pi.on("session_start", (_event, ctx) => {
            runtime.bashOutputs.rememberFromSession(ctx);
        });
        runtime.pi.on("tool_result", (event) => {
            if (!isBashToolResult(event)) {
                return;
            }
            runtime.bashOutputs.remember(event.details);
        });
    },
};
