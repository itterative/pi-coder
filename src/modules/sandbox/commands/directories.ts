import { PATH_VALUE, UNSAFE, VALUE, type CommandSpec } from "./spec";

// first positional is a search pattern, remaining positionals are paths
const FD_SPEC: CommandSpec = {
    positionals: "first-pattern",
    flags: {
        "-d": VALUE, "--max-depth": VALUE,
        "-t": VALUE, "--type": VALUE,
        "-e": VALUE, "--extension": VALUE,
        "--size": VALUE, "--owner": VALUE,
        "--changed-within": VALUE, "--changed-before": VALUE, "--changed-after": VALUE,
        "--change-newer-than": VALUE, "--change-older-than": VALUE,
        "--max-results": VALUE, "--color": VALUE,
        // -x/-X run a command on the results; -L descends into symlinks
        "-x": UNSAFE, "--exec": UNSAFE,
        "-X": UNSAFE, "--exec-batch": UNSAFE,
        "-L": UNSAFE, "--follow": UNSAFE,
    },
};

/** Directory readers and tree searchers. */
export const DIRECTORY_COMMANDS: Record<string, CommandSpec> = {
    ls: {},
    dir: {},
    vdir: {},
    du: {
        flags: {
            "-B": VALUE, "--block-size": VALUE,
            "-t": VALUE, "--threshold": VALUE, "--time-style": VALUE,
            "--files0-from": PATH_VALUE,
            // -L follows symlinks during traversal
            "-L": UNSAFE, "--dereference-all": UNSAFE,
        },
    },
    tree: {
        flags: {
            "-L": VALUE, "-P": VALUE, "-I": VALUE,
            "--filelimit": VALUE, "--charset": VALUE,
            "-o": PATH_VALUE,
            // -l follows symlinks to directories during traversal
            "-l": UNSAFE,
        },
    },
    fd: FD_SPEC,
    // Debian/Ubuntu name for fd
    fdfind: FD_SPEC,
};
