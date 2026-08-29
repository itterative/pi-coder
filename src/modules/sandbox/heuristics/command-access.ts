import { BashAst, parseBashAst } from "../bash";
import type {
    BashAstNode,
    BashCommand,
    BashSubstitutionNode,
    BashWordNode,
} from "../bash";
import { CommandTag } from "../commands";
import type { CommandSpec, FlagSpec } from "../commands";
import {
    Heuristic,
    UnsafeReason,
    addUnsafeReason,
    type ConfinementDiagnostics,
} from "./types";
import {
    SPECIAL_ALLOWED_PATHS,
    REDIRECTION_OPERATORS,
    isDangerousEnvName,
    type ConfinementOptions,
} from "./path-policy";

// User-declared commands are trusted to be read-only; the generic spec still
// confines every invocation argument that could name a filesystem path.
export const CUSTOM_SAFE_COMMAND_SPEC: CommandSpec = {
    positionals: "paths",
};

export function matchesCustomSafeBashCommand(
    args: readonly string[],
    customSafeBashCommands: readonly string[][],
): boolean {
    return customSafeBashCommands.some((pattern) => {
        const wildcard = pattern[pattern.length - 1] === "*";
        const fixedLength = wildcard ? pattern.length - 1 : pattern.length;
        if ((!wildcard && args.length !== pattern.length) || (wildcard && args.length <= fixedLength)) {
            return false;
        }
        for (let index = 0; index < fixedLength; index++) {
            if (args[index] !== pattern[index]) return false;
        }
        return true;
    });
}

export function parseCustomSafeBashCommands(commands: readonly string[]): string[][] {
    const patterns: string[][] = [];
    for (const command of commands) {
        try {
            const parsed = parseBashAst(command);
            if (parsed.statements.length !== 1) {
                continue;
            }
            const statement = parsed.statements[0];
            if (statement.parts.length !== 1 || statement.commands.length !== 1) {
                continue;
            }
            const [simpleCommand] = statement.commands;
            if (simpleCommand.redirections.length > 0) {
                continue;
            }

            const words = simpleCommand.words;
            const args = words.map((word) => word.value);
            if (args.length === 0) {
                continue;
            }
            const wildcard = args[args.length - 1] === "*"
                && !words[words.length - 1].quoted;
            const fixedArgs = wildcard ? args.slice(0, -1) : args;
            if (fixedArgs.includes("*")) {
                continue;
            }
            if (args.some((arg) => arg !== "*" && hasDynamicShellExpansion(arg))) {
                continue;
            }
            if (args[0].includes("/") || args[0].includes("\\")) {
                continue;
            }
            patterns.push(args);
        } catch {
            // Invalid patterns are ignored and remain permission-gated.
        }
    }
    return patterns;
}

