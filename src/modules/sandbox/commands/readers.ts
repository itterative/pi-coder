import { PATH_VALUE, UNSAFE, VALUE, type CommandSpec } from "./spec";

/** File readers and binary/compressed readers. */
export const READER_COMMANDS: Record<string, CommandSpec> = {
    // file readers
    cat: {},
    head: { flags: { "-n": VALUE, "-c": VALUE, "--lines": VALUE, "--bytes": VALUE } },
    tail: {
        flags: {
            "-n": VALUE, "-c": VALUE,
            "--lines": VALUE, "--bytes": VALUE,
            "-s": VALUE, "--sleep-interval": VALUE, "--pid": VALUE,
        },
    },
    // NOTE: less/more are intentionally NOT whitelisted: with an inherited
    // LESSOPEN/LESSCLOSE env var (common via the lesspipe package), they pipe
    // file contents through a user script that can execute arbitrary programs.
    wc: { flags: { "--files0-from": PATH_VALUE } },
    file: {
        flags: {
            "-F": VALUE, "--separator": VALUE,
            "-f": PATH_VALUE, "--files-from": PATH_VALUE,
            "-m": PATH_VALUE, "--magic-file": PATH_VALUE,
        },
    },
    stat: { flags: { "-c": VALUE, "--format": VALUE, "--printf": VALUE } },

    // binary and compressed readers
    zcat: {},
    strings: {
        flags: {
            "-n": VALUE, "--min-length": VALUE, "--minimum-length": VALUE,
            "-t": VALUE, "--radix": VALUE, "--bytes": VALUE,
        },
    },
    od: {
        flags: {
            "-A": VALUE, "--address-radix": VALUE,
            "-j": VALUE, "--skip-bytes": VALUE,
            "-N": VALUE, "--read-bytes": VALUE,
            "-S": VALUE, "--seek": VALUE,
            "-t": VALUE, "--format": VALUE,
        },
    },
    hexdump: {
        flags: {
            "-e": VALUE, "--format": VALUE,
            "-n": VALUE, "--length": VALUE,
            "-s": VALUE, "--offset": VALUE,
        },
    },
    xxd: {
        flags: {
            "-l": VALUE, "--length": VALUE,
            "-s": VALUE, "--offset": VALUE,
            "-c": VALUE, "--cols": VALUE,
            "-g": VALUE, "--group-size": VALUE,
            // -r/-b write files; --post runs a program on the output
            "-r": UNSAFE, "--revert": UNSAFE,
            "-b": UNSAFE, "--bin": UNSAFE, "--post": UNSAFE,
        },
    },
    base64: {
        flags: {
            "-w": VALUE, "--wrap": VALUE,
            "-o": PATH_VALUE, "--output": PATH_VALUE,
        },
    },
};
