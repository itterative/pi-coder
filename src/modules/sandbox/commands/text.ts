import { PATH_VALUE, UNSAFE, VALUE, VALUE2, type CommandSpec } from "./spec";

// shared by grep, egrep, fgrep, and zgrep (a wrapper around grep on
// compressed files) — identical flag semantics
const GREP_SPEC: CommandSpec = {
    positionals: "first-pattern",
    patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
    flags: {
        "-e": VALUE, "--regexp": VALUE,
        "-m": VALUE, "--max-count": VALUE,
        "-A": VALUE, "--after-context": VALUE,
        "-B": VALUE, "--before-context": VALUE,
        "-C": VALUE, "--context": VALUE,
        "--label": VALUE,
        "--include": VALUE, "--exclude": VALUE, "--exclude-dir": VALUE,
        "--binary-files": VALUE,
        "-D": VALUE, "--directories": VALUE,
        "-d": VALUE, "--devices": VALUE,
        "--group-separator": VALUE,
        "--color": VALUE, "--colour": VALUE,
        "-f": PATH_VALUE, "--file": PATH_VALUE, "--exclude-from": PATH_VALUE,
        // -R follows symlinks during recursive traversal
        "-R": UNSAFE, "--dereference-recursive": UNSAFE,
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
            "-e": VALUE, "--regexp": VALUE,
            "-t": VALUE, "--type": VALUE,
            "-g": VALUE, "--glob": VALUE, "--iglob": VALUE,
            "-A": VALUE, "--after-context": VALUE,
            "-B": VALUE, "--before-context": VALUE,
            "-C": VALUE, "--context": VALUE,
            "-m": VALUE, "--max-count": VALUE,
            "-M": VALUE, "--max-count-per-file": VALUE,
            "--max-depth": VALUE,
            "--max-columns": VALUE,
            "--max-filesize": VALUE,
            "-j": VALUE, "--threads": VALUE,
            "--engine": VALUE,
            "--sort": VALUE, "--sortr": VALUE,
            "--color": VALUE,
            "--context-separator": VALUE,
            "--field-context-separator": VALUE,
            "--pre-glob": VALUE,
            "-f": PATH_VALUE, "--file": PATH_VALUE,
            // --pre runs an external program; --follow descends into symlinks
            "--pre": UNSAFE, "--follow": UNSAFE,
        },
    },
    sort: {
        flags: {
            "-k": VALUE, "--key": VALUE,
            "-t": VALUE, "--field-separator": VALUE,
            "-S": VALUE, "--buffer-size": VALUE,
            "--parallel": VALUE, "--batch-size": VALUE,
            "-o": PATH_VALUE, "--output": PATH_VALUE,
            "-T": PATH_VALUE, "--temporary-dir": PATH_VALUE,
            "--files0-from": PATH_VALUE,
            // executes an external program
            "--compress-program": UNSAFE,
        },
    },
    uniq: {
        flags: {
            "-s": VALUE, "--skip-chars": VALUE,
            "-w": VALUE, "--check-chars": VALUE,
            "-f": VALUE, "--skip-fields": VALUE,
        },
    },
    cut: {
        flags: {
            "-d": VALUE, "--delimiter": VALUE,
            "-f": VALUE, "--fields": VALUE,
            "-c": VALUE, "--characters": VALUE,
            "-b": VALUE, "--bytes": VALUE,
        },
    },
    paste: { flags: { "-d": VALUE, "--delimiters": VALUE } },
    comm: {},
    join: {
        flags: {
            "-t": VALUE, "-e": VALUE, "-1": VALUE, "-2": VALUE,
            "-j": VALUE, "-o": VALUE, "-a": VALUE, "-v": VALUE,
        },
    },
    tr: { positionals: "ignore" },
    find: {
        // flags that write files or execute commands
        flags: {
            "-delete": UNSAFE,
            "-exec": UNSAFE, "-execdir": UNSAFE,
            "-ok": UNSAFE, "-okdir": UNSAFE,
            "-fls": UNSAFE, "-fprint": UNSAFE, "-fprint0": UNSAFE, "-fprintf": UNSAFE,
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
            "--arg": VALUE2, "--argjson": VALUE2,
            "--indent": VALUE,
            "-f": PATH_VALUE, "--from-file": PATH_VALUE,
            // -L/--library-path: module search dir, path-checked like -f
            "-L": PATH_VALUE, "--library-path": PATH_VALUE,
            // name + FILE: the file slot is path-checked
            "--slurpfile": { values: 2, pathSlots: [1] },
            "--rawfile": { values: 2, pathSlots: [1] },
            "--argfile": { values: 2, pathSlots: [1] },
        },
    },
};
