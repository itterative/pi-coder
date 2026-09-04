import { PATH_VALUE, UNSAFE, VALUE, type CommandSpec } from "./spec";

const SED_SHELL_TOKENS = new Set(["<", ">", ">>", "2>", "2>>"]);

function skipSedWhitespace(script: string, index: number): number {
    while (index < script.length && /\s/.test(script[index])) index++;
    return index;
}

/** Read a sed address or address range without interpreting its regex. */
function readSedAddress(script: string, start: number): number {
    let index = skipSedWhitespace(script, start);
    const readOne = (): number => {
        if (/\d/.test(script[index] ?? "")) {
            while (/\d/.test(script[index] ?? "")) index++;
        } else if (script[index] === "$") {
            index++;
        } else if (script[index] === "/") {
            index++;
            let closed = false;
            while (index < script.length) {
                if (script[index] === "\\") {
                    index += 2;
                } else if (script[index] === "/") {
                    index++;
                    closed = true;
                    break;
                } else {
                    index++;
                }
            }
            if (!closed) return -1;
        } else {
            return -2;
        }
        return index;
    };

    const first = readOne();
    if (first === -2) return start;
    if (first === -1) return -1;
    index = first;

    // GNU sed's first~step address is still a pure input selection.
    if (script[index] === "~") {
        index++;
        if (!/\d/.test(script[index] ?? "")) return -1;
        while (/\d/.test(script[index] ?? "")) index++;
    }

    index = skipSedWhitespace(script, index);
    if (script[index] === ",") {
        index = skipSedWhitespace(script, index + 1);
        const second = readOne();
        if (second === -1 || second === -2) return -1;
        index = second;
    }

    index = skipSedWhitespace(script, index);
    if (script[index] === "!") index++;
    return index;
}

function readSedDelimited(script: string, start: number): number {
    const delimiter = script[start];
    if (!delimiter || /\s/.test(delimiter)) return -1;
    let index = start + 1;
    while (index < script.length) {
        if (script[index] === "\\") {
            index += 2;
        } else if (script[index] === delimiter) {
            return index + 1;
        } else if (script[index] === "\n") {
            return -1;
        } else {
            index++;
        }
    }
    return -1;
}

/**
 * Accept the useful, read-only part of sed: address selection, printing, and
 * substitution. In particular, reject sed's e/r/w commands and flags, which
 * can execute programs or read/write a file named inside the script.
 */
function isSafeSedScript(script: string): boolean {
    let index = 0;
    let commandSeen = false;

    while (true) {
        index = skipSedWhitespace(script, index);
        if (index >= script.length) return commandSeen;

        const addressEnd = readSedAddress(script, index);
        if (addressEnd === -1) return false;
        index = skipSedWhitespace(script, addressEnd);
        const command = script[index];
        if (!command) return false;
        index++;

        if (command === "s") {
            const patternEnd = readSedDelimited(script, index);
            if (patternEnd === -1) return false;
            // The closing delimiter of the pattern is also the opening
            // delimiter for the replacement.
            const replacementEnd = readSedDelimited(script, patternEnd - 1);
            if (replacementEnd === -1) return false;
            index = replacementEnd;
            while (/[gimpIM0-9]/.test(script[index] ?? "")) index++;
        } else if (command === "y") {
            const sourceEnd = readSedDelimited(script, index);
            if (sourceEnd === -1) return false;
            const targetEnd = readSedDelimited(script, sourceEnd - 1);
            if (targetEnd === -1) return false;
            index = targetEnd;
        } else if (!"pPdDnNqQl=".includes(command)) {
            return false;
        }
        commandSeen = true;

        index = skipSedWhitespace(script, index);
        if (script[index] === ";") index++;
    }
}

interface SedInvocationState {
    scripts: string[];
    positionals: string[];
    expressionSeen: boolean;
    inPlace: boolean;
    afterDoubleDash: boolean;
}

function addSedExpression(state: SedInvocationState, script: string | undefined): boolean {
    if (script === undefined) return false;
    state.scripts.push(script);
    state.expressionSeen = true;
    return true;
}

