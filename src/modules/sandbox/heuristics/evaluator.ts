import fs from "node:fs";
import os from "node:os";

import { parseBash } from "../bash";
import { CommandTag, KNOWN_COMMANDS } from "../commands";
import type { CommandSpec } from "../commands";
import {
    Heuristic, UnsafeReason,
    addCommandTags, addUnsafeReason,
    createCwdConfinementState, cloneCwdConfinementState, restoreCwdConfinementState,
    type CwdConfinementState, type ConfinementDiagnostics,
} from "./types";
import {
    isAllowedPath, isSensitivePath, isRealPathConfined, isPathWithinAdditionalRoot,
    isExistingDirectoryOperand, isHardLinkedFileOperand, resolvePath, isLexicallyWithin,
    ENV_ASSIGNMENT, isDangerousEnvName,
    type ConfinementOptions,
} from "./path-policy";
import {
    extractCommandPaths,
    combineHeuristics,
    hasDynamicShellExpansion,
    CUSTOM_SAFE_COMMAND_SPEC,
    matchesCustomSafeBashCommand,
} from "./command-access";

const CHAIN_OPERATORS = new Set(["&&", "||", "|", ";", "&"]);

/**
 * Split a parsed command at chain operators. parseBash keeps operators like
 * && and | as arguments of a single command, so each segment between them
 * must be evaluated as its own command.
 */
export interface ChainSegment {
    args: string[];
    operatorAfter: string | null;
}

export function splitAtChainOperatorsWithOperators(args: string[]): ChainSegment[] {
    const segments: ChainSegment[] = [];
    let current: string[] = [];

    for (const arg of args) {
        if (CHAIN_OPERATORS.has(arg)) {
            if (current.length > 0) {
                segments.push({ args: current, operatorAfter: arg });
                current = [];
            }
        } else {
            current.push(arg);
        }
    }

    if (current.length > 0) {
        segments.push({ args: current, operatorAfter: null });
    }

    return segments;
}

export function splitAtChainOperators(args: string[]): string[][] {
    return splitAtChainOperatorsWithOperators(args).map((segment) => segment.args);
}

export function isNonPersistentChainOperator(operator: string | null): boolean {
    return operator === "|" || operator === "&";
}

