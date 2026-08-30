import { OUTPUT_PATH_VALUE, PATH_VALUE, UNSAFE, VALUE, VALUE2, type CommandSpec } from "./spec";

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

/**
 * Validate sed's script-bearing arguments. A -f script file is intentionally
 * not accepted: its contents cannot be audited without reading another file.
 */
function isSafeSedInvocation(args: readonly string[]): boolean {
    const scripts: string[] = [];
    const positionals: string[] = [];
    let expressionSeen = false;
    let inPlace = false;
    let afterDoubleDash = false;

    for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (SED_SHELL_TOKENS.has(arg)) {
            index++;
            continue;
        }
        if (afterDoubleDash) {
            positionals.push(arg);
            continue;
        }
        if (arg === "--") {
            afterDoubleDash = true;
            continue;
        }
        if (arg.startsWith("--")) {
            const equals = arg.indexOf("=");
            const name = equals === -1 ? arg : arg.slice(0, equals);
            const inline = equals === -1 ? undefined : arg.slice(equals + 1);
            if (name === "--follow-symlinks" || name === "--file") {
                return false;
            }
            if (name === "--in-place") {
                if (inline !== undefined) {
                    return false;
                }
                inPlace = true;
                continue;
            }
            if (name === "--expression") {
                const script = inline ?? args[++index];
                if (script === undefined) return false;
                scripts.push(script);
                expressionSeen = true;
            } else if (name === "--line-length") {
                if (inline === undefined) index++;
            }
            continue;
        }
        if (arg === "-i") {
            inPlace = true;
            continue;
        }
        if (arg.startsWith("-") && arg.length > 1) {
            const cluster = arg.slice(1);
            for (let part = 0; part < cluster.length; part++) {
                const flag = cluster[part];
                if (flag === "i" || flag === "f") return false;
                if (flag === "e") {
                    const script =
                        part + 1 < cluster.length ? cluster.slice(part + 1) : args[++index];
                    if (script === undefined) return false;
                    scripts.push(script);
                    expressionSeen = true;
                    break;
                }
                if (flag === "l") {
                    if (part + 1 === cluster.length) index++;
                    break;
                }
            }
            continue;
        }
        positionals.push(arg);
    }

    if (!expressionSeen) {
        const script = positionals.shift();
        if (script === undefined) return false;
        scripts.push(script);
    }

    if (inPlace && positionals.length === 0) {
        return false;
    }

    return scripts.every(isSafeSedScript);
}

// shared by grep, egrep, fgrep, and zgrep (a wrapper around grep on
// compressed files) — identical flag semantics
const GREP_SPEC: CommandSpec = {
    positionals: "first-pattern",
    patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
    flags: {
        "-e": VALUE,
        "--regexp": VALUE,
        "-m": VALUE,
        "--max-count": VALUE,
        "-A": VALUE,
        "--after-context": VALUE,
        "-B": VALUE,
        "--before-context": VALUE,
        "-C": VALUE,
        "--context": VALUE,
        "--label": VALUE,
        "--include": VALUE,
        "--exclude": VALUE,
        "--exclude-dir": VALUE,
        "--binary-files": VALUE,
        "-D": VALUE,
        "--directories": VALUE,
        "-d": VALUE,
        "--devices": VALUE,
        "--group-separator": VALUE,
        "--color": VALUE,
        "--colour": VALUE,
        "-f": PATH_VALUE,
        "--file": PATH_VALUE,
        "--exclude-from": PATH_VALUE,
        // -R follows symlinks during recursive traversal
        "-R": UNSAFE,
        "--dereference-recursive": UNSAFE,
    },
};

