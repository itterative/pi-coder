import { CommandTag, PATH_VALUE, UNSAFE, VALUE, type CommandSpec } from "./spec";

// shared by log and whatchanged (an alias of log)
const LOG_SPEC: CommandSpec = {
    flags: {
        "-n": VALUE,
        "--max-count": VALUE,
        "--since": VALUE,
        "--until": VALUE,
        "--after": VALUE,
        "--before": VALUE,
        "--author": VALUE,
        "--grep": VALUE,
        "-S": VALUE,
        "-G": VALUE,
        "--format": VALUE,
        "--pretty": VALUE,
        "--diff-filter": VALUE,
        // Historical patches are normal read-only project access in the
        // trusted local environment assumed by safe-bash.
    },
};

/**
 * `git diff` is read-only project inspection in the trusted local environment.
 * Keep external-program and output-file options ineligible; ordinary patch,
 * metadata (including stat summaries), checking, quiet, and explicitly scoped
 * path output are allowed.
 */
const BRANCH_SPEC: CommandSpec = {
    // The default invocation lists branches. Creation, deletion, movement,
    // copying, and upstream/description changes must remain explicit.
    positionals: "none",
    flags: {
        "-d": UNSAFE,
        "--delete": UNSAFE,
        "-D": UNSAFE,
        "-m": UNSAFE,
        "--move": UNSAFE,
        "-M": UNSAFE,
        "-c": UNSAFE,
        "--copy": UNSAFE,
        "-C": UNSAFE,
        "-u": UNSAFE,
        "--set-upstream-to": UNSAFE,
        "--unset-upstream": UNSAFE,
        "--edit-description": UNSAFE,
        "--track": UNSAFE,
        "--no-track": UNSAFE,
        // Read-only selectors: each consumes its revision so `positionals: "none"` still holds.
        "--contains": VALUE,
        "--no-contains": VALUE,
        "--merged": VALUE,
        "--no-merged": VALUE,
        "--points-at": VALUE,
        "--sort": VALUE,
        "--format": VALUE,
    },
};

const TAG_SPEC: CommandSpec = {
    // The default invocation lists tags. Tag creation, deletion, signing,
    // movement, and reflog changes are not heuristic-safe.
    positionals: "none",
    flags: {
        "-d": UNSAFE,
        "--delete": UNSAFE,
        "-D": UNSAFE,
        "-a": UNSAFE,
        "--annotate": UNSAFE,
        "-s": UNSAFE,
        "--sign": UNSAFE,
        "-u": UNSAFE,
        "--local-user": UNSAFE,
        "-f": UNSAFE,
        "--force": UNSAFE,
        "-m": UNSAFE,
        "--move": UNSAFE,
        "--create-reflog": UNSAFE,
    },
};

const DIFF_SPEC: CommandSpec = {
    validate: (args) => {
        for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            if (arg === "--") {
                break;
            }

            // Revision/path arguments are still checked by the normal path
            // extractor. Only option-looking arguments need allowlisting.
            if (
                arg.startsWith("-") &&
                arg !== "-h" &&
                arg !== "--check" &&
                arg !== "--stat" &&
                arg !== "--numstat" &&
                arg !== "--shortstat" &&
                arg !== "--summary" &&
                arg !== "--compact-summary" &&
                arg !== "--dirstat" &&
                arg !== "--dirstat-by-file" &&
                arg !== "--name-status" &&
                arg !== "--name-only" &&
                arg !== "--quiet" &&
                arg !== "--cached" &&
                arg !== "--staged" &&
                arg !== "--relative" &&
                arg !== "--no-renames" &&
                arg !== "--no-ext-diff" &&
                arg !== "--no-textconv"
            ) {
                return false;
            }
        }

        // All remaining forms are read-only diff output. Path arguments after
        // `--` are still checked by the normal path extractor.
        return true;
    },
};

/**
 * `git show` is history inspection, including its default patch output. Keep
 * only output-file redirection ineligible because it mutates the checkout.
 */
const SHOW_SPEC: CommandSpec = {
    flags: { "--output": UNSAFE },
    validate: (args) => !args.some((arg) => arg === "--output" || arg.startsWith("--output=")),
};