function isDynamicDirectoryPath(value: string): boolean {
    // Expansion and globbing can select a directory outside the lexical cwd;
    // do not guess what a state-changing builtin will receive.
    return /[$`*?\[\]~]/.test(value);
}

function isConfinedDirectoryPath(
    value: string,
    cwd: string,
    rootCwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    if (isDynamicDirectoryPath(value)) {
        return false;
    }
    if (!isAllowedPath(value, cwd, home, options, rootCwd)) {
        return false;
    }
    if (isSensitivePath(value, cwd, home, options)) {
        return false;
    }
    return isRealPathConfined(value, cwd, home, options);
}

/**
 * Apply the cwd-changing Bash builtins we can model precisely. A false result
 * means the builtin itself is not eligible for the heuristic; state is still
 * updated when its destination is known, so a later `cd` can recover.
 */
function applyDirectoryCommand(
    args: string[],
    state: CwdConfinementState,
    rootCwd: string,
    options: ConfinementOptions,
): boolean | undefined {
    const command = args[0];
    if (command !== "cd" && command !== "pushd" && command !== "popd") {
        return undefined;
    }

    const operands: string[] = [];
    let afterDoubleDash = false;
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (!afterDoubleDash && arg === "--") {
            afterDoubleDash = true;
            continue;
        }
        if (!afterDoubleDash && command === "cd" && (arg === "-L" || arg === "-P")) {
            continue;
        }
        if (!afterDoubleDash && command === "cd" && arg === "-") {
            operands.push(arg);
            continue;
        }
        if (!afterDoubleDash && arg.startsWith("-")) {
            state.blocked = true;
            return false;
        }
        operands.push(arg);
    }

    const home = os.homedir();
    if (command === "popd") {
        if (operands.length > 0) {
            state.blocked = true;
            return false;
        }
        if (state.directoryStack.length === 0) {
            // Bash reports an error and leaves cwd unchanged.
            return true;
        }
        const oldCwd = state.currentCwd;
        state.currentCwd = state.directoryStack.pop()!;
        state.previousCwd = oldCwd;
        return isConfinedDirectoryPath(state.currentCwd, state.currentCwd, rootCwd, home, options);
    }

    if (command === "pushd" && operands.length === 0) {
        // The no-argument form rotates the existing stack, which we do not
        // model because its result depends on stack indices.
        state.blocked = true;
        return false;
    }
    if (command === "pushd" && /^[+-]\d+$/.test(operands[0] ?? "")) {
        // +N/-N also rotates/selects an existing stack entry.
        state.blocked = true;
        return false;
    }
    if (operands.length > 1) {
        state.blocked = true;
        return false;
    }

    const oldCwd = state.currentCwd;
    let target = operands[0];
    if (command === "cd" && target === undefined) {
        target = home;
    } else if (command === "cd" && target === "-") {
        if (state.previousCwd === null) return false;
        target = state.previousCwd;
    }

    if (target === undefined) {
        state.blocked = true;
        return false;
    }
    if (isDynamicDirectoryPath(target)) {
        state.blocked = true;
        return false;
    }

    const lexicalTarget = resolvePath(target, oldCwd, home);
    state.currentCwd = lexicalTarget;
    if (options.realCwd !== null) {
        try {
            // Track the kernel's actual cwd, not merely Bash's logical PWD;
            // otherwise `cd symlink && cat ../file` could resolve `..` from
            // the wrong directory.
            state.currentCwd = fs.realpathSync(lexicalTarget);
        } catch {
            // A missing target makes cd fail, so the shell remains in oldCwd.
            state.currentCwd = oldCwd;
        }
    }
    state.previousCwd = oldCwd;
    if (command === "pushd") {
        state.directoryStack.push(oldCwd);
    }

    return isConfinedDirectoryPath(target, oldCwd, rootCwd, home, options);
}

/**
 * Check whether a single parsed command is a known command whose file
 * accesses all stay within the working directory.
 */
export function isCommandConfined(
    args: string[],
    cwd: string,
    rootCwd: string,
    options: ConfinementOptions,
    state: CwdConfinementState,
    diagnostics?: ConfinementDiagnostics,
): Heuristic | undefined {
    if (state.blocked) {
        addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_CWD);
        return undefined;
    }
    // skip leading environment assignments (FOO=bar cmd ...), but reject
    // assignments that can alter the command's behavior (LD_PRELOAD, PATH,
    // ...) and path-check the values of the rest
    let idx = 0;
    const envValues: string[] = [];
    while (idx < args.length && ENV_ASSIGNMENT.test(args[idx])) {
        const eq = args[idx].indexOf("=");
        const name = args[idx].slice(0, eq);
        if (isDangerousEnvName(name)) {
            addUnsafeReason(diagnostics, UnsafeReason.DANGEROUS_ENVIRONMENT);
            return undefined;
        }
        envValues.push(args[idx].slice(eq + 1));
        idx++;
    }

    if (idx >= args.length) {
        addUnsafeReason(diagnostics, UnsafeReason.EMPTY_INPUT);
        return undefined;
    }

    const commandName = args[idx];

    // commands invoked by path are not trusted to be the real binary
    if (commandName.includes("/") || commandName.includes("\\")) {
        addUnsafeReason(diagnostics, UnsafeReason.COMMAND_PATH);
        return undefined;
    }

    const customCommand = matchesCustomSafeBashCommand(
        args,
        options.customSafeBashCommands,
    );
    const spec = KNOWN_COMMANDS[commandName]
        ?? (customCommand ? CUSTOM_SAFE_COMMAND_SPEC : undefined);
    if (!spec) {
        addUnsafeReason(diagnostics, UnsafeReason.UNKNOWN_COMMAND);
        return undefined;
    }

    const commandArgs = args.slice(idx);
    const directoryResult = applyDirectoryCommand(commandArgs, state, rootCwd, options);
    if (directoryResult !== undefined) {
        const home = os.homedir();
        const envConfined = envValues.every((p) =>
            isAllowedPath(p, cwd, home, options, rootCwd) &&
            !isSensitivePath(p, cwd, home, options) &&
            isRealPathConfined(p, cwd, home, options),
        );
        const commandAllowed =
            options.allowedCommands === null || options.allowedCommands.has(commandName);
        if (!directoryResult) addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_CWD);
        if (!envConfined) addUnsafeReason(diagnostics, UnsafeReason.OUTSIDE_CWD);
        if (!commandAllowed) addUnsafeReason(diagnostics, UnsafeReason.COMMAND_NOT_ALLOWED);
        return directoryResult && envConfined && commandAllowed
            ? Heuristic.SAFE_READONLY
            : undefined;
    }

    if (options.allowedCommands !== null && !options.allowedCommands.has(commandName)) {
        addUnsafeReason(diagnostics, UnsafeReason.COMMAND_NOT_ALLOWED);
        return undefined;
    }

    if (spec.validate && !spec.validate(commandArgs)) {
        addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
        return undefined;
    }

    const access = extractCommandPaths(commandArgs, spec, cwd, options, diagnostics, {
        evaluateNested: (nested, nestedCwd, nestedOptions, nestedDiagnostics) =>
            isConfined(nested, nestedCwd, nestedOptions, nestedDiagnostics),
    });
    if (access === null) {
        if (diagnostics?.reasons.length === 0) {
            addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
        }
        return undefined;
    }

    const home = os.homedir();
    const allPaths = [...envValues, ...access.paths];
    const confined = allPaths.every((p) => {
        if (!isAllowedPath(p, cwd, home, options, rootCwd)) {
            addUnsafeReason(diagnostics, UnsafeReason.OUTSIDE_CWD);
            return false;
        }
        if (isSensitivePath(p, cwd, home, options)) {
            addUnsafeReason(diagnostics, UnsafeReason.SENSITIVE_PATH);
            return false;
        }
        if (!isRealPathConfined(p, cwd, home, options)) {
            addUnsafeReason(diagnostics, UnsafeReason.SYMLINK_ESCAPE);
            return false;
        }
        return true;
    });

    if (!confined) return undefined;

    if (access.writes && allPaths.some((p) =>
        options.additionalRoots.some((root) =>
            root.readOnly && isLexicallyWithin(p, root.lexical, cwd, home)))) {
        addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_MODE);
        return undefined;
    }

    const hasAdditionalRootPolicy = spec.additionalRootOnly
        || spec.additionalRootLastPositional
        || access.requiresAdditionalRoot;
    if (
        hasAdditionalRootPolicy
        && commandArgs.slice(1).some(hasDynamicShellExpansion)
    ) {
        addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
        return undefined;
    }

    const destination = access.positionalPaths[access.positionalPaths.length - 1];
    if (
        spec.rejectDirectoryDestination
        && destination !== undefined
        && isExistingDirectoryOperand(destination, cwd, home)
    ) {
        addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_MODE);
        return undefined;
    }

    let hardLinkPaths: string[] = [];
    if (spec.rejectHardLinkedPositionals) {
        hardLinkPaths = access.positionalPaths;
    } else if (spec.rejectHardLinkedDestination && destination !== undefined) {
        hardLinkPaths = [destination];
    }
    if (hardLinkPaths.some((p) => isHardLinkedFileOperand(p, cwd, home))) {
        addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_MODE);
        return undefined;
    }

    let additionalRootPaths: string[] = [];
    if (spec.additionalRootOnly || access.requiresAdditionalRoot) {
        additionalRootPaths = allPaths;
    } else if (spec.additionalRootLastPositional && destination !== undefined) {
        additionalRootPaths = [destination];
    }

    if (hasAdditionalRootPolicy && (
        options.additionalRoots.length === 0
        || additionalRootPaths.length === 0
        || !additionalRootPaths.every((p) =>
            isPathWithinAdditionalRoot(p, cwd, home, options))
    )) {
        addUnsafeReason(diagnostics, UnsafeReason.OUTSIDE_CWD);
        return undefined;
    }

    addCommandTags(diagnostics, access.tags);
    return access.writes ? Heuristic.SAFE_EDIT : Heuristic.SAFE_READONLY;
}

/**
 * Check whether every command in a (possibly multi-line or chained) command
 * string is known and confined to the working directory.
 */
export function isConfined(
    command: string,
    cwd: string,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
): Heuristic | undefined {
    let parsed: string[][];
    try {
        parsed = parseBash(command);
    } catch {
        addUnsafeReason(diagnostics, UnsafeReason.PARSE_ERROR);
        return undefined;
    }

    if (parsed.length === 0) {
        addUnsafeReason(diagnostics, UnsafeReason.EMPTY_INPUT);
        return undefined;
    }

    const state = createCwdConfinementState(cwd);
    let heuristic: Heuristic | null = null;
    for (const cmdArgs of parsed) {
        const segments = splitAtChainOperatorsWithOperators(cmdArgs);
        let nonPersistentBase: CwdConfinementState | null = null;

        if (segments.length === 0) {
            addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
            return undefined;
        }

        for (const { args, operatorAfter } of segments) {
            const beforeSegment = cloneCwdConfinementState(state);
            if (nonPersistentBase === null && isNonPersistentChainOperator(operatorAfter)) {
                nonPersistentBase = beforeSegment;
            }
            const segmentState = nonPersistentBase
                ? cloneCwdConfinementState(nonPersistentBase)
                : state;
            const result = isCommandConfined(
                args,
                segmentState.currentCwd,
                cwd,
                options,
                segmentState,
                diagnostics,
            );

            if (nonPersistentBase !== null) {
                restoreCwdConfinementState(state, nonPersistentBase);
                if (!isNonPersistentChainOperator(operatorAfter)) {
                    nonPersistentBase = null;
                }
            }
            if (result === undefined) {
                if (diagnostics?.reasons.length === 0) {
                    addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
                }
                return undefined;
            }
            heuristic = combineHeuristics(heuristic ?? Heuristic.SAFE_READONLY, result)
                ?? Heuristic.SAFE_READONLY;
        }
    }

    return heuristic ?? undefined;
}
