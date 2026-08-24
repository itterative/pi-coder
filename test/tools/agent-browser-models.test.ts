import { describe, expect, it } from "vitest";

import type { AgentWorkspace } from "../../src/tools/agent/contracts/workspaces";
import { workspaceBrowserItem } from "../../src/tools/agent/presentation/browser-models";

function workspace(overrides: Partial<AgentWorkspace> = {}): AgentWorkspace {
    return {
        version: 1,
        id: "workspace-1",
        cwd: "/repo",
        repositoryRoot: "/repo",
        worktreePath: "/state/workspaces/workspace-1",
        slug: "workspace-1",
        baseRevision: "base",
        setupState: "ready",
        status: "available",
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    };
}

describe("agent browser view models", () => {
    it("projects prepared workspace actions and Git state", () => {
        const item = workspaceBrowserItem(workspace({
            leaseOwnerSessionId: "session-1",
            leaseRunId: "worker-1",
            leaseKind: "task",
            latestResult: {
                id: "result-1",
                workspaceId: "workspace-1",
                runId: "worker-1",
                baseRevision: "base",
                workerHead: "worker-head",
                commitRange: "base..worker-head",
                commits: ["worker-head change"],
                preparedAt: 3,
                status: "prepared",
            },
        }), {
            kind: "available",
            dirty: true,
            changedFiles: 2,
        }, "session-1");

        expect(item).toMatchObject({
            kind: "workspace",
            statusText: "leased",
            leaseText: "task · worker-1",
            git: { text: "dirty · 2 changed files" },
        });
        expect(item.actions.map(({ action }) => action)).toEqual([
            "inspect",
            "apply",
            "retain",
            "reset",
            "discard",
        ]);
    });

    it("protects a known lease owned by another parent session", () => {
        const item = workspaceBrowserItem(workspace({
            leaseOwnerSessionId: "other-session",
            leaseRunId: "worker-1",
            leaseKind: "task",
            leaseState: "known",
        }), undefined, "session-1");

        expect(item.actions).toEqual([]);
        expect(item.notice).toContain("leased by another parent session");
    });

    it("treats a historical result as unrelated to the current stale lease", () => {
        const item = workspaceBrowserItem(workspace({
            leaseOwnerSessionId: "session-1",
            leaseRunId: "worker-2",
            leaseKind: "task",
            latestResult: {
                id: "result-1",
                workspaceId: "workspace-1",
                runId: "worker-1",
                baseRevision: "base",
                workerHead: "worker-head",
                commitRange: "base..worker-head",
                commits: ["worker-head change"],
                preparedAt: 3,
                status: "prepared",
            },
        }), undefined, "session-1");

        expect(item.actions.map(({ action }) => action)).toEqual(["inspect", "release", "discard"]);
    });

    it("limits an orphaned lease owned by another session to recovery actions", () => {
        const item = workspaceBrowserItem(workspace({
            leaseOwnerSessionId: "other-session",
            leaseRunId: "missing-run",
            leaseKind: "task",
            leaseState: "orphaned",
            latestResult: {
                id: "result-1",
                workspaceId: "workspace-1",
                runId: "missing-run",
                baseRevision: "base",
                workerHead: "worker-head",
                commitRange: "base..worker-head",
                commits: ["worker-head change"],
                preparedAt: 3,
                status: "prepared",
            },
        }), undefined, "session-1");

        expect(item.statusText).toBe("orphaned lease");
        expect(item.actions.map(({ action }) => action)).toEqual(["recover", "inspect"]);
        expect(item.notice).toContain("protected until explicit recovery");
    });
});