/**
 * Read-only history and object inspection that answers "what does git still hold".
 *
 * These verbs are the forensic half of git: they read the object database, refs, and reflogs, and
 * write nothing. They are curated as a family because a delegated search for lost commits needs
 * several of them in one pass; each miss used to be an unconsultable `UNSAFE_SUBCOMMAND` (see
 * `sandbox/commands.md`). Only flags that write or consume unmodeled stdin are marked, because every
 * remaining argument is data for these verbs rather than a filesystem path.
 *
 * Deliberately absent: `gc`/`prune` (maintenance, not inspection), `config` (can expose unrelated
 * configuration), `ls-remote` (network), and `verify-pack` (takes a `.git` path, which the sensitive
 * path rule refuses; `count-objects` and `fsck` answer the same question).
 */
const HISTORY_SPEC: CommandSpec = {
    positionals: "ignore",
};

const REV_LIST_SPEC: CommandSpec = {
    positionals: "ignore",
    flags: {
        "-n": VALUE,
        "--max-count": VALUE,
        "--skip": VALUE,
        "--since": VALUE,
        "--until": VALUE,
        "--after": VALUE,
        "--before": VALUE,
        "--author": VALUE,
        "--committer": VALUE,
        "--grep": VALUE,
        "--format": VALUE,
        "--pretty": VALUE,
        "--date": VALUE,
        "--encoding": VALUE,
        "--min-parents": VALUE,
        "--max-parents": VALUE,
        "--exclude": VALUE,
        "--glob": VALUE,
        "--filter": VALUE,
        "--missing": VALUE,
        // Reads a revision list from stdin, which the AST does not model.
        "--stdin": UNSAFE,
    },
};

/** `cat-file` reads objects; `--filters`/`--textconv` run configured helpers and batch modes read stdin. */
const CAT_FILE_SPEC: CommandSpec = {
    positionals: "ignore",
    flags: {
        "--filters": UNSAFE,
        "--textconv": UNSAFE,
        "--batch": UNSAFE,
        "--batch-check": UNSAFE,
        "--batch-command": UNSAFE,
        "--follow-symlinks": UNSAFE,
        "--path": PATH_VALUE,
    },
};

/** `reflog` dispatches again on its verb: `show`/`exists` read, `expire`/`delete`/`drop` move refs. */
const REFLOG_SPEC: CommandSpec = {
    positionals: "ignore",
    flags: {
        "-n": VALUE,
        "--max-count": VALUE,
        "--format": VALUE,
        "--pretty": VALUE,
        "--date": VALUE,
        "--decorate": VALUE,
        "--output": UNSAFE,
    },
    validate: (args) => {
        const verb = args[1];
        // No verb (bare `git reflog`) is `show`; a leading option is a show option.
        return verb === undefined || verb.startsWith("-") || verb === "show" || verb === "exists";
    },
};

const STASH_SPEC: CommandSpec = {
    positionals: "ignore",
    flags: {
        "-p": {},
        "--patch": {},
        "--stat": {},
        "--no-stat": {},
        "--numstat": {},
        "--shortstat": {},
        "--name-only": {},
        "--name-status": {},
        "--include-untracked": {},
        "--only-untracked": {},
        "--binary": {},
        "-n": VALUE,
        "--max-count": VALUE,
        "--format": VALUE,
        "--pretty": VALUE,
        "--date": VALUE,
        "--since": VALUE,
        "--until": VALUE,
        "--author": VALUE,
        "--grep": VALUE,
        "--output": UNSAFE,
    },
    // Both readers take the log-option surface; every mutating verb stays refused. `--output` is the
    // one log option that writes, so the validate check backs up the flag's own UNSAFE marking.
    validate: (args) =>
        (args[1] === "list" || args[1] === "show") &&
        !args.some((arg) => arg === "--output" || arg.startsWith("--output=")),
};

/**
 * `git format-patch` exports a mailbox. Without `--stdout` it writes `.patch` files into the cwd or an
 * `-o` directory, so only the stdout mode is read-only; the output-directory flags stay unsafe.
 */
const FORMAT_PATCH_SPEC: CommandSpec = {
    positionals: "ignore",
    safeModeFlags: ["--stdout"],
    flags: {
        "-o": UNSAFE,
        "--output-directory": UNSAFE,
        "--stdout": {},
    },
};

