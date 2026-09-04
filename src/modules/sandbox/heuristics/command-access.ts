import { BashAst, parseBashAst } from "../bash";
import type { BashAstNode, BashCommand, BashSubstitutionNode, BashWordNode } from "../bash";
import { CommandTag } from "../commands";
import type { CommandSpec, FlagSpec } from "../commands";
import { Heuristic, UnsafeReason, addUnsafeReason, type ConfinementDiagnostics } from "./types";
import { expandGlobPattern } from "./glob-expansion";
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
        if (
            (!wildcard && args.length !== pattern.length) ||
            (wildcard && args.length <= fixedLength)
        ) {
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
            const wildcard = args[args.length - 1] === "*" && !words[words.length - 1].quoted;
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
    const shortBypass = bypass.filter((f) => !f.startsWith("--")).map((f) => f[1]);
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
    const shortSafe = safe.filter((f) => !f.startsWith("--")).map((f) => f[1]);
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
 * Returns the next unprocessed argument index, or null if the command is ineligible.
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

    const inspectValue = (
        value: string,
        pathContext: boolean,
        word: BashWordNode | undefined,
        slotWrites: boolean,
    ): boolean => {
        const operands = resolveSlotOperands(
            value,
            pathContext,
            word,
            spec,
            slotWrites,
            cwd,
            options,
            diagnostics,
        );
        if (operands === null) {
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
            paths.push(...operands);
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
                if (
                    value === undefined ||
                    !inspectValue(
                        value,
                        hasPathSlot(flagSpec, 0),
                        wordAt?.(index + 1),
                        flagSpec?.writes === true,
                    )
                ) {
                    return null;
                }
                return index + 2;
            }
            if (
                !inspectValue(
                    cluster.slice(j + 1),
                    hasPathSlot(flagSpec, 0),
                    wordAt?.(index),
                    flagSpec?.writes === true,
                )
            ) {
                return null;
            }
            return index + 1;
        }

        // boolean (known or unknown): continue with the cluster
    }

    return index + 1;
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
    return (
        value.includes("$(") || value.includes("`") || value.includes("<(") || value.includes(">(")
    );
}

/**
 * Shell syntax that can turn one parsed-argument value into different
 * filesystem operands after confinement has been checked. The parsed-argument
 * path has no AST provenance, so rejecting these forms may produce safe false
 * negatives; that is preferable to guessing at Bash expansion semantics.
 */
