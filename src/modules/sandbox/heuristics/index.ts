import os from "node:os";
import path from "node:path";

import sandboxConfig, { type SandboxConfigCwdConfinement } from "../../../common/config";
import { type Permission } from "../permissions";
import {
    Heuristic, UnsafeReason, HeuristicAssessment,
    assessment, isSafeHeuristic, createCwdConfinementState,
    type FileAccess, type CwdConfinementState, type ConfinementDiagnostics,
} from "./types";
import {
    buildConfinementOptions, isAllowedPath, isSensitivePath, isRealPathConfined,
    hasSymlinkComponent, resolvePath,
} from "./path-policy";
import { isCommandConfined, isConfined } from "./evaluator";

export { Heuristic, UnsafeReason, describeUnsafeReason, isSafeHeuristic,
    createCwdConfinementState, cloneCwdConfinementState, restoreCwdConfinementState } from "./types";
export type { FileAccess, HeuristicAssessment, CwdConfinementState } from "./types";
export { ChainSegment, splitAtChainOperatorsWithOperators, splitAtChainOperators, isNonPersistentChainOperator } from "./evaluator";
export { isPathWithinDirectory } from "./path-policy";
export { CommandTag, KNOWN_COMMANDS } from "../commands";
export type { CommandSpec, FlagSpec } from "../commands";

function resolveConfinementConfig(
    config?: SandboxConfigCwdConfinement | null,
): SandboxConfigCwdConfinement | undefined {
    return config === undefined
        ? sandboxConfig.current?.heuristics?.cwdConfinement
        : (config ?? undefined);
}

/** Return the configured execution permission for a successful heuristic. */
export function getConfiguredCwdConfinementPermission(
    config?: SandboxConfigCwdConfinement | null,
): Permission {
    return resolveConfinementConfig(config)?.permission ?? "allow:sandbox";
}

/**
 * Cwd-confinement heuristic for a direct file-tool access. A path is granted
 * only when it is inside cwd or an additional managed root and does not touch
 * a sensitive segment outside an additional root. The symlink check also
 * handles nonexistent write targets. Read access returns
 * SAFE_READONLY; write access returns SAFE_EDIT. Rejected accesses return
 * UNSAFE so callers can distinguish them from a successful classification.
 */
export function getPathConfinementPermission(
    filePath: string,
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
    access: FileAccess = "read",
    additionalRoots: readonly string[] = [],
    sensitiveAdditionalRoots?: readonly string[],
): Heuristic {
    const confinement = resolveConfinementConfig(config);

    if (confinement?.enabled === false || filePath.trim() === "") {
        return Heuristic.UNSAFE;
    }

    const resolvedCwd = path.resolve(cwd);
    const home = os.homedir();
    const options = buildConfinementOptions(
        confinement,
        resolvedCwd,
        additionalRoots,
        sensitiveAdditionalRoots,
    );

    if (!isAllowedPath(filePath, resolvedCwd, home, options, resolvedCwd)) {
        return Heuristic.UNSAFE;
    }

    if (isSensitivePath(filePath, resolvedCwd, home, options)) {
        return Heuristic.UNSAFE;
    }

    if ((confinement?.resolveSymlinks ?? true) &&
        !isRealPathConfined(filePath, resolvedCwd, home, options)) {
        return Heuristic.UNSAFE;
    }

    return access === "write" ? Heuristic.SAFE_EDIT : Heuristic.SAFE_READONLY;
}

export function getPathConfinementAssessment(
    filePath: string,
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
    access: FileAccess = "read",
    additionalRoots: readonly string[] = [],
    sensitiveAdditionalRoots?: readonly string[],
): HeuristicAssessment {
    const classification = getPathConfinementPermission(
        filePath,
        cwd,
        config,
        access,
        additionalRoots,
        sensitiveAdditionalRoots,
    );
    if (isSafeHeuristic(classification)) return assessment(classification);

    const confinement = resolveConfinementConfig(config);
    if (confinement?.enabled === false || filePath.trim() === "") {
        return assessment(Heuristic.UNSAFE, [
            confinement?.enabled === false
                ? UnsafeReason.HEURISTIC_DISABLED
                : UnsafeReason.EMPTY_INPUT,
        ]);
    }

    const resolvedCwd = path.resolve(cwd);
    const home = os.homedir();
    const options = buildConfinementOptions(
        confinement,
        resolvedCwd,
        additionalRoots,
        sensitiveAdditionalRoots,
    );
    if (isSensitivePath(filePath, resolvedCwd, home, options)) {
        return assessment(Heuristic.UNSAFE, [UnsafeReason.SENSITIVE_PATH]);
    }
    if (!isAllowedPath(filePath, resolvedCwd, home, options, resolvedCwd)) {
        if (
            (confinement?.resolveSymlinks ?? true)
            && hasSymlinkComponent(resolvePath(filePath, resolvedCwd, home))
        ) {
            return assessment(Heuristic.UNSAFE, [UnsafeReason.SYMLINK_ESCAPE]);
        }
        return assessment(Heuristic.UNSAFE, [UnsafeReason.OUTSIDE_CWD]);
    }
    return assessment(Heuristic.UNSAFE, [UnsafeReason.SYMLINK_ESCAPE]);
}