function inspectSedLongOption(
    args: readonly string[],
    index: number,
    state: SedInvocationState,
): number | null {
    const arg = args[index];
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);

    if (name === "--follow-symlinks" || name === "--file") {
        return null;
    }
    if (name === "--in-place") {
        if (inline !== undefined) return null;
        state.inPlace = true;
        return index + 1;
    }
    if (name === "--expression") {
        const script = inline ?? args[index + 1];
        if (!addSedExpression(state, script)) return null;
        return inline === undefined ? index + 2 : index + 1;
    }
    if (name === "--line-length" && inline === undefined) {
        return index + 2;
    }
    return index + 1;
}

function inspectSedShortOption(
    args: readonly string[],
    index: number,
    state: SedInvocationState,
): number | null {
    const cluster = args[index].slice(1);
    for (let part = 0; part < cluster.length; part++) {
        const flag = cluster[part];
        if (flag === "i" || flag === "f") return null;
        if (flag === "e") {
            const inline = part + 1 < cluster.length ? cluster.slice(part + 1) : undefined;
            const script = inline ?? args[index + 1];
            if (!addSedExpression(state, script)) return null;
            return inline === undefined ? index + 2 : index + 1;
        }
        if (flag === "l") {
            return part + 1 === cluster.length ? index + 2 : index + 1;
        }
    }
    return index + 1;
}

function inspectSedArgument(
    args: readonly string[],
    index: number,
    state: SedInvocationState,
): number | null {
    const arg = args[index];
    if (SED_SHELL_TOKENS.has(arg)) return index + 2;
    if (state.afterDoubleDash) {
        state.positionals.push(arg);
        return index + 1;
    }
    if (arg === "--") {
        state.afterDoubleDash = true;
        return index + 1;
    }
    if (arg.startsWith("--")) return inspectSedLongOption(args, index, state);
    if (arg === "-i") {
        state.inPlace = true;
        return index + 1;
    }
    if (arg.startsWith("-") && arg.length > 1) {
        return inspectSedShortOption(args, index, state);
    }
    state.positionals.push(arg);
    return index + 1;
}

/**
 * Validate sed's script-bearing arguments. A -f script file is intentionally
 * not accepted: its contents cannot be audited without reading another file.
 */
function isSafeSedInvocation(args: readonly string[]): boolean {
    const state: SedInvocationState = {
        scripts: [],
        positionals: [],
        expressionSeen: false,
        inPlace: false,
        afterDoubleDash: false,
    };

    for (let index = 1; index < args.length;) {
        const nextIndex = inspectSedArgument(args, index, state);
        if (nextIndex === null) return false;
        index = nextIndex;
    }

    if (!state.expressionSeen) {
        const script = state.positionals.shift();
        if (!addSedExpression(state, script)) return false;
    }
    if (state.inPlace && state.positionals.length === 0) return false;

    return state.scripts.every(isSafeSedScript);
}

export const SED_COMMANDS: Record<string, CommandSpec> = {
    sed: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--expression", "-f", "--file"],
        rejectUnknownFlags: true,
        rejectHardLinkedPositionals: true,
        validate: isSafeSedInvocation,
        flags: {
            "-n": {},
            "--quiet": {},
            "--silent": {},
            "-E": {},
            "-r": {},
            "--regexp-extended": {},
            "-s": {},
            "--separate": {},
            "-u": {},
            "--unbuffered": {},
            "-z": {},
            "--null-data": {},
            "--posix": {},
            "-e": VALUE,
            "--expression": VALUE,
            // Script files are rejected by the validator because their
            // contents are not available to this lexical check.
            "-f": PATH_VALUE,
            "--file": PATH_VALUE,
            "-l": VALUE,
            "--line-length": VALUE,
            "-i": { writes: true, requiresAdditionalRoot: true },
            "--in-place": { writes: true, requiresAdditionalRoot: true },
            "--follow-symlinks": UNSAFE,
        },
    },
};
