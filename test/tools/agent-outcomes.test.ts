import { describe, expect, it } from "vitest";

import { snapshotText } from "../helpers";

import type { Usage } from "@earendil-works/pi-ai";

import type {
    AgentRunDetails,
    AgentRunSummary,
    AgentRunStatus,
} from "../../src/tools/agent/contracts/runs";
import type {
    AgentWorkspace,
    AgentWorkspaceResult,
    WorkspaceResultStatus,
} from "../../src/tools/agent/contracts/workspaces";
import type { AgentParameters } from "../../src/tools/agent/definitions/prompt";
import {
    failedOutcome,
    listOutcome,
    updateResult,
} from "../../src/tools/agent/presentation/outcomes";
import type { AgentRunManager } from "../../src/tools/agent/runs/manager";
import { ZERO_USAGE } from "../../src/tools/agent/runs/usage";

/** Replaces the checkout path that `workspace()` embeds with a stable token. */
function normalizeWorkspacePath(text: string): string {
    return text.split(process.cwd()).join("<repo>");
}

const liveManager = (...runs: AgentRunSummary[]) =>
    ({
        listRuns: () => runs,
    }) as unknown as AgentRunManager;

function workspace(overrides: Partial<AgentWorkspace> = {}): AgentWorkspace {
    return {
        version: 1,
        id: "workspace-1",
        cwd: "/repo",
        repositoryRoot: "/repo",
        // Must be a directory that really exists, outside the synthetic `/repo` cwd: the
        // presentation layer stats the worktree path to tell "review this workspace" from "its
        // worktree is missing". `normalizeWorkspacePath` keeps this checkout location out of the
        // file snapshots so they hold on any machine or git worktree.
        worktreePath: process.cwd(),
        slug: "worktree-1",
        baseRevision: "base",
        setupState: "ready",
        status: "available",
        createdAt: 10,
        updatedAt: 20,
        ...overrides,
    };
}

/**
 * Detail JSON with the clock removed: `listOutcome` and `failedOutcome` stamp both timestamps from
 * `Date.now()`, so the snapshot records that they exist and leaves their value out.
 */
function stableDetails(value: { details: object; isError: boolean }): string {
    const details = value.details as Record<string, unknown>;
    return JSON.stringify(
        {
            isError: value.isError,
            details: { ...details, startedAt: "<timestamp>", updatedAt: "<timestamp>" },
        },
        null,
        2,
    );
}

/** The `- ` lines of a list outcome, one per run the listing names. */
function rows(content: string): string[] {
    return content.split("\n").filter((line) => line.startsWith("- "));
}

function usage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function details(overrides: Partial<AgentRunDetails> = {}): AgentRunDetails {
    return {
        runId: "run-1",
        title: "Wire it up",
        agent: "worker",
        status: "running",
        task: "Implement the change",
        recentActivity: [],
        usage: usage(),
        startedAt: 10,
        updatedAt: 20,
        ...overrides,
    };
}

function workspaceResult(
    id: string,
    runId: string,
    status: WorkspaceResultStatus = "prepared",
): AgentWorkspaceResult {
    const changed = status === "prepared" || status === "applied";
    return {
        id,
        workspaceId: "workspace-1",
        runId,
        baseRevision: "base",
        workerHead: changed ? "head" : "base",
        commitRange: changed ? "base..head" : "base..base",
        commits: changed ? ["head"] : [],
        preparedAt: 25,
        status,
    };
}

function run(runId: string): AgentRunSummary {
    return {
        runId,
        title: "Live worker",
        agent: "worker",
        status: "completed",
        background: false,
        task: "Implement the task",
        startedAt: 10,
        updatedAt: 20,
        usage: usage(),
    };
}

