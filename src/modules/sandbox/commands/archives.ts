import { PATH_VALUE, UNSAFE, VALUE, type CommandSpec } from "./spec";

/**
 * Archives (list/inspect only; modes that write or run programs are unsafe).
 * First positional is the archive, the rest are member names (data, not paths).
 */
export const ARCHIVE_COMMANDS: Record<string, CommandSpec> = {
    tar: {
        positionals: "first-path",
        flags: {
            "--transform": VALUE, "--exclude": VALUE,
            "-f": PATH_VALUE, "--file": PATH_VALUE, "--exclude-file": PATH_VALUE,
            // create/extract/modify write files; -I/--to-command/
            // --checkpoint-action run external programs
            "-c": UNSAFE, "--create": UNSAFE,
            "-x": UNSAFE, "--extract": UNSAFE,
            "-d": UNSAFE, "--delete": UNSAFE,
            "-r": UNSAFE, "--append": UNSAFE, "-A": UNSAFE,
            "-u": UNSAFE, "--update": UNSAFE,
            "-I": UNSAFE, "--use-compress-program": UNSAFE,
            "--to-command": UNSAFE,
            "--checkpoint-action": UNSAFE,
        },
    },
    zipinfo: { flags: { "-T": VALUE } },
    // the default mode extracts files (writes); only read-only modes are
    // eligible. First positional is the archive, the rest are member names.
    unzip: {
        positionals: "first-path",
        safeModeFlags: ["-l", "--list", "-p", "-z", "-t", "-v"],
        flags: { "-T": VALUE },
    },
};
