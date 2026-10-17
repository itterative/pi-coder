import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type { SandboxConfig } from "../../common/config";
import { buildProbeCommand } from "./bubblewrap";

/** Wall-clock budget for a probe. A probe is evidence for a decision, so it must never stall one. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

const DEFAULT_MAX_CHANGES = 200;
const STATUS_FD = 3;
const UPPER_DIRECTORY_NAME = "upper";
const WORK_DIRECTORY_NAME = "work";
const EXIT_CODE_DOCUMENT = /\{\s*"exit-code"\s*:\s*(-?\d+)\s*\}/g;

export type ProbeChangeKind = "created" | "modified" | "deleted";

/** One workspace path the probed command changed, in an overlay that the real tree never saw. */
export interface ProbeChange {
    /** Workspace-relative path. */
    path: string;
    kind: ProbeChangeKind;
    /** Bytes in the real workspace; `null` when the path did not exist or is not a regular file. */
    beforeBytes: number | null;
    /** Bytes in the probe's overlay; `null` when the path is gone or is not a regular file. */
    afterBytes: number | null;
}

export interface ProbeOptions {
    command: string;
    cwd: string;
    bwrap?: string;
    env?: NodeJS.ProcessEnv;
    config?: SandboxConfig;
    additionalRoots?: readonly string[];
    /** Parent of the overlay's upper/work directories; both must land on one filesystem under it. */
    scratchRoot?: string;
    timeoutMs?: number;
    maxChanges?: number;
}

/**
 * What a probe observed.
 *
 * `status` and `changes` are deliberately separate, because only a `completed` probe says anything about
 * the command. A timeout, a bwrap that never came up, and an unreadable overlay all leave `changes` empty
 * too — reading any of those as "nothing would change" inverts the meaning of the reading, so `status` is
 * what tells the two apart and `reason` always says why.
 */
export interface ProbeResult {
    status: "completed" | "timeout" | "unavailable";
    /**
     * The command's exit code, present whenever `status` is `completed` — including a non-zero one, since a
     * command that failed partway can still have changed files before it died.
     */
    exitCode: number | null;
    changes: readonly ProbeChange[];
    /** Set when `changes` was cut short at the configured maximum. */
    truncated: boolean;
    durationMs: number;
    /** Present unless `status` is `completed`. */
    reason?: string;
}

/**
 * Run a command in a restricted bubble and report which workspace files it would change.
 *
 * This answers one question only — what would change — and is not a permission: it reports, it does not
 * decide. The bubble is strictly weaker than the sandbox a command is normally allowed to run in (no
 * network, read-only everything, `/tmp` shadowed by a tmpfs), so probing never grants a capability. It does
 * mean an unapproved command executes, which is why the reading is meant for decisions that were about to
 * consult a model or a user anyway.
 */
export async function probeCommand(options: ProbeOptions): Promise<ProbeResult> {
    const started = Date.now();
    const cwd = path.resolve(options.cwd);
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

    if (!isDirectory(cwd)) {
        return unavailable(started, `cwd is not a directory: ${cwd}`);
    }

    const scratch = fs.mkdtempSync(
        path.join(options.scratchRoot ?? os.tmpdir(), "pi-coder-probe-"),
    );
    const upper = path.join(scratch, UPPER_DIRECTORY_NAME);
    const work = path.join(scratch, WORK_DIRECTORY_NAME);
    fs.mkdirSync(upper);
    fs.mkdirSync(work);

    try {
        const line = buildProbeCommand(options.command, {
            ...options,
            cwd,
            upper,
            work,
            statusFd: STATUS_FD,
        });
        const run = await runProbe(line, timeoutMs);

        if (run.status !== "completed") {
            return {
                status: run.status,
                exitCode: null,
                changes: [],
                truncated: false,
                durationMs: Date.now() - started,
                ...(run.reason === undefined ? {} : { reason: run.reason }),
            };
        }

        const scanned = scanOverlay(upper, cwd, options.maxChanges ?? DEFAULT_MAX_CHANGES);

        return {
            status: "completed",
            exitCode: run.exitCode,
            changes: scanned.changes,
            truncated: scanned.truncated,
            durationMs: Date.now() - started,
        };
    } finally {
        removeScratch(scratch);
    }
}

/**
 * Remove a probe's scratch directory.
 *
 * overlayfs locks its private work directory down to mode 0000 (`work/work`) and may leave entries inside it,
 * so neither Node's recursive `rm` (which cannot read it) nor `rmdir` (which reports ENOTEMPTY) gets rid of
 * it. Ownership is enough to restore the permissions, which unlocks the directory for the removal that
 * follows.
 */
function removeScratch(scratch: string): void {
    makeReachable(scratch);
    fs.rmSync(scratch, { recursive: true, force: true });
}

/** Restore owner access down a tree so that a removal can traverse it. */
function makeReachable(target: string): void {
    const stat = statOrNull(target);
    if (stat === null || !stat.isDirectory()) {
        return;
    }

    try {
        fs.chmodSync(target, 0o700);
    } catch {
        // Nothing to do: the caller either removes it anyway or reports it.
    }

    for (const entry of readDirectory(target)) {
        if (entry.isDirectory()) {
            makeReachable(path.join(target, entry.name));
        }
    }
}

interface ProbeRun {
    status: "completed" | "timeout" | "unavailable";
    exitCode: number | null;
    reason?: string;
}

