import { VALUE, type CommandSpec } from "./spec";

/** Path manipulation utilities. */
export const PATH_COMMANDS: Record<string, CommandSpec> = {
    realpath: {},
    readlink: {},
    basename: { flags: { "-s": VALUE, "--suffix": VALUE } },
    dirname: {},
    cd: {},
};