/** Text processing, search, and structured data (grep family, rg, find, jq). */
export const TEXT_COMMANDS: Record<string, CommandSpec> = {
    grep: GREP_SPEC,
    egrep: GREP_SPEC,
    fgrep: GREP_SPEC,
    zgrep: GREP_SPEC,
    rg: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        flags: {
            "-e": VALUE,
            "--regexp": VALUE,
            "-t": VALUE,
            "--type": VALUE,
            "-g": VALUE,
            "--glob": VALUE,
            "--iglob": VALUE,
            "-A": VALUE,
            "--after-context": VALUE,
            "-B": VALUE,
            "--before-context": VALUE,
            "-C": VALUE,
            "--context": VALUE,
            "-m": VALUE,
            "--max-count": VALUE,
            "-M": VALUE,
            "--max-count-per-file": VALUE,
            "--max-depth": VALUE,
            "--max-columns": VALUE,
            "--max-filesize": VALUE,
            "-j": VALUE,
            "--threads": VALUE,
            "--engine": VALUE,
            "--sort": VALUE,
            "--sortr": VALUE,
            "--color": VALUE,
            "--context-separator": VALUE,
            "--field-context-separator": VALUE,
            "--pre-glob": VALUE,
            "-f": PATH_VALUE,
            "--file": PATH_VALUE,
            // --pre runs an external program; --follow descends into symlinks
            "--pre": UNSAFE,
            "--follow": UNSAFE,
        },
    },
    sort: {
        flags: {
            "-k": VALUE,
            "--key": VALUE,
            "-t": VALUE,
            "--field-separator": VALUE,
            "-S": VALUE,
            "--buffer-size": VALUE,
            "--parallel": VALUE,
            "--batch-size": VALUE,
            "-o": OUTPUT_PATH_VALUE,
            "--output": OUTPUT_PATH_VALUE,
            "-T": OUTPUT_PATH_VALUE,
            "--temporary-dir": OUTPUT_PATH_VALUE,
            "--files0-from": PATH_VALUE,
            // executes an external program
            "--compress-program": UNSAFE,
        },
    },
    uniq: {
        flags: {
            "-s": VALUE,
            "--skip-chars": VALUE,
            "-w": VALUE,
            "--check-chars": VALUE,
            "-f": VALUE,
            "--skip-fields": VALUE,
        },
    },
    cut: {
        flags: {
            "-d": VALUE,
            "--delimiter": VALUE,
            "-f": VALUE,
            "--fields": VALUE,
            "-c": VALUE,
            "--characters": VALUE,
            "-b": VALUE,
            "--bytes": VALUE,
        },
    },
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
    // Stream-only text filters. Their positionals are input paths; output is
    // stdout, so they do not have hidden output-file or execution modes.
    fold: { flags: { "-w": VALUE, "--width": VALUE } },
    fmt: {
        flags: {
            "-w": VALUE,
            "--width": VALUE,
            "-g": VALUE,
            "--goal": VALUE,
            "-p": VALUE,
            "--prefix": VALUE,
        },
    },
    expand: { flags: { "-t": VALUE, "--tabs": VALUE } },
    unexpand: { flags: { "-t": VALUE, "--tabs": VALUE } },
    nl: {
        flags: {
            "-b": VALUE,
            "-d": VALUE,
            "-f": VALUE,
            "-h": VALUE,
            "-i": VALUE,
            "-l": VALUE,
            "-n": VALUE,
            "-s": VALUE,
            "-v": VALUE,
            "-w": VALUE,
        },
    },
    tac: { flags: { "-s": VALUE, "--separator": VALUE } },
    rev: {},
    paste: { flags: { "-d": VALUE, "--delimiters": VALUE } },
    comm: {},
    join: {
        flags: {
            "-t": VALUE,
            "-e": VALUE,
            "-1": VALUE,
            "-2": VALUE,
            "-j": VALUE,
            "-o": VALUE,
            "-a": VALUE,
            "-v": VALUE,
        },
    },
    tr: { positionals: "ignore" },
    find: {
        // flags that write files or execute commands
        flags: {
            "-delete": UNSAFE,
            "-exec": UNSAFE,
            "-execdir": UNSAFE,
            "-ok": UNSAFE,
            "-okdir": UNSAFE,
            "-fls": UNSAFE,
            "-fprint": UNSAFE,
            "-fprint0": UNSAFE,
            "-fprintf": UNSAFE,
            // follows symlinks during traversal
            "-L": UNSAFE,
        },
    },
    // first positional is the jq filter, remaining positionals are input files
    jq: {
        positionals: "first-pattern",
        // -f/--from-file supplies the filter, so all positionals are files
        patternBypassFlags: ["-f", "--from-file"],
        flags: {
            // name + value, neither is a path
            "--arg": VALUE2,
            "--argjson": VALUE2,
            "--indent": VALUE,
            "-f": PATH_VALUE,
            "--from-file": PATH_VALUE,
            // -L/--library-path: module search dir, path-checked like -f
            "-L": PATH_VALUE,
            "--library-path": PATH_VALUE,
            // name + FILE: the file slot is path-checked
            "--slurpfile": { values: 2, pathSlots: [1] },
            "--rawfile": { values: 2, pathSlots: [1] },
            "--argfile": { values: 2, pathSlots: [1] },
        },
    },
};
