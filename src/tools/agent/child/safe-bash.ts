import {
    describeUnsafeReason,
    getBashCommandConfinementAssessment,
    getCwdConfinementAssessment,
    getPathConfinementPermission,
    Heuristic,
    KNOWN_COMMANDS,
    UnsafeReason,
    type HeuristicAssessment,
} from "../../../modules/sandbox/heuristics";
import {
    BashCommand,
    parseBashAst,
    unwrapWrapperCommand,
    type BashAst,
    type BashWordNode,
} from "../../../modules/sandbox";
import {
    inlineCodeOperand,
    isLiteralWord,
    readScriptFile,
    resolveScriptRun,
    scriptFileIdentity,
} from "../../../modules/decision/script";
import type { ChildAgentFactoryContext } from "../contracts/runs";
import { getSafeBashRuntimeBlock } from "./safe-bash-rules";
import { CHILD_CONFINEMENT } from "./policy";

export interface SafeBashBlock {
    block: true;
    reason: string;
}

/** Named options for assessing a delegated agent's bash command. */
export interface SafeBashOptions {
    additionalRoots?: readonly string[];
    sensitiveAdditionalRoots?: readonly string[];
    safeBashCommands?: readonly string[];
}

/** Named options for guarding a delegated agent's bash command. */
export interface SafeBashGuardOptions extends SafeBashOptions {
    safeBash: boolean;
    onTrace?: ChildAgentFactoryContext["onTrace"];
    /**
     * A second opinion for a command the cwd heuristic does not allow, consulted before the block.
     *
     * Returns true when the gate may proceed; `undefined` or false blocks exactly as before. The callback owns
     * its own deterministic checks and decision-log record, because the blocker is the only place that knows
     * whether a verdict was consulted at all.
     */
    allowUnsafeCommand?: (
        assessment: HeuristicAssessment,
        command: string,
    ) => Promise<boolean> | undefined;
}

/**
 * The reasons the decision model may be asked about.
 *
 * Only the curated-allowlist axis: a command the heuristic does not know is judged elsewhere, while a
 * confinement failure (outside cwd, sensitive path, symlink escape, dynamic path, dangerous environment,
 * parse failure) is the deterministic layer's own decision and a classifier cannot overwrite it. Known-command
 * flag and mode failures stay deterministic too: the safe-bash guard is stronger than a model opinion for the
 * write shapes (`sed -i`, redirections) it was built to block.
 */
const MODEL_CONSULTABLE_REASONS: ReadonlySet<UnsafeReason> = new Set([
    UnsafeReason.UNKNOWN_COMMAND,
    UnsafeReason.COMMAND_NOT_ALLOWED,
]);

/** Whether every reason for an unsafe assessment belongs to the allowlist axis. */
export function isModelConsultableAssessment(assessment: HeuristicAssessment): boolean {
    return (
        assessment.classification !== Heuristic.SAFE_READONLY &&
        assessment.reasons.length > 0 &&
        assessment.reasons.every((reason) => MODEL_CONSULTABLE_REASONS.has(reason))
    );
}

/** How far the deterministic layer lets one unsafe command reach the decision consult. */
export type RelaxedConfinement = "safe" | "readable" | "unsafe";

/**
 * Classify what the relaxed (generic-spec) confinement view says about a command.
 *
 * The strict pass has already reduced the failure to the curated-allowlist axis; this pass admits every bare
 * executable as a generic path-checked command, so literal paths are still checked against the child's roots.
 * `safe` means that view passed outright. `readable` means it failed only on dynamic paths while the
 * command's one code subject was still read from disk and every unmodeled word is data — the shape
 * `isConsultableSubjectConfinement` accepts, where a capability verdict is meaningful and the deterministic
 * block would be a false negative. `unsafe` means the deterministic block stands.
 */
export function classifyRelaxedConfinement(
    command: string,
    cwd: string,
    options: SafeBashOptions = {},
): RelaxedConfinement {
    const patterns = executablePatterns(command);
    if (patterns.length === 0) {
        return "unsafe";
    }

    const relaxed = getSafeBashAssessment(command, cwd, {
        ...options,
        safeBashCommands: [...(options.safeBashCommands ?? []), ...patterns],
    });
    if (relaxed.classification === Heuristic.SAFE_READONLY) {
        return "safe";
    }
    if (relaxed.classification !== Heuristic.UNSAFE) {
        // A write form (`SAFE_EDIT`), even with no reason attached: the read-only gate only relaxes reads.
        return "unsafe";
    }
    if (
        relaxed.reasons.length === 0 ||
        !relaxed.reasons.every((reason) => reason === UnsafeReason.DYNAMIC_PATH)
    ) {
        return "unsafe";
    }

    let ast: BashAst;
    try {
        ast = parseBashAst(command);
    } catch {
        return "unsafe";
    }

    return isConsultableSubjectConfinement(ast, cwd, options, patterns) ? "readable" : "unsafe";
}