export function hasDynamicShellExpansion(value: string): boolean {
    return (
        hasShellSubstitution(value) ||
        value.includes("$") ||
        value.includes("`") ||
        value.includes("{") ||
        value.includes("}") ||
        value.includes("*") ||
        value.includes("?") ||
        value.includes("[") ||
        value.includes("]") ||
        value.startsWith("~") ||
        /[@+!]\(/.test(value)
    );
}

/**
 * Whether the only expansion left on this word is a leading `~` the shell expands against the
 * home directory, so the operand is still a single statically known path and can be confined
 * after expansion.
 *
 * The word may carry no quoted content at all. Bash expands `~` only while the login name that
 * follows it stays unquoted, so `~'/'x` is passed through verbatim even though quote removal
 * stores it as `~/x`, and a literal `./~` is a repository-controllable name the same way any
 * other file is. Deciding from the stored value alone would certify an operand the shell never
 * produces.
 */
function isExpandableHomePath(value: string, word: BashWordNode): boolean {
    if (word.quoted || !word.expansions.tilde || word.substitutions.length > 0) {
        return false;
    }

    const { glob, brace, variable } = word.expansions;
    if (glob || brace || variable) {
        return false;
    }

    return value === "~" || value.startsWith("~/");
}

export function hasUnmodeledPathExpansion(value: string, word?: BashWordNode): boolean {
    if (word !== undefined) {
        const substitution = BashAst.substitutionFor(word, value);
        if (substitution?.complete) {
            return false;
        }
        if (word.substitutions.length > 0) {
            return true;
        }
        if (isExpandableHomePath(value, word)) {
            return false;
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
function getStaticSubstitutionPathsFromAst(ast: BashAstNode, cwd: string): string[] | null {
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

function getStaticSubstitutionPathsFromValue(value: string, cwd: string): string[] | null {
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
    evaluateNested: (
        command: string,
        cwd: string,
        options: ConfinementOptions,
        diagnostics?: ConfinementDiagnostics,
    ) => Heuristic | undefined;
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
    const substitution = word === undefined ? undefined : BashAst.substitutionFor(word, value);
    const valueSubstitution =
        substitution ??
        (word === undefined ? parseBashAst(value).singleCommand?.singleSubstitution : undefined);
    const processSubstitution =
        valueSubstitution?.kind === "process-input" || valueSubstitution?.kind === "process-output";
    const commandSubstitution =
        valueSubstitution?.kind === "command" || valueSubstitution?.kind === "backtick";

    if (valueSubstitution !== undefined && !valueSubstitution.complete) {
        addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
        return null;
    }

    if (!processSubstitution && !commandSubstitution) {
        if (
            (word !== undefined && word.substitutions.length > 0) ||
            (word === undefined && hasShellSubstitution(value))
        ) {
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

    const paths =
        word === undefined
            ? getStaticSubstitutionPathsFromValue(value, cwd)
            : getStaticSubstitutionPaths(valueSubstitution, cwd);
    if (paths === null) {
        addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
        return null;
    }
    return { heuristic: inner, paths };
}

/**
 * Operands for a value whose only live expansion is a glob, or null when it is not expandable.
 *
 * `slotWrites` is the read-only scope control, and it is per slot rather than per command: a command
 * that writes somewhere still performs ordinary reads on its other operands, and gating on the
 * command-level flag made `sort -o out.txt a*.ts` and `sort a*.ts -o out.txt` answer two different
 * ways for the same intent.
 *
 * The word must carry no quoted content at all. Per-character provenance says *whether* a
 * metacharacter is live, not which characters arrived inside quotes, and a quoted bracket
 * expression reads narrower than the literal it stands for: `'[a]'*.ts` matches names beginning
 * with the three characters `[a]`, while translating `[a]` into a class would match `a.ts` and
 * miss the file the shell really passes. Checking a set that is not a superset of the operand set
 * is the one unsound direction, so mixed-quoting words keep prompting. That also keeps patterns
 * that are never paths at all, such as `find . -name "*.jsonl"`, out of the enumerator.
 */
function expandGlobOperands(
    value: string,
    word: BashWordNode | undefined,
    slotWrites: boolean,
    cwd: string,
    options: ConfinementOptions,
): string[] | null {
    if (!options.globExpansion || slotWrites || word === undefined) {
        return null;
    }
    if (word.quoted || word.substitutions.length > 0) {
        return null;
    }

    const { tilde, glob, brace, variable } = word.expansions;
    if (!glob || tilde || brace || variable) {
        return null;
    }

    return expandGlobPattern(value, cwd, options.globMaxDepth);
}

/**
 * Whether a *positional* path of this spec is consumed as a destination. Derived from the registry
 * instead of from the command-level `writes` flag, which says only that the command writes somewhere.
 * `commands-registry.test.ts` fails if a spec gains a positional destination without one of these
 * markers, which is what keeps expansion out of destination slots.
 *
 * OPEN - currently unobservable, deliberately kept. Replacing the body with `return false` leaves
 * `npm run test:run` green, because every spec this returns true for is refused earlier by the blanket
 * check in `evaluator.ts` (`hasAdditionalRootPolicy && argv.some(hasDynamicShellExpansion)`). Measured
 * across the registry: `rm`, `mkdir`, `rmdir`, `touch`, `truncate`, `tee`, `mv`, `chmod` are all
 * `writes: true` + `additionalRootOnly`; `cp` is `writes: true` + `additionalRootLastPositional`; and
 * `sed` is the only one without spec-level writes, reaching in-place editing through a
 * `requiresAdditionalRoot` flag while carrying a hard-link destination marker. All three shapes satisfy
 * `hasAdditionalRootPolicy`, so a dynamic positional never survives extraction for any of them.
 *
 * It stays because this is the guard that expresses the policy at the decision point: if a future spec
 * writes to a positional without a root policy (a plausible `patch`, `convert`, or `rsync --delete`
 * style curation), this is what stops "one approved destination" from becoming "one destination per
 * match" without anyone having to remember the evaluator's blanket rule. Removing it is a judgement
 * call, not a cleanup - if you drop it, `commands-registry.test.ts` must be widened to forbid such a
 * spec outright, and the read-only scope decision in `src/modules/sandbox/PLAN.md` ("reads only,
 * mutators later") should be re-read first, because today's redundancy is what makes that decision
 * safe.
 */
function positionalsAreDestinations(spec: CommandSpec): boolean {
    return (
        spec.writes === true ||
        spec.additionalRootOnly === true ||
        spec.additionalRootLastPositional === true ||
        spec.rejectDirectoryDestination === true ||
        spec.rejectHardLinkedDestination === true ||
        spec.rejectHardLinkedPositionals === true
    );
}

/**
 * Resolve one argument value to the filesystem operands it can access, or `null` to refuse it, in
 * which case the reason is already recorded.
 *
 * A data value, a static path, and a modeled command substitution all resolve to the value itself.
 * A live glob resolves to the operand set the shell may pass, which then faces the ordinary path
 * checks, so containment and sensitive-name decisions stay in one place. `slotWrites` marks a slot
 * whose operand is consumed as a write destination, and those never expand: one approved intent must
 * not become a set of mutations.
 */
function resolveSlotOperands(
    value: string,
    pathContext: boolean,
    word: BashWordNode | undefined,
    spec: CommandSpec,
    slotWrites: boolean,
    cwd: string,
    options: ConfinementOptions,
    diagnostics?: ConfinementDiagnostics,
): string[] | null {
    if (spec.additionalRootOnly && hasDynamicShellExpansion(value)) {
        addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
        return null;
    }
    if (!pathContext || !hasUnmodeledPathExpansion(value, word)) {
        return [value];
    }

    const operands = expandGlobOperands(value, word, slotWrites, cwd, options);
    if (operands !== null) {
        return operands;
    }

    addUnsafeReason(diagnostics, UnsafeReason.DYNAMIC_PATH);
    return null;
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

class CommandPathExtractor {
    private readonly paths: string[] = [];
    private readonly positionalPaths: string[] = [];
    private readonly commandWords: readonly BashWordNode[] | undefined;
    private readonly tags: Set<CommandTag>;
    private writes: boolean;
    private requiresAdditionalRoot = false;
    private afterDoubleDash = false;
    private positionalSeen = false;
    // Subcommand dispatch begins with the parent spec and switches to the
    // child spec after its name. The validator later receives argv from this
    // normalized subcommand index (for example ["diff", ...] for git diff).
    private activeSpec: CommandSpec;
    private activeArgvStart = 0;
    private dispatched: boolean;
    private positionals: NonNullable<CommandSpec["positionals"]>;
    private patternProvided: boolean;

    public constructor(
        private readonly args: string[],
        private readonly spec: CommandSpec,
        private readonly cwd: string,
        private readonly options: ConfinementOptions,
        private readonly diagnostics?: ConfinementDiagnostics,
        private readonly context?: CommandAccessContext,
        private readonly astCommand?: BashCommand,
    ) {
        this.commandWords = astCommand?.words.slice(astCommand.environment.length);
        this.tags = new Set<CommandTag>(spec.tags);
        this.writes = spec.writes === true;
        this.activeSpec = spec;
        this.dispatched = spec.subcommands === undefined;
        this.positionals = spec.positionals ?? "paths";
        this.patternProvided =
            this.positionals !== "first-pattern" || hasPatternBypass(args, this.activeSpec);
    }

    public extract(): ExtractedCommandAccess | null {
        for (let index = 1; index < this.args.length;) {
            const nextIndex = this.inspectArgument(index);
            if (nextIndex === null) {
                return null;
            }
            index = nextIndex;
        }

        if (!this.inspectAstRedirections()) {
            return null;
        }
        return this.finish();
    }

    /** Return the next unprocessed argument index, or null when unsafe. */
    private inspectArgument(index: number): number | null {
        const arg = this.args[index];
        const argWord = this.wordAt(index);

        if (this.rejectLegacyHeredoc(arg)) {
            return null;
        }
        const redirectionIndex = this.inspectLegacyRedirection(index, arg);
        if (redirectionIndex !== undefined) {
            return redirectionIndex;
        }
        if (this.isProcessSubstitution(arg, argWord)) {
            return this.inspectValue(arg, false, argWord, false) ? index + 1 : null;
        }

        const optionIndex = this.inspectOption(index, arg, argWord);
        if (optionIndex !== undefined) {
            return optionIndex;
        }
        if (!this.dispatched) {
            const sub = this.spec.subcommands![arg];
            if (sub === undefined) {
                addUnsafeReason(this.diagnostics, UnsafeReason.UNSAFE_SUBCOMMAND);
                return null;
            }
            this.adoptSpec(sub);
            this.activeArgvStart = index;
            this.dispatched = true;
            return index + 1;
        }
        return this.inspectPositional(arg, argWord) ? index + 1 : null;
    }

    private inspectOption(
        index: number,
        arg: string,
        argWord?: BashWordNode,
    ): number | null | undefined {
        if (this.afterDoubleDash) {
            return undefined;
        }
        if (arg === "--") {
            this.afterDoubleDash = true;
            return index + 1;
        }
        if (arg.startsWith("--")) {
            const nextIndex = this.inspectLongFlag(index, arg, argWord);
            return nextIndex === null ? null : nextIndex;
        }
        if (arg.length <= 1 || !arg.startsWith("-")) {
            return undefined;
        }
        const nextIndex = this.inspectShortFlag(index, arg);
        return nextIndex === null ? null : nextIndex;
    }

    private wordAt(index: number): BashWordNode | undefined {
        return this.commandWords?.[index];
    }

    private adoptSpec(spec: CommandSpec): void {
        this.activeSpec = spec;
        spec.tags?.forEach((tag) => this.tags.add(tag));
        this.positionals = spec.positionals ?? "paths";
        this.patternProvided =
            this.positionals !== "first-pattern" || hasPatternBypass(this.args, spec);
    }

    /**
     * Inspect one value. `slotWrites` says whether this particular slot is consumed as a write
     * destination, which is what gates glob expansion; the command-level `this.writes` is a separate
     * question and only decides SAFE_READONLY versus SAFE_EDIT afterwards.
     */
    private inspectValue(
        value: string,
        pathContext: boolean,
        word: BashWordNode | undefined,
        slotWrites: boolean,
    ): boolean {
        const operands = resolveSlotOperands(
            value,
            pathContext,
            word,
            this.activeSpec,
            slotWrites,
            this.cwd,
            this.options,
            this.diagnostics,
        );
        if (operands === null) {
            return false;
        }

        const substitution = inspectShellSubstitution(
            value,
            this.cwd,
            this.options,
            pathContext,
            this.diagnostics,
            this.context,
            word,
        );
        if (substitution === null) {
            return false;
        }
        if (substitution !== undefined) {
            this.paths.push(...substitution.paths);
            this.writes = this.writes || substitution.heuristic === Heuristic.SAFE_EDIT;
        } else if (pathContext) {
            this.paths.push(...operands);
        }
        return true;
    }

    private inspectPositionalPath(value: string, word?: BashWordNode): boolean {
        const pathCount = this.paths.length;
        if (!this.inspectValue(value, true, word, positionalsAreDestinations(this.activeSpec))) {
            return false;
        }
        this.positionalPaths.push(...this.paths.slice(pathCount));
        return true;
    }

    private rejectLegacyHeredoc(arg: string): boolean {
        if (this.astCommand !== undefined) {
            return false;
        }
        const operator = parseBashAst(arg).singleCommand?.singleRedirection?.operator;
        if (operator !== "<<" && operator !== "<<-") {
            return false;
        }
        addUnsafeReason(this.diagnostics, UnsafeReason.DYNAMIC_PATH);
        return true;
    }

    /**
     * Inspect parsed-argument redirections. AST commands expose redirections
     * separately; legacy argv still needs shell syntax checked after `--`.
     * Returns the next unprocessed index, null when unsafe, or undefined when
     * the current argument is not a redirection.
     */
    private inspectLegacyRedirection(index: number, arg: string): number | null | undefined {
        if (this.astCommand !== undefined || !REDIRECTION_OPERATORS.has(arg)) {
            return undefined;
        }
        const target = this.args[index + 1];
        const targetSubstitution =
            target === undefined
                ? undefined
                : parseBashAst(target).singleCommand?.singleSubstitution;
        const processTarget =
            targetSubstitution?.kind === "process-input" ||
            targetSubstitution?.kind === "process-output";
        // Known before inspecting the operand, so a glob cannot reach a destination slot.
        const writesTarget =
            target !== undefined &&
            !processTarget &&
            arg !== "<" &&
            !target.startsWith("&") &&
            !SPECIAL_ALLOWED_PATHS.has(target);
        if (target === undefined || !this.inspectValue(target, true, undefined, writesTarget)) {
            return null;
        }

        if (writesTarget) {
            this.writes = true;
        }
        return index + 2;
    }

    private isProcessSubstitution(arg: string, word?: BashWordNode): boolean {
        if (word !== undefined) {
            return word.kind === "process-substitution";
        }
        const substitution = parseBashAst(arg).singleCommand?.singleSubstitution;
        return substitution?.kind === "process-input" || substitution?.kind === "process-output";
    }

    /** Return the next unprocessed index, or null when the flag is unsafe. */
    private inspectLongFlag(index: number, arg: string, argWord?: BashWordNode): number | null {
        const eq = arg.indexOf("=");
        const name = eq === -1 ? arg : arg.slice(0, eq);
        const inline = eq === -1 ? undefined : arg.slice(eq + 1);
        const flagSpec = this.activeSpec.flags?.[name];

        if (!flagSpec && this.activeSpec.rejectUnknownFlags) {
            addUnsafeReason(this.diagnostics, UnsafeReason.UNSAFE_FLAG);
            return null;
        }
        if (flagSpec?.unsafe) {
            addUnsafeReason(this.diagnostics, UnsafeReason.UNSAFE_FLAG);
            return null;
        }
        if (flagSpec?.writes) {
            this.writes = true;
        }
        if (flagSpec?.requiresAdditionalRoot) {
            this.requiresAdditionalRoot = true;
        }

        const values = flagSpec?.values ?? 0;
        if (values === 0) {
            if (
                inline !== undefined &&
                !this.inspectValue(inline, true, argWord, flagSpec?.writes === true)
            ) {
                return null;
            }
            return index + 1;
        }
        if (inline !== undefined) {
            if (
                values > 1 ||
                !this.inspectValue(
                    inline,
                    hasPathSlot(flagSpec, 0),
                    argWord,
                    flagSpec?.writes === true,
                )
            ) {
                return null;
            }
            return index + 1;
        }
        for (let slot = 0; slot < values; slot++) {
            const value = this.args[index + 1 + slot];
            if (
                value === undefined ||
                !this.inspectValue(
                    value,
                    hasPathSlot(flagSpec, slot),
                    this.wordAt(index + 1 + slot),
                    flagSpec?.writes === true,
                )
            ) {
                return null;
            }
        }
        return index + values + 1;
    }

    /** Return the next unprocessed index, or null when the flag is unsafe. */
    private inspectShortFlag(index: number, arg: string): number | null {
        if (this.activeSpec.flags?.[arg]?.unsafe) {
            addUnsafeReason(this.diagnostics, UnsafeReason.UNSAFE_FLAG);
            return null;
        }

        const cluster = arg.slice(1);
        for (let position = 0; position < cluster.length; position++) {
            const flagSpec = this.activeSpec.flags?.[`-${cluster[position]}`];
            if (flagSpec?.writes) {
                this.writes = true;
            }
            if (flagSpec?.requiresAdditionalRoot) {
                this.requiresAdditionalRoot = true;
            }
            if ((flagSpec?.values ?? 0) > 0) {
                break;
            }
        }

        const writeState = { value: this.writes };
        const nextIndex = handleShortCluster(
            this.args,
            index,
            this.activeSpec,
            this.paths,
            this.cwd,
            this.options,
            writeState,
            this.diagnostics,
            this.context,
            (wordIndex) => this.wordAt(wordIndex),
        );
        this.writes = writeState.value;
        return nextIndex;
    }

    private inspectPositional(arg: string, argWord?: BashWordNode): boolean {
        switch (this.positionals) {
            case "none":
                return false;
            case "ignore":
                return this.inspectValue(arg, false, argWord, false);
            case "first-pattern":
                if (!this.positionalSeen && !this.patternProvided) {
                    this.positionalSeen = true;
                    return this.inspectValue(arg, false, argWord, false);
                }
                return this.inspectPositionalPath(arg, argWord);
            case "first-path":
                if (!this.positionalSeen) {
                    this.positionalSeen = true;
                    return this.inspectPositionalPath(arg, argWord);
                }
                return this.inspectValue(arg, false, argWord, false);
            case "assignments":
                return this.inspectAssignment(arg, argWord);
            default:
                return this.inspectPositionalPath(arg, argWord);
        }
    }

    private inspectAssignment(arg: string, argWord?: BashWordNode): boolean {
        const eq = arg.indexOf("=");
        if (eq === -1) {
            return /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg);
        }
        const name = arg.slice(0, eq);
        if (eq === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            return false;
        }
        if (isDangerousEnvName(name)) {
            return false;
        }
        return this.inspectValue(arg.slice(eq + 1), true, argWord, false);
    }

    private inspectAstRedirections(): boolean {
        if (this.astCommand === undefined) {
            return true;
        }
        for (const redirection of this.astCommand.redirections) {
            const operator = redirection.operator;
            if (operator === "<<" || operator === "<<-" || redirection.heredoc !== undefined) {
                addUnsafeReason(this.diagnostics, UnsafeReason.DYNAMIC_PATH);
                return false;
            }

            const target = redirection.target;
            if (target === undefined) {
                if (operator === "2>&1") {
                    continue;
                }
                return false;
            }
            const writesTarget =
                target.kind !== "process-substitution" &&
                operator !== "<" &&
                !operator.includes(">&") &&
                !SPECIAL_ALLOWED_PATHS.has(target.value);
            if (writesTarget) {
                // Mark the write before inspecting the target, so a glob in a write position cannot
                // expand: bash creates one literal file there, and the read-only scope means the
                // operand set is not ours to choose.
                this.writes = true;
            }
            if (!this.inspectValue(target.value, true, target, writesTarget)) {
                return false;
            }
        }
        return true;
    }

    private finish(): ExtractedCommandAccess | null {
        if (!this.dispatched) {
            return null;
        }
        if (this.activeSpec !== this.spec && this.activeSpec.validate) {
            const activeArgv = this.args.slice(this.activeArgvStart);
            if (!this.activeSpec.validate(activeArgv)) {
                return null;
            }
        }
        if (this.activeSpec.safeModeFlags && !hasSafeModeFlag(this.args, this.activeSpec)) {
            addUnsafeReason(this.diagnostics, UnsafeReason.UNSAFE_MODE);
            return null;
        }
        return {
            paths: this.paths,
            positionalPaths: this.positionalPaths,
            writes: this.writes,
            requiresAdditionalRoot: this.requiresAdditionalRoot,
            tags: [...this.tags],
        };
    }
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
    return new CommandPathExtractor(
        args,
        spec,
        cwd,
        options,
        diagnostics,
        context,
        astCommand,
    ).extract();
}
