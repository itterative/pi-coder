/**
 * Generic, hardcoded facts about what each runner is allowed to do.
 *
 * These are not project rules and they are not permission rules. They are the premises a classifier needs
 * to judge a routine action correctly, and they are the same for every project: a coding agent rewrites
 * files as its normal work, and a review child runs the tests. Without being told that the runner owns the
 * workspace, the model reads an in-place file rewrite as "destructive" and withholds it.
 *
 * Shape, measured on a 25-case hand-labelled set crossed with three runners (agreement with the intended
 * block/allow label):
 *
 *     parent    may-only 24/25   DO/DON'T 24/25     (identical: nothing negative to state)
 *     worker    may-only 24/25   DO/DON'T 24/25     (identical: nothing negative to state)
 *     reviewer  may-only 19/25   DO/DON'T 24/25     (the DON'T lines are what enforce the role)
 *
 * So: phrase positively wherever the runner has no prohibition, and state the prohibition explicitly where
 * it does. The earlier scare — project prohibitions in the state being read as permission verdicts, which
 * turned 6 of 7 `prettier --write` commands into `refuse` — does not reproduce, because these DON'Ts are
 * about *authority* (what the runner may touch), never about workflow (what the project prefers).
 */

/** Who is running the command. `agent` is the baseline for a child whose type is not listed. */
export type DecisionRunner = "parent" | "agent" | "scout" | "advisor" | "reviewer" | "worker";

/** Where a mutating runner's working copy is. */
export type DecisionIsolation = "worktree" | "checkout";

/**
 * The authority rung each runner sits at, mirroring `AGENT_AUTHORITY_LADDER` in
 * `src/tools/agent/definitions/types.ts` (`read` < `inspect` < `command` < `mutate`).
 *
 * It is a mirror rather than an import: `modules/` does not depend on `tools/`, and the delegated-agent
 * declaration layer stays the single owner of capability names and implications. Keep the two in step.
 */
export const RUNNER_AUTHORITY: Readonly<Record<DecisionRunner, "inspect" | "command" | "mutate">> =
    {
        parent: "mutate",
        agent: "command",
        scout: "inspect",
        advisor: "inspect",
        reviewer: "command",
        worker: "mutate",
    };

const READ_ONLY_RULES = [
    "Runs as a delegated read-only child.",
    "DO: read files and run read-only inspection commands.",
    "DON'T: create, change, or delete files.",
    "DON'T: install packages or use the network.",
];

/** The generic facts for a runner, or the `agent` baseline for an unlisted type. */
export function runnerRulesFor(
    runner: DecisionRunner,
    isolation: DecisionIsolation = "checkout",
): readonly string[] {
    switch (runner) {
        case "parent":
            return [
                "Runs the user's own session in the user's working tree.",
                "DO: read, create, edit, and delete files in the user's working tree.",
                "DO: run build, test, format, and package commands.",
                "DO: use the network, install packages, and start local processes.",
            ];

        case "scout":
        case "advisor":
            return READ_ONLY_RULES;

        case "reviewer":
            return [
                "Runs as a delegated review child with the parent's read access.",
                "DO: read files and inspect the checkout.",
                "DO: run the project's own build, test, format, and lint commands.",
                "DON'T: create, change, or delete files.",
                "DON'T: install packages or act on remote repositories.",
            ];

        case "worker":
            return [
                isolation === "worktree"
                    ? "Runs as a delegated implementation child, in an isolated disposable git worktree."
                    : "Runs as a delegated implementation child, in the user's working tree.",
                "DO: read, create, edit, and delete files in its own working copy.",
                "DO: run build, test, format, and package commands in that working copy.",
                "DO: use the network for package installs.",
                "DON'T: change files outside its own working copy.",
            ];

        case "agent":
            return [
                "Runs as a delegated child of the parent session, in its own working copy.",
                "DO: read files and inspect the checkout.",
                "DO: run the project's own build, test, format, and lint commands.",
                "DON'T: change files unless its own definition grants that.",
            ];
    }
}

/**
 * The same authority facts phrased for a *path*, for the file-access subject.
 *
 * A separate set rather than a reuse of `runnerRulesFor`, because those rules are written about a working
 * tree, and a classifier shown "DO: read, create, edit, and delete files in the user's working tree" reads an
 * outside path as outside the rules. Measured on 111 real outside-cwd accesses, that phrasing resolved 63 of
 * the 102 the user approved and left every private path alone; stating that other projects, installed
 * packages, and the user's own tool settings are ordinary material took it to 72 with no additional wrong
 * grant, and the two DON'T lines are what keeps a wallet blob or an OS unit out of the grant set. They are
 * about authority over *which files*, never about workflow, which is the category these premises measured
 * safe in.
 */
export function runnerRulesForFileAccess(
    runner: DecisionRunner,
    isolation: DecisionIsolation = "checkout",
): readonly string[] {
    switch (runner) {
        case "parent":
            return [
                "Runs the user's own session in the user's working tree.",
                "DO: read, create, edit, and delete files in the user's working tree.",
                "DO: read source, documentation, and configuration of other projects, installed packages, and the user's own tool settings, when the work needs them.",
                "DO: write throwaway scripts and notes outside the working tree when the task needs them.",
                "DON'T: read the user's private documents, credentials, or keys.",
                "DON'T: change OS or service files.",
            ];

        case "scout":
        case "advisor":
            return [
                "Runs as a delegated read-only child.",
                "DO: read files, including documentation, installed packages, and other projects, when the task needs them.",
                "DON'T: create, change, or delete any file.",
                "DON'T: read the user's private documents, credentials, or keys.",
            ];

        case "reviewer":
            return [
                "Runs as a delegated review child with the parent's read access.",
                "DO: read files, including documentation, installed packages, and other projects, when the review needs them.",
                "DON'T: create, change, or delete any file.",
                "DON'T: read the user's private documents, credentials, or keys.",
            ];

        case "worker":
            return [
                isolation === "worktree"
                    ? "Runs as a delegated implementation child, in an isolated disposable git worktree."
                    : "Runs as a delegated implementation child, in the user's working tree.",
                "DO: read, create, edit, and delete files in its own working copy.",
                "DO: read source, documentation, and configuration of other projects, installed packages, and the user's own tool settings, when the task needs them.",
                "DON'T: change files outside its own working copy.",
                "DON'T: read the user's private documents, credentials, or keys.",
            ];

        case "agent":
            return [
                "Runs as a delegated child of the parent session, in its own working copy.",
                "DO: read files, including documentation and other projects, when the task needs them.",
                "DON'T: change files outside its own working copy.",
                "DON'T: read the user's private documents, credentials, or keys.",
            ];
    }
}

/** Map a child's agent name to a decision runner. Unknown/custom agents use the `agent` baseline. */
export function decisionRunnerForAgent(agentName: string | undefined): DecisionRunner {
    switch (agentName) {
        case "scout":
        case "advisor":
        case "reviewer":
        case "worker":
            return agentName;
        default:
            return "agent";
    }
}
