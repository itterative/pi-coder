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
 * by itself. The quiet form emits no diff contents (or diagnostics), making
 * it suitable for the cwd heuristic. Keep the option surface deliberately
 * small so a later diff-output or external-program option cannot make this
 * an output or execution bypass.
 */
const DIFF_QUIET_SPEC: CommandSpec = {
    validate: (args) => {
        let hasQuiet = false;

        for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            if (arg === "--") {
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

            if (arg === "--quiet") {
                hasQuiet = true;
            }
        }

        return hasQuiet;
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
        },
        subcommands: {
            // positionals are pathspecs
            status: {},
            // Only quiet diff modes are eligible: --check alone echoes the
            // offending line, while --quiet suppresses all diff output.
            diff: DIFF_QUIET_SPEC,
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
            // list mode only: a ref name as positional means create/delete
            branch: { positionals: "none" },
            tag: { positionals: "none" },
        },
    },
};