function hasPatternBypass(args: string[], spec: CommandSpec): boolean {
    const bypass = spec.patternBypassFlags ?? [];
    const shortBypass = bypass
        .filter((f) => !f.startsWith("--"))
        .map((f) => f[1]);
    const longBypass = bypass.filter((f) => f.startsWith("--"));

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            break;
        }

        if (arg.startsWith("--")) {
            const name = arg.split("=", 1)[0];
            if (longBypass.includes(name)) {
                return true;
            }
        } else if (arg.length > 1 && arg.startsWith("-")) {
            const cluster = arg.slice(1);
            if (shortBypass.some((c) => cluster.includes(c))) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Whether any argument provides one of the spec's safeModeFlags
 * (e.g. unzip -l, unzip --list).
 */
function hasSafeModeFlag(args: string[], spec: CommandSpec): boolean {
    const safe = spec.safeModeFlags ?? [];
    const shortSafe = safe
        .filter((f) => !f.startsWith("--"))
        .map((f) => f[1]);
    const longSafe = safe.filter((f) => f.startsWith("--"));

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            break;
        }

        if (arg.startsWith("--")) {
            if (longSafe.includes(arg.split("=", 1)[0])) {
                return true;
            }
        } else if (arg.length > 1 && arg.startsWith("-")) {
            const cluster = arg.slice(1);
            if (shortSafe.some((c) => cluster.includes(c))) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Handle a short-flag cluster (e.g. -la, -n5, -efoo).
 * Returns the new argument index, or null if the command is ineligible.
 */
function handleShortCluster(
    args: string[],
    index: number,
    spec: CommandSpec,
    paths: string[],
    cwd: string,
    options: ConfinementOptions,
    writes: { value: boolean },
    diagnostics?: ConfinementDiagnostics,
    context?: CommandAccessContext,
    wordAt?: (index: number) => BashWordNode | undefined,
): number | null {
    const cluster = args[index].slice(1);

    const inspectValue = (value: string, pathContext: boolean, word?: BashWordNode): boolean => {
        if (
            (spec.additionalRootOnly && hasDynamicShellExpansion(value))
            || (pathContext && hasUnmodeledPathExpansion(value, word))
        ) {
            addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
            return false;
        }

        const substitution = inspectShellSubstitution(
            value,
            cwd,
            options,
            pathContext,
            diagnostics,
            context,
            word,
        );
        if (substitution === null) return false;
        if (substitution !== undefined) {
            paths.push(...substitution.paths);
            writes.value = writes.value || substitution.heuristic === Heuristic.SAFE_EDIT;
        } else if (pathContext) {
            paths.push(value);
        }
        return true;
    };

    for (let j = 0; j < cluster.length; j++) {
        const flag = "-" + cluster[j];
        const flagSpec = spec.flags?.[flag];

        if (!flagSpec && spec.rejectUnknownFlags) {
            addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_FLAG);
            return null;
        }
        if (flagSpec?.unsafe) {
            addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_FLAG);
            return null;
        }

        const values = flagSpec?.values ?? 0;
        if (values > 0) {
            if (values > 1) {
                // multi-value short flag: cannot be classified safely
                return null;
            }
            // inline value is the rest of the cluster, otherwise next arg
            if (j === cluster.length - 1) {
                const value = args[index + 1];
                if (value === undefined
                    || !inspectValue(value, hasPathSlot(flagSpec, 0), wordAt?.(index + 1))) {
                    return null;
                }
                return index + 1;
            }
            if (!inspectValue(
                cluster.slice(j + 1),
                hasPathSlot(flagSpec, 0),
                wordAt?.(index),
            )) {
                return null;
            }
            return index;
        }

        // boolean (known or unknown): continue with the cluster
    }

    return index;
}

function hasPathSlot(flagSpec: FlagSpec | undefined, slot: number): boolean {
    return flagSpec?.pathSlots?.includes(slot) ?? false;
}

export function combineHeuristics(
    a: Heuristic | undefined,
    b: Heuristic | undefined,
): Heuristic | undefined {
    if (a === undefined || b === undefined) return undefined;
    return a === Heuristic.SAFE_EDIT || b === Heuristic.SAFE_EDIT
        ? Heuristic.SAFE_EDIT
        : Heuristic.SAFE_READONLY;
}

function hasShellSubstitution(value: string): boolean {
    return value.includes("$(") || value.includes("`") ||
        value.includes("<(") || value.includes(">(");
}

/**
 * Shell syntax that can turn one parsed-argument value into different
 * filesystem operands after confinement has been checked. The parsed-argument
 * path has no AST provenance, so rejecting these forms may produce safe false
 * negatives; that is preferable to guessing at Bash expansion semantics.
 */
