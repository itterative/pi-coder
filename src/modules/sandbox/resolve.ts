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

type SegmentResult = {
    permission: Permission;
    /** where the permission came from */
    source: "policy" | "heuristic" | "unresolved";
    /** segments covered by neither a rule nor the heuristic */
    unresolved: string[][];
};

type SegmentResolution =
    | { permission: Permission; source: "policy" }
    | { permission: Permission; source: "heuristic" }
    | { source: "unresolved"; tokens: string[] };

export interface ResolvePermissionDetails {
    permission: Permission;
    /**
     * Segments (tokenized) covered by neither a rule nor the heuristic.
     * Non-empty exactly when the "ask" result is due to uncovered
     * segments — an explicit "ask" rule (or "**" default) yields "ask"
     * with an empty list, as do all non-ask results.
     */
    unresolved: string[][];
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
 */
export function resolvePermissionDetails(
    command: string,
    cwd: string,
    options?: ResolvePermissionOptions,
): ResolvePermissionDetails {
    // empty command and unparsable input keep the whole-command behavior
    if (command === "" || command.trim() === "") {
        return {
            permission: getPermissionMatch(command, options?.permissions).permission,
            unresolved: [],
        };
    }

    let parsed: BashAst;
    try {
        parsed = parseBashAst(command);
    } catch {
        return { permission: "ask", unresolved: [] };
    }

    if (parsed.statements.length === 0) {
        return {
            permission: getPermissionMatch(command, options?.permissions).permission,
            unresolved: [],
        };
    }

    let policy: Permission | null = null;
    let heuristic: Permission | null = null;
    let hasUnresolved = false;
    const unresolved: string[][] = [];

    for (const statement of parsed.statements) {
        const result = resolveLine(statement, cwd, options);
        unresolved.push(...result.unresolved);

        if (result.source === "policy") {
            policy =
                policy === null ? result.permission : moreRestrictive(policy, result.permission);
            if (policy === "deny") {
                return { permission: "deny", unresolved };
            }
        } else if (result.source === "heuristic") {
            heuristic =
                heuristic === null
                    ? result.permission
                    : moreRestrictive(heuristic, result.permission);
        } else {
            hasUnresolved = true;
        }
    }

    if (hasUnresolved) {
        return { permission: "ask", unresolved };
    }

    if (policy !== null) {
        return { permission: policy, unresolved };
    }

    return { permission: heuristic ?? "ask", unresolved };
}

export default function resolvePermission(
    command: string,
    cwd: string,
    options?: ResolvePermissionOptions,
): Permission {
    return resolvePermissionDetails(command, cwd, options).permission;
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
        return { permission: match.permission, source: "policy" };
    }
    if (!isSafeHeuristic(grant)) {
        return { source: "unresolved", tokens: command.toTokens() };
    }
    return {
        permission: getConfiguredCwdConfinementPermission(options?.cwdConfinement),
        source: "heuristic",
    };
}

function resolveLine(
    statement: BashStatement,
    cwd: string,
    options?: ResolvePermissionOptions,
): SegmentResult {
    // 1. whole-line match (chain-aware patterns work here)
    const whole = getBashStatementPermissionMatch(statement, options?.permissions);
    if (whole.matched) {
        // a matching whole-line rule covers every segment on the line
        return { permission: whole.permission, source: "policy", unresolved: [] };
    }

    // 2. per-segment resolution
    if (statement.commands.length === 0) {
        return { permission: whole.permission, source: "policy", unresolved: [] };
    }
    let policy: Permission | null = null;
    let heuristic: Permission | null = null;
    let hasUnresolved = false;
    const unresolved: string[][] = [];
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

        if (resolution.source === "policy") {
            policy =
                policy === null
                    ? resolution.permission
                    : moreRestrictive(policy, resolution.permission);
            if (policy === "deny") {
                return { permission: "deny", source: "policy", unresolved };
            }
        }

        if (nonPersistentBase !== null) {
            restoreCwdConfinementState(confinementState, nonPersistentBase);
            if (!isNonPersistentChainOperator(operatorAfter)) {
                nonPersistentBase = null;
            }
        }

        if (resolution.source === "heuristic") {
            heuristic =
                heuristic === null
                    ? resolution.permission
                    : moreRestrictive(heuristic, resolution.permission);
        } else if (resolution.source === "unresolved") {
            hasUnresolved = true;
            unresolved.push(resolution.tokens);
        }
    }

    if (hasUnresolved) {
        return { permission: "ask", source: "unresolved", unresolved };
    }

    if (policy !== null) {
        return { permission: policy, source: "policy", unresolved };
    }

    return {
        permission: heuristic ?? "ask",
        source: heuristic ? "heuristic" : "unresolved",
        unresolved,
    };
}
