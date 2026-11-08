/**
 * The automatic memory audit.
 *
 * An agent no longer has to remember to run the audit: a step that changed a memory file is audited, and a
 * finding becomes a held reminder the agent reads in the run that caused it. The check is keyed on a stat
 * fingerprint of both trees rather than on the tool calls, because a memory can be written by `edit`, by
 * `write`, by a bash heredoc, or by a nested doc added beside an index - the filesystem is the only place all
 * of those agree.
 *
 * The fingerprint covers top-level indexes *and* nested docs. Top level is where a parse failure hides a
 * memory from every later prompt, but a nested-only edit is what breaks an index link, and a stat per file
 * costs the same either way.
 *
 * Parsing is the expensive half, so it only happens when the fingerprint moved, and it is kept per tree: a
 * project edit is not evidence about the user tree, so pre-existing user warnings must not ride along with it.
 * The audit itself reads both trees, because a reference crosses them, and the findings are then filtered to
 * the tree that actually moved.
 *
 * A finding is announced once, and deduped on its identity - the file and the rule - not on its message: a
 * repair that takes several steps must not be reminded on each of them, and a failed attempt that only changes
 * the YAML error text is still the same defect. What the session has been told is pruned to what is still
 * outstanding on every audit, so a fixed finding is news again if it comes back.
 */
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import {
    memoryAuditDirectories,
    runMemoryAudit,
    type AuditFinding,
    type AuditResult,
    type MemoryAuditDirectories,
} from "../memory/audit";

/** How many findings one reminder carries; the rest are pointed at the tool. */
export const MAX_REMINDER_FINDINGS = 10;

/** One finding with the tree it came from, because `path` alone is ambiguous across the two trees. */
export interface LabeledFinding extends AuditFinding {
    tree: "project" | "user";
}

/** One stat fingerprint per tree: they are compared separately so each tree answers for its own changes. */
interface MemoryTreeStamps {
    project: string;
    user: string;
}

export interface MemoryAuditTrigger {
    /**
     * Take a new baseline without auditing.
     *
     * Called at every restart point: what was already on disk when the session began is not something this
     * run introduced, and reporting it would make every session open with the same findings.
     */
    reseed(cwd: string): Promise<void>;
    /** Audit if the trees moved since the last look; the findings block, or `undefined` for nothing to say. */
    check(cwd: string): Promise<string | undefined>;
}

export interface MemoryAuditTriggerOptions {
    /** Off disables the automatic check without touching the `memory_audit` tool. */
    enabled?: boolean;
    /** Diagnostic reads, so a test can drive the trigger without a filesystem. */
    audit?: (cwd: string) => Promise<AuditResult[]>;
    fingerprint?: (dirs: MemoryAuditDirectories) => Promise<MemoryTreeStamps>;
}

function isNotFound(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** One tree's `.md` files as `rel:size:mtime`, sorted, so the joined value depends on content and not order. */
async function treeStamps(dir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(dir, { recursive: true, withFileTypes: true });
    } catch (error) {
        if (isNotFound(error)) {
            return ["<absent>"];
        }

        throw error;
    }

    const stamps: string[] = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) {
            continue;
        }

        const abs = join(entry.parentPath ?? dir, entry.name);
        try {
            const info = await stat(abs);
            stamps.push(`${relative(dir, abs).split("\\").join("/")}:${info.size}:${info.mtimeMs}`);
        } catch (error) {
            // Removed between the readdir and the stat: the next check sees the settled tree.
            if (!isNotFound(error)) {
                throw error;
            }
        }
    }

    return stamps.sort();
}

/** A cheap fingerprint of both memory trees: paths, sizes, and mtimes, with no parse. */
async function memoryTreeFingerprint(dirs: MemoryAuditDirectories): Promise<MemoryTreeStamps> {
    const [project, user] = await Promise.all([
        treeStamps(dirs.projectDir),
        treeStamps(dirs.userDir),
    ]);

    return {
        project: `${dirs.projectDir}\n${project.join("\n")}`,
        user: `${dirs.userDir}\n${user.join("\n")}`,
    };
}

/** The trees whose fingerprint moved, in a stable order. */
function movedTrees(before: MemoryTreeStamps, after: MemoryTreeStamps): Array<"project" | "user"> {
    const moved: Array<"project" | "user"> = [];
    for (const tree of ["project", "user"] as const) {
        if (before[tree] !== after[tree]) {
            moved.push(tree);
        }
    }

    return moved;
}

function collectFindings(
    results: readonly AuditResult[],
    only: readonly ("project" | "user")[],
): LabeledFinding[] {
    const findings: LabeledFinding[] = [];
    for (const result of results) {
        if (!only.includes(result.label)) {
            continue;
        }

        for (const finding of result.findings) {
            findings.push({ ...finding, tree: result.label });
        }
    }

    // Errors first: a memory that failed to parse is missing from every later prompt, a warning may be
    // deliberate.
    return findings.toSorted((left, right) => {
        if (left.severity !== right.severity) {
            return left.severity === "error" ? -1 : 1;
        }

        return `${left.tree}/${left.path}`.localeCompare(`${right.tree}/${right.path}`);
    });
}