/**
 * Cwd-confinement heuristic: known, safe commands whose file accesses all
 * resolve inside the working directory or an additional managed root are
 * classified by capability.
 *
 * Returns UNSAFE for unknown commands, paths outside the working directory,
 * or unclassifiable usage. Callers should fall back to the permission system.
 */
export function getCwdConfinementAssessment(
    command: string,
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
    additionalRoots: readonly string[] = [],
    sensitiveAdditionalRoots?: readonly string[],
    readOnlyAdditionalRoots: readonly string[] = [],
    customSafeBashCommands: readonly string[] = [],
): HeuristicAssessment {
    const confinement = resolveConfinementConfig(config);

    if (confinement?.enabled === false) {
        return assessment(Heuristic.UNSAFE, [UnsafeReason.HEURISTIC_DISABLED]);
    }

    if (command.trim() === "") {
        return assessment(Heuristic.UNSAFE, [UnsafeReason.EMPTY_INPUT]);
    }

    const diagnostics: ConfinementDiagnostics = { reasons: [], tags: [] };
    const resolvedCwd = path.resolve(cwd);
    const classification = isConfined(
        command,
        resolvedCwd,
        buildConfinementOptions(
            confinement,
            resolvedCwd,
            additionalRoots,
            sensitiveAdditionalRoots,
            readOnlyAdditionalRoots,
            customSafeBashCommands,
        ),
        diagnostics,
    ) ?? Heuristic.UNSAFE;
    if (isSafeHeuristic(classification)) return assessment(classification, [], diagnostics.tags);

    return assessment(
        Heuristic.UNSAFE,
        diagnostics.reasons.length > 0
            ? diagnostics.reasons
            : [UnsafeReason.UNSAFE_COMMAND],
        diagnostics.tags,
    );
}

export function getCwdConfinementPermission(
    command: string,
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
    additionalRoots: readonly string[] = [],
    sensitiveAdditionalRoots?: readonly string[],
    readOnlyAdditionalRoots: readonly string[] = [],
    customSafeBashCommands: readonly string[] = [],
): Heuristic {
    return getCwdConfinementAssessment(
        command,
        cwd,
        config,
        additionalRoots,
        sensitiveAdditionalRoots,
        readOnlyAdditionalRoots,
        customSafeBashCommands,
    ).classification;
}

/**
 * Segment-level variant of the cwd-confinement heuristic: evaluates a single
 * already-parsed command (list of arguments, no chain operators).
 *
 * Returns UNSAFE when the heuristic does not apply.
 */
export function getArgsConfinementAssessment(
    args: string[],
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
    state?: CwdConfinementState,
    additionalRoots: readonly string[] = [],
    sensitiveAdditionalRoots?: readonly string[],
    readOnlyAdditionalRoots: readonly string[] = [],
    customSafeBashCommands: readonly string[] = [],
): HeuristicAssessment {
    const confinement = resolveConfinementConfig(config);

    if (confinement?.enabled === false) {
        return assessment(Heuristic.UNSAFE, [UnsafeReason.HEURISTIC_DISABLED]);
    }
    if (args.length === 0) {
        return assessment(Heuristic.UNSAFE, [UnsafeReason.EMPTY_INPUT]);
    }

    const diagnostics: ConfinementDiagnostics = { reasons: [], tags: [] };
    const resolvedCwd = path.resolve(cwd);
    const confinementState = state ?? createCwdConfinementState(resolvedCwd);
    const classification = isCommandConfined(
        args,
        confinementState.currentCwd,
        resolvedCwd,
        buildConfinementOptions(
            confinement,
            resolvedCwd,
            additionalRoots,
            sensitiveAdditionalRoots,
            readOnlyAdditionalRoots,
            customSafeBashCommands,
        ),
        confinementState,
        diagnostics,
    ) ?? Heuristic.UNSAFE;
    if (isSafeHeuristic(classification)) return assessment(classification, [], diagnostics.tags);

    return assessment(
        Heuristic.UNSAFE,
        diagnostics.reasons.length > 0
            ? diagnostics.reasons
            : [UnsafeReason.UNSAFE_COMMAND],
        diagnostics.tags,
    );
}

export function getArgsConfinementPermission(
    args: string[],
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
    state?: CwdConfinementState,
    additionalRoots: readonly string[] = [],
    sensitiveAdditionalRoots?: readonly string[],
    readOnlyAdditionalRoots: readonly string[] = [],
    customSafeBashCommands: readonly string[] = [],
): Heuristic {
    return getArgsConfinementAssessment(
        args,
        cwd,
        config,
        state,
        additionalRoots,
        sensitiveAdditionalRoots,
        readOnlyAdditionalRoots,
        customSafeBashCommands,
    ).classification;
}