/**
 * Run the probe command line and report whether the sandbox itself came up.
 *
 * bwrap tells the two cases apart on the status descriptor: a run that reached the command emits a
 * namespace document followed by `{"exit-code": N}`, while a setup failure emits the namespace document
 * alone and exits 1. So it is the presence of an exit code that says the command ran, not bwrap's own exit
 * status, which is 1 either way. Without that check a kernel that cannot mount the overlay would look like a
 * clean probe and quietly vouch for every command sent through it.
 */
function runProbe(line: string, timeoutMs: number): Promise<ProbeRun> {
    return new Promise((resolve) => {
        const child = spawn("/bin/sh", ["-c", line], {
            stdio: ["ignore", "ignore", "pipe", "pipe"],
        });

        let statusText = "";
        let stderrText = "";
        let timedOut = false;

        const statusStream = child.stdio[STATUS_FD];
        if (statusStream instanceof Readable) {
            statusStream.on("data", (chunk: Buffer) => {
                statusText += chunk.toString("utf8");
            });
        }

        child.stderr?.on("data", (chunk: Buffer) => {
            stderrText += chunk.toString("utf8");
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);

        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({
                status: "unavailable",
                exitCode: null,
                reason: `could not start bwrap: ${error.message}`,
            });
        });

        child.on("close", () => {
            clearTimeout(timer);

            if (timedOut) {
                resolve({
                    status: "timeout",
                    exitCode: null,
                    reason: `still running after ${timeoutMs}ms`,
                });
                return;
            }

            const exitCode = parseExitCode(statusText);
            if (exitCode === null) {
                resolve({
                    status: "unavailable",
                    exitCode: null,
                    reason: firstLine(stderrText) ?? "the sandbox did not start",
                });
                return;
            }

            resolve({ status: "completed", exitCode });
        });
    });
}

/**
 * Read bwrap's exit-code document out of its status stream.
 *
 * The stream holds newline-separated JSON documents and can arrive in arbitrary chunks, so the exit code is
 * matched out of the accumulated text rather than parsed as one document.
 */
function parseExitCode(statusText: string): number | null {
    const match = [...statusText.matchAll(EXIT_CODE_DOCUMENT)].pop();
    return match === undefined ? null : Number(match[1]);
}

function firstLine(text: string): string | undefined {
    const line = text
        .split("\n")
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== "");

    return line;
}

/**
 * Compare an overlay's upper layer against the real tree it was layered over.
 *
 * overlayfs records a deletion as a 0:0 character-device whiteout in the upper layer, so the three kinds of
 * change are distinguishable without knowing anything about the command that caused them.
 */
export function scanOverlay(
    upper: string,
    lower: string,
    maxChanges = DEFAULT_MAX_CHANGES,
): { changes: ProbeChange[]; truncated: boolean } {
    const changes: ProbeChange[] = [];
    const pending = [upper];
    let truncated = false;

    while (pending.length > 0 && !truncated) {
        const directory = pending.pop();
        if (directory === undefined) {
            break;
        }

        for (const entry of readDirectory(directory)) {
            const absolute = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                pending.push(absolute);
                continue;
            }

            const change = describeChange(absolute, path.relative(upper, absolute), lower);
            if (change === null) {
                continue;
            }

            if (changes.length >= maxChanges) {
                truncated = true;
                break;
            }

            changes.push(change);
        }
    }

    return { changes: sortChanges(changes), truncated };
}

function describeChange(absolute: string, relative: string, lower: string): ProbeChange | null {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(absolute);
    } catch {
        return null;
    }

    const real = statOrNull(path.join(lower, relative));
    const before = real !== null && real.isFile() ? real.size : null;

    if (stat.isCharacterDevice()) {
        return { path: relative, kind: "deleted", beforeBytes: before, afterBytes: null };
    }

    const after = stat.isFile() ? stat.size : null;

    if (real === null || !real.isFile()) {
        return { path: relative, kind: "created", beforeBytes: null, afterBytes: after };
    }

    return { path: relative, kind: "modified", beforeBytes: real.size, afterBytes: after };
}

const KIND_ORDER: Record<ProbeChangeKind, number> = { deleted: 0, modified: 1, created: 2 };

/**
 * Order changes by what a decision needs to notice first: deletions, then the largest losses, then the rest.
 * Byte counts, not paths, carry the signal — a rewrite that keeps the size and one that throws away most of
 * a file read identically otherwise.
 */
function sortChanges(changes: ProbeChange[]): ProbeChange[] {
    return changes.toSorted((left, right) => {
        const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
        if (byKind !== 0) {
            return byKind;
        }

        const byLoss = lostBytes(right) - lostBytes(left);
        if (byLoss !== 0) {
            return byLoss;
        }

        return left.path.localeCompare(right.path);
    });
}

/** Bytes the change removed from the workspace, as the ordering and reporting signal. */
function lostBytes(change: ProbeChange): number {
    if (change.beforeBytes === null) {
        return 0;
    }

    if (change.afterBytes === null) {
        return change.beforeBytes;
    }

    return Math.max(0, change.beforeBytes - change.afterBytes);
}

function readDirectory(directory: string): fs.Dirent[] {
    try {
        return fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }
}

function statOrNull(target: string): fs.Stats | null {
    try {
        return fs.lstatSync(target);
    } catch {
        return null;
    }
}

function isDirectory(target: string): boolean {
    const stat = statOrNull(target);
    return stat !== null && stat.isDirectory();
}

function unavailable(started: number, reason: string): ProbeResult {
    return {
        status: "unavailable",
        exitCode: null,
        changes: [],
        truncated: false,
        durationMs: Date.now() - started,
        reason,
    };
}