/** Whether the deterministic layer lets this command reach the consult (a `safe` or `readable` verdict). */
export function isRelaxedConfinementSafe(
    command: string,
    cwd: string,
    options: SafeBashOptions = {},
): boolean {
    return classifyRelaxedConfinement(command, cwd, options) !== "unsafe";
}

/**
 * Whether one command whose only remaining failures are dynamic paths is still a consultable subject.
 *
 * The generic spec has no AST provenance, so quoted punctuation inside an inline operand and dynamic data
 * arguments both surface as `DYNAMIC_PATH`. This accepts exactly the shapes where that does not matter:
 *
 * - exactly one top-level command is unknown to the curated registry — the one subject the resolver and the
 *   evaluator can classify. A second unknown segment would run code nobody reads.
 * - the subject's code body was read (`resolveScriptRun` returned artifacts) and every file it came from is
 *   confined to the child's roots. An unread body must not gain authority through the invocation answer.
 * - the code/file operand is literal, and every flag and environment assignment is literal. For an inline
 *   subject no later positional may be dynamic either: `node -e CODE --require $X` still parses options after
 *   the code (verified locally). A file subject may take dynamic data arguments, because option parsing stops
 *   at the script path (`node script.js --require $X`).
 * - the subject owns no redirection except a heredoc, so no dynamic redirect target is waved through.
 * - with the code operand and every dynamic data positional replaced by placeholders, the parsed-command
 *   evaluator still calls the subject `SAFE_READONLY` with AST provenance; the full-line pass short-circuits
 *   at the first dynamic reason, so a literal outside path beside the code operand would otherwise slip by.
 */
function isConsultableSubjectConfinement(
    ast: BashAst,
    cwd: string,
    options: SafeBashOptions,
    patterns: readonly string[],
): boolean {
    const entries = ast.commands.map((parsed) => ({
        parsed,
        subject: unwrapWrapperCommand(parsed) ?? parsed,
    }));
    const subjects = entries.filter(({ subject }) => {
        const name = subject.command;
        return name !== undefined && !Object.hasOwn(KNOWN_COMMANDS, name);
    });
    if (subjects.length !== 1) {
        return false;
    }

    const [entry] = subjects;
    if (entry === undefined) {
        return false;
    }

    for (const { parsed, subject } of entries) {
        if (subject.environment.some(({ word }) => !isLiteralWord(word))) {
            return false;
        }
        if (subject.flagWords.some((word) => !isLiteralWord(word))) {
            return false;
        }
        if (parsed !== entry.parsed && subject.words.some((word) => !isLiteralWord(word))) {
            return false;
        }
    }

    const subject = entry.subject;
    if (subject.redirections.some((part) => part.heredoc === undefined)) {
        return false;
    }

    const run = resolveScriptRun(ast.input, {
        cwd,
        readFile: readScriptFile,
        statFile: scriptFileIdentity,
    });
    if (run === undefined || run.artifacts.length === 0) {
        return false;
    }

    const positionals = subject.positionalWords;
    const first = positionals[0];
    if (first === undefined || !isLiteralWord(first)) {
        return false;
    }
    if (run.kind === "inline" && positionals.slice(1).some((word) => !isLiteralWord(word))) {
        return false;
    }
    if (run.kind === "package" && subject.words.some((word) => !isLiteralWord(word))) {
        return false;
    }

    // The rest of the subject is still checked with AST provenance: the code operand and every dynamic data
    // positional become path-neutral placeholders. The full-line pass short-circuits at the first dynamic
    // reason, so a literal outside path beside the code operand would otherwise slip by.
    const replaced = new Set<BashWordNode>();
    const code = inlineCodeOperand(subject);
    if (code !== undefined) {
        replaced.add(code);
    }
    if (run.kind === "file" || run.kind === "package") {
        for (const word of positionals.slice(1)) {
            if (!isLiteralWord(word)) {
                replaced.add(word);
            }
        }
    }

    const assessment = getBashCommandConfinementAssessment(
        withReplacedWords(entry.parsed, replaced),
        {
            cwd,
            config: CHILD_CONFINEMENT,
            additionalRoots: options.additionalRoots,
            sensitiveAdditionalRoots: options.sensitiveAdditionalRoots,
            customSafeBashCommands: [...(options.safeBashCommands ?? []), ...patterns],
        },
    );
    if (assessment.classification !== Heuristic.SAFE_READONLY) {
        return false;
    }

    return run.artifacts.every(
        (artifact) =>
            artifact.path === undefined ||
            getPathConfinementPermission(artifact.path, {
                cwd,
                config: CHILD_CONFINEMENT,
                access: "read",
                additionalRoots: options.additionalRoots,
                sensitiveAdditionalRoots: options.sensitiveAdditionalRoots,
            }) === Heuristic.SAFE_READONLY,
    );
}