export function hasDynamicShellExpansion(value: string): boolean {
    return hasShellSubstitution(value)
        || value.includes("$")
        || value.includes("`")
        || value.includes("{")
        || value.includes("}")
        || value.includes("*")
        || value.includes("?")
        || value.includes("[")
        || value.includes("]")
        || value.startsWith("~")
        || /[@+!]\(/.test(value);
}

export function hasUnmodeledPathExpansion(
    value: string,
    word?: BashWordNode,
): boolean {
    if (word !== undefined) {
        const substitution = BashAst.substitutionFor(word, value);
        if (substitution?.complete) {
            return false;
        }
        if (word.substitutions.length > 0) {
            return true;
        }
        return hasDynamicShellExpansion(value);
    }

    const substitution = parseBashAst(value).singleCommand?.singleSubstitution;
    if (substitution !== undefined) {
        return false;
    }
    return hasDynamicShellExpansion(value);
}

/**
 * Return the literal paths that a narrowly modeled command substitution can
 * produce when it is used as a filesystem path. A safe inner command alone is
 * not enough: `$(echo /etc/passwd)` is safe to execute but unsafe as `cat`'s
 * path argument.
 */
function getStaticSubstitutionPathsFromAst(
    ast: BashAstNode,
    cwd: string,
): string[] | null {
    if (ast.statements.length !== 1) {
        return null;
    }
    const statement = ast.statements[0];
    if (statement.parts.length !== 1 || statement.commands.length !== 1) {
        return null;
    }
    if (statement.commands[0].redirections.length > 0) {
        return null;
    }

    const words = statement.commands[0].words;
    if (words.some((word) => word.assignment !== undefined)) {
        return null;
    }
    const args = words.map((word) => word.value);
    if (args.length === 1 && args[0] === "pwd") {
        return [cwd];
    }
    if (args.length !== 2 || (args[0] !== "echo" && args[0] !== "printf")) {
        return null;
    }

    const outputWord = words[1];
    const nested = BashAst.substitutionFor(outputWord);
    if (nested?.kind === "command" || nested?.kind === "backtick") {
        return getStaticSubstitutionPathsFromAst(nested.ast, cwd);
    }
    if (outputWord.substitutions.length > 0) {
        return null;
    }
    const output = outputWord.value;
    if (!/^[A-Za-z0-9._+@/:-]+$/.test(output)) {
        return null;
    }
    if (output.includes("%")) {
        return null;
    }
    return [output];
}

function getStaticSubstitutionPaths(
    substitution: BashSubstitutionNode,
    cwd: string,
): string[] | null {
    if (substitution.kind !== "command" && substitution.kind !== "backtick") {
        return null;
    }
    return getStaticSubstitutionPathsFromAst(substitution.ast, cwd);
}

function getStaticSubstitutionPathsFromValue(
    value: string,
    cwd: string,
): string[] | null {
    const substitution = parseBashAst(value).singleCommand?.singleSubstitution;
    if (substitution?.kind !== "command" && substitution?.kind !== "backtick") {
        return null;
    }
    return getStaticSubstitutionPathsFromAst(substitution.ast, cwd);
}

interface ShellSubstitutionAccess {
    heuristic: Heuristic;
    paths: string[];
}

/**
 * Inspect shell substitutions embedded in one token. `null` means the token
 * is not safely classifiable; `undefined` means it contains no substitution.
 */
export interface CommandAccessContext {
    evaluateNested: (command: string, cwd: string, options: ConfinementOptions, diagnostics?: ConfinementDiagnostics) => Heuristic | undefined;
}

function inspectShellSubstitution(
    value: string,
    cwd: string,
    options: ConfinementOptions,
    pathContext: boolean,
    diagnostics?: ConfinementDiagnostics,
    context?: CommandAccessContext,
    word?: BashWordNode,
): ShellSubstitutionAccess | null | undefined {
    const substitution = word === undefined
        ? undefined
        : BashAst.substitutionFor(word, value);
    const valueSubstitution = substitution
        ?? (word === undefined
            ? parseBashAst(value).singleCommand?.singleSubstitution
            : undefined);
    const processSubstitution = valueSubstitution?.kind === "process-input"
        || valueSubstitution?.kind === "process-output";
    const commandSubstitution = valueSubstitution?.kind === "command"
        || valueSubstitution?.kind === "backtick";

    if (valueSubstitution !== undefined && !valueSubstitution.complete) {
        addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
        return null;
    }

    if (!processSubstitution && !commandSubstitution) {
        if ((word !== undefined && word.substitutions.length > 0)
            || (word === undefined && hasShellSubstitution(value))) {
            addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
            return null;
        }
        return undefined;
    }

    const content = valueSubstitution?.content ?? value;
    const inner = context?.evaluateNested(content, cwd, options, diagnostics);
    if (inner === undefined) {
        if (diagnostics?.reasons.length === 0) {
            addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_COMMAND);
        }
        return null;
    }

    if (processSubstitution) {
        return { heuristic: inner, paths: [] };
    }

    if (!pathContext) {
        return { heuristic: inner, paths: [] };
    }

    const paths = word === undefined
        ? getStaticSubstitutionPathsFromValue(value, cwd)
        : getStaticSubstitutionPaths(valueSubstitution, cwd);
    if (paths === null) {
        addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
        return null;
    }
    return { heuristic: inner, paths };
}

