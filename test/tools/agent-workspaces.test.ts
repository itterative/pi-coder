import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { executeWorkspaceAction } from "../../src/tools/agent/workspaces/actions";
import {
    createAgentWorkspace,
    discardAgentWorkspace,
    recycleAgentWorkspaceForReuse,
    recoverAgentWorkspaceLease,
    releaseAgentWorkspaceLeaseForRecovery,
    resetAgentWorkspaceForReuse,
    updateAgentWorkspace,
} from "../../src/tools/agent/workspaces/lifecycle";
import { prepareIsolatedWorkspace } from "../../src/tools/agent/workspaces/setup";
import {
    applyAgentWorkspaceApplication,
    discardAgentWorkspaceResult,
    inspectAgentWorkspaceResult,
    prepareAgentWorkspaceApplication,
    reconcileNoChangeAgentWorkspaceLeases,
    releaseAgentWorkspaceAfterApplication,
    releaseAgentWorkspaceAfterNoChanges,
    retainAgentWorkspaceResult,
} from "../../src/tools/agent/workspaces/results";
import {
    createAgentWorkspaceCheckpoint,
    getAgentWorkspaceCheckpoint,
    latestAgentWorkspaceCheckpoint,
    listAgentWorkspaceCheckpoints,
    restoreAgentWorkspaceCheckpoint,
} from "../../src/tools/agent/workspaces/checkpoints";
import { openAgentMetadataDatabase } from "../../src/tools/agent/storage/metadata";
import {
    claimAgentWorkspace,
    findAvailableAgentWorkspace,
    inspectAgentWorkspaceGitState,
    listAgentWorkspaceResults,
    listAgentWorkspaces,
    transferAgentWorkspaceLease,
} from "../../src/tools/agent/workspaces/store";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
    await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, { cwd });
    return result.stdout.trim();
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("agent workspaces", () => {
    async function createClaimedWorkspace(repository: string, state: string) {
        const workspace = await createAgentWorkspace(repository, { workspacesDir: state });
        const prepared = await updateAgentWorkspace(workspace, { setupState: "skipped" }, { workspacesDir: state });
        const claimed = await claimAgentWorkspace(prepared.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            leaseKind: "task",
            workspacesDir: state,
        });
        return { workspace: claimed, state };
    }

    it("creates durable checkpoints without changing the parent checkout", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", "tracked.txt");
        await git(repository, "commit", "--quiet", "-m", "initial");
        const parentHead = await gitOutput(repository, "rev-parse", "HEAD");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "checkpointed\n");
        await fs.writeFile(path.join(workspace.worktreePath, "untracked.txt"), "also checkpointed\n");
        const beforeStatus = await gitOutput(workspace.worktreePath, "status", "--porcelain=v1", "--untracked-files=all");
        const checkpoint = await createAgentWorkspaceCheckpoint(workspace.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            runInstanceId: "worker-instance",
            kind: "intermediate",
            runStatus: "interrupted",
            childSessionLeafId: null,
            workspacesDir: state,
        });

        expect(checkpoint.sequence).toBe(1);
        expect(checkpoint.workspaceId).toBe(workspace.id);
        expect(checkpoint.baseRevision).toBe(parentHead);
        expect(await gitOutput(repository, "rev-parse", checkpoint.durableRef)).toBe(checkpoint.headRevision);
        expect(await gitOutput(repository, "rev-parse", "HEAD")).toBe(parentHead);
        expect(await gitOutput(workspace.worktreePath, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
        expect(await gitOutput(workspace.worktreePath, "log", "-1", "--format=%s")).toBe("pi-coder: workspace checkpoint");
        expect(await gitOutput(workspace.worktreePath, "show", `${checkpoint.headRevision}:tracked.txt`)).toBe("checkpointed");
        expect(await gitOutput(workspace.worktreePath, "show", `${checkpoint.headRevision}:untracked.txt`)).toBe("also checkpointed");
        expect(beforeStatus).toContain("tracked.txt");
        expect(beforeStatus).toContain("untracked.txt");

        const stored = await getAgentWorkspaceCheckpoint(checkpoint.id, { workspacesDir: state });
        expect(stored).toEqual(checkpoint);
        expect(await latestAgentWorkspaceCheckpoint(workspace.id, "worker-instance", { workspacesDir: state })).toEqual(checkpoint);
        expect(await listAgentWorkspaceCheckpoints(workspace.id, { workspacesDir: state })).toEqual([checkpoint]);
    });

    it("recycles an inactive checkpointed workspace while preserving history", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", "tracked.txt");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const workspace = await createAgentWorkspace(repository, { workspacesDir: state });
        const prepared = await updateAgentWorkspace(workspace, { setupState: "skipped" }, { workspacesDir: state });
        const leased = await claimAgentWorkspace(prepared.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            leaseRunInstanceId: "worker-instance-1",
            leaseKind: "task",
            workspacesDir: state,
        });
        await fs.writeFile(path.join(leased.worktreePath, "tracked.txt"), "checkpointed\n");
        const checkpoint = await createAgentWorkspaceCheckpoint(leased.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            runInstanceId: "worker-instance-1",
            kind: "terminal",
            runStatus: "completed",
            childSessionLeafId: null,
            workspacesDir: state,
        });
        const result = await prepareAgentWorkspaceApplication(leased, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            leaseRunInstanceId: "worker-instance-1",
            workspacesDir: state,
        });
        await fs.writeFile(path.join(repository, "parent-change.txt"), "new parent state\n");
        await git(repository, "add", "parent-change.txt");
        await git(repository, "commit", "--quiet", "-m", "parent update");
        const parentHead = await gitOutput(repository, "rev-parse", "HEAD");

        const recycled = await recycleAgentWorkspaceForReuse(leased.id, {
            previousOwnerSessionId: "session-1",
            previousLeaseRunId: "worker-1",
            previousLeaseRunInstanceId: "worker-instance-1",
            ownerSessionId: "session-2",
            leaseRunId: "worker-2",
            leaseRunInstanceId: "worker-instance-2",
            workspacesDir: state,
        });

        expect(recycled).toMatchObject({
            id: leased.id,
            baseRevision: parentHead,
            status: "available",
            leaseOwnerSessionId: "session-2",
            leaseRunId: "worker-2",
            leaseRunInstanceId: "worker-instance-2",
            leaseKind: "task",
        });
        expect(await gitOutput(recycled.worktreePath, "rev-parse", "HEAD")).toBe(parentHead);
        expect(await gitOutput(recycled.worktreePath, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
        expect(await getAgentWorkspaceCheckpoint(checkpoint.id, { workspacesDir: state })).toEqual(checkpoint);
        expect(await listAgentWorkspaceResults(leased.id, { workspacesDir: state })).toEqual([result]);
        expect(await gitOutput(repository, "rev-parse", checkpoint.durableRef)).toBe(checkpoint.headRevision);

        await fs.writeFile(path.join(recycled.worktreePath, "new-worker.txt"), "new worker\n");
        const newerResult = await prepareAgentWorkspaceApplication(recycled, {
            ownerSessionId: "session-2",
            leaseRunId: "worker-2",
            leaseRunInstanceId: "worker-instance-2",
            workspacesDir: state,
        });
        const historicalInspection = await inspectAgentWorkspaceResult(recycled, result);
        expect(historicalInspection).toContain("tracked.txt");
        const metadata = await openAgentMetadataDatabase(state);
        await metadata.run("UPDATE workspace_results SET reservation_token = ? WHERE id = ?", "held-by-other", result.id);
        await metadata.close();
        await expect(applyAgentWorkspaceApplication(recycled, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            leaseRunInstanceId: "worker-instance-1",
            resultId: result.id,
            workspacesDir: state,
        })).rejects.toThrow("already reserved");
        const releasedMetadata = await openAgentMetadataDatabase(state);
        await releasedMetadata.run("UPDATE workspace_results SET reservation_token = NULL WHERE id = ?", result.id);
        await releasedMetadata.close();
        await applyAgentWorkspaceApplication(recycled, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            leaseRunInstanceId: "worker-instance-1",
            resultId: result.id,
            workspacesDir: state,
        });
        expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("checkpointed\n");
        expect(await fs.readFile(path.join(recycled.worktreePath, "new-worker.txt"), "utf8")).toBe("new worker\n");
        expect(await listAgentWorkspaceResults(leased.id, { workspacesDir: state })).toEqual([
            { ...result, status: "applied", parentRevision: parentHead, appliedAt: expect.any(Number) },
            newerResult,
        ]);
    });

    it("allocates a recyclable checkpointed slot before reporting capacity", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", "tracked.txt");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const workspace = await createAgentWorkspace(repository, { workspacesDir: state });
        const prepared = await updateAgentWorkspace(workspace, { setupState: "skipped" }, { workspacesDir: state });
        const leased = await claimAgentWorkspace(prepared.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            leaseRunInstanceId: "worker-instance-1",
            leaseKind: "task",
            workspacesDir: state,
        });
        await fs.writeFile(path.join(leased.worktreePath, "worker.txt"), "saved\n");
        await createAgentWorkspaceCheckpoint(leased.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            runInstanceId: "worker-instance-1",
            kind: "intermediate",
            runStatus: "interrupted",
            childSessionLeafId: null,
            workspacesDir: state,
        });

        const reservation = await prepareIsolatedWorkspace(repository, {
            definition: {
                name: "worker",
                source: "builtin",
                capabilities: ["edit"],
                description: "worker",
                systemPrompt: "worker",
            },
            factory: async () => {
                throw new Error("the setup worker must not run while recycling");
            },
            manager: {
                hasActiveNonIsolatedMutatingRun: false,
                getRunStatus: () => undefined,
                parkWorkspaceRunForReuse: () => false,
            } as never,
            ctx: {
                cwd: repository,
                sessionManager: { getSessionId: () => "session-2" },
            } as never,
            workspacesDir: state,
        });

        expect(reservation).toMatchObject({
            workspace: {
                id: leased.id,
                leaseOwnerSessionId: "session-2",
                leaseRunId: expect.stringMatching(/^workspace-provision-/),
                leaseKind: "task",
            },
            ownerSessionId: "session-2",
        });
    });

    it("restores a checkpoint into its original workspace", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", "tracked.txt");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "first checkpoint\n");
        const checkpoint = await createAgentWorkspaceCheckpoint(workspace.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            runInstanceId: "worker-instance",
            kind: "terminal",
            runStatus: "canceled",
            childSessionLeafId: "leaf-1",
            workspacesDir: state,
        });
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "later state\n");
        await fs.writeFile(path.join(workspace.worktreePath, "later.txt"), "remove me\n");

        await restoreAgentWorkspaceCheckpoint(workspace, checkpoint, { workspacesDir: state });

        expect(await gitOutput(workspace.worktreePath, "rev-parse", "HEAD")).toBe(checkpoint.headRevision);
        expect(await fs.readFile(path.join(workspace.worktreePath, "tracked.txt"), "utf8")).toBe("first checkpoint\n");
        await expect(fs.access(path.join(workspace.worktreePath, "later.txt"))).rejects.toThrow();
    });

    it("creates flat random-slug worktrees and claims them atomically", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "workspace test\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const workspace = await createAgentWorkspace(repository, { workspacesDir: state });
        expect(path.dirname(workspace.worktreePath)).toBe(path.resolve(state));
        expect(workspace.slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{3}$/);
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))).toHaveLength(1);
        await expect(inspectAgentWorkspaceGitState(workspace)).resolves.toMatchObject({
            kind: "available",
            dirty: false,
            changedFiles: 0,
        });
        await fs.writeFile(path.join(workspace.worktreePath, "untracked.txt"), "dirty\n");
        await expect(inspectAgentWorkspaceGitState(workspace)).resolves.toMatchObject({
            kind: "available",
            dirty: true,
            changedFiles: 1,
            untrackedFiles: 1,
        });

        const prepared = await updateAgentWorkspace(workspace, { setupState: "skipped" }, { workspacesDir: state });
        const provisional = await claimAgentWorkspace(prepared.id, {
            ownerSessionId: "session-1",
            leaseRunId: "setup-1",
            leaseKind: "setup",
            workspacesDir: state,
            leaseRunInstanceId: "setup-instance",
        });
        expect(await findAvailableAgentWorkspace(repository, { workspacesDir: state })).toBeUndefined();
        await transferAgentWorkspaceLease(workspace.id, {
            ownerSessionId: "session-1",
            fromLeaseRunId: provisional.leaseRunId!,
            toLeaseRunId: "worker-1",
            leaseKind: "task",
            workspacesDir: state,
            fromLeaseRunInstanceId: "setup-instance",
            toLeaseRunInstanceId: "worker-instance",
        });
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]).toMatchObject({
            leaseOwnerSessionId: "session-1",
            leaseRunId: "worker-1",
            leaseRunInstanceId: "worker-instance",
            leaseKind: "task",
        });
        await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
            leaseRunInstanceId: "worker-instance",
        });
        await applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
            leaseRunInstanceId: "worker-instance",
        });
        await releaseAgentWorkspaceAfterApplication(workspace.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
            leaseRunInstanceId: "worker-instance",
        });
        expect(await findAvailableAgentWorkspace(repository, { workspacesDir: state })).toBeUndefined();
        expect(await listAgentWorkspaces(repository, { workspacesDir: state })).toMatchObject([
            { id: workspace.id, status: "review_required" },
        ]);
    });

    it("identifies and explicitly recovers an orphaned task lease", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "orphan recovery test\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]).toMatchObject({
            leaseRunId: "worker-1",
            leaseState: "orphaned",
        });
        const recovered = await recoverAgentWorkspaceLease(workspace.id, { ownerSessionId: "session-2", workspacesDir: state });
        expect(recovered).toMatchObject({
            leaseOwnerSessionId: "session-2",
            leaseRunId: "worker-1",
            leaseState: "orphaned",
        });
    });

    it("releases an explicit stale clean task lease without resetting the worktree", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "stale lease test\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        const recovered = await releaseAgentWorkspaceLeaseForRecovery(workspace.id, { workspacesDir: state });

        expect(recovered).toMatchObject({
            id: workspace.id,
            status: "available",
            leaseRunId: undefined,
            leaseKind: undefined,
        });
        await expect(inspectAgentWorkspaceGitState(recovered)).resolves.toMatchObject({ dirty: false });
    });

    it("allows explicit discard of a stale task lease without a result", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "stale discard test\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "untracked.txt"), "discard me\n");
        await discardAgentWorkspace(workspace.id, { workspacesDir: state });

        expect(await listAgentWorkspaces(repository, { workspacesDir: state })).toHaveLength(0);
        await expect(fs.access(workspace.worktreePath)).rejects.toThrow();
    });

    it("allows another session to reset or discard an inactive task lease", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "cross-session clear test\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const resetTarget = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(resetTarget.workspace.worktreePath, "reset-me.txt"), "reset\n");
        const database = await openAgentMetadataDatabase(state);
        await database.run(`
            INSERT INTO agent_runs (
                run_instance_id, owner_session_id, run_id, parent_cwd, title, agent, agent_source,
                task, status, background, mutating, started_at, updated_at, usage_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, "session-1:worker-1",
            "session-1",
            "worker-1",
            repository,
            "Worker",
            "worker",
            "builtin",
            "Clear test",
            "running",
            0,
            1,
            1,
            1,
            "{}",);
        await database.close();
        await expect(resetAgentWorkspaceForReuse(resetTarget.workspace.id, {
            ownerSessionId: "session-2",
            leaseRunId: "worker-1",
            workspacesDir: state,
        })).rejects.toThrow("still used by active run worker-1");

        const completedDatabase = await openAgentMetadataDatabase(state);
        await completedDatabase.run("UPDATE agent_runs SET status = 'completed' WHERE run_instance_id = ?", "session-1:worker-1");
        await completedDatabase.close();
        const reset = await resetAgentWorkspaceForReuse(resetTarget.workspace.id, {
            ownerSessionId: "session-2",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        expect(reset.leaseRunId).toBeUndefined();
        await expect(fs.access(path.join(resetTarget.workspace.worktreePath, "reset-me.txt"))).rejects.toThrow();

        const discardTarget = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(discardTarget.workspace.worktreePath, "discard-me.txt"), "discard\n");
        await discardAgentWorkspace(discardTarget.workspace.id, {
            ownerSessionId: "session-2",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        await expect(fs.access(discardTarget.workspace.worktreePath)).rejects.toThrow();
    });

    it("does not recover a stale lease when the worktree is dirty", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "dirty stale lease test\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "untracked.txt"), "keep me\n");

        await expect(releaseAgentWorkspaceLeaseForRecovery(workspace.id, { workspacesDir: state })).rejects.toThrow("discard it explicitly");
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]).toMatchObject({ leaseRunId: "worker-1" });
    });

    it("limits each repository to the configured workspace capacity", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "workspace capacity test\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");

        await createAgentWorkspace(repository, { workspacesDir: state });
        await createAgentWorkspace(repository, { workspacesDir: state });
        await createAgentWorkspace(repository, { workspacesDir: state });

        await expect(createAgentWorkspace(repository, { workspacesDir: state })).rejects.toThrow("Workspace capacity reached");
        expect(await listAgentWorkspaces(repository, { workspacesDir: state })).toHaveLength(3);

        const customState = path.join(root, "custom-root", "state");
        const subdirectory = path.join(repository, "subdirectory");
        await fs.mkdir(subdirectory);
        const subdirectoryWorkspace = await createAgentWorkspace(subdirectory, {
            workspacesDir: customState,
            maxWorkspaces: 1,
        });
        await expect(listAgentWorkspaces(repository, { workspacesDir: customState })).resolves.toMatchObject([
            { id: subdirectoryWorkspace.id, cwd: subdirectory },
        ]);
        await expect(createAgentWorkspace(repository, { workspacesDir: customState, maxWorkspaces: 1 })).rejects.toThrow("Workspace capacity reached");
    });

    it("allows manual creation from a dirty parent while using committed HEAD", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "committed\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");
        const head = await gitOutput(repository, "rev-parse", "HEAD");
        await fs.writeFile(path.join(repository, "README.md"), "dirty parent\n");

        const workspace = await createAgentWorkspace(repository, {
            workspacesDir: state,
            skipParentDirtyCheck: true,
        });

        expect(workspace.baseRevision).toBe(head);
        expect(await gitOutput(workspace.worktreePath, "rev-parse", "HEAD")).toBe(head);
        expect(await fs.readFile(path.join(workspace.worktreePath, "README.md"), "utf8")).toBe("committed\n");
        expect(await fs.readFile(path.join(repository, "README.md"), "utf8")).toBe("dirty parent\n");
    });

    it("releases a clean no-change result without creating a durable ref", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "no change test\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        const result = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        expect(result.workerHead).toBe(result.baseRevision);
        expect(result.commits).toEqual([]);
        expect(result.durableRef).toBeUndefined();

        await fs.writeFile(path.join(repository, "parent-advanced.txt"), "parent advanced\n");
        await git(repository, "add", ".");
        await git(repository, "commit", "--quiet", "-m", "advance parent");
        const parentHead = await gitOutput(repository, "rev-parse", "HEAD");

        await releaseAgentWorkspaceAfterNoChanges(workspace.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        await expect(findAvailableAgentWorkspace(repository, { workspacesDir: state })).resolves.toMatchObject({
            id: workspace.id,
            status: "available",
            baseRevision: parentHead,
        });
        expect(await gitOutput(workspace.worktreePath, "rev-parse", "HEAD")).toBe(parentHead);
        expect((await listAgentWorkspaceResults(workspace.id, { workspacesDir: state }))[0]).toMatchObject({ status: "discarded" });
    });

    it("does not reconcile an older no-change result from a newly claimed task lease", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "reconcile test\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        await releaseAgentWorkspaceAfterNoChanges(workspace.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        await claimAgentWorkspace(workspace.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-2",
            leaseKind: "task",
            workspacesDir: state,
        });

        await expect(reconcileNoChangeAgentWorkspaceLeases(repository, { workspacesDir: state })).resolves.toBe(0);
        await expect(listAgentWorkspaces(repository, { workspacesDir: state })).resolves.toMatchObject([
            { id: workspace.id, leaseRunId: "worker-2", leaseKind: "task" },
        ]);
    });

    it("commits dirty tracked and untracked worker changes exactly once and persists the result", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", ".");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "changed\n");
        await fs.writeFile(path.join(workspace.worktreePath, "new.txt"), "untracked\n");
        const application = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });

        expect(application.status).toBe("prepared");
        expect(application.commits).toHaveLength(1);
        expect(await gitOutput(workspace.worktreePath, "log", "-1", "--format=%s")).toBe("pi-coder: finalize isolated worker result");
        expect(await inspectAgentWorkspaceGitState(workspace)).toMatchObject({ dirty: false, changedFiles: 0 });
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]?.latestResult).toMatchObject({
            id: application.id,
            workerHead: application.workerHead,
            baseRevision: workspace.baseRevision,
            commitRange: `${workspace.baseRevision}..${application.workerHead}`,
            status: "prepared",
            durableRef: `refs/pi-coder/workspace-results/${workspace.id}/${application.id}`,
        });
        expect(await listAgentWorkspaceResults(workspace.id, { workspacesDir: state })).toHaveLength(1);
        expect(await gitOutput(workspace.worktreePath, "rev-parse", `refs/pi-coder/workspace-results/${workspace.id}/${application.id}`)).toBe(application.workerHead);
    });

    it("does not create an empty final commit for an already-committed worker and applies without committing the parent", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", ".");
        await git(repository, "commit", "--quiet", "-m", "initial");
        const parentHead = await gitOutput(repository, "rev-parse", "HEAD");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "worker\n");
        await git(workspace.worktreePath, "add", "tracked.txt");
        await git(workspace.worktreePath, "commit", "--quiet", "-m", "worker change");
        const workerCommit = await gitOutput(workspace.worktreePath, "rev-parse", "HEAD");
        const application = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        expect(application.workerHead).toBe(workerCommit);
        expect(await gitOutput(workspace.worktreePath, "log", "--format=%s", "-2")).not.toContain("finalize isolated");

        const applied = await applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        expect(applied.status).toBe("applied");
        expect(await gitOutput(repository, "rev-parse", "HEAD")).toBe(parentHead);
        expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("worker\n");
        expect(await gitOutput(repository, "status", "--porcelain=v1")).toContain("tracked.txt");
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]?.latestResult).toMatchObject({
            id: application.id,
            status: "applied",
            parentRevision: parentHead,
        });
        // Application does not implicitly release the lease; the caller does so explicitly.
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]?.leaseRunId).toBe("worker-1");
        await releaseAgentWorkspaceAfterApplication(workspace.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]?.leaseRunId).toBeUndefined();
    });

    it("applies and releases a lease through the shared workspace action service", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", ".");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "worker\n");
        await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        const prepared = (await listAgentWorkspaces(repository, { workspacesDir: state }))[0]!;

        const action = await executeWorkspaceAction({
            action: "apply",
            workspace: prepared,
            ownerSessionId: "session-1",
            runId: "worker-1",
            workspacesDir: state,
        });

        expect(action.disposition).toBe("applied");
        expect(action.workspace).toMatchObject({
            id: workspace.id,
            status: "review_required",
            latestResult: { status: "applied" },
        });
        expect(action.workspace?.leaseRunId).toBeUndefined();
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]?.leaseRunId).toBeUndefined();
        expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("worker\n");
    });

    it("retains, inspects, resets, and discards changed workspace results explicitly", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", ".");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "worker\n");
        const result = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        const inspection = await inspectAgentWorkspaceResult({
            ...workspace,
            latestResult: result,
        });
        expect(inspection).toContain("tracked.txt");
        expect(inspection).toContain(`Durable ref: ${result.durableRef}`);
        expect(inspection).not.toContain("worker\n");

        await retainAgentWorkspaceResult(workspace.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        const retained = (await listAgentWorkspaces(repository, { workspacesDir: state }))[0];
        expect(retained).toMatchObject({ id: workspace.id, status: "review_required" });
        expect(retained?.leaseRunId).toBeUndefined();
        await fs.writeFile(path.join(repository, "parent-dirty.txt"), "keep parent changes\n");
        const reset = await resetAgentWorkspaceForReuse(workspace.id, { workspacesDir: state });
        expect(reset).toMatchObject({
            id: workspace.id,
            status: "available",
            latestResult: { status: "discarded" },
        });
        expect(reset.leaseRunId).toBeUndefined();
        expect(reset.leaseState).toBe("none");
        expect(await findAvailableAgentWorkspace(repository, { workspacesDir: state })).toMatchObject({ id: workspace.id });
        expect(await fs.readFile(path.join(workspace.worktreePath, "tracked.txt"), "utf8")).toBe("base\n");
        expect(await fs.readFile(path.join(repository, "parent-dirty.txt"), "utf8")).toBe("keep parent changes\n");
        const resetResult = (await listAgentWorkspaceResults(workspace.id, { workspacesDir: state }))[0];
        expect(resetResult).toMatchObject({ status: "discarded" });
        expect(resetResult?.durableRef).toBeUndefined();

        await fs.rm(path.join(repository, "parent-dirty.txt"));
        const discarded = await createAgentWorkspace(repository, { workspacesDir: state });
        await discardAgentWorkspace(discarded.id, { workspacesDir: state });
        expect(await listAgentWorkspaces(repository, { workspacesDir: state })).toHaveLength(1);
        await expect(fs.access(discarded.worktreePath)).rejects.toThrow();
    });

    it("lets an owner discard a prepared result without requiring a clean parent", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", ".");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "worker\n");
        await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        await fs.writeFile(path.join(repository, "parent-advanced.txt"), "parent advanced\n");
        await git(repository, "add", ".");
        await git(repository, "commit", "--quiet", "-m", "advance parent");
        const parentHead = await gitOutput(repository, "rev-parse", "HEAD");
        await fs.writeFile(path.join(repository, "parent-dirty.txt"), "leave me\n");
        await discardAgentWorkspaceResult(workspace.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });

        expect(await fs.readFile(path.join(workspace.worktreePath, "tracked.txt"), "utf8")).toBe("base\n");
        expect(await fs.readFile(path.join(workspace.worktreePath, "parent-advanced.txt"), "utf8")).toBe("parent advanced\n");
        expect(await gitOutput(workspace.worktreePath, "rev-parse", "HEAD")).toBe(parentHead);
        expect(await fs.readFile(path.join(repository, "parent-dirty.txt"), "utf8")).toBe("leave me\n");
        expect(await findAvailableAgentWorkspace(repository, { workspacesDir: state })).toMatchObject({
            id: workspace.id,
            baseRevision: parentHead,
        });
        expect((await listAgentWorkspaceResults(workspace.id, { workspacesDir: state }))[0]).toMatchObject({ status: "discarded" });
    });

    it("rejects dirty parents and applies clean descendant parent changes", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", ".");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "worker\n");
        const application = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        await expect(releaseAgentWorkspaceAfterApplication(workspace.id, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        })).rejects.toThrow("only after successful application");
        const workerHead = await gitOutput(workspace.worktreePath, "rev-parse", "HEAD");
        await fs.writeFile(path.join(repository, "parent-uncommitted.txt"), "do not apply\n");
        await expect(applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        })).rejects.toThrow("uncommitted changes");
        expect(await gitOutput(workspace.worktreePath, "rev-parse", "HEAD")).toBe(workerHead);
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]).toMatchObject({ leaseRunId: "worker-1", latestResult: { status: "prepared", workerHead: application.workerHead } });
        expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("base\n");

        await fs.rm(path.join(repository, "parent-uncommitted.txt"));
        await fs.writeFile(path.join(repository, "parent-advanced.txt"), "parent advanced\n");
        await git(repository, "add", "parent-advanced.txt");
        await git(repository, "commit", "--quiet", "-m", "parent advanced");
        const parentHead = await gitOutput(repository, "rev-parse", "HEAD");
        const applied = await applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        expect(applied).toMatchObject({ status: "applied", parentRevision: parentHead });
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]).toMatchObject({
            leaseRunId: "worker-1",
            latestResult: { status: "applied", parentRevision: parentHead },
        });
        expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("worker\n");
        expect(await fs.readFile(path.join(repository, "parent-advanced.txt"), "utf8")).toBe("parent advanced\n");
    });

    it("rejects a conflicting parent change without consuming the prepared result", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", ".");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "worker\n");
        const application = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        await fs.writeFile(path.join(repository, "tracked.txt"), "parent\n");
        await git(repository, "add", "tracked.txt");
        await git(repository, "commit", "--quiet", "-m", "parent conflict");

        await expect(applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        })).rejects.toThrow();
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]).toMatchObject({
            leaseRunId: "worker-1",
            latestResult: { id: application.id, status: "prepared" },
        });
        expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("parent\n");
    });

    it("rejects a clean parent history that no longer contains the workspace base", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", ".");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const { workspace } = await createClaimedWorkspace(repository, state);
        await fs.writeFile(path.join(workspace.worktreePath, "tracked.txt"), "worker\n");
        const application = await prepareAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        });
        await git(repository, "checkout", "--orphan", "diverged");
        await fs.writeFile(path.join(repository, "tracked.txt"), "diverged\n");
        await git(repository, "add", "tracked.txt");
        await git(repository, "commit", "--quiet", "-m", "diverged history");

        await expect(applyAgentWorkspaceApplication(workspace, {
            ownerSessionId: "session-1",
            leaseRunId: "worker-1",
            workspacesDir: state,
        })).rejects.toThrow("no longer contains workspace base");
        expect((await listAgentWorkspaces(repository, { workspacesDir: state }))[0]).toMatchObject({
            leaseRunId: "worker-1",
            latestResult: { id: application.id, status: "prepared" },
        });
        expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("diverged\n");
    });

    it("includes registered workspaces whose worktrees are missing when requested", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-workspaces-"));
        temporaryDirectories.push(root);
        const repository = path.join(root, "repo");
        const state = path.join(root, "state");
        await fs.mkdir(repository);
        await git(repository, "init", "--quiet");
        await git(repository, "config", "user.email", "test@example.com");
        await git(repository, "config", "user.name", "Test");
        await fs.writeFile(path.join(repository, "README.md"), "missing worktree test\n");
        await git(repository, "add", "README.md");
        await git(repository, "commit", "--quiet", "-m", "initial");

        const workspace = await createAgentWorkspace(repository, { workspacesDir: state });
        await fs.rm(workspace.worktreePath, { recursive: true, force: true });

        await expect(listAgentWorkspaces(repository, { workspacesDir: state })).resolves.toHaveLength(0);
        await expect(listAgentWorkspaces(repository, {
            workspacesDir: state,
            includeMissingWorktrees: true,
        })).resolves.toMatchObject([{ id: workspace.id }]);
    });
});