/** The same parsed command with the given words replaced by a path-neutral placeholder. */
function withReplacedWords(command: BashCommand, words: ReadonlySet<BashWordNode>): BashCommand {
    if (words.size === 0) {
        return command;
    }

    const replacements = new Map<BashWordNode, BashWordNode>();
    const replace = (word: BashWordNode): BashWordNode => {
        let replacement = replacements.get(word);
        if (replacement === undefined) {
            replacement = { ...word, value: "data" };
            replacements.set(word, replacement);
        }
        return replacement;
    };

    return new BashCommand({
        ...command.node,
        words: command.node.words.map((word) => (words.has(word) ? replace(word) : word)),
        parts: command.node.parts.map((part) =>
            part.type === "word" && words.has(part) ? replace(part) : part,
        ),
    });
}

/** The exact and wildcard safe-bash patterns for every bare executable named in the line. */
function executablePatterns(command: string): string[] {
    const names = new Set<string>();
    const add = (name: string | undefined): void => {
        if (name !== undefined && /^[A-Za-z0-9._+-]+$/.test(name)) {
            names.add(name);
        }
    };
    const visit = (ast: BashAst): void => {
        for (const parsed of ast.commands) {
            add(parsed.command);
            // A transparent wrapper (`timeout 5 …`) is resolved to its inner command before the registry
            // lookup, so the inner executable is the one that needs a pattern.
            add(unwrapWrapperCommand(parsed)?.command);
            for (const word of parsed.words) {
                for (const substitution of word.substitutions) {
                    try {
                        visit(parseBashAst(substitution.content));
                    } catch {
                        // An unparsable substitution is left to the evaluator's own parse-failure reason.
                    }
                }
            }
        }
    };

    try {
        visit(parseBashAst(command));
    } catch {
        return [];
    }

    return [...names].flatMap((name) => [name, `${name} *`]);
}

/** Assess whether a delegated agent's bash command is cwd-confined and safe. */
export function getSafeBashAssessment(
    command: string,
    cwd: string,
    options: SafeBashOptions = {},
): HeuristicAssessment {
    const { additionalRoots = [], sensitiveAdditionalRoots, safeBashCommands = [] } = options;

    return getCwdConfinementAssessment(command, {
        cwd,
        config: CHILD_CONFINEMENT,
        additionalRoots,
        sensitiveAdditionalRoots,
        customSafeBashCommands: safeBashCommands,
    });
}

/** @deprecated Use getSafeBashAssessment. */
export const getScoutBashAssessment = getSafeBashAssessment;

export function isSafeBashAllowed(
    command: string,
    cwd: string,
    options: SafeBashOptions = {},
): boolean {
    return getSafeBashAssessment(command, cwd, options).classification === Heuristic.SAFE_READONLY;
}

/** @deprecated Use isSafeBashAllowed. */
export const isScoutBashAllowed = isSafeBashAllowed;

/**
 * Applies the safe-bash capability gate. Syntax/path classification belongs to
 * the heuristic; tag-selected contextual checks live in safe-bash-rules.ts.
 */
export async function guardSafeBashCommand(
    command: string,
    cwd: string,
    options: SafeBashGuardOptions,
): Promise<SafeBashBlock | undefined> {
    const { safeBash, onTrace, additionalRoots, sensitiveAdditionalRoots, safeBashCommands } =
        options;

    if (!safeBash) {
        return {
            block: true,
            reason: "Read-only agent bash blocked: the safe-bash capability is not enabled.",
        };
    }

    const assessment = getSafeBashAssessment(command, cwd, {
        additionalRoots,
        sensitiveAdditionalRoots,
        safeBashCommands,
    });
    const allowedByModel =
        assessment.classification !== Heuristic.SAFE_READONLY &&
        options.allowUnsafeCommand !== undefined &&
        (await options.allowUnsafeCommand(assessment, command));
    if (assessment.classification !== Heuristic.SAFE_READONLY && !allowedByModel) {
        const reasons = assessment.reasons
            .map((reason) => `${describeUnsafeReason(reason)} [${reason}]`)
            .join("; ");
        onTrace?.("safe_bash.blocked", {
            classification: assessment.classification,
            reasons: assessment.reasons.join(", "),
        });
        return {
            block: true,
            reason: `Read-only agent bash blocked: ${reasons}. Commands must be cwd-confined and classified SAFE_READONLY.`,
        };
    }

    const runtimeBlock = await getSafeBashRuntimeBlock(assessment, cwd);
    if (runtimeBlock) {
        onTrace?.("safe_bash.blocked", {
            classification: assessment.classification,
            reasons: runtimeBlock.traceReason,
        });
        return { block: true, reason: runtimeBlock.reason };
    }

    onTrace?.("safe_bash.allowed", { classification: assessment.classification });
    return undefined;
}