describe("agent list workspace catalog", () => {
    it("shows a catalog-only lease without suggesting continue or collect", () => {
        const result = listOutcome(liveManager(), [
            workspace({
                leaseOwnerSessionId: "dead-session",
                leaseRunId: "worker-dead",
                leaseKind: "task",
                leaseAcquiredAt: 15,
            }),
        ]);

        expect(result.content).toContain('"worker-dead"');
        expect(result.content).toContain("catalog-only workspace blocker");
        expect(result.content).toContain("interrupted");
        expect(result.content).toContain('inspect workspace "worktree-1"');
        expect(result.content).not.toContain("continue with guidance");
        expect(result.content).not.toContain("collect with runId");
    });

    it("shows a prepared result after the manager no longer tracks its run", () => {
        const result = listOutcome(liveManager(), [
            workspace({ latestResult: workspaceResult("result-1", "worker-collected") }),
        ]);

        expect(result.content).toContain('"worker-collected"');
        expect(result.content).toContain('"result-1"');
        expect(result.content).toContain("apply, retain, reset, or discard");
        expect(result.content).not.toContain("collect with runId");
        expect(result.content).not.toContain("continue with guidance");
    });

    it("does not list a released no-change result as a blocker", () => {
        const result = listOutcome(liveManager(), [
            workspace({
                latestResult: workspaceResult("result-no-change", "worker-old", "discarded"),
            }),
        ]);

        expect(result.content).toBe("No delegated agent runs are currently tracked.");
    });

    it("does not merge an isolated blocker with a same-named same-checkout run", () => {
        const result = listOutcome(liveManager(run("worker-1")), [
            workspace({
                leaseRunId: "worker-1",
                leaseKind: "task",
            }),
        ]);

        expect(rows(result.content)).toHaveLength(2);
        expect(result.content).toContain("catalog-only workspace blocker");
    });

    it("deduplicates a catalog lease that belongs to a live isolated run", () => {
        const isolated = { ...run("worker-live"), workspaceId: "workspace-1" };
        const result = listOutcome(liveManager(isolated), [
            workspace({
                leaseRunId: "worker-live",
                leaseKind: "task",
            }),
        ]);

        expect(rows(result.content)).toHaveLength(1);
        expect(result.content).not.toContain("catalog-only workspace blocker");
        expect(result.content).toContain('collect with runId="worker-live"');
    });

    it("shows a missing worktree that may still consume capacity", () => {
        const result = listOutcome(liveManager(), [
            workspace({
                id: "missing-workspace",
                slug: "missing-worktree",
                worktreePath: "/path/that/does/not/exist",
            }),
        ]);

        expect(result.content).toContain('"workspace-missing-workspace"');
        expect(result.content).toContain("worktree is missing");
    });

    it("uses review actions when a workspace remains unavailable", () => {
        const result = listOutcome(liveManager(), [
            workspace({
                status: "review_required",
                latestResult: workspaceResult("result-2", "worker-reviewed", "applied"),
            }),
        ]);

        expect(result.content).toContain("inspect workspace");
        expect(result.content).toContain("review it before reusing");
        expect(result.content).not.toContain("collect with runId");
    });
});

/**
 * These snapshots are the characterization suite for the listing's rendered shape: row headers,
 * blank-indented task and guidance lines, and the workspace note. `presentation/outcomes.ts` is
 * restructured around them, so a formatting change has to show up here as a readable diff instead of
 * silently altering what the parent model reads.
 */
describe("agent list rendering", () => {
    const STATUSES: AgentRunStatus[] = [
        "starting",
        "running",
        "waiting_for_permission",
        "waiting_for_parent",
        "interrupted",
        "completed",
        "failed",
        "aborted",
        "canceled",
    ];

    it("renders each run status with the guidance its arm selects", async () => {
        const sections = [
            `### empty listing\n${listOutcome(liveManager(), []).content}`,
            `### two runs keep manager order\n${listOutcome(liveManager(run("worker-1"), run("scout-2"))).content}`,
        ];
        for (const status of STATUSES) {
            const listing = listOutcome(liveManager({ ...run("run-1"), status }));
            sections.push(`### ${status}\n${listing.content}`);
        }

        await expect(
            snapshotText(normalizeWorkspacePath(sections.join("\n\n"))),
        ).toMatchFileSnapshot("__snapshots__/agent-outcomes.list-rows.txt");
    });

    it("reports the listing itself as a completed runtime outcome", async () => {
        const outcome = listOutcome(liveManager(run("worker-1")));

        expect(outcome.details.updatedAt - outcome.details.startedAt).toBe(0);
        await expect(
            snapshotText(normalizeWorkspacePath(stableDetails(outcome))),
        ).toMatchFileSnapshot("__snapshots__/agent-outcomes.list-envelope.txt");
    });
});

