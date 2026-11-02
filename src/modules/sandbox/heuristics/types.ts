import path from "node:path";

import type { SandboxConfigCwdConfinement } from "../../../common/config";
import type { CommandTag } from "../commands";

/**
 * Capability granted by a successful cwd-confinement heuristic.
 *
 * These are deliberately independent from bash's execution permission. A
 * caller can use them to give an agent only the capabilities it needs.
 */
export enum Heuristic {
    SAFE_READONLY = "SAFE_READONLY",
    SAFE_EDIT = "SAFE_EDIT",
    UNSAFE = "UNSAFE",
}

export type FileAccess = "read" | "write";

/**
 * How read operands are confined.
 *
 * `"cwd"` is the host rule: a read must land inside the working directory (plus declared roots).
 * `"runtime"` says this runtime's own filesystem view *is* the boundary — a container mounts what it
 * mounts — so re-checking reads against the cwd adds nothing. Writes are unaffected either way.
 *
 * Keyed on enforcement, never on a backend name: a rule that granted because the backend is a container
 * would grant under bubblewrap too, where the same path is the host's.
 */
export type ReadConfinement = "cwd" | "runtime";

/** Named options for direct file-path confinement checks. */
export interface PathConfinementOptions {
    cwd: string;
    config?: SandboxConfigCwdConfinement | null;
    access?: FileAccess;
    additionalRoots?: readonly string[];
    sensitiveAdditionalRoots?: readonly string[];
    /** Defaults to `"cwd"`; `"runtime"` skips read confinement, never write confinement. */
    readConfinement?: ReadConfinement;
}

/** Named options for parsed command-string confinement checks. */
export interface CwdConfinementOptions {
    cwd: string;
    config?: SandboxConfigCwdConfinement | null;
    additionalRoots?: readonly string[];
    sensitiveAdditionalRoots?: readonly string[];
    readOnlyAdditionalRoots?: readonly string[];
    customSafeBashCommands?: readonly string[];
    readConfinement?: ReadConfinement;
}

/** Named options for already-parsed command-argument confinement checks. */
export interface ArgsConfinementOptions {
    cwd: string;
    config?: SandboxConfigCwdConfinement | null;
    state?: CwdConfinementState;
    additionalRoots?: readonly string[];
    sensitiveAdditionalRoots?: readonly string[];
    readOnlyAdditionalRoots?: readonly string[];
    customSafeBashCommands?: readonly string[];
    readConfinement?: ReadConfinement;
}

export enum UnsafeReason {
    HEURISTIC_DISABLED = "HEURISTIC_DISABLED",
    EMPTY_INPUT = "EMPTY_INPUT",
    PARSE_ERROR = "PARSE_ERROR",
    UNKNOWN_COMMAND = "UNKNOWN_COMMAND",
    COMMAND_PATH = "COMMAND_PATH",
    COMMAND_NOT_ALLOWED = "COMMAND_NOT_ALLOWED",
    DANGEROUS_ENVIRONMENT = "DANGEROUS_ENVIRONMENT",
    OUTSIDE_CWD = "OUTSIDE_CWD",
    /**
     * A write whose target is inside the working directory but not inside any writable root.
     *
     * Distinct from {@link OUTSIDE_CWD} because it is the truth for `touch ./x": the path is exactly where
     * it appears to be, and what stopped it is that this runtime has no writable root for it — a read-only
     * child, or a command the heuristic only grants under the agent's own scratchpad. An agent told "outside
     * the working directory" about a path in the working directory retries with other paths instead of
     * stopping.
     */
    NOT_IN_WRITABLE_ROOT = "NOT_IN_WRITABLE_ROOT",
    SENSITIVE_PATH = "SENSITIVE_PATH",
    SYMLINK_ESCAPE = "SYMLINK_ESCAPE",
    DYNAMIC_CWD = "DYNAMIC_CWD",
    DYNAMIC_PATH = "DYNAMIC_PATH",
    UNSAFE_FLAG = "UNSAFE_FLAG",
    UNSAFE_SUBCOMMAND = "UNSAFE_SUBCOMMAND",
    UNSAFE_MODE = "UNSAFE_MODE",
    UNSAFE_COMMAND = "UNSAFE_COMMAND",
}

export interface HeuristicAssessment {
    classification: Heuristic;
    reasons: UnsafeReason[];
    /** Semantic tags for parsed command operations, in first-seen order. */
    tags: CommandTag[];
}

