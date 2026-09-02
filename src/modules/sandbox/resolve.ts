import {
    type SandboxConfigCwdConfinement,
    type SandboxConfigPermissions,
} from "../../common/config";
import {
    getBashCommandPermissionMatch,
    getBashStatementPermissionMatch,
    getPermissionMatch,
    moreRestrictive,
    type Permission,
} from "./permissions";
import { parseBashAst } from "./bash";
import type { BashAst, BashCommand, BashStatement } from "./bash";
import { unwrapWrapperCommand } from "./command-wrappers";
import {
    cloneCwdConfinementState,
    createCwdConfinementState,
    getBashCommandConfinementPermission,
    getConfiguredCwdConfinementPermission,
    isSafeHeuristic,
    isNonPersistentChainOperator,
    restoreCwdConfinementState,
} from "./heuristics";

export interface ResolvePermissionOptions {
    permissions?: SandboxConfigPermissions;
    cwdConfinement?: SandboxConfigCwdConfinement | null;
    /** Runtime-managed roots treated as additional cwd-confinement roots. */
    additionalRoots?: readonly string[];
    /** Additional roots that may be read but never written by heuristic-safe commands. */
    readOnlyAdditionalRoots?: readonly string[];
    /** Additional roots whose sensitive path names are explicitly trusted. */
    sensitiveAdditionalRoots?: readonly string[];
    /** Exact command patterns that extend the safe-Bash heuristic. */
    safeBashCommands?: readonly string[];
}

/** Where a single chain segment's permission came from. */
export type SegmentSource = "policy" | "heuristic" | "unresolved";

/** A single chain command with the reason it was allowed, denied, or left to prompt. */
export interface BashDecisionSegment {
    /**
     * Unwrapped token view — the same transform the classifier, the matcher,
     * and the rule suggestions use, so a logged segment and a suggested rule
     * always name the command that actually runs.
     */
    tokens: string[];
    source: SegmentSource;
    /** resolved permission; absent for segments that still require a prompt */
    permission?: Permission;
    /** configured rule that matched, when {@link source} is `"policy"` */
    pattern: string | null;
    /** for a `"policy"` segment: whether the matched rule covered it alone or the whole chained line */
    coveredBy: "segment" | "whole-line" | null;
}

type SegmentResolution =
    | {
          kind: "policy";
          tokens: string[];
          permission: Permission;
          pattern: string | null;
          coveredBy: "segment" | "whole-line";
      }
    | { kind: "heuristic"; tokens: string[]; permission: Permission }
    | { kind: "unresolved"; tokens: string[] };

type LineOutcome = {
    permission: Permission;
    /** where the line's permission came from */
    source: SegmentSource;
    /** rule that decided the line, when a configured rule matched it */
    pattern: string | null;
    /** per-segment breakdown, including whole-line coverage */
    segments: BashDecisionSegment[];
    /** the line resolved to an explicit deny, which dominates the command */
    denied: boolean;
};

export interface ResolvePermissionDetails {
    permission: Permission;
    /**
     * Segments (tokenized) covered by neither a rule nor the heuristic.
     * Non-empty exactly when the "ask" result is due to uncovered
     * segments — an explicit "ask" rule (or "**" default) yields "ask"
     * with an empty list, as do all non-ask results.
     */
    unresolved: string[][];
    /**
     * Which source decided the combined result. `"policy"` also covers results
     * that came from the `"**"` default rather than an explicit rule — check
     * {@link pattern}, which is `null` in that case. `"unresolved"` means at
     * least one segment was covered by nothing (or the line could not be
     * parsed at all), which forces `"ask"`.
     */
    source: SegmentSource;
    /** configured rule that decided the result, `null` when no explicit rule matched */
    pattern: string | null;
    /**
     * Per chain-command breakdown. Empty only for the whole-command fallbacks
     * (empty input, unparsable input, and a line with no chain commands), where
     * segment-level analysis never ran.
     */
    segments: BashDecisionSegment[];
}

/**
 * Details for a resolution that could not be attempted (unparsable input or a
 * classifier failure). It forces a prompt and carries no segment breakdown.
 */
export function unresolvedPermissionDetails(): ResolvePermissionDetails {
    return {
        permission: "ask",
        unresolved: [],
        source: "unresolved",
        pattern: null,
        segments: [],
    };
}

/**
 * Resolve the effective permission for a command.
 *
 * The command is split into AST statements and each statement into chain
 * commands (&&, ||, ;, |, |&, &). Resolution rules:
 *
 * 1. A permission pattern matching a whole line (chain operators included)
 *    wins for that line.
 * 2. Otherwise each segment resolves independently: explicit pattern match,
 *    then the non-"ask" default ("**"), then — only when the segment would
 *    prompt — heuristics.
 * 3. Combination: "deny" dominates; then unresolved segments force "ask";
 *    then explicit/default ("policy") results combine most-restrictive.
 *    Heuristic grants only rescue segments that would prompt — they never
 *    downgrade policy results, so `cd /project && npx vitest | tail -5` with
 *    `"npx *": "allow"` resolves to "allow". A chain covered *only* by
 *    heuristics resolves to the configured heuristic permission.
 *
 * The returned details additionally record which source decided each segment
 * and which rule matched, so callers can explain or log a decision without
 * reparsing the command.
 */
