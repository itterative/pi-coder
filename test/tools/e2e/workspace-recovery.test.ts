import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeWorkspaceAction } from "../../../src/tools/agent/workspaces/actions";
import { createAgentWorkspace, recycleAgentWorkspaceForReuse, resetAgentWorkspaceForReuse } from "../../../src/tools/agent/workspaces/lifecycle";
import { createAgentWorkspaceCheckpoint } from "../../../src/tools/agent/workspaces/checkpoints";
import { applyAgentWorkspaceApplication, prepareAgentWorkspaceApplication, retainAgentWorkspaceResult } from "../../../src/tools/agent/workspaces/results";
import { getAgentWorkspace, MAX_AGENT_WORKSPACES } from "../../../src/tools/agent/workspaces/store";
import * as workspaceGit from "../../../src/tools/agent/workspaces/git";
import { appendParentCommit, createClaimedTaskWorkspace, createE2EPaths, gitOutput, initializeRepository, insertE2EAgentRun, removeE2EPaths, withE2EMetadataDatabase, type E2EPaths } from "./helpers";

const pathsInUse: E2EPaths[] = [];

afterEach(() => {
    vi.restoreAllMocks();
    for (const paths of pathsInUse.splice(0)) removeE2EPaths(paths);
});

describe("isolated workspace recovery e2e", () => {
    it("rebases a recycled workspace to the current parent head", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        const initialHead = initializeRepository(paths.repository);
        const workspace = await createClaimedTaskWorkspace(paths, { runId: "worker-x", runInstanceId: "worker-x-instance" });
        fs.writeFileSync(path.join(workspace.worktreePath, "worker-x.txt"), "x\n");
        await createAgentWorkspaceCheckpoint(workspace.id, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            runInstanceId: "worker-x-instance",
            kind: "terminal",
            runStatus: "completed",
            childSessionLeafId: null,
            workspacesDir: paths.state,
        });

        appendParentCommit(paths.repository, "parent-change.txt", "parent\n");
        const currentParentHead = gitOutput(paths.repository, ["rev-parse", "HEAD"]);

        const recycled = await recycleAgentWorkspaceForReuse(workspace.id, {
            previousOwnerSessionId: "owner",
            previousLeaseRunId: "worker-x",
            previousLeaseRunInstanceId: "worker-x-instance",
            ownerSessionId: "other-owner",
            leaseRunId: "worker-y",
            leaseRunInstanceId: "worker-y-instance",
            workspacesDir: paths.state,
        });

        expect(initialHead).not.toBe(currentParentHead);
        expect(gitOutput(recycled.worktreePath, ["rev-parse", "HEAD"])).toBe(currentParentHead);
        expect(fs.existsSync(path.join(recycled.worktreePath, "worker-x.txt"))).toBe(false);
        expect(fs.existsSync(path.join(recycled.worktreePath, "parent-change.txt"))).toBe(true);
        expect(recycled.baseRevision).toBe(currentParentHead);
    });

    it("does not recycle a workspace whose catalog run is still active", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        initializeRepository(paths.repository);
        const workspace = await createClaimedTaskWorkspace(paths, { runId: "worker-x", runInstanceId: "worker-x-instance" });
        await insertE2EAgentRun(paths, { runId: "worker-x", runInstanceId: "worker-x-instance", status: "running" });

        await expect(recycleAgentWorkspaceForReuse(workspace.id, {
            previousOwnerSessionId: "owner",
            previousLeaseRunId: "worker-x",
            previousLeaseRunInstanceId: "worker-x-instance",
            ownerSessionId: "other-owner",
            leaseRunId: "worker-y",
            leaseRunInstanceId: "worker-y-instance",
            workspacesDir: paths.state,
        })).rejects.toThrow("still used by active run worker-x");

        const unchanged = await getAgentWorkspace(workspace.id, { workspacesDir: paths.state });
        expect(unchanged).toMatchObject({
            leaseOwnerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            status: "available",
        });
    });

    it("recovers an applying result owned by a dead foreign process", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        initializeRepository(paths.repository);
        const workspace = await createClaimedTaskWorkspace(paths, { runId: "worker-x", runInstanceId: "worker-x-instance" });
        fs.writeFileSync(path.join(workspace.worktreePath, "worker-x.txt"), "x\n");
        const result = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            workspacesDir: paths.state,
        });
        const parentRevision = gitOutput(paths.repository, ["rev-parse", "HEAD"]);
        fs.writeFileSync(path.join(paths.repository, "worker-x.txt"), "x\n");
        await withE2EMetadataDatabase(paths, (database) => {
            database.prepare(`
                UPDATE workspace_results
                SET status = 'applying', parent_revision = ?, reservation_token = ?,
                    reservation_owner_session_id = ?, reservation_run_id = ?,
                    reservation_run_instance_id = ?, reservation_owner_pid = ?
                WHERE id = ?
            `).run(
                parentRevision,
                "apply-token",
                "owner",
                "worker-x",
                "worker-x-instance",
                123_456,
                result.id,
            );
        });
        vi.spyOn(process, "kill").mockImplementation(() => {
            const error = new Error("process not found") as NodeJS.ErrnoException;
            error.code = "ESRCH";
            throw error;
        });

        const action = await executeWorkspaceAction({
            action: "apply",
            workspace,
            ownerSessionId: "owner",
            runId: "worker-x",
            runInstanceId: "worker-x-instance",
            resultId: result.id,
            workspacesDir: paths.state,
        });
        const recovered = action.result;

        expect(recovered).toMatchObject({ id: result.id, status: "applied", parentRevision });
        expect(fs.readFileSync(path.join(paths.repository, "worker-x.txt"), "utf8")).toBe("x\n");
        await withE2EMetadataDatabase(paths, (database) => {
            expect(database.prepare("SELECT status, reservation_token FROM workspace_results WHERE id = ?").get(result.id))
                .toEqual({ status: "applied", reservation_token: null });
        });
    });

    it("does not recover an apply while the original apply is still running", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        initializeRepository(paths.repository);
        const workspace = await createClaimedTaskWorkspace(paths, { runId: "worker-x", runInstanceId: "worker-x-instance" });
        fs.writeFileSync(path.join(workspace.worktreePath, "worker-x.txt"), "x\n");
        const result = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            workspacesDir: paths.state,
        });
        const originalGit = workspaceGit.git;
        let applyStarted!: () => void;
        const applyStartedPromise = new Promise<void>((resolve) => {
            applyStarted = resolve;
        });
        let releaseApply!: () => void;
        const applyRelease = new Promise<void>((resolve) => {
            releaseApply = resolve;
        });
        vi.spyOn(workspaceGit, "git").mockImplementation(async (cwd, args) => {
            if (args[0] === "apply" && !args.includes("--check")) {
                applyStarted();
                await applyRelease;
            }
            return originalGit(cwd, args);
        });

        const firstApply = applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            resultId: result.id,
            workspacesDir: paths.state,
        });
        await applyStartedPromise;
        await expect(applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            resultId: result.id,
            workspacesDir: paths.state,
        })).rejects.toThrow("still being applied");
        releaseApply();
        await expect(firstApply).resolves.toMatchObject({ id: result.id, status: "applied" });
    });

    it("does not recover an applying result owned by a live foreign process", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        initializeRepository(paths.repository);
        const workspace = await createClaimedTaskWorkspace(paths, { runId: "worker-x", runInstanceId: "worker-x-instance" });
        fs.writeFileSync(path.join(workspace.worktreePath, "worker-x.txt"), "x\n");
        const result = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            workspacesDir: paths.state,
        });
        const parentRevision = gitOutput(paths.repository, ["rev-parse", "HEAD"]);
        await withE2EMetadataDatabase(paths, (database) => {
            database.prepare(`
                UPDATE workspace_results
                SET status = 'applying', parent_revision = ?, reservation_token = ?,
                    reservation_owner_session_id = ?, reservation_run_id = ?,
                    reservation_run_instance_id = ?, reservation_owner_pid = ?
                WHERE id = ?
            `).run(
                parentRevision,
                "foreign-apply-token",
                "owner",
                "worker-x",
                "worker-x-instance",
                123_456,
                result.id,
            );
        });
        vi.spyOn(process, "kill").mockReturnValue(true);

        await expect(applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            resultId: result.id,
            workspacesDir: paths.state,
        })).rejects.toThrow("live process");

        await withE2EMetadataDatabase(paths, (database) => {
            expect(database.prepare("SELECT status, reservation_token FROM workspace_results WHERE id = ?").get(result.id))
                .toEqual({ status: "applying", reservation_token: "foreign-apply-token" });
        });
        expect(fs.existsSync(path.join(paths.repository, "worker-x.txt"))).toBe(false);
    });

    it("releases a result reservation after apply preflight failure so retry is safe", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        initializeRepository(paths.repository);
        const workspace = await createClaimedTaskWorkspace(paths, { runId: "worker-x", runInstanceId: "worker-x-instance" });
        fs.writeFileSync(path.join(workspace.worktreePath, "worker-x.txt"), "x\n");
        const result = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            workspacesDir: paths.state,
        });
        fs.writeFileSync(path.join(paths.repository, "uncommitted-parent.txt"), "dirty\n");

        await expect(applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            resultId: result.id,
            workspacesDir: paths.state,
        })).rejects.toThrow("uncommitted changes");
        await withE2EMetadataDatabase(paths, (failedDatabase) => {
            const stored = failedDatabase.prepare(
                "SELECT status, reservation_token FROM workspace_results WHERE id = ?",
            ).get(result.id) as { status: string; reservation_token?: string };
            expect(stored).toEqual({ status: "prepared", reservation_token: null });
        });

        fs.rmSync(path.join(paths.repository, "uncommitted-parent.txt"));
        await expect(applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            resultId: result.id,
            workspacesDir: paths.state,
        })).resolves.toMatchObject({ id: result.id, status: "applied" });
    });

    it("rejects new workspaces while the parent checkout is dirty", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        initializeRepository(paths.repository);
        fs.writeFileSync(path.join(paths.repository, "parent-uncommitted.txt"), "dirty\n");

        await expect(createAgentWorkspace(paths.repository, { workspacesDir: paths.state }))
            .rejects.toThrow("parent checkout has uncommitted changes");
    });

    // TODO: Re-enable when metadata access is asynchronous or isolated from
    // this event loop; DatabaseSync blocks concurrent Promise.all callers.
    it.skip("enforces workspace capacity across concurrent allocations", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        initializeRepository(paths.repository);

        const attempts = await Promise.allSettled(
            Array.from({ length: MAX_AGENT_WORKSPACES + 1 }, () => (
                createAgentWorkspace(paths.repository, { workspacesDir: paths.state })
            )),
        );

        expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(MAX_AGENT_WORKSPACES);
        expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
        expect(attempts.find((attempt) => attempt.status === "rejected")?.reason?.message).toContain("capacity reached");
    });

    it("blocks lifecycle reuse during a live result reservation and recovers a dead one", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        initializeRepository(paths.repository);
        const workspace = await createClaimedTaskWorkspace(paths, { runId: "worker-x", runInstanceId: "worker-x-instance" });
        fs.writeFileSync(path.join(workspace.worktreePath, "worker-x.txt"), "x\n");
        const result = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            workspacesDir: paths.state,
        });

        await withE2EMetadataDatabase(paths, (database) => {
            database.prepare(`
                UPDATE workspace_results
                SET reservation_token = ?, reservation_owner_pid = ?, reservation_acquired_at = ?
                WHERE id = ?
            `).run("live-token", process.pid, Date.now(), result.id);
        });
        await expect(retainAgentWorkspaceResult(workspace.id, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            workspacesDir: paths.state,
        })).rejects.toThrow("already reserved");
        await expect(resetAgentWorkspaceForReuse(workspace.id, { workspacesDir: paths.state }))
            .rejects.toThrow("result disposition in progress");

        await withE2EMetadataDatabase(paths, (staleDatabase) => {
            staleDatabase.prepare(`
                UPDATE workspace_results
                SET reservation_token = ?, reservation_owner_pid = ?, reservation_acquired_at = ?
                WHERE id = ?
            `).run("dead-token", 999_999_999, Date.now() - 10 * 60_000, result.id);
        });
        await expect(retainAgentWorkspaceResult(workspace.id, {
            ownerSessionId: "owner",
            leaseRunId: "worker-x",
            leaseRunInstanceId: "worker-x-instance",
            workspacesDir: paths.state,
        })).resolves.toBeUndefined();

        await withE2EMetadataDatabase(paths, (finalDatabase) => {
            const reservation = finalDatabase.prepare(
                "SELECT reservation_token FROM workspace_results WHERE id = ?",
            ).get(result.id) as { reservation_token?: string };
            expect(reservation.reservation_token).toBeNull();
        });
    });
});
