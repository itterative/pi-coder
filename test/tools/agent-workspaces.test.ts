import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
    applyAgentWorkspaceApplication,
    claimAgentWorkspace,
    completeAgentWorkspaceLease,
    discardAgentWorkspace,
    discardAgentWorkspaceResult,
    createAgentWorkspace,
    findAvailableAgentWorkspace,
    inspectAgentWorkspaceDiff,
    inspectAgentWorkspaceGitState,
    listAgentWorkspaceResults,
    listAgentWorkspaces,
    prepareAgentWorkspaceApplication,
    releaseAgentWorkspaceAfterApplication,
    releaseAgentWorkspaceAfterNoChanges,
    recoverAgentWorkspaceLease,
    releaseAgentWorkspaceLeaseForRecovery,
    reconcileNoChangeAgentWorkspaceLeases,
    resetAgentWorkspaceForReuse,
    retainAgentWorkspaceResult,
    transferAgentWorkspaceLease,
    updateAgentWorkspace,
} from "../../src/tools/agent/workspaces";

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
        const workspace = await createAgentWorkspace(repository, state);
        const prepared = await updateAgentWorkspace(workspace, { setupState: "skipped" }, state);
        const claimed = await claimAgentWorkspace(prepared.id, "session-1", "worker-1", "task", state);
        return { workspace: claimed, state };
    }

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

        const workspace = await createAgentWorkspace(repository, state);
        expect(path.dirname(workspace.worktreePath)).toBe(path.resolve(state));
        expect(workspace.slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{3}$/);
        expect((await listAgentWorkspaces(repository, state))).toHaveLength(1);
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

        const prepared = await updateAgentWorkspace(workspace, { setupState: "skipped" }, state);
        const provisional = await claimAgentWorkspace(prepared.id, "session-1", "setup-1", "setup", state);
        expect(await findAvailableAgentWorkspace(repository, state)).toBeUndefined();
        await transferAgentWorkspaceLease(workspace.id, "session-1", provisional.leaseRunId!, "worker-1", "task", state);
        await prepareAgentWorkspaceApplication(workspace, "session-1", "worker-1", state);
        await applyAgentWorkspaceApplication(workspace, "session-1", "worker-1", state);
        await completeAgentWorkspaceLease(workspace.id, "session-1", "worker-1", state);
        expect(await findAvailableAgentWorkspace(repository, state)).toBeUndefined();
        expect(await listAgentWorkspaces(repository, state)).toMatchObject([
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
        expect((await listAgentWorkspaces(repository, state))[0]).toMatchObject({
            leaseRunId: "worker-1",
            leaseState: "orphaned",
        });
        const recovered = await recoverAgentWorkspaceLease(workspace.id, "session-2", state);
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
        const recovered = await releaseAgentWorkspaceLeaseForRecovery(workspace.id, state);

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
        await discardAgentWorkspace(workspace.id, undefined, undefined, state);

        expect(await listAgentWorkspaces(repository, state)).toHaveLength(0);
        await expect(fs.access(workspace.worktreePath)).rejects.toThrow();
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

        await expect(releaseAgentWorkspaceLeaseForRecovery(workspace.id, state)).rejects.toThrow("discard it explicitly");
        expect((await listAgentWorkspaces(repository, state))[0]).toMatchObject({ leaseRunId: "worker-1" });
    });

    it("limits each project to three persistent workspaces", async () => {
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

        await createAgentWorkspace(repository, state);
        await createAgentWorkspace(repository, state);
        await createAgentWorkspace(repository, state);

        await expect(createAgentWorkspace(repository, state)).rejects.toThrow("Workspace capacity reached");
        expect(await listAgentWorkspaces(repository, state)).toHaveLength(3);
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
        const result = await prepareAgentWorkspaceApplication(workspace, "session-1", "worker-1", state);
        expect(result.workerHead).toBe(result.baseRevision);
        expect(result.commits).toEqual([]);
        expect(result.durableRef).toBeUndefined();

        await releaseAgentWorkspaceAfterNoChanges(workspace.id, "session-1", "worker-1", state);
        await expect(findAvailableAgentWorkspace(repository, state)).resolves.toMatchObject({
            id: workspace.id,
            status: "available",
        });
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
        await prepareAgentWorkspaceApplication(workspace, "session-1", "worker-1", state);
        await releaseAgentWorkspaceAfterNoChanges(workspace.id, "session-1", "worker-1", state);
        await claimAgentWorkspace(workspace.id, "session-1", "worker-2", "task", state);

        await expect(reconcileNoChangeAgentWorkspaceLeases(repository, state)).resolves.toBe(0);
        await expect(listAgentWorkspaces(repository, state)).resolves.toMatchObject([
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
        const application = await prepareAgentWorkspaceApplication(workspace, "session-1", "worker-1", state);

        expect(application.status).toBe("prepared");
        expect(application.commits).toHaveLength(1);
        expect(await gitOutput(workspace.worktreePath, "log", "-1", "--format=%s")).toBe("pi-coder: finalize isolated worker result");
        expect(await inspectAgentWorkspaceGitState(workspace)).toMatchObject({ dirty: false, changedFiles: 0 });
        expect((await listAgentWorkspaces(repository, state))[0]?.latestResult).toMatchObject({
            id: application.id,
            workerHead: application.workerHead,
            baseRevision: workspace.baseRevision,
            commitRange: `${workspace.baseRevision}..${application.workerHead}`,
            status: "prepared",
            durableRef: `refs/pi-coder/workspace-results/${workspace.id}/${application.id}`,
        });
        expect(await listAgentWorkspaceResults(workspace.id, state)).toHaveLength(1);
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
        const application = await prepareAgentWorkspaceApplication(workspace, "session-1", "worker-1", state);
        expect(application.workerHead).toBe(workerCommit);
        expect(await gitOutput(workspace.worktreePath, "log", "--format=%s", "-2")).not.toContain("finalize isolated");

        const applied = await applyAgentWorkspaceApplication(workspace, "session-1", "worker-1", state);
        expect(applied.status).toBe("applied");
        expect(await gitOutput(repository, "rev-parse", "HEAD")).toBe(parentHead);
        expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("worker\n");
        expect(await gitOutput(repository, "status", "--porcelain=v1")).toContain("tracked.txt");
        expect((await listAgentWorkspaces(repository, state))[0]?.latestResult).toMatchObject({
            id: application.id,
            status: "applied",
            parentRevision: parentHead,
        });
        // Application does not implicitly release the lease; the caller does so explicitly.
        expect((await listAgentWorkspaces(repository, state))[0]?.leaseRunId).toBe("worker-1");
        await releaseAgentWorkspaceAfterApplication(workspace.id, "session-1", "worker-1", state);
        expect((await listAgentWorkspaces(repository, state))[0]?.leaseRunId).toBeUndefined();
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
        const result = await prepareAgentWorkspaceApplication(workspace, "session-1", "worker-1", state);
        const diff = await inspectAgentWorkspaceDiff({
            ...workspace,
            latestResult: result,
        });
        expect(diff).toContain("worker");

        await retainAgentWorkspaceResult(workspace.id, "session-1", "worker-1", state);
        const retained = (await listAgentWorkspaces(repository, state))[0];
        expect(retained).toMatchObject({ id: workspace.id, status: "review_required" });
        expect(retained?.leaseRunId).toBeUndefined();
        await fs.writeFile(path.join(repository, "parent-dirty.txt"), "keep parent changes\n");
        await resetAgentWorkspaceForReuse(workspace.id, undefined, undefined, state);
        expect(await findAvailableAgentWorkspace(repository, state)).toMatchObject({ id: workspace.id });
        expect(await fs.readFile(path.join(workspace.worktreePath, "tracked.txt"), "utf8")).toBe("base\n");
        expect(await fs.readFile(path.join(repository, "parent-dirty.txt"), "utf8")).toBe("keep parent changes\n");
        const resetResult = (await listAgentWorkspaceResults(workspace.id, state))[0];
        expect(resetResult).toMatchObject({ status: "discarded" });
        expect(resetResult?.durableRef).toBeUndefined();

        const discarded = await createAgentWorkspace(repository, state);
        await discardAgentWorkspace(discarded.id, undefined, undefined, state);
        expect(await listAgentWorkspaces(repository, state)).toHaveLength(1);
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
        await prepareAgentWorkspaceApplication(workspace, "session-1", "worker-1", state);
        await fs.writeFile(path.join(repository, "parent-dirty.txt"), "leave me\n");
        await discardAgentWorkspaceResult(workspace.id, "session-1", "worker-1", state);

        expect(await fs.readFile(path.join(workspace.worktreePath, "tracked.txt"), "utf8")).toBe("base\n");
        expect(await fs.readFile(path.join(repository, "parent-dirty.txt"), "utf8")).toBe("leave me\n");
        expect(await findAvailableAgentWorkspace(repository, state)).toMatchObject({ id: workspace.id });
        expect((await listAgentWorkspaceResults(workspace.id, state))[0]).toMatchObject({ status: "discarded" });
    });

    it("keeps both workspaces and the lease untouched when parent preflight fails", async () => {
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
        const application = await prepareAgentWorkspaceApplication(workspace, "session-1", "worker-1", state);
        await expect(releaseAgentWorkspaceAfterApplication(workspace.id, "session-1", "worker-1", state)).rejects.toThrow("only after successful application");
        const workerHead = await gitOutput(workspace.worktreePath, "rev-parse", "HEAD");
        await fs.writeFile(path.join(repository, "parent-uncommitted.txt"), "do not apply\n");
        await expect(applyAgentWorkspaceApplication(workspace, "session-1", "worker-1", state)).rejects.toThrow("uncommitted changes");
        expect(await gitOutput(workspace.worktreePath, "rev-parse", "HEAD")).toBe(workerHead);
        expect((await listAgentWorkspaces(repository, state))[0]).toMatchObject({ leaseRunId: "worker-1", latestResult: { status: "prepared", workerHead: application.workerHead } });
        expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("base\n");

        await fs.rm(path.join(repository, "parent-uncommitted.txt"));
        await git(repository, "commit", "--quiet", "--allow-empty", "-m", "parent advanced");
        await expect(applyAgentWorkspaceApplication(workspace, "session-1", "worker-1", state)).rejects.toThrow("expected workspace base");
        expect((await listAgentWorkspaces(repository, state))[0]?.leaseRunId).toBe("worker-1");
        expect(await fs.readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("base\n");
    });
});
