import { PATH_VALUE, VALUE, type CommandSpec } from "./spec";

/**
 * Filesystem mutators that are safe to classify only when every affected path
 * is inside a runtime-managed additional root such as a scratchpad.
 */
export const SCRATCHPAD_MUTATOR_COMMANDS: Record<string, CommandSpec> = {
    rm: {
        writes: true,
        additionalRootOnly: true,
        rejectUnknownFlags: true,
        flags: {
            "-d": {}, "--dir": {},
            "-f": {}, "--force": {},
            "-i": {}, "-I": {}, "--interactive": {},
            "-r": {}, "-R": {}, "--recursive": {},
            "-v": {}, "--verbose": {},
            "--one-file-system": {}, "--preserve-root": {},
        },
    },
    mkdir: {
        writes: true,
        additionalRootOnly: true,
        rejectUnknownFlags: true,
        flags: { "-p": {}, "--parents": {}, "-v": {}, "--verbose": {} },
    },
    rmdir: {
        writes: true,
        additionalRootOnly: true,
        rejectUnknownFlags: true,
        flags: {
            "-p": {}, "--parents": {},
            "-v": {}, "--verbose": {},
            "--ignore-fail-on-non-empty": {},
        },
    },
    touch: {
        writes: true,
        additionalRootOnly: true,
        rejectUnknownFlags: true,
        flags: {
            "-a": {}, "-c": {}, "-m": {},
            "-r": PATH_VALUE, "--reference": PATH_VALUE,
            "--no-create": {},
        },
    },
    truncate: {
        writes: true,
        additionalRootOnly: true,
        rejectUnknownFlags: true,
        flags: {
            "-r": PATH_VALUE, "--reference": PATH_VALUE,
            "-s": VALUE, "--size": VALUE,
        },
    },
    tee: {
        writes: true,
        additionalRootOnly: true,
        rejectUnknownFlags: true,
        flags: {
            "-a": {}, "--append": {},
            "-i": {}, "--ignore-interrupts": {},
        },
    },
};
