import {
    describeUnsafeReason,
    getBashCommandConfinementAssessment,
    getCwdConfinementAssessment,
    Heuristic,
    UnsafeReason,
    type HeuristicAssessment,
} from "../../../modules/sandbox/heuristics";
import {
    BashCommand,
    parseBashAst,
    type BashAst,
    type BashWordNode,
} from "../../../modules/sandbox";
import { inlineCodeOperand } from "../../../modules/decision/script";
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

/**
 * Re-assess an unknown command with the allowlist relaxed, so its literal paths are still checked.
 *
 * The strict assessment short-circuits at `UNKNOWN_COMMAND`, before any path is looked at; admitting the bare
 * executable as a generic path-checked command (`python3 *`) makes the evaluator check every positional against
 * the same roots, sensitive patterns, symlink resolution, and dynamic-expansion rules as a curated command.
 * The command still has to end up `SAFE_READONLY`; a write this layer can see stays blocked.
 */
export function isRelaxedConfinementSafe(
    command: string,
    cwd: string,
    options: SafeBashOptions = {},
): boolean {
    const patterns = executablePatterns(command);
    if (patterns.length === 0) {
        return false;
    }

    const relaxed = getSafeBashAssessment(command, cwd, {
        ...options,
        safeBashCommands: [...(options.safeBashCommands ?? []), ...patterns],
    });
    if (relaxed.classification === Heuristic.SAFE_READONLY) {
        return true;
    }

    return isSingleInlineCommandSafe(command, cwd, options, patterns);
}

/**
 * The fallback for one inline interpreter command whose quoted code reads as a dynamic path.
 *
 * The generic spec scans parsed arguments for shell syntax and has no AST provenance, so `print({"a": 1})`
 * inside a single-quoted operand looks like brace expansion. That argument is code, not a path: the resolver
 * already vouched for it as a literal word (`inlineCodeOperand`), so it is replaced by a path-neutral
 * placeholder and the same parsed-command evaluator checks everything else with AST provenance. Only a single
 * simple command qualifies; a chain, a pipe, a wrapper, or a `cd` prefix keeps the full-line answer, so no
 * directory state or operator semantics are guessed at here.
 */
function isSingleInlineCommandSafe(
    command: string,
    cwd: string,
    options: SafeBashOptions,
    patterns: readonly string[],
): boolean {
    let ast: BashAst;
    try {
        ast = parseBashAst(command);
    } catch {
        return false;
    }
    if (ast.commands.length !== 1) {
        return false;
    }

    const parsed = ast.commands[0];
    if (parsed === undefined) {
        return false;
    }
    const operand = inlineCodeOperand(parsed);
    if (operand === undefined) {
        return false;
    }

    const assessment = getBashCommandConfinementAssessment(withReplacedWord(parsed, operand), {
        cwd,
        config: CHILD_CONFINEMENT,
        additionalRoots: options.additionalRoots,
        sensitiveAdditionalRoots: options.sensitiveAdditionalRoots,
        customSafeBashCommands: [...(options.safeBashCommands ?? []), ...patterns],
    });
    return assessment.classification === Heuristic.SAFE_READONLY;
}

/** The same parsed command with one word's value replaced, for the confinement view. */
function withReplacedWord(command: BashCommand, from: BashWordNode): BashCommand {
    const replacement: BashWordNode = { ...from, value: "inline-code" };

    return new BashCommand({
        ...command.node,
        words: command.node.words.map((word) => (word === from ? replacement : word)),
        parts: command.node.parts.map((part) =>
            part.type === "word" && part === from ? replacement : part,
        ),
    });
}

/** The exact and wildcard safe-bash patterns for every bare executable named in the line. */
function executablePatterns(command: string): string[] {
    const names = new Set<string>();
    const visit = (ast: BashAst): void => {
        for (const parsed of ast.commands) {
            const name = parsed.command;
            if (name !== undefined && /^[A-Za-z0-9._+-]+$/.test(name)) {
                names.add(name);
            }
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
