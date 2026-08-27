import { VALUE, type CommandSpec } from "./spec";

/**
 * Filesystem mutators that are safe to classify only when every affected path
 * is inside a runtime-managed additional root such as a scratchpad.
 */
export const SCRATCHPAD_MUTATOR_COMMANDS: Record<string, CommandSpec> = {
    rm: {
        writes: true,
        additionalRootOnly: true,
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
        flags: { "-p": {}, "--parents": {}, "-v": {}, "--verbose": {} },
    },
    rmdir: {
        writes: true,
        additionalRootOnly: true,
        flags: {
            "-p": {}, "--parents": {},
            "-v": {}, "--verbose": {},
            "--ignore-fail-on-non-empty": {},
        },
    },
    touch: {
        writes: true,
        additionalRootOnly: true,
        flags: {
            "-a": {}, "-c": {}, "-m": {},
            "--no-create": {},
        },
    },
    truncate: {
        writes: true,
        additionalRootOnly: true,
        flags: { "-s": VALUE, "--size": VALUE },
    },
    tee: {
        writes: true,
        additionalRootOnly: true,
        flags: {
            "-a": {}, "--append": {},
            "-i": {}, "--ignore-interrupts": {},
        },
    },
};
