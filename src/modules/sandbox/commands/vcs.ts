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
 * Keep the safe, metadata/checking modes of `git diff` deliberately small.
 * `--check` may echo an offending changed line, but is useful for validating
 * worktree changes; `--stat` only reports change metadata. Quiet mode emits no
 * diff contents. Other output and external-program options remain ineligible.
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

const DIFF_SPEC: CommandSpec = {
    validate: (args) => {
        let hasCheck = false;
        let hasStat = false;
        let hasNameStatus = false;
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
                arg !== "--stat" &&
                arg !== "--name-status" &&
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
            } else if (arg === "--stat") {
                hasStat = true;
            } else if (arg === "--name-status") {
                hasNameStatus = true;
            } else if (arg === "--quiet") {
                hasQuiet = true;
            }
        }

        const hasPathspec = separator !== -1 && separator < args.length - 1;
        return hasCheck || hasStat || hasNameStatus || hasQuiet || hasPathspec;
    },
};

/** Metadata-only `git show` modes. Any patch/content option remains ineligible. */
const SHOW_METADATA_SPEC: CommandSpec = {
    validate: (args) => {
        let hasMetadataMode = false;
        for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            if (
                arg === "--stat"
                || arg === "--summary"
                || arg === "--name-only"
                || arg === "--name-status"
                || arg === "--format="
            ) {
                hasMetadataMode = true;
                continue;
            }
            if (arg.startsWith("-")) return false;
        }
        return hasMetadataMode;
    },
};

/**
 * Version control (read-only inspection of the repo in cwd).
 *
 * Excluded subcommands: cat-file and content-printing diff/show modes print
 * file contents from the worktree or history (a sensitive file can reach the output
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
            // `git status` may refresh the .git/index stat cache. This is an
            // intentional SAFE_READONLY exception: it changes only Git metadata,
            // and bash defaults to sandboxed execution.
            // Positionals are pathspecs.
            status: {},
            // Keep only the explicitly modeled checking, stat, and quiet
            // modes eligible; other diff output modes remain prompts.
            diff: DIFF_SPEC,
            show: SHOW_METADATA_SPEC,
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