export function resolvePermissionDetails(
    command: string,
    cwd: string,
    options?: ResolvePermissionOptions,
): ResolvePermissionDetails {
    // empty command and unparsable input keep the whole-command behavior
    if (command.trim() === "") {
        return policyDetails(getPermissionMatch(command, options?.permissions));
    }

    let parsed: BashAst;
    try {
        parsed = parseBashAst(command);
    } catch {
        return unresolvedPermissionDetails();
    }

    if (parsed.statements.length === 0) {
        return policyDetails(getPermissionMatch(command, options?.permissions));
    }

    const segments: BashDecisionSegment[] = [];
    let policy: PolicyOutcome | null = null;
    let heuristic: Permission | null = null;

    for (const statement of parsed.statements) {
        const outcome = resolveLine(statement, cwd, options);
        segments.push(...outcome.segments);

        if (outcome.denied) {
            return buildDetails("deny", outcome.pattern, "policy", segments);
        }

        if (outcome.source === "policy") {
            policy = combinePolicy(policy, outcome.permission, outcome.pattern);
        } else if (outcome.source === "heuristic") {
            heuristic =
                heuristic === null
                    ? outcome.permission
                    : moreRestrictive(heuristic, outcome.permission);
        }
    }

    const unresolved = unresolvedTokens(segments);
    if (unresolved.length > 0) {
        return buildDetails("ask", null, "unresolved", segments);
    }

    if (policy !== null) {
        return buildDetails(policy.permission, policy.pattern, "policy", segments);
    }

    if (heuristic !== null) {
        return buildDetails(heuristic, null, "heuristic", segments);
    }

    return buildDetails("ask", null, "unresolved", segments);
}

export default function resolvePermission(
    command: string,
    cwd: string,
    options?: ResolvePermissionOptions,
): Permission {
    return resolvePermissionDetails(command, cwd, options).permission;
}

type PolicyOutcome = { permission: Permission; pattern: string | null };

/** Combine line-level policy results, keeping the pattern that decided the outcome. */
function combinePolicy(
    current: PolicyOutcome | null,
    permission: Permission,
    pattern: string | null,
): PolicyOutcome {
    if (current === null) {
        return { permission, pattern };
    }

    const combined = moreRestrictive(current.permission, permission);
    if (combined !== current.permission) {
        return { permission: combined, pattern };
    }

    return { permission: combined, pattern: current.pattern ?? pattern };
}

function unresolvedTokens(segments: readonly BashDecisionSegment[]): string[][] {
    return segments
        .filter((segment) => segment.source === "unresolved")
        .map((segment) => segment.tokens);
}

function buildDetails(
    permission: Permission,
    pattern: string | null,
    source: SegmentSource,
    segments: readonly BashDecisionSegment[],
): ResolvePermissionDetails {
    return {
        permission,
        unresolved: unresolvedTokens(segments),
        source,
        pattern,
        segments: [...segments],
    };
}

/** Details for a result decided without segment analysis (empty or unstructured input). */
function policyDetails(match: {
    permission: Permission;
    pattern: string | null;
}): ResolvePermissionDetails {
    return {
        permission: match.permission,
        unresolved: [],
        source: "policy",
        pattern: match.pattern,
        segments: [],
    };
}

function lineOutcome(
    permission: Permission,
    source: SegmentSource,
    pattern: string | null,
    segments: BashDecisionSegment[],
): LineOutcome {
    return {
        permission,
        source,
        pattern,
        segments,
        denied: permission === "deny",
    };
}

function getOperatorAfter(statement: BashStatement, command: BashCommand): string | null {
    const partIndex = statement.node.parts.findIndex(
        (part) => part.type === "command" && part === command.node,
    );
    const nextPart = statement.node.parts[partIndex + 1];
    return nextPart?.type === "operator" ? nextPart.value : null;
}

function resolveSegment(
    command: BashCommand,
    cwd: string,
    options: ResolvePermissionOptions | undefined,
    state: ReturnType<typeof createCwdConfinementState>,
): SegmentResolution {
    const tokens = decisionTokens(command);
    // Advance modeled shell-directory state even when an explicit policy
    // handles this segment; later heuristic segments still need the correct
    // current directory.
    const grant = getBashCommandConfinementPermission(command, {
        cwd,
        config: options?.cwdConfinement,
        state,
        additionalRoots: options?.additionalRoots,
        sensitiveAdditionalRoots: options?.sensitiveAdditionalRoots,
        readOnlyAdditionalRoots: options?.readOnlyAdditionalRoots,
        customSafeBashCommands: options?.safeBashCommands,
    });
    const match = getBashCommandPermissionMatch(command, options?.permissions);

    if (match.matched || match.permission !== "ask") {
        return {
            kind: "policy",
            tokens,
            permission: match.permission,
            pattern: match.pattern,
            coveredBy: "segment",
        };
    }
    if (!isSafeHeuristic(grant)) {
        return { kind: "unresolved", tokens };
    }

    return {
        kind: "heuristic",
        tokens,
        permission: getConfiguredCwdConfinementPermission(options?.cwdConfinement),
    };
}

