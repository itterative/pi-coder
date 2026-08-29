import { describe, expect, it } from "vitest";

import type { AgentWorkspace } from "../../src/tools/agent/contracts/workspaces";
import type { AgentSessionBrowserItem } from "../../src/tools/agent/presentation/browser-models";
import { mergeHistoricalAgentSessions } from "../../src/tools/agent/browser";
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

function sessionItem(overrides: Partial<AgentSessionBrowserItem>): AgentSessionBrowserItem {
    return {
        kind: "past",
        id: "session-1",
        title: "Session",
        agent: "scout",
        status: "completed",
        task: "Inspect",
        updatedAt: 1,
        ...overrides,
    };
}

describe("agent browser view models", () => {
    it("merges cwd-wide history while replacing current-parent files with exact checkpoints", () => {
        const allPast = [
            sessionItem({ id: "active-file", sessionFile: "/state/current-child.jsonl", transcript: "catalog latest" }),
            sessionItem({ id: "other-file", sessionFile: "/state/other-child.jsonl", transcript: "other parent history" }),
            sessionItem({ id: "live-file", sessionFile: "/state/live-child.jsonl", transcript: "stale catalog" }),
        ];
        const activeBranchPast = [
            sessionItem({
                id: "active-file",
                sessionFile: "/state/current-child.jsonl",
                transcript: "active branch checkpoint",
                readOnlyReason: "continued on another branch",
            }),
        ];
        const current = [sessionItem({ kind: "current", id: "live-file", sessionFile: "/state/live-child.jsonl" })];

        const merged = mergeHistoricalAgentSessions(allPast, activeBranchPast, current);

        expect(merged).toHaveLength(2);
        expect(merged).toContainEqual(expect.objectContaining({
            id: "active-file",
            transcript: "active branch checkpoint",
            readOnlyReason: "continued on another branch",
        }));
        expect(merged).toContainEqual(expect.objectContaining({
            id: "other-file",
            transcript: "other parent history",
        }));
        expect(merged.find((item) => item.id === "live-file")).toBeUndefined();
    });
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
            gitState: {
                kind: "available",
                dirty: true,
                changedFiles: 2,
            },
            currentSessionId: "session-1",
        });

        expect(item).toMatchObject({
            kind: "workspace",
            id: "workspace-1",
            cwd: "/repo",
            repositoryRoot: "/repo",
            worktreePath: "/state/workspaces/workspace-1",
            baseRevision: "base",
            statusText: "leased",
            leaseText: "task · worker-1",
            leaseOwnerSessionId: "session-1",
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
            leaseActive: true,
        }), { currentSessionId: "session-1" });

        expect(item.actions).toEqual([]);
        expect(item.notice).toContain("leased by another parent session");
    });

    it("allows an old task lease from another session to be reset or discarded", () => {
        const item = workspaceBrowserItem(workspace({
            leaseOwnerSessionId: "other-session",
            leaseRunId: "worker-1",
            leaseKind: "task",
            leaseState: "known",
            leaseActive: false,
        }), { currentSessionId: "session-1" });

        expect(item.actions.map(({ action }) => action)).toEqual(["reset", "discard"]);
        expect(item.notice).toContain("reset or discard");
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
        }), { currentSessionId: "session-1" });

        expect(item.actions.map(({ action }) => action)).toEqual(["inspect", "release", "discard"]);
    });

    it("offers recovery and manual clearing for an orphaned lease owned by another session", () => {
        const item = workspaceBrowserItem(workspace({
            leaseOwnerSessionId: "other-session",
            leaseRunId: "missing-run",
            leaseKind: "task",
            leaseState: "orphaned",
            leaseActive: false,
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
        }), { currentSessionId: "session-1" });

        expect(item.statusText).toBe("orphaned lease");
        expect(item.actions.map(({ action }) => action)).toEqual(["recover", "inspect", "reset", "discard"]);
        expect(item.notice).toContain("reset or discard");
    });
});