function identityOf(finding: LabeledFinding): string {
    // What makes a finding a finding: the file and the rule it broke. The message is deliberately left out -
    // a failed repair that changes the YAML error text is the same defect, and the agent that was already told
    // about this file and rule should not be told again on every attempt.
    return `${finding.tree} ${finding.path} ${finding.rule}`;
}

/**
 * The findings block a reminder carries: counts for the new findings, the first
 * {@link MAX_REMINDER_FINDINGS} of them, and a line for what was reported before and still stands.
 *
 * `outstanding` is what keeps the reminder honest without repeating itself: the lines are only the findings
 * this report is the first to mention, and the count says how much of the earlier report is still open.
 */
export function formatMemoryAuditFindings(
    findings: readonly LabeledFinding[],
    outstanding = 0,
): string {
    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.length - errors;
    const counts: string[] = [];
    if (errors > 0) {
        counts.push(`${errors} new ${errors === 1 ? "error" : "errors"}`);
    }
    if (warnings > 0) {
        counts.push(`${warnings} new ${warnings === 1 ? "warning" : "warnings"}`);
    }

    const head = `${counts.join(", ")} after the memory edits in this run:`;

    const lines = findings.slice(0, MAX_REMINDER_FINDINGS).map((finding) => {
        const marker = finding.severity === "error" ? "ERROR" : "warn ";
        return `${marker} ${finding.tree}/${finding.path} [${finding.rule}] ${finding.message}`;
    });

    const hidden = findings.length - lines.length;
    if (hidden > 0) {
        lines.push(
            `…and ${hidden} more ${hidden === 1 ? "finding" : "findings"}; call the memory_audit tool for the full report.`,
        );
    }

    if (outstanding > 0) {
        lines.push(
            `…and ${outstanding} previously reported ${outstanding === 1 ? "finding is" : "findings are"} still present; this reminder repeats none of them.`,
        );
    }

    return [head, ...lines].join("\n");
}

export function createMemoryAuditTrigger(
    options: MemoryAuditTriggerOptions = {},
): MemoryAuditTrigger {
    const enabled = options.enabled !== false;
    const audit = options.audit ?? ((cwd: string) => runMemoryAudit(cwd, "both"));
    const fingerprint = options.fingerprint ?? memoryTreeFingerprint;

    /** Bumped by every reseed, so a late read from the previous session cannot install its own baseline. */
    let generation = 0;
    let baseline: MemoryTreeStamps | undefined;
    /**
     * The findings the session has already been told about, as {@link identityOf} keys.
     *
     * Replaced by what is currently outstanding on every audit, not accumulated: a finding that was fixed is
     * pruned, so breaking the same file and rule again later is news a second time. What it prevents is the
     * repeat that matters - a memory that stays broken across a multi-step repair, whose finding must not be
     * announced on every turn of it.
     */
    let reported = new Set<string>();

    const reseed = async (cwd: string): Promise<void> => {
        const at = ++generation;
        const stamps = await fingerprint(memoryAuditDirectories(cwd));

        if (at !== generation) {
            return;
        }

        baseline = stamps;
        reported = new Set<string>();
    };

    const check = async (cwd: string): Promise<string | undefined> => {
        if (!enabled) {
            return undefined;
        }

        const at = generation;

        let stamps: MemoryTreeStamps;
        try {
            stamps = await fingerprint(memoryAuditDirectories(cwd));
        } catch {
            // A tree that cannot be read is not worth failing a step over: the next check retries.
            return undefined;
        }

        if (at !== generation) {
            return undefined;
        }

        if (baseline === undefined) {
            baseline = stamps;
            return undefined;
        }

        const moved = movedTrees(baseline, stamps);
        if (moved.length === 0) {
            return undefined;
        }

        baseline = stamps;

        let results: AuditResult[];
        try {
            results = await audit(cwd);
        } catch {
            return undefined;
        }

        if (at !== generation) {
            return undefined;
        }

        // Read both trees, report only the ones that moved: the audit needs them together for cross-tree
        // references, but a project edit says nothing about warnings the user tree has carried for weeks.
        const findings = collectFindings(results, moved);

        // Prune what the edit fixed and remember what still stands. The reminder carries only the findings this
        // audit is the first to see; the outstanding count keeps the earlier ones visible without restating
        // them, which is what stops a repair that takes several steps from being told on each of them.
        const previous = reported;
        reported = new Set(findings.map(identityOf));

        const fresh = findings.filter((finding) => !previous.has(identityOf(finding)));
        if (fresh.length === 0) {
            return undefined;
        }

        return formatMemoryAuditFindings(fresh, reported.size - fresh.length);
    };

    return { reseed, check };
}
