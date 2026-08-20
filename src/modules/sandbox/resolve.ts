import { type SandboxConfigCwdConfinement, type SandboxConfigPermissions } from "../../common/config";
import {
    getPermissionMatch,
    getArgsPermissionMatch,
    moreRestrictive,
    type Permission,
} from "./permissions";
import { parseBash } from "./bash";
import { getArgsConfinementPermission, splitAtChainOperators } from "./heuristics";

export interface ResolvePermissionOptions {
    permissions?: SandboxConfigPermissions;
    cwdConfinement?: SandboxConfigCwdConfinement | null;
}

type SegmentResult = {
    permission: Permission;
    /** where the permission came from */
    source: "policy" | "heuristic" | "unresolved";
    /** segments covered by neither a rule nor the heuristic */
    unresolved: string[][];
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
}

/**
 * Resolve the effective permission for a command.
 *
 * The command is split into lines (parseBash) and each line into chain
 * segments (&&, ||, ;, |, &). Resolution rules:
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
 *    heuristics resolves to the heuristic permission ("allow:sandbox").
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

    let lines: string[][];
    try {
        lines = parseBash(command);
    } catch {
        return { permission: "ask", unresolved: [] };
    }

    if (lines.length === 0) {
        return {
            permission: getPermissionMatch(command, options?.permissions).permission,
            unresolved: [],
        };
    }

    let policy: Permission | null = null;
    let heuristic: Permission | null = null;
    let hasUnresolved = false;
    const unresolved: string[][] = [];

    for (const line of lines) {
        const result = resolveLine(line, cwd, options);
        unresolved.push(...result.unresolved);

        if (result.source === "policy") {
            policy = policy === null ? result.permission : moreRestrictive(policy, result.permission);
            if (policy === "deny") {
                return { permission: "deny", unresolved };
            }
        } else if (result.source === "heuristic") {
            heuristic = heuristic === null ? result.permission : moreRestrictive(heuristic, result.permission);
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

function resolveLine(
    lineArgs: string[],
    cwd: string,
    options?: ResolvePermissionOptions,
): SegmentResult {
    // 1. whole-line match (chain-aware patterns work here)
    const whole = getArgsPermissionMatch(lineArgs, options?.permissions);
    if (whole.matched) {
        // a matching whole-line rule covers every segment on the line
        return { permission: whole.permission, source: "policy", unresolved: [] };
    }

    // 2. per-segment resolution
    const segments = splitAtChainOperators(lineArgs);

    if (segments.length === 0) {
        return { permission: whole.permission, source: "policy", unresolved: [] };
    }

    let policy: Permission | null = null;
    let heuristic: Permission | null = null;
    let hasUnresolved = false;
    const unresolved: string[][] = [];

    for (const segment of segments) {
        const match = getArgsPermissionMatch(segment, options?.permissions);

        if (match.matched) {
            policy = policy === null ? match.permission : moreRestrictive(policy, match.permission);
            if (policy === "deny") {
                return { permission: "deny", source: "policy", unresolved };
            }
        } else if (match.permission !== "ask") {
            // non-"ask" default ("**") stands as-is
            policy = policy === null ? match.permission : moreRestrictive(policy, match.permission);
            if (policy === "deny") {
                return { permission: "deny", source: "policy", unresolved };
            }
        } else {
            // would prompt: heuristics may rescue the segment
            const grant = getArgsConfinementPermission(segment, cwd, options?.cwdConfinement);
            if (grant) {
                heuristic = heuristic === null ? grant : moreRestrictive(heuristic, grant);
            } else {
                hasUnresolved = true;
                unresolved.push(segment);
            }
        }
    }

    if (hasUnresolved) {
        return { permission: "ask", source: "unresolved", unresolved };
    }

    if (policy !== null) {
        return { permission: policy, source: "policy", unresolved };
    }

    return { permission: heuristic ?? "ask", source: heuristic ? "heuristic" : "unresolved", unresolved };
}
