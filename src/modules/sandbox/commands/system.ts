import { PATH_VALUE, UNSAFE, VALUE, type CommandSpec } from "./spec";

/**
 * `command -v`/`command -V` only inspect command resolution; without one of
 * those lookup flags, the builtin executes its operand and is unsafe.
 */
function isSafeCommandLookup(args: readonly string[]): boolean {
    let parsingOptions = true;
    let hasLookupFlag = false;

    for (const arg of args.slice(1)) {
        if (!parsingOptions) {
            continue;
        }

        if (arg === "--") {
            parsingOptions = false;
            continue;
        }

        if (arg === "-" || !arg.startsWith("-")) {
            parsingOptions = false;
            continue;
        }

        if (arg.startsWith("--")) {
            return false;
        }

        for (const flag of arg.slice(1)) {
            if (flag === "v" || flag === "V") {
                hasLookupFlag = true;
                continue;
            }
            if (flag === "p") {
                continue;
            }
            return false;
        }
    }

    return hasLookupFlag;
}

/**
 * No-filesystem-argument commands and system utilities (no file access, or
 * program names instead of paths).
 */
export const SYSTEM_COMMANDS: Record<string, CommandSpec> = {
    pwd: { positionals: "none" },
    true: { positionals: "none" },
    false: { positionals: "none" },
    command: {
        positionals: "ignore",
        validate: isSafeCommandLookup,
    },
    echo: { positionals: "ignore" },
    printf: { positionals: "ignore" },
    // export: NAME=VALUE positionals are checked like leading env
    // assignments (dangerous names ineligible, values path-checked); bare
    // names only mark existing variables for export
    export: {
        positionals: "assignments",
        flags: {
            // -f exports shell functions as environment (code via env);
            // -p prints the whole environment (inherited secrets would
            // reach the output)
            "-f": UNSAFE,
            "-p": UNSAFE,
        },
    },

    date: {
        flags: {
            "-d": VALUE,
            "--date": VALUE,
            "-f": PATH_VALUE,
            "--file": PATH_VALUE,
        },
    },
    sleep: { positionals: "ignore" },
    which: { positionals: "ignore" },
    whereis: { positionals: "ignore" },
    type: { positionals: "ignore" },
    uname: { positionals: "none" },
    hostname: {
        positionals: "ignore",
        flags: {
            "-F": PATH_VALUE,
            "--file": PATH_VALUE,
            // -f/-i/-I resolve names via DNS; the sandbox has no network
            // isolation, so these are ineligible (audit: observed connect()
            // to the system resolver)
            "-f": UNSAFE,
            "--fqdn": UNSAFE,
            "-i": UNSAFE,
            "--ip-address": UNSAFE,
            "-I": UNSAFE,
            "--all-ip-addresses": UNSAFE,
        },
    },
    nproc: { positionals: "none", flags: { "--ignore": VALUE } },
    free: { positionals: "none", flags: { "-c": VALUE } },
    id: { positionals: "none" },
    df: { flags: { "-B": VALUE, "--block-size": VALUE, "--output": VALUE } },
};
