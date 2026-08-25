import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

import type { SandboxConfigCwdConfinement } from "../../../common/config";
import {
    getPathConfinementPermission,
    Heuristic,
} from "../../../modules/sandbox/heuristics";

const execFile = promisify(execFileCallback);
const MAX_DIFF_CHARS = 24_000;
const MAX_NAME_STATUS_CHARS = 24_000;
const REVISION = /^(?:HEAD(?:~[0-9]+)?|[0-9a-f]{7,64})$/i;

const REVIEW_CONFINEMENT: SandboxConfigCwdConfinement = {
    enabled: true,
    permission: "allow",
    resolveSymlinks: true,
};

export interface HistoryReviewInput {
    base: string;
    head: string;
}

export interface HistoryReviewDetails {
    base: string;
    head: string;
    changedFiles: number;
    reviewedFiles: number;
    withheldSensitiveFiles: number;
    redactedLines: number;
    truncated: boolean;
}

interface GitResult {
    stdout: string;
    truncated: boolean;
}

function gitEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
        // Git's environment can relocate a repository, replace its object
        // database, or inject config. A history review must always inspect the
        // repository rooted at its supplied cwd instead.
        if (value !== undefined && !name.startsWith("GIT_")) environment[name] = value;
    }
    return {
        ...environment,
        // Do not load machine-wide or user Git configuration while producing
        // reviewer output. The repository's local configuration still cannot
        // enable external diff/textconv because those modes are disabled below.
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: os.devNull,
        // Git pathspec magic must never expand a safe-looking filename into
        // paths that were withheld from the review.
        GIT_LITERAL_PATHSPECS: "1",
    };
}

async function git(cwd: string, args: string[], maxBuffer = MAX_DIFF_CHARS): Promise<GitResult> {
    try {
        const { stdout } = await execFile("git", args, {
            cwd,
            env: gitEnvironment(),
            encoding: "utf8",
            maxBuffer,
            windowsHide: true,
        });
        return { stdout, truncated: false };
    } catch (error) {
        const candidate = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
        if (candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && typeof candidate.stdout === "string") {
            return { stdout: candidate.stdout, truncated: true };
        }
        throw error;
    }
}

async function assertRepositoryRoot(cwd: string): Promise<void> {
    const { stdout } = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const [resolvedCwd, resolvedRoot] = await Promise.all([realpath(cwd), realpath(stdout.trim())]);
    if (resolvedCwd !== resolvedRoot) {
        throw new Error("safe-git-history requires the agent cwd to be the repository root.");
    }
}

async function resolveCommit(cwd: string, revision: string): Promise<string> {
    if (!REVISION.test(revision)) throw new Error("Revisions must be HEAD, HEAD~<number>, or a commit SHA.");
    const { stdout } = await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
    const hash = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(hash)) throw new Error("Revision did not resolve to a commit.");
    return hash;
}

/** Parses `git diff --name-status -z` without ever exposing a withheld name. */
function changedPathRecords(output: string): string[][] {
    const fields = output.split("\0");
    const records: string[][] = [];
    let index = 0;
    while (index < fields.length - 1) {
        const status = fields[index++];
        if (!status) break;
        const pathCount = /^[RC]/.test(status) ? 2 : 1;
        const paths = fields.slice(index, index + pathCount);
        if (paths.length !== pathCount || paths.some((filePath) => !filePath)) break;
        index += pathCount;
        records.push(paths);
    }
    return records;
}

function reviewablePaths(records: string[][], cwd: string): { paths: string[]; withheld: number } {
    const paths = new Set<string>();
    let withheld = 0;
    for (const record of records) {
        if (record.every((filePath) => (
            getPathConfinementPermission(filePath, cwd, REVIEW_CONFINEMENT) === Heuristic.SAFE_READONLY
        ))) {
            record.forEach((filePath) => paths.add(filePath));
        } else {
            withheld++;
        }
    }
    return { paths: [...paths], withheld };
}

function redactDiff(diff: string): { text: string; redactedLines: number } {
    let privateKeyBlock = false;
    let redactedLines = 0;
    const text = diff.split("\n").map((line) => {
        const prefix = line.match(/^[ +\-]/)?.[0] ?? "";
        if (/^[ +\-]?-----BEGIN [A-Z ]*(?:PRIVATE )?KEY-----$/.test(line)) {
            privateKeyBlock = true;
            redactedLines++;
            return `${prefix}[REDACTED PRIVATE KEY BLOCK]`;
        }
        if (privateKeyBlock) {
            redactedLines++;
            if (/^[ +\-]?-----END [A-Z ]*(?:PRIVATE )?KEY-----$/.test(line)) privateKeyBlock = false;
            return `${prefix}[REDACTED PRIVATE KEY BLOCK]`;
        }
        if (/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|private[_-]?key|client[_-]?secret|connection[_-]?string)\b/i.test(line)) {
            const separator = line.search(/[:=]/);
            if (separator !== -1) {
                redactedLines++;
                return `${line.slice(0, separator + 1)} [REDACTED]`;
            }
        }
        const redacted = line
            .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
            .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]");
        if (redacted !== line) redactedLines++;
        return redacted;
    }).join("\n");
    return { text, redactedLines };
}

/**
 * Returns a bounded, best-effort-redacted patch for a reviewer-selected commit
 * range. Callers receive only safe changed paths; a record is withheld whenever
 * either side of a rename/copy is sensitive or outside cwd.
 */
export async function reviewHistory(cwd: string, input: HistoryReviewInput): Promise<{
    text: string;
    details: HistoryReviewDetails;
}> {
    await assertRepositoryRoot(cwd);
    const base = await resolveCommit(cwd, input.base);
    const head = await resolveCommit(cwd, input.head);
    if (base === head) throw new Error("Base and head must identify different commits.");

    try {
        await git(cwd, ["merge-base", "--is-ancestor", base, head]);
    } catch {
        throw new Error("Base must be an ancestor of head.");
    }

    const names = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--name-status", "-z", base, head], MAX_NAME_STATUS_CHARS);
    if (names.truncated) {
        throw new Error(`Changed-path metadata exceeds ${MAX_NAME_STATUS_CHARS} characters; review a smaller commit range.`);
    }
    const records = changedPathRecords(names.stdout);
    const { paths, withheld } = reviewablePaths(records, cwd);
    const details: HistoryReviewDetails = {
        base,
        head,
        changedFiles: records.length,
        reviewedFiles: paths.length,
        withheldSensitiveFiles: withheld,
        redactedLines: 0,
        truncated: false,
    };

    if (paths.length === 0) {
        return {
            text: `No reviewable changed files in ${base.slice(0, 12)}..${head.slice(0, 12)}. ${withheld} sensitive or out-of-cwd change record(s) were withheld.`,
            details,
        };
    }

    const patch = await git(cwd, [
        "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3",
        base, head, "--", ...paths,
    ]);
    const redacted = redactDiff(patch.stdout);
    details.redactedLines = redacted.redactedLines;
    details.truncated = patch.truncated;
    const notices = [
        `Review range ${base.slice(0, 12)}..${head.slice(0, 12)} (${paths.length} reviewable file(s)).`,
        withheld ? `${withheld} sensitive or out-of-cwd change record(s) were withheld.` : "",
        redacted.redactedLines ? `${redacted.redactedLines} line(s) were best-effort redacted.` : "",
        patch.truncated ? `Patch output was truncated at ${MAX_DIFF_CHARS} characters.` : "",
    ].filter(Boolean);
    return { text: `${notices.join("\n")}\n\n${redacted.text}`, details };
}