/**
 * Tokens recorded for a segment, and used to suggest a session rule for an uncovered one.
 *
 * A transparent wrapper is unwrapped through the same command-node transform the classifier and the
 * matcher use, so the suggested rule names the command that actually runs and the remembered rule
 * matches the wrapped form. A `timeout *` suggestion would silently authorize any command under a
 * timeout, so it is never offered.
 */
function decisionTokens(command: BashCommand): string[] {
    const wrappedCommand = unwrapWrapperCommand(command);
    return wrappedCommand ? wrappedCommand.toTokens() : command.toTokens();
}

function resolveLine(
    statement: BashStatement,
    cwd: string,
    options?: ResolvePermissionOptions,
): LineOutcome {
    // 1. whole-line match (chain-aware patterns work here)
    const whole = getBashStatementPermissionMatch(statement, options?.permissions);
    if (whole.matched) {
        // a matching whole-line rule covers every segment on the line
        return lineOutcome(
            whole.permission,
            "policy",
            whole.pattern,
            wholeLineSegments(statement, whole),
        );
    }

    // 2. per-segment resolution
    if (statement.commands.length === 0) {
        return lineOutcome(whole.permission, "policy", whole.pattern, []);
    }

    let policy: PolicyOutcome | null = null;
    let heuristic: Permission | null = null;
    let denied = false;
    const segments: BashDecisionSegment[] = [];
    const confinementState = createCwdConfinementState(cwd);
    let nonPersistentBase: ReturnType<typeof cloneCwdConfinementState> | null = null;

    for (const segmentCommand of statement.commands) {
        const operatorAfter = getOperatorAfter(statement, segmentCommand);
        const beforeSegment = cloneCwdConfinementState(confinementState);
        if (nonPersistentBase === null && isNonPersistentChainOperator(operatorAfter)) {
            nonPersistentBase = beforeSegment;
        }
        const segmentState = nonPersistentBase
            ? cloneCwdConfinementState(nonPersistentBase)
            : confinementState;
        const resolution = resolveSegment(segmentCommand, cwd, options, segmentState);
        segments.push(segmentFromResolution(resolution));

        if (resolution.kind === "policy") {
            policy = combinePolicy(policy, resolution.permission, resolution.pattern);
            if (policy.permission === "deny") {
                denied = true;
            }
        }

        if (nonPersistentBase !== null) {
            restoreCwdConfinementState(confinementState, nonPersistentBase);
            if (!isNonPersistentChainOperator(operatorAfter)) {
                nonPersistentBase = null;
            }
        }

        if (denied) {
            break;
        }

        if (resolution.kind === "heuristic") {
            heuristic =
                heuristic === null
                    ? resolution.permission
                    : moreRestrictive(heuristic, resolution.permission);
        }
    }

    if (denied) {
        return lineOutcome("deny", "policy", policy?.pattern ?? null, segments);
    }

    const hasUnresolved = segments.some((segment) => segment.source === "unresolved");
    if (hasUnresolved) {
        return lineOutcome("ask", "unresolved", null, segments);
    }

    if (policy !== null) {
        return lineOutcome(policy.permission, "policy", policy.pattern, segments);
    }

    if (heuristic !== null) {
        return lineOutcome(heuristic, "heuristic", null, segments);
    }

    return lineOutcome("ask", "unresolved", null, segments);
}

function segmentFromResolution(resolution: SegmentResolution): BashDecisionSegment {
    if (resolution.kind === "policy") {
        return {
            tokens: resolution.tokens,
            source: "policy",
            permission: resolution.permission,
            pattern: resolution.pattern,
            coveredBy: resolution.coveredBy,
        };
    }
    if (resolution.kind === "heuristic") {
        return {
            tokens: resolution.tokens,
            source: "heuristic",
            permission: resolution.permission,
            pattern: null,
            coveredBy: null,
        };
    }

    return {
        tokens: resolution.tokens,
        source: "unresolved",
        pattern: null,
        coveredBy: null,
    };
}

function wholeLineSegments(
    statement: BashStatement,
    whole: { permission: Permission; pattern: string | null },
): BashDecisionSegment[] {
    return statement.commands.map((command) => ({
        tokens: decisionTokens(command),
        source: "policy" as const,
        permission: whole.permission,
        pattern: whole.pattern,
        coveredBy: "whole-line" as const,
    }));
}