describe("agent list workspace blockers", () => {
    const cases: Array<[string, AgentRunSummary[], AgentWorkspace[]]> = [
        [
            "setup lease",
            [],
            [workspace({ leaseRunId: "setup-1", leaseKind: "setup", leaseAcquiredAt: 15 })],
        ],
        [
            "task lease",
            [],
            [
                workspace({
                    leaseRunId: "worker-dead",
                    leaseKind: "task",
                    leaseOwnerSessionId: "dead-session",
                }),
            ],
        ],
        [
            "review required with a lease and no result",
            [],
            [workspace({ status: "review_required", leaseRunId: "worker-x", leaseKind: "task" })],
        ],
        [
            "prepared result the manager no longer tracks",
            [],
            [workspace({ latestResult: workspaceResult("result-1", "worker-collected") })],
        ],
        [
            "setup lease whose own result exists",
            [],
            [
                workspace({
                    leaseRunId: "setup-1",
                    leaseKind: "setup",
                    latestResult: workspaceResult("result-1", "setup-1"),
                }),
            ],
        ],
        [
            "lease and prepared result name the same run",
            [],
            [
                workspace({
                    leaseRunId: "worker-1",
                    leaseKind: "task",
                    latestResult: workspaceResult("result-2", "worker-1"),
                }),
            ],
        ],
        [
            "applied result under a review status",
            [],
            [
                workspace({
                    status: "review_required",
                    latestResult: workspaceResult("result-3", "worker-reviewed", "applied"),
                }),
            ],
        ],
        [
            "missing worktree with no run to name",
            [],
            [
                workspace({
                    id: "ws-missing",
                    slug: "missing-worktree",
                    worktreePath: "/no/such/path",
                }),
            ],
        ],
        [
            // The synthetic id only needs *no blocking* result, while the `workspace-registry` label
            // needs no result at all, so this row keeps the registry id and loses the registry label.
            "missing worktree whose result was already released",
            [],
            [
                workspace({
                    worktreePath: "/no/such/path",
                    latestResult: workspaceResult("result-4", "worker-old", "discarded"),
                }),
            ],
        ],
        [
            "recycling workspace under lease",
            [],
            [workspace({ status: "recycling", leaseRunId: "worker-y", leaseKind: "task" })],
        ],
        [
            "released no-change result",
            [],
            [workspace({ latestResult: workspaceResult("result-5", "worker-z", "discarded") })],
        ],
        ["available workspace with nothing outstanding", [], [workspace({ setupState: "ready" })]],
        [
            "live isolated run deduplicates its blocker",
            [{ ...run("worker-live"), workspaceId: "workspace-1" }],
            [workspace({ leaseRunId: "worker-live", leaseKind: "task" })],
        ],
        [
            "live isolated run gains the prepared-result action",
            [{ ...run("worker-1"), workspaceId: "workspace-1" }],
            [
                workspace({
                    leaseRunId: "worker-1",
                    leaseKind: "task",
                    latestResult: workspaceResult("result-1", "worker-1"),
                }),
            ],
        ],
        [
            "same run id in a different checkout stays a separate row",
            [run("worker-1")],
            [workspace({ leaseRunId: "worker-1", leaseKind: "task" })],
        ],
        [
            "two blockers from one lease and one result row",
            [],
            [
                workspace({
                    leaseRunId: "worker-lease",
                    leaseKind: "task",
                    latestResult: workspaceResult("result-9", "worker-other"),
                }),
            ],
        ],
    ];

    it("renders one row per run a workspace blocks", async () => {
        const sections = cases.map(([label, runs, workspaces]) => {
            return `### ${label}\n${listOutcome(liveManager(...runs), workspaces).content}`;
        });

        await expect(
            snapshotText(normalizeWorkspacePath(sections.join("\n\n"))),
        ).toMatchFileSnapshot("__snapshots__/agent-outcomes.workspace-blockers.txt");
    });
});