/**
 * Extract all filesystem paths accessed by a single known command.
 * Returns null if the command usage cannot be classified safely.
 * args[0] is the command name.
 */
interface ExtractedCommandAccess {
    paths: string[];
    positionalPaths: string[];
    writes: boolean;
    requiresAdditionalRoot: boolean;
    tags: CommandTag[];
}

export function extractCommandPaths(
    args: string[],
    spec: CommandSpec,
    cwd: string,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
    context?: CommandAccessContext,
    astCommand?: BashCommand,
): ExtractedCommandAccess | null {
    const paths: string[] = [];
    const commandWords = astCommand?.words.slice(astCommand.environment.length);
    const wordAt = (index: number): BashWordNode | undefined => commandWords?.[index];
    const positionalPaths: string[] = [];
    const tags = new Set<CommandTag>(spec.tags);
    let writes = spec.writes === true;
    let requiresAdditionalRoot = false;
    let afterDoubleDash = false;
    let positionalSeen = false;

    // Commands with subcommands (e.g. git) dispatch on the first positional:
    // it must name a known subcommand, after which the subcommand's spec
    // governs the remaining arguments. The parent's unsafe flags apply before
    // dispatch only (after it they would collide with subcommand flags,
    // e.g. `git log -C` means detect-copies, not change directory).
    const subcommands = spec.subcommands;
    let activeSpec = spec;
    // Index in the normalized argv where the active spec begins. For a
    // regular command this is 0; for `git diff`, it points at `diff`, so the
    // diff validator receives ["diff", ...] rather than ["git", "diff", ...].
    let activeArgvStart = 0;
    let dispatched = subcommands === undefined;
    let positionals = activeSpec.positionals ?? "paths";
    let patternProvided =
        positionals !== "first-pattern" || hasPatternBypass(args, activeSpec);

    const adoptSpec = (s: CommandSpec) => {
        activeSpec = s;
        s.tags?.forEach((tag) => tags.add(tag));
        positionals = s.positionals ?? "paths";
        patternProvided =
            positionals !== "first-pattern" || hasPatternBypass(args, s);
    };

    const inspectValue = (
        value: string,
        pathContext: boolean,
        word?: BashWordNode,
    ): boolean => {
        if (
            (activeSpec.additionalRootOnly && hasDynamicShellExpansion(value))
            || (pathContext && hasUnmodeledPathExpansion(value, word))
        ) {
            addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
            return false;
        }

        const substitution = inspectShellSubstitution(
            value,
            cwd,
            options,
            pathContext,
            diagnostics,
            context,
            word,
        );
        if (substitution === null) return false;
        if (substitution !== undefined) {
            paths.push(...substitution.paths);
            writes = writes || substitution.heuristic === Heuristic.SAFE_EDIT;
        } else if (pathContext) {
            paths.push(value);
        }
        return true;
    };

    const inspectPositionalPath = (value: string, word?: BashWordNode): boolean => {
        const pathCount = paths.length;
        if (!inspectValue(value, true, word)) {
            return false;
        }
        positionalPaths.push(...paths.slice(pathCount));
        return true;
    };

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        const argWord = wordAt(i);

        // Shell redirections and substitutions retain their meaning after a
        // command's `--`; only command flag parsing stops there. AST commands
        // expose redirections separately, so the legacy token handling is
        // only needed for the parsed-arguments entrypoint.
        if (astCommand === undefined && (
            parseBashAst(arg).singleCommand?.singleRedirection?.operator === "<<"
            || parseBashAst(arg).singleCommand?.singleRedirection?.operator === "<<-"
        )) {
            // Parsed-argument input does not retain heredoc body expansion
            // metadata. Falling back prevents hidden substitutions from executing
            // under an otherwise safe outer command.
            addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
            return null;
        }

        if (astCommand === undefined && REDIRECTION_OPERATORS.has(arg)) {
            const target = args[++i];
            if (target === undefined) {
                return null;
            }

            if (!inspectValue(target, true)) {
                return null;
            }
            // File-descriptor duplication (for example 2>&1) is not
            // a filesystem write. All other non-special redirection
            // targets can create or overwrite a file.
            const targetSubstitution = parseBashAst(target).singleCommand?.singleSubstitution;
            const processTarget = targetSubstitution?.kind === "process-input"
                || targetSubstitution?.kind === "process-output";
            if (!processTarget && arg !== "<" && !target.startsWith("&")
                && !SPECIAL_ALLOWED_PATHS.has(target)) {
                writes = true;
            }
            continue;
        }

        const processSubstitution = argWord === undefined
            ? (() => {
                const substitution = parseBashAst(arg).singleCommand?.singleSubstitution;
                return substitution?.kind === "process-input"
                    || substitution?.kind === "process-output";
            })()
            : argWord.kind === "process-substitution";
        if (processSubstitution) {
            if (!inspectValue(arg, false, argWord)) {
                return null;
            }
            continue;
        }

        if (!afterDoubleDash) {
            if (arg === "--") {
                afterDoubleDash = true;
                continue;
            }

            if (arg.startsWith("--")) {
                const eq = arg.indexOf("=");
                const name = eq === -1 ? arg : arg.slice(0, eq);
                const inline = eq === -1 ? undefined : arg.slice(eq + 1);
                const flagSpec = activeSpec.flags?.[name];

                if (!flagSpec && activeSpec.rejectUnknownFlags) {
                    addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_FLAG);
                    return null;
                }
                if (flagSpec?.unsafe) {
                    addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_FLAG);
                    return null;
                }
                if (flagSpec?.writes) {
                    writes = true;
                }
                if (flagSpec?.requiresAdditionalRoot) {
                    requiresAdditionalRoot = true;
                }

                const values = flagSpec?.values ?? 0;
                if (values > 0) {
                    if (inline !== undefined) {
                        // inline value fills slot 0; multi-value flags do
                        // not have a usable inline form
                        if (values > 1) {
                            return null;
                        }
                        if (!inspectValue(inline, hasPathSlot(flagSpec, 0), argWord)) {
                            return null;
                        }
                        continue;
                    }
                    for (let slot = 0; slot < values; slot++) {
                        const value = args[i + 1 + slot];
                        if (value === undefined) {
                            return null;
                        }
                        if (!inspectValue(
                            value,
                            hasPathSlot(flagSpec, slot),
                            wordAt(i + 1 + slot),
                        )) {
                            return null;
                        }
                    }
                    i += values;
                    continue;
                }

                // unknown long flag with inline value: treat value as path
                if (inline !== undefined && !inspectValue(inline, true, argWord)) {
                    return null;
                }
                continue;
            }

            if (arg.length > 1 && arg.startsWith("-")) {
                // whole-arg unsafe flags: find's expression actions are
                // single-dash multi-character tokens, not short clusters
                // (-delete, -exec, -fprint, ...)
                if (activeSpec.flags?.[arg]?.unsafe) {
                    addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_FLAG);
                    return null;
                }

                const cluster = arg.slice(1);
                for (let j = 0; j < cluster.length; j++) {
                    const flagSpec = activeSpec.flags?.[`-${cluster[j]}`];
                    if (flagSpec?.writes) {
                        writes = true;
                    }
                    if (flagSpec?.requiresAdditionalRoot) {
                        requiresAdditionalRoot = true;
                    }
                    if ((flagSpec?.values ?? 0) > 0) {
                        break;
                    }
                }

                const writeState: { value: boolean } = { value: writes };
                const next = handleShortCluster(
                    args,
                    i,
                    activeSpec,
                    paths,
                    cwd,
                    options,
                    writeState,
                    diagnostics,
                    context,
                    wordAt,
                );
                writes = writeState.value;
                if (next === null) {
                    return null;
                }
                i = next;
                continue;
            }
        }

        // positional argument
        if (!dispatched) {
            const sub = subcommands![arg];
            if (sub === undefined) {
                addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_SUBCOMMAND);
                return null;
            }
            adoptSpec(sub);
            activeArgvStart = i;
            dispatched = true;
            continue;
        }

        switch (positionals) {
            case "none":
                return null;
            case "ignore":
                if (!inspectValue(arg, false, argWord)) {
                    return null;
                }
                continue;
            case "first-pattern":
                if (!positionalSeen && !patternProvided) {
                    positionalSeen = true;
                    if (!inspectValue(arg, false, argWord)) {
                        return null;
                    }
                    continue;
                }
                if (!inspectPositionalPath(arg, argWord)) {
                    return null;
                }
                continue;
            case "first-path":
                if (!positionalSeen) {
                    positionalSeen = true;
                    if (!inspectPositionalPath(arg, argWord)) {
                        return null;
                    }
                } else if (!inspectValue(arg, false, argWord)) {
                    return null;
                }
                continue;
            case "assignments": {
                // env-assignment positional (the export builtin): NAME=VALUE
                // is checked like a leading env assignment (dangerous names
                // ineligible, value path-checked); a bare NAME only marks an
                // existing variable for export — nothing to check
                const eq = arg.indexOf("=");
                if (eq === -1) {
                    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
                        return null;
                    }
                    continue;
                }
                const name = arg.slice(0, eq);
                if (eq === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                    return null;
                }
                if (isDangerousEnvName(name)) {
                    return null;
                }
                if (!inspectValue(arg.slice(eq + 1), true, argWord)) {
                    return null;
                }
                continue;
            }
            default:
                if (!inspectPositionalPath(arg, argWord)) {
                    return null;
                }
                continue;
        }
    }

    if (astCommand !== undefined) {
        for (const redirection of astCommand.redirections) {
            const operator = redirection.operator;
            if (
                operator === "<<"
                || operator === "<<-"
                || redirection.heredoc !== undefined
            ) {
                // Falling back prevents hidden substitutions from executing
                // under an otherwise safe outer command.
                addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
                return null;
            }

            const target = redirection.target;
            if (target === undefined) {
                if (operator === "2>&1") {
                    continue;
                }
                return null;
            }
            if (!inspectValue(target.value, true, target)) {
                return null;
            }

            if (
                target.kind !== "process-substitution"
                && operator !== "<"
                && !operator.includes(">&")
                && !SPECIAL_ALLOWED_PATHS.has(target.value)
            ) {
                writes = true;
            }
        }
    }

    // a subcommand-taking command with no subcommand (e.g. bare `git`)
    if (!dispatched) {
        return null;
    }

    // Subcommands may have their own invocation-level safety check. Their
    // spec receives a subcommand-relative normalized argv vector, with the
    // subcommand name at argv[0]. The parent check is performed by
    // isCommandConfined before extraction.
    if (activeSpec !== spec && activeSpec.validate) {
        const activeArgv = args.slice(activeArgvStart);
        if (!activeSpec.validate(activeArgv)) {
            return null;
        }
    }

    // default mode is unsafe unless a read-only mode flag is present
    if (activeSpec.safeModeFlags && !hasSafeModeFlag(args, activeSpec)) {
        addUnsafeReason(diagnostics, UnsafeReason.UNSAFE_MODE);
        return null;
    }

    return {
        paths,
        positionalPaths,
        writes,
        requiresAdditionalRoot,
        tags: [...tags],
    };
}
