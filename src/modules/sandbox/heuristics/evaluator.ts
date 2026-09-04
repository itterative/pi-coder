import fs from "node:fs";
import os from "node:os";

import { parseBashAst } from "../bash";
import type { BashAst, BashCommand, BashStatement, BashWordNode } from "../bash";
import { KNOWN_COMMANDS } from "../commands";
import type { CommandSpec } from "../commands";
import { unwrapWrapperCommand, unwrapWrapperTokens } from "../command-wrappers";
import {
    Heuristic,
    UnsafeReason,
    addCommandTags,
    addUnsafeReason,
    createCwdConfinementState,
    cloneCwdConfinementState,
    restoreCwdConfinementState,
    type CwdConfinementState,
    type ConfinementDiagnostics,
} from "./types";
import {
    isAllowedPath,
    isSensitivePath,
    isRealPathConfined,
    isPathWithinAdditionalRoot,
    isExistingDirectoryOperand,
    isHardLinkedFileOperand,
    resolvePath,
    isLexicallyWithin,
    ENV_ASSIGNMENT,
    isDangerousEnvName,
    type ConfinementOptions,
} from "./path-policy";
import {
    extractCommandPaths,
    combineHeuristics,
    hasDynamicShellExpansion,
    CUSTOM_SAFE_COMMAND_SPEC,
    matchesCustomSafeBashCommand,
} from "./command-access";

export function isNonPersistentChainOperator(operator: string | null): boolean {
    return operator === "|" || operator === "|&" || operator === "&";
}