describe("agent failure and update outcomes", () => {
    it("describes a failed action for both start and non-start requests", async () => {
        const sections = [
            "### start with an Error\n" +
                (() => {
                    const outcome = failedOutcome(
                        {
                            action: "start",
                            agent: "scout",
                            task: "Inspect the loader\nsecond line",
                            title: "  Spare   title  ",
                            background: true,
                        } as AgentParameters,
                        new Error("boom"),
                    );
                    return `${outcome.content}\n${stableDetails(outcome)}`;
                })(),
            "### non-start with a string throwable\n" +
                (() => {
                    const outcome = failedOutcome(
                        {
                            action: "collect",
                            runId: "run-1",
                            task: "not the failed task",
                        } as AgentParameters,
                        "not an error",
                    );
                    return `${outcome.content}\n${stableDetails(outcome)}`;
                })(),
            "### start with only an action\n" +
                (() => {
                    const outcome = failedOutcome({ action: "start" } as AgentParameters, {
                        message: "looked like an error",
                    });
                    return `${outcome.content}\n${stableDetails(outcome)}`;
                })(),
        ];

        await expect(
            snapshotText(normalizeWorkspacePath(sections.join("\n\n"))),
        ).toMatchFileSnapshot("__snapshots__/agent-outcomes.failed.txt");
    });

    it("truncates a start task and keeps a non-start task out of the details", () => {
        const started = failedOutcome(
            { action: "start", task: "x".repeat(3_000) } as AgentParameters,
            new Error("boom"),
        );
        expect(started.details.task).toHaveLength(2_000);

        const collected = failedOutcome(
            { action: "collect", runId: "run-1", task: "x".repeat(3_000) } as AgentParameters,
            new Error("boom"),
        );
        expect(collected.details.task).toBe("");
    });

    it("shows the newest activity line, or the status when there is none", async () => {
        const activeInput = details({ recentActivity: ["Reading src/a.ts", "Editing src/b.ts"] });
        const active = updateResult(activeInput);
        const idle = updateResult(details({ status: "waiting_for_parent" }));

        // The update result carries the details object through untouched, so the TUI can reuse it.
        expect(active.details).toBe(activeInput);
        await expect(
            snapshotText(
                normalizeWorkspacePath(
                    [
                        `### with activity\n${JSON.stringify(active.content, null, 2)}`,
                        `### without activity\n${JSON.stringify(idle.content, null, 2)}`,
                    ].join("\n\n"),
                ),
            ),
        ).toMatchFileSnapshot("__snapshots__/agent-outcomes.update.txt");
    });
});

describe("agent outcome usage frames", () => {
    it("gives each usage frame its own cost object", () => {
        const outcome = listOutcome(liveManager(), []);

        expect(outcome.usage).not.toBe(ZERO_USAGE);
        expect(outcome.usage.cost).not.toBe(ZERO_USAGE.cost);
        expect(outcome.details.usage).not.toBe(outcome.usage);
        expect(outcome.details.usage).toEqual(usage());

        // Every frame in the process clones from the module-level `ZERO_USAGE`, so a shallow clone
        // would let one accumulated total leak into the next listing.
        outcome.usage.cost.total = 5;
        expect(ZERO_USAGE.cost.total).toBe(0);
        expect(outcome.details.usage.cost.total).toBe(0);
    });
});
