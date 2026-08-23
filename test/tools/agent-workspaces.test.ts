import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
    claimAgentWorkspace,
    createAgentWorkspace,
    findAvailableAgentWorkspace,
    listAgentWorkspaces,
    releaseAgentWorkspaceLease,
    transferAgentWorkspaceLease,
    updateAgentWorkspace,
} from "../../src/tools/agent/workspaces";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
    await execFileAsync("git", args, { cwd });
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("agent workspaces", () => {
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

        const prepared = await updateAgentWorkspace(workspace, { setupState: "skipped" }, state);
        const provisional = await claimAgentWorkspace(prepared.id, "session-1", "setup-1", "setup", state);
        expect(await findAvailableAgentWorkspace(repository, state)).toBeUndefined();
        await transferAgentWorkspaceLease(workspace.id, "session-1", provisional.leaseRunId!, "worker-1", "task", state);
        await releaseAgentWorkspaceLease(workspace.id, "session-1", "worker-1", state);
        expect(await findAvailableAgentWorkspace(repository, state)).toMatchObject({ id: workspace.id });
    });
});