const FSCK_SPEC: CommandSpec = {
    positionals: "ignore",
    flags: {
        // Writes `.git/lost-found`; plain fsck only reports.
        "--lost-found": UNSAFE,
    },
};

const FOR_EACH_REF_SPEC: CommandSpec = {
    positionals: "ignore",
    flags: {
        "--format": VALUE,
        "--sort": VALUE,
        "--count": VALUE,
        "--points-at": VALUE,
        "--merged": VALUE,
        "--no-merged": VALUE,
        "--contains": VALUE,
        "--no-contains": VALUE,
        "--stdin": UNSAFE,
    },
};

const NAME_REV_SPEC: CommandSpec = {
    positionals: "ignore",
    flags: {
        "--refs": VALUE,
        "--exclude": VALUE,
        "--stdin": UNSAFE,
        "--annotate-stdin": UNSAFE,
    },
};

/**
 * Version control (read-only inspection of the repo in cwd).
 *
 * Excluded subcommands: cat-file, remote/config, and
 * fetch/pull/push/checkout/... can expose unrelated configuration, write, or
 * use the network. Historical `log` and `show` content is ordinary read-only
 * project access in the trusted local environment assumed by safe-bash.
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
            "-c": UNSAFE,
            "-C": UNSAFE,
            "--git-dir": UNSAFE,
            "--work-tree": UNSAFE,
            "--exec-path": UNSAFE,
            // Can inject arbitrary git config through an inherited env var,
            // including helper and external-diff settings.
            "--config-env": UNSAFE,
        },
        subcommands: {
            // `git status` may refresh the .git/index stat cache. This is an
            // intentional SAFE_READONLY exception: it changes only Git metadata,
            // and bash defaults to sandboxed execution.
            // Positionals are pathspecs.
            status: { tags: [CommandTag.GIT_STATUS] },
            // Keep only explicitly modeled diff modes eligible; default patch
            // output is allowed, while other output modes remain prompts.
            diff: DIFF_SPEC,
            show: SHOW_SPEC,
            log: LOG_SPEC,
            "ls-files": {
                flags: { "--exclude": VALUE, "--with-tree": VALUE },
            },
            describe: {
                flags: {
                    "--abbrev": VALUE,
                    "--candidates": VALUE,
                    "--matches": VALUE,
                    "--exclude": VALUE,
                },
            },
            // positionals are revisions, not paths
            "rev-parse": {
                positionals: "ignore",
                flags: {
                    "--short": VALUE,
                    "--abbrev": VALUE,
                    "--abbrev-ref": VALUE,
                    "--git-path": VALUE,
                    "--verify": VALUE,
                },
            },
            shortlog: {
                flags: {
                    "-n": VALUE,
                    "--max-count": VALUE,
                    "--since": VALUE,
                    "--until": VALUE,
                    "--after": VALUE,
                    "--before": VALUE,
                    "--author": VALUE,
                    "--grep": VALUE,
                    "--format": VALUE,
                    "--pretty": VALUE,
                    "-p": UNSAFE,
                    "--patch": UNSAFE,
                },
            },
            // alias of log
            whatchanged: LOG_SPEC,
            branch: BRANCH_SPEC,
            tag: TAG_SPEC,
            // `stash` dispatches again on its own verb, and only `list`/`show` read: pop/drop/clear/push
            // all move refs or the worktree, and bare `git stash` is a push. The subcommand validate hook
            // is what keeps the single-level dispatch from granting the mutators with the readers.
            stash: STASH_SPEC,
            // The forensic verbs. `reflog` and `stash` dispatch again on their own verb; the rest take
            // data positionals (revisions, refs, object names), not filesystem paths.
            "rev-list": REV_LIST_SPEC,
            "cat-file": CAT_FILE_SPEC,
            "format-patch": FORMAT_PATCH_SPEC,
            reflog: REFLOG_SPEC,
            fsck: FSCK_SPEC,
            "count-objects": { positionals: "none" },
            "for-each-ref": FOR_EACH_REF_SPEC,
            "show-ref": HISTORY_SPEC,
            "ls-tree": {
                ...HISTORY_SPEC,
                flags: { "--format": VALUE, "--abbrev": VALUE },
            },
            "name-rev": NAME_REV_SPEC,
            "merge-base": HISTORY_SPEC,
        },
    },
};