function isDynamicDirectoryPath(value: string): boolean {
    // Expansion and globbing can select a directory outside the lexical cwd;
    // do not guess what a state-changing builtin will receive.
    return /[$`*?[\]~]/.test(value);
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

type DirectoryCommand = "cd" | "pushd" | "popd";

function isDirectoryCommand(command: string | undefined): command is DirectoryCommand {
    return command === "cd" || command === "pushd" || command === "popd";
}

function parseDirectoryOperands(
    command: DirectoryCommand,
    args: string[],
    state: CwdConfinementState,
): string[] | null {
    const operands: string[] = [];
    let afterDoubleDash = false;

    for (let index = 1; index < args.length; index++) {
        const arg = args[index];
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
            return null;
        }
        operands.push(arg);
    }

    return operands;
}

function applyPopd(
    operands: string[],
    state: CwdConfinementState,
    rootCwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
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

function validatePushdOperands(operands: string[], state: CwdConfinementState): boolean {
    if (operands.length === 0) {
        // The no-argument form rotates the existing stack, which we do not
        // model because its result depends on stack indices.
        state.blocked = true;
        return false;
    }
    if (/^[+-]\d+$/.test(operands[0] ?? "")) {
        // +N/-N also rotates/selects an existing stack entry.
        state.blocked = true;
        return false;
    }
    if (operands.length > 1) {
        state.blocked = true;
        return false;
    }
    return true;
}

function resolveDirectoryTarget(
    command: "cd" | "pushd",
    operands: string[],
    state: CwdConfinementState,
    home: string,
): string | null {
    let target = operands[0];
    if (command === "cd" && target === undefined) {
        target = home;
    } else if (command === "cd" && target === "-") {
        if (state.previousCwd === null) {
            return null;
        }
        target = state.previousCwd;
    }

    if (target === undefined || isDynamicDirectoryPath(target)) {
        state.blocked = true;
        return null;
    }
    return target;
}

function updateDirectoryState(
    command: "cd" | "pushd",
    target: string,
    state: CwdConfinementState,
    rootCwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    const oldCwd = state.currentCwd;
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
    if (!isDirectoryCommand(command)) {
        return undefined;
    }

    const operands = parseDirectoryOperands(command, args, state);
    if (operands === null) {
        return false;
    }

    const home = os.homedir();
    if (command === "popd") {
        return applyPopd(operands, state, rootCwd, home, options);
    }
    if (command === "pushd" && !validatePushdOperands(operands, state)) {
        return false;
    }

    const target = resolveDirectoryTarget(command, operands, state, home);
    if (target === null) {
        return false;
    }
    return updateDirectoryState(command, target, state, rootCwd, home, options);
}

interface EnvironmentAccess {
    index: number;
    values: string[];
    writes: boolean;
}

interface ResolvedCommand {
    name: string;
    spec: CommandSpec;
    argv: string[];
}

type ExtractedAccess = NonNullable<ReturnType<typeof extractCommandPaths>>;

function inspectEnvironmentSubstitutions(
    word: BashWordNode,
    cwd: string,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
): boolean | undefined {
    let writes = false;
    for (const substitution of word.substitutions) {
        if (!substitution.complete) {
            addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
            return undefined;
        }
        const nested = isConfined(substitution.content, cwd, options, diagnostics);
        if (nested === undefined) {
            return undefined;
        }
        writes = writes || nested === Heuristic.SAFE_EDIT;
    }
    return writes;
}

function inspectEnvironmentAssignments(
    input: string[] | BashCommand,
    args: string[],
    cwd: string,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
): EnvironmentAccess | undefined {
    const astCommand = Array.isArray(input) ? undefined : input;
    const values: string[] = [];
    let writes = false;
    let index = 0;

    if (astCommand !== undefined) {
        index = astCommand.environment.length;
        for (const { name, value, word } of astCommand.environment) {
            if (isDangerousEnvName(name)) {
                addUnsafeReason(diagnostics, UnsafeReason.DANGEROUS_ENVIRONMENT);
                return undefined;
            }
            const substitutionWrites = inspectEnvironmentSubstitutions(
                word,
                cwd,
                options,
                diagnostics,
            );
            if (substitutionWrites === undefined) {
                return undefined;
            }
            writes = writes || substitutionWrites;
            values.push(value);
        }
        return { index, values, writes };
    }

    while (index < args.length && ENV_ASSIGNMENT.test(args[index])) {
        const eq = args[index].indexOf("=");
        const name = args[index].slice(0, eq);
        if (isDangerousEnvName(name)) {
            addUnsafeReason(diagnostics, UnsafeReason.DANGEROUS_ENVIRONMENT);
            return undefined;
        }
        values.push(args[index].slice(eq + 1));
        index++;
    }
    return { index, values, writes };
}

function resolveKnownCommand(
    args: string[],
    index: number,
    commandName: string | undefined,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
): ResolvedCommand | undefined {
    if (index >= args.length) {
        addUnsafeReason(diagnostics, UnsafeReason.EMPTY_INPUT);
        return undefined;
    }

    const name = commandName ?? args[index];
    if (name.includes("/") || name.includes("\\")) {
        addUnsafeReason(diagnostics, UnsafeReason.COMMAND_PATH);
        return undefined;
    }

    const customCommand = matchesCustomSafeBashCommand(args, options.customSafeBashCommands);
    const spec = KNOWN_COMMANDS[name] ?? (customCommand ? CUSTOM_SAFE_COMMAND_SPEC : undefined);
    if (spec === undefined) {
        addUnsafeReason(diagnostics, UnsafeReason.UNKNOWN_COMMAND);
        return undefined;
    }
    return { name, spec, argv: args.slice(index) };
}

function areEnvironmentPathsConfined(
    paths: string[],
    cwd: string,
    rootCwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    return paths.every(
        (value) =>
            isAllowedPath(value, cwd, home, options, rootCwd) &&
            !isSensitivePath(value, cwd, home, options) &&
            isRealPathConfined(value, cwd, home, options),
    );
}

function assessDirectoryCommand(
    result: boolean,
    commandName: string,
    astCommand: BashCommand | undefined,
    envValues: string[],
    envWrites: boolean,
    cwd: string,
    rootCwd: string,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
): Heuristic | undefined {
    if (astCommand?.redirections.length) {
        addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
        return undefined;
    }

    const home = os.homedir();
    const envConfined = areEnvironmentPathsConfined(envValues, cwd, rootCwd, home, options);
    const commandAllowed =
        options.allowedCommands === null || options.allowedCommands.has(commandName);
    if (!result) addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_CWD);
    if (!envConfined) addUnsafeReason(diagnostics, UnsafeReason.OUTSIDE_CWD);
    if (!commandAllowed) addUnsafeReason(diagnostics, UnsafeReason.COMMAND_NOT_ALLOWED);
    if (!result || !envConfined || !commandAllowed) {
        return undefined;
    }
    return envWrites ? Heuristic.SAFE_EDIT : Heuristic.SAFE_READONLY;
}

function areCommandPathsConfined(
    paths: string[],
    cwd: string,
    rootCwd: string,
    home: string,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
): boolean {
    return paths.every((value) => {
        if (!isAllowedPath(value, cwd, home, options, rootCwd)) {
            addUnsafeReason(diagnostics, UnsafeReason.OUTSIDE_CWD);
            return false;
        }
        if (isSensitivePath(value, cwd, home, options)) {
            addUnsafeReason(diagnostics, UnsafeReason.SENSITIVE_PATH);
            return false;
        }
        if (!isRealPathConfined(value, cwd, home, options)) {
            addUnsafeReason(diagnostics, UnsafeReason.SYMLINK_ESCAPE);
            return false;
        }
        return true;
    });
}

function allowsReadOnlyAdditionalRoots(
    access: ExtractedAccess,
    paths: string[],
    cwd: string,
    home: string,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
): boolean {
    if (!access.writes) return true;
    const writesToReadOnlyRoot = paths.some((value) =>
        options.additionalRoots.some(
            (root) => root.readOnly && isLexicallyWithin(value, root.lexical, cwd, home),
        ),
    );
    if (!writesToReadOnlyRoot) return true;
    addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_MODE);
    return false;
}

function isSafeDestination(
    spec: CommandSpec,
    destination: string | undefined,
    cwd: string,
    home: string,
    diagnostics?: ConfinementDiagnostics,
): boolean {
    if (
        spec.rejectDirectoryDestination &&
        destination !== undefined &&
        isExistingDirectoryOperand(destination, cwd, home)
    ) {
        addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_MODE);
        return false;
    }
    return true;
}

function areHardLinksAllowed(
    spec: CommandSpec,
    access: ExtractedAccess,
    destination: string | undefined,
    cwd: string,
    home: string,
    diagnostics?: ConfinementDiagnostics,
): boolean {
    let paths: string[] = [];
    if (spec.rejectHardLinkedPositionals) {
        paths = access.positionalPaths;
    } else if (spec.rejectHardLinkedDestination && destination !== undefined) {
        paths = [destination];
    }
    if (!paths.some((value) => isHardLinkedFileOperand(value, cwd, home))) {
        return true;
    }
    addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_MODE);
    return false;
}

function hasAdditionalRootPolicy(spec: CommandSpec, access: ExtractedAccess): boolean {
    return (
        spec.additionalRootOnly ||
        spec.additionalRootLastPositional ||
        access.requiresAdditionalRoot
    );
}

function allowsAdditionalRootContainment(
    spec: CommandSpec,
    access: ExtractedAccess,
    allPaths: string[],
    destination: string | undefined,
    cwd: string,
    home: string,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
): boolean {
    if (!hasAdditionalRootPolicy(spec, access)) return true;

    let paths: string[] = [];
    if (spec.additionalRootOnly || access.requiresAdditionalRoot) {
        paths = allPaths;
    } else if (spec.additionalRootLastPositional && destination !== undefined) {
        paths = [destination];
    }
    if (
        options.additionalRoots.length === 0 ||
        paths.length === 0 ||
        !paths.every((value) => isPathWithinAdditionalRoot(value, cwd, home, options))
    ) {
        addUnsafeReason(diagnostics, UnsafeReason.OUTSIDE_CWD);
        return false;
    }
    return true;
}

/**
 * Replace transparent wrapper prefixes with the innermost command they run.
 *
 * Confinement must be judged on that command, because it is what actually touches files. Both
 * entrypoints in `command-wrappers.ts` unwrap to a bounded depth, so nesting is handled here exactly
 * as it is for rule matching and suggestions, and environment assignments stay opaque in both.
 */
function transparentSubject(input: string[] | BashCommand): string[] | BashCommand {
    const unwrapped = Array.isArray(input)
        ? unwrapWrapperTokens(input)
        : unwrapWrapperCommand(input);
    return unwrapped ?? input;
}

/**
 * Check whether a single parsed command is a known command whose file accesses all stay within the
 * working directory. A transparent wrapper is unwrapped first, so the inner command is what gets
 * classified; see `command-wrappers.ts` for which prefixes qualify.
 */
export function isCommandConfined(
    input: string[] | BashCommand,
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

    const args = Array.isArray(input) ? input : input.words.map((word) => word.value);
    const environment = inspectEnvironmentAssignments(input, args, cwd, options, diagnostics);
    if (environment === undefined) return undefined;

    const subject = transparentSubject(input);
    const astCommand = Array.isArray(subject) ? undefined : subject;
    const subjectArgs = Array.isArray(subject) ? subject : subject.words.map((word) => word.value);

    const command = resolveKnownCommand(
        subjectArgs,
        environment.index,
        astCommand?.command,
        options,
        diagnostics,
    );
    if (command === undefined) return undefined;

    const directoryResult = applyDirectoryCommand(command.argv, state, rootCwd, options);
    if (directoryResult !== undefined) {
        return assessDirectoryCommand(
            directoryResult,
            command.name,
            astCommand,
            environment.values,
            environment.writes,
            cwd,
            rootCwd,
            options,
            diagnostics,
        );
    }

    if (options.allowedCommands !== null && !options.allowedCommands.has(command.name)) {
        addUnsafeReason(diagnostics, UnsafeReason.COMMAND_NOT_ALLOWED);
        return undefined;
    }
    if (command.spec.validate && !command.spec.validate(command.argv)) {
        addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
        return undefined;
    }

    const access = extractCommandPaths(
        command.argv,
        command.spec,
        cwd,
        options,
        diagnostics,
        {
            evaluateNested: (nested, nestedCwd, nestedOptions, nestedDiagnostics) =>
                isConfined(nested, nestedCwd, nestedOptions, nestedDiagnostics),
        },
        astCommand,
    );
    if (access === null) {
        if (diagnostics?.reasons.length === 0) {
            addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
        }
        return undefined;
    }

    const home = os.homedir();
    const allPaths = [...environment.values, ...access.paths];
    if (!areCommandPathsConfined(allPaths, cwd, rootCwd, home, options, diagnostics)) {
        return undefined;
    }
    if (!allowsReadOnlyAdditionalRoots(access, allPaths, cwd, home, options, diagnostics)) {
        return undefined;
    }

    const hasRootPolicy = hasAdditionalRootPolicy(command.spec, access);
    if (hasRootPolicy && command.argv.slice(1).some(hasDynamicShellExpansion)) {
        addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
        return undefined;
    }

    const destination = access.positionalPaths[access.positionalPaths.length - 1];
    if (!isSafeDestination(command.spec, destination, cwd, home, diagnostics)) {
        return undefined;
    }
    if (!areHardLinksAllowed(command.spec, access, destination, cwd, home, diagnostics)) {
        return undefined;
    }
    if (
        !allowsAdditionalRootContainment(
            command.spec,
            access,
            allPaths,
            destination,
            cwd,
            home,
            options,
            diagnostics,
        )
    ) {
        return undefined;
    }

    addCommandTags(diagnostics, access.tags);
    return access.writes || environment.writes ? Heuristic.SAFE_EDIT : Heuristic.SAFE_READONLY;
}

interface StatementCommandResult {
    heuristic: Heuristic | undefined;
    nonPersistentBase: CwdConfinementState | null;
}

function evaluateStatementCommand(
    astCommand: BashCommand,
    operatorAfter: string | null,
    state: CwdConfinementState,
    rootCwd: string,
    options: ConfinementOptions,
    diagnostics: ConfinementDiagnostics | undefined,
    nonPersistentBase: CwdConfinementState | null,
): StatementCommandResult {
    const beforeSegment = cloneCwdConfinementState(state);
    let nextNonPersistentBase = nonPersistentBase;
    if (nextNonPersistentBase === null && isNonPersistentChainOperator(operatorAfter)) {
        nextNonPersistentBase = beforeSegment;
    }

    const segmentState = nextNonPersistentBase
        ? cloneCwdConfinementState(nextNonPersistentBase)
        : state;
    const heuristic = isCommandConfined(
        astCommand,
        segmentState.currentCwd,
        rootCwd,
        options,
        segmentState,
        diagnostics,
    );

    if (nextNonPersistentBase !== null) {
        restoreCwdConfinementState(state, nextNonPersistentBase);
        if (!isNonPersistentChainOperator(operatorAfter)) {
            nextNonPersistentBase = null;
        }
    }
    if (heuristic === undefined && diagnostics?.reasons.length === 0) {
        addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
    }

    return { heuristic, nonPersistentBase: nextNonPersistentBase };
}

function evaluateStatement(
    statement: BashStatement,
    state: CwdConfinementState,
    rootCwd: string,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
): Heuristic | undefined {
    let nonPersistentBase: CwdConfinementState | null = null;
    let heuristic: Heuristic | null = null;
    let commandIndex = 0;
    let hasCommand = false;

    for (let partIndex = 0; partIndex < statement.node.parts.length; partIndex++) {
        const part = statement.node.parts[partIndex];
        if (part.type === "operator") {
            continue;
        }

        hasCommand = true;
        const astCommand = statement.commands[commandIndex++];
        if (astCommand === undefined) {
            addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
            return undefined;
        }
        const nextPart = statement.node.parts[partIndex + 1];
        const operatorAfter = nextPart?.type === "operator" ? nextPart.value : null;
        const evaluation = evaluateStatementCommand(
            astCommand,
            operatorAfter,
            state,
            rootCwd,
            options,
            diagnostics,
            nonPersistentBase,
        );
        nonPersistentBase = evaluation.nonPersistentBase;
        if (evaluation.heuristic === undefined) {
            return undefined;
        }
        heuristic =
            combineHeuristics(heuristic ?? Heuristic.SAFE_READONLY, evaluation.heuristic) ??
            Heuristic.SAFE_READONLY;
    }

    if (!hasCommand) {
        addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
        return undefined;
    }
    return heuristic ?? undefined;
}

function parseConfinementAst(
    command: string,
    diagnostics?: ConfinementDiagnostics,
): BashAst | undefined {
    let parsed: BashAst;
    try {
        parsed = parseBashAst(command);
    } catch {
        addUnsafeReason(diagnostics, UnsafeReason.PARSE_ERROR);
        return undefined;
    }

    if (parsed.statements.length === 0) {
        addUnsafeReason(diagnostics, UnsafeReason.EMPTY_INPUT);
        return undefined;
    }
    return parsed;
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
    const parsed = parseConfinementAst(command, diagnostics);
    if (parsed === undefined) {
        return undefined;
    }

    const state = createCwdConfinementState(cwd);
    let heuristic: Heuristic | null = null;
    for (const statement of parsed.statements) {
        const statementHeuristic = evaluateStatement(statement, state, cwd, options, diagnostics);
        if (statementHeuristic === undefined) {
            return undefined;
        }
        heuristic =
            combineHeuristics(heuristic ?? Heuristic.SAFE_READONLY, statementHeuristic) ??
            Heuristic.SAFE_READONLY;
    }

    return heuristic ?? undefined;
}
