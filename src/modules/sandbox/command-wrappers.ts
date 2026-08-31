import { BashCommand, type BashWordNode } from "./bash";

/**
 * Transparent command wrappers.
 *
 * A wrapper is transparent when running it grants exactly the access its inner command grants: the
 * wrapper itself opens no file, changes no directory, and interprets no code. Modeling them lets
 * `timeout 600 npm run test:run` be judged—and suggested—as `npm run test:run`, which is the only
 * way a session rule remembered for the inner command also covers the wrapped form.
 *
 * Recognition is deliberately all-or-nothing per wrapper: any token the grammar below does not model
 * makes the prefix non-transparent, so the segment keeps the conservative behavior of being
 * classified as an unknown command. Wrappers and forms are excluded on purpose rather than partially
 * modeled:
 *
 * - `timeout -c/--chdir` (moves the confinement cwd), `--profile` (writes a file), `--group`,
 *   combined short options, and `--` (its operand rules are not modeled here).
 * - `nohup` writes `nohup.out`, and `env`, `time`, `nice`, `stdbuf`, and `xargs` each need their own
 *   option grammar before they can be trusted to add nothing.
 * - A wrapper around a directory builtin (`cd`, `pushd`, `popd`) leaves the calling shell where it
 *   was, so unwrapping it would advance modeled directory state that never moved.
 * - A wrapper preceded by environment assignments stays unwrapped as a whole segment. Dropping the
 *   assignments would let a rule for `npm test` authorize `FOO=evil npm test`, and keeping them would
 *   make the suggested rule differ from the token list rules are matched against; either way the
 *   suggestion and the grant stop agreeing, so those combinations keep prompting as they did before.
 */

/** Mirrors `ENV_ASSIGNMENT` in the confinement path policy; kept local so this module stays a leaf. */
const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;

const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
// Signal names with or without the `SIG` prefix (`TERM`, `KILL`, `SIGTERM`), or a signal number.
const SIGNAL = /^(?:\d{1,3}|(?:SIG)?[A-Z][A-Z0-9]*)$/;
const TIMEOUT_FLAGS = new Set(["-v", "--verbose", "--preserve-status", "--foreground"]);
const TIMEOUT_VALUE_OPTIONS = new Map<string, RegExp>([
    ["-k", DURATION],
    ["--kill-after", DURATION],
    ["-s", SIGNAL],
    ["--signal", SIGNAL],
]);
const TIMEOUT_INLINE_VALUE = /^(--kill-after|--signal)=(.*)$/;
const DIRECTORY_BUILTINS = new Set(["cd", "pushd", "popd"]);

export interface WrapperPrefix {
    /** Index of the first token of the wrapped command. */
    start: number;
}

/**
 * Nesting is pathological (`timeout 5 timeout 3 …`) but legal, and every consumer must reach the
 * same answer for it. This bound keeps a long prefix chain from looping while still unwrapping
 * realistic depth.
 */
const MAX_TRANSPARENT_WRAPPERS = 4;

/**
 * Repeatedly apply the wrapper grammar until the tokens describe a command that is not wrapped.
 *
 * Returns the index of the first innermost-command token, or undefined when the head token is not a
 * transparent wrapper. Leading environment assignments are refused textually here because this helper
 * sees plain values; the parsed-node entrypoint uses the lexer's assignment view instead.
 */
function wrappedStart(values: readonly string[]): number | undefined {
    if (values.length === 0 || ASSIGNMENT_TOKEN.test(values[0])) {
        return undefined;
    }

    let start = 0;
    for (let depth = 0; depth < MAX_TRANSPARENT_WRAPPERS; depth += 1) {
        const prefix = recognizeWrapperPrefix(values.slice(start));
        if (prefix === undefined) {
            break;
        }
        start += prefix.start;
    }
    return start === 0 ? undefined : start;
}

/**
 * Recognize a transparent wrapper at the head of a command token list.
 *
 * `tokens[0]` must be the command name itself, with no leading environment assignments.
 */
export function recognizeWrapperPrefix(tokens: readonly string[]): WrapperPrefix | undefined {
    if (tokens[0] === "timeout") {
        return recognizeTimeoutPrefix(tokens);
    }
    return undefined;
}

/** `timeout [OPTION]… DURATION COMMAND [ARG]…` */
function recognizeTimeoutPrefix(tokens: readonly string[]): WrapperPrefix | undefined {
    let index = 1;
    while (index < tokens.length) {
        const token = tokens[index];
        if (TIMEOUT_FLAGS.has(token)) {
            index += 1;
            continue;
        }

        const inlineValue = TIMEOUT_INLINE_VALUE.exec(token);
        if (inlineValue) {
            const pattern = TIMEOUT_VALUE_OPTIONS.get(inlineValue[1]);
            if (!pattern || !pattern.test(inlineValue[2])) {
                return undefined;
            }
            index += 1;
            continue;
        }

        const optionPattern = TIMEOUT_VALUE_OPTIONS.get(token);
        if (optionPattern) {
            const value = tokens[index + 1];
            if (value === undefined || !optionPattern.test(value)) {
                return undefined;
            }
            index += 2;
            continue;
        }
        break;
    }

    const duration = tokens[index];
    if (duration === undefined || !DURATION.test(duration)) {
        return undefined;
    }

    const wrapped = tokens.slice(index + 1);
    if (wrapped.length === 0 || DIRECTORY_BUILTINS.has(wrapped[0])) {
        return undefined;
    }
    return { start: index + 1 };
}

/**
 * Drop transparent wrapper prefixes from a tokenized segment, returning the innermost command tokens.
 *
 * Used by the argument-token classification entrypoint. Permission matching and rule suggestions
 * derive their view from `unwrapWrapperCommand()` instead, so all three agree on nesting, word order,
 * and redirections.
 */
export function unwrapWrapperTokens(tokens: readonly string[]): string[] | undefined {
    const start = wrappedStart(tokens);
    if (start === undefined) {
        return undefined;
    }
    return tokens.slice(start);
}

/**
 * Replace transparent wrapper prefixes with the innermost command inside a parsed command node.
 *
 * The remaining word order and every redirection of the original command are preserved, so a
 * redirection the wrapper would have owned stays subject to confinement. The returned command shares
 * the original word nodes; nothing is reparsed, which keeps substitution and quoting provenance
 * intact for the confinement checks. A command with leading environment assignments is not unwrapped,
 * for the reason documented in this module's header.
 */
export function unwrapWrapperCommand(command: BashCommand): BashCommand | undefined {
    if (command.environment.length > 0) {
        return undefined;
    }

    const words: readonly BashWordNode[] = command.words;
    const start = wrappedStart(words.map((word) => word.value));
    if (start === undefined) {
        return undefined;
    }

    const dropped = new Set(words.slice(0, start));
    return new BashCommand({
        type: "command",
        parts: command.parts.filter(
            (part) => part.type === "redirection" || !dropped.has(part as BashWordNode),
        ),
        words: [...words.slice(start)],
        redirections: command.redirections,
    });
}