const UNSAFE_REASON_DESCRIPTIONS: Record<UnsafeReason, string> = {
    [UnsafeReason.HEURISTIC_DISABLED]: "the cwd-confinement safety heuristic is disabled",
    [UnsafeReason.EMPTY_INPUT]: "the command is empty",
    [UnsafeReason.PARSE_ERROR]: "the shell syntax could not be parsed safely",
    [UnsafeReason.UNKNOWN_COMMAND]: "the command is not in the curated read-only allowlist",
    [UnsafeReason.COMMAND_PATH]:
        "commands must use a trusted command name rather than a filesystem path",
    [UnsafeReason.COMMAND_NOT_ALLOWED]:
        "the command is not enabled by the restricted command policy",
    [UnsafeReason.DANGEROUS_ENVIRONMENT]:
        "an environment assignment could alter command behavior unsafely",
    [UnsafeReason.OUTSIDE_CWD]: "a path is outside the working directory",
    [UnsafeReason.NOT_IN_WRITABLE_ROOT]: "the write target is not inside a writable root",
    [UnsafeReason.SENSITIVE_PATH]: "a path is sensitive",
    [UnsafeReason.SYMLINK_ESCAPE]:
        "a symlink escapes the working directory or cannot be resolved safely",
    [UnsafeReason.DYNAMIC_CWD]: "the working-directory change cannot be modeled safely",
    [UnsafeReason.DYNAMIC_PATH]: "a filesystem path is dynamic or cannot be resolved safely",
    [UnsafeReason.UNSAFE_FLAG]: "an option is not safe for restricted read-only execution",
    [UnsafeReason.UNSAFE_SUBCOMMAND]:
        "the subcommand is not safe for restricted read-only execution",
    [UnsafeReason.UNSAFE_MODE]: "the command mode is not read-only",
    [UnsafeReason.UNSAFE_COMMAND]:
        "the command form is not safe for restricted read-only execution",
};

/** A concise user-facing explanation for a stable unsafe-reason code. */
export function describeUnsafeReason(reason: UnsafeReason): string {
    return UNSAFE_REASON_DESCRIPTIONS[reason];
}

export interface ConfinementDiagnostics {
    reasons: UnsafeReason[];
    tags: CommandTag[];
}

export function addCommandTags(
    diagnostics: ConfinementDiagnostics | undefined,
    tags: readonly CommandTag[],
): void {
    if (diagnostics === undefined) return;
    for (const tag of tags) {
        if (!diagnostics.tags.includes(tag)) diagnostics.tags.push(tag);
    }
}

export function addUnsafeReason(
    diagnostics: ConfinementDiagnostics | undefined,
    reason: UnsafeReason,
): void {
    if (diagnostics !== undefined && !diagnostics.reasons.includes(reason)) {
        diagnostics.reasons.push(reason);
    }
}

export function assessment(
    classification: Heuristic,
    reasons: UnsafeReason[] = [],
    tags: CommandTag[] = [],
): HeuristicAssessment {
    return {
        classification,
        reasons: [...new Set(reasons)],
        tags: [...new Set(tags)],
    };
}

export function isSafeHeuristic(
    heuristic: Heuristic,
): heuristic is Heuristic.SAFE_READONLY | Heuristic.SAFE_EDIT {
    return heuristic === Heuristic.SAFE_READONLY || heuristic === Heuristic.SAFE_EDIT;
}

/** Shell directory state while evaluating one command line. */
export interface CwdConfinementState {
    currentCwd: string;
    previousCwd: string | null;
    directoryStack: string[];
    /** Set when an unsupported state-changing builtin makes cwd uncertain. */
    blocked: boolean;
}

export function createCwdConfinementState(cwd: string): CwdConfinementState {
    return {
        currentCwd: path.resolve(cwd),
        previousCwd: null,
        directoryStack: [],
        blocked: false,
    };
}

export function cloneCwdConfinementState(state: CwdConfinementState): CwdConfinementState {
    return { ...state, directoryStack: [...state.directoryStack] };
}

export function restoreCwdConfinementState(
    target: CwdConfinementState,
    source: CwdConfinementState,
): void {
    target.currentCwd = source.currentCwd;
    target.previousCwd = source.previousCwd;
    target.directoryStack = [...source.directoryStack];
    target.blocked = source.blocked;
}
