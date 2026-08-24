import { UNSAFE, VALUE, type CommandSpec } from "./spec";

// shared by log and whatchanged (an alias of log)
const LOG_SPEC: CommandSpec = {
    flags: {
        "-n": VALUE, "--max-count": VALUE,
        "--since": VALUE, "--until": VALUE, "--after": VALUE, "--before": VALUE,
        "--author": VALUE, "--grep": VALUE,
        "-S": VALUE, "-G": VALUE,
        "--format": VALUE, "--pretty": VALUE,
        "--diff-filter": VALUE,
        // patch output prints file contents from history
        "-p": UNSAFE, "--patch": UNSAFE, "-U": UNSAFE, "--unified": UNSAFE,
    },
};

/**
 * `git diff --check` can echo the offending changed line, so it is not safe
 * across the whole repository by itself. It is safe with an explicit `--`
 * pathspec because that has the same explicit-path boundary as `cat`; quiet
 * mode is safe even without a pathspec because it emits no diff contents.
 * Keep the option surface deliberately small so a later diff-output or
 * external-program option cannot make this an output or execution bypass.
 */
const BRANCH_SPEC: CommandSpec = {
    // The default invocation lists branches. Creation, deletion, movement,
    // copying, and upstream/description changes must remain explicit.
    positionals: "none",
    flags: {
        "-d": UNSAFE, "--delete": UNSAFE, "-D": UNSAFE,
        "-m": UNSAFE, "--move": UNSAFE, "-M": UNSAFE,
        "-c": UNSAFE, "--copy": UNSAFE, "-C": UNSAFE,
        "-u": UNSAFE, "--set-upstream-to": UNSAFE,
        "--unset-upstream": UNSAFE, "--edit-description": UNSAFE,
        "--track": UNSAFE, "--no-track": UNSAFE,
    },
};

const TAG_SPEC: CommandSpec = {
    // The default invocation lists tags. Tag creation, deletion, signing,
    // movement, and reflog changes are not heuristic-safe.
    positionals: "none",
    flags: {
        "-d": UNSAFE, "--delete": UNSAFE, "-D": UNSAFE,
        "-a": UNSAFE, "--annotate": UNSAFE,
        "-s": UNSAFE, "--sign": UNSAFE, "-u": UNSAFE, "--local-user": UNSAFE,
        "-f": UNSAFE, "--force": UNSAFE,
        "-m": UNSAFE, "--move": UNSAFE,
        "--create-reflog": UNSAFE,
    },
};

const DIFF_CHECK_SPEC: CommandSpec = {
    validate: (args) => {
        let hasCheck = false;
        let hasQuiet = false;
        let separator = -1;

        for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            if (arg === "--") {
                separator = i;
                break;
            }

            // Revision/path arguments are still checked by the normal path
            // extractor. Only option-looking arguments need allowlisting.
            if (
                arg.startsWith("-") &&
                arg !== "--check" &&
                arg !== "--quiet" &&
                arg !== "--cached" &&
                arg !== "--staged" &&
                arg !== "--relative" &&
                arg !== "--no-ext-diff" &&
                arg !== "--no-textconv"
            ) {
                return false;
            }

            if (arg === "--check") {
                hasCheck = true;
            } else if (arg === "--quiet") {
                hasQuiet = true;
            }
        }

        const hasPathspec = separator !== -1 && separator < args.length - 1;
        return hasQuiet || (hasCheck && hasPathspec);
    },
};

/**
 * Version control (read-only inspection of the repo in cwd).
 *
 * Excluded subcommands: diff/show/cat-file print file CONTENTS from the
 * worktree or history (a sensitive file's content can reach the output
 * with no sensitive path argument), remote/config can print credentials
 * stored in .git/config, and fetch/pull/push/checkout/... write or use
 * the network. Those need explicit allow rules or output protections.
 * Note: `git status` refreshes .git/index stat caches, which is normal
 * git behavior (it happens outside the sandbox too).
 */
export const VCS_COMMANDS: Record<string, CommandSpec> = {
    git: {
        // global flags, valid before the subcommand: -c can select external
        // programs (diff.external, core.sshCommand, gpg.program, ...),
        // -C/--git-dir/--work-tree relocate the repo, --exec-path changes
        // which helpers git runs
        flags: {
            "-c": UNSAFE, "-C": UNSAFE,
            "--git-dir": UNSAFE, "--work-tree": UNSAFE, "--exec-path": UNSAFE,
            // Can inject arbitrary git config through an inherited env var,
            // including helper and external-diff settings.
            "--config-env": UNSAFE,
        },
        subcommands: {
            // positionals are pathspecs
            status: {},
            // --check is eligible only with an explicit pathspec; --quiet
            // suppresses output and is eligible without one.
            diff: DIFF_CHECK_SPEC,
            log: LOG_SPEC,
            "ls-files": {
                flags: { "--exclude": VALUE, "--with-tree": VALUE },
            },
            describe: {
                flags: {
                    "--abbrev": VALUE, "--candidates": VALUE,
                    "--matches": VALUE, "--exclude": VALUE,
                },
            },
            // positionals are revisions, not paths
            "rev-parse": {
                positionals: "ignore",
                flags: {
                    "--short": VALUE, "--abbrev": VALUE, "--abbrev-ref": VALUE,
                    "--git-path": VALUE, "--verify": VALUE,
                },
            },
            shortlog: {
                flags: {
                    "-n": VALUE, "--max-count": VALUE,
                    "--since": VALUE, "--until": VALUE, "--after": VALUE, "--before": VALUE,
                    "--author": VALUE, "--grep": VALUE,
                    "--format": VALUE, "--pretty": VALUE,
                    "-p": UNSAFE, "--patch": UNSAFE,
                },
            },
            // alias of log
            whatchanged: LOG_SPEC,
            branch: BRANCH_SPEC,
            tag: TAG_SPEC,
        },
    },
};
