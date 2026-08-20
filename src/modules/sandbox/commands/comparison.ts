import { PATH_VALUE, VALUE, type CommandSpec } from "./spec";

// shared by diff and diff3 — identical flag semantics
const DIFF_SPEC: CommandSpec = {
    flags: {
        "-C": VALUE, "--context": VALUE,
        "-U": VALUE, "--unified": VALUE,
        "--label": VALUE,
        "-I": VALUE, "--ignore-matching-lines": VALUE,
        "-x": VALUE, "--exclude": VALUE,
        "-S": VALUE, "--starting-file": VALUE,
        "-X": PATH_VALUE, "--exclude-from": PATH_VALUE,
    },
};

/** File comparison. */
export const COMPARISON_COMMANDS: Record<string, CommandSpec> = {
    diff: DIFF_SPEC,
    diff3: DIFF_SPEC,
    cmp: { flags: { "-i": VALUE, "--ignore-initial": VALUE, "-n": VALUE, "--bytes": VALUE } },
};
