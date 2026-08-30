import { describe, expect, it } from "vitest";

import type { AgentRunSummary } from "../../src/tools/agent/contracts/runs";
import type { AgentWorkspace } from "../../src/tools/agent/contracts/workspaces";
import { listOutcome } from "../../src/tools/agent/presentation/outcomes";
import type { AgentRunManager } from "../../src/tools/agent/runs/manager";

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
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
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
            workspace({
                latestResult: {
                    id: "result-1",
                    workspaceId: "workspace-1",
                    runId: "worker-collected",
                    baseRevision: "base",
                    workerHead: "head",
                    commitRange: "base..head",
                    commits: ["head"],
                    preparedAt: 25,
                    status: "prepared",
                },
            }),
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
                latestResult: {
                    id: "result-no-change",
                    workspaceId: "workspace-1",
                    runId: "worker-old",
                    baseRevision: "base",
                    workerHead: "base",
                    commitRange: "base..base",
                    commits: [],
                    preparedAt: 25,
                    status: "discarded",
                },
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

        expect(result.content.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
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

        expect(result.content.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
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
                latestResult: {
                    id: "result-2",
                    workspaceId: "workspace-1",
                    runId: "worker-reviewed",
                    baseRevision: "base",
                    workerHead: "head",
                    commitRange: "base..head",
                    commits: [],
                    preparedAt: 25,
                    status: "applied",
                },
            }),
        ]);

        expect(result.content).toContain("inspect workspace");
        expect(result.content).toContain("review it before reusing");
        expect(result.content).not.toContain("collect with runId");
    });
});
