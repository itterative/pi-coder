import { PATH_VALUE, VALUE, type CommandSpec } from "./spec";

const SHELL_ACCESS_TOKENS = new Set([
    "<", ">", ">>", "2>", "2>>", "2>&1", "<<", "<<-",
]);

function getSimplePositionals(args: readonly string[]): string[] | null {
    const positionals: string[] = [];
    let afterDoubleDash = false;

    for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (SHELL_ACCESS_TOKENS.has(arg)) {
            return null;
        }
        if (!afterDoubleDash && arg === "--") {
            afterDoubleDash = true;
            continue;
        }
        if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") {
            continue;
        }
        positionals.push(arg);
    }

    return positionals;
}

function hasExactlyTwoPositionals(args: readonly string[]): boolean {
    return getSimplePositionals(args)?.length === 2;
}

function isChmodInvocation(args: readonly string[]): boolean {
    const positionals = getSimplePositionals(args);
    if (!positionals || positionals.length < 2) {
        return false;
    }

    const mode = positionals[0];
    if (/^[0-7]{3,4}$/.test(mode)) {
        return true;
    }

    return /^(?:[ugoa]*[+=-][rwxXstugo]*)(?:,[ugoa]*[+=-][rwxXstugo]*)*$/.test(mode);
}

/**
 * Filesystem mutators that are safe to classify only when their write effects
 * stay inside a runtime-managed additional root such as a scratchpad.
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
        rejectHardLinkedPositionals: true,
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
        rejectHardLinkedPositionals: true,
        flags: {
            "-r": PATH_VALUE, "--reference": PATH_VALUE,
            "-s": VALUE, "--size": VALUE,
        },
    },
    tee: {
        writes: true,
        additionalRootOnly: true,
        rejectUnknownFlags: true,
        rejectHardLinkedPositionals: true,
        flags: {
            "-a": {}, "--append": {},
            "-i": {}, "--ignore-interrupts": {},
        },
    },
    cp: {
        writes: true,
        additionalRootLastPositional: true,
        rejectDirectoryDestination: true,
        rejectHardLinkedPositionals: true,
        rejectUnknownFlags: true,
        validate: hasExactlyTwoPositionals,
        flags: {
            "-f": {}, "--force": {},
            "-n": {}, "--no-clobber": {},
            "-u": {}, "--update": {},
            "-v": {}, "--verbose": {},
        },
    },
    mv: {
        writes: true,
        additionalRootOnly: true,
        rejectDirectoryDestination: true,
        rejectHardLinkedDestination: true,
        rejectUnknownFlags: true,
        validate: hasExactlyTwoPositionals,
        flags: {
            "-f": {}, "--force": {},
            "-i": {}, "--interactive": {},
            "-n": {}, "--no-clobber": {},
            "-T": {}, "--no-target-directory": {},
            "-v": {}, "--verbose": {},
        },
    },
    chmod: {
        writes: true,
        additionalRootOnly: true,
        rejectUnknownFlags: true,
        rejectHardLinkedPositionals: true,
        positionals: "first-pattern",
        validate: isChmodInvocation,
        flags: {
            "-c": {}, "--changes": {},
            "-f": {}, "--silent": {}, "--quiet": {},
            "-v": {}, "--verbose": {},
        },
    },
};
