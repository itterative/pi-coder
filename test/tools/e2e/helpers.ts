import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { openAgentMetadataDatabase, type AgentMetadataDatabase } from "../../../src/tools/agent/storage/metadata";
import { upsertAgentRunCatalogRecordInDatabase } from "../../../src/tools/agent/storage/run-catalog";
import { loadAgentRunPersistence } from "../../../src/tools/agent/runs/persistence";
import type { ChildAgentHandle, ParentQuestion } from "../../../src/tools/agent/contracts/runs";
import type { AgentRunCatalogRecord } from "../../../src/tools/agent/contracts/workspaces";
import { claimAgentWorkspace, type AgentWorkspace } from "../../../src/tools/agent/workspaces/store";
import { createAgentWorkspace, updateAgentWorkspace } from "../../../src/tools/agent/workspaces/lifecycle";

export interface E2EPaths {
    root: string;
    repository: string;
    state: string;
    sessions: string;
}

export function createE2EPathsAtRoot(root: string): E2EPaths {
    const paths = {
        root,
        repository: path.join(root, "repo"),
        state: path.join(root, "workspaces"),
        sessions: path.join(root, "agent-sessions"),
    };
    assertTemporaryStateDirectory(paths.state);
    fs.mkdirSync(paths.repository, { recursive: true });
    return paths;
}

export function createE2EPaths(prefix = "pi-coder-agent-e2e-"): E2EPaths {
    return createE2EPathsAtRoot(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function assertTemporaryStateDirectory(directory: string): void {
    const resolved = path.resolve(directory);
    const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temporaryRoot) || resolved.includes(`${path.sep}.state${path.sep}`)) {
        throw new Error(`E2E tests must use a temporary state directory: ${directory}`);
    }
    if (path.basename(resolved) === ".state" || path.basename(resolved) === "meta.sqlite") {
        throw new Error(`E2E tests must not use the project metadata database: ${directory}`);
    }
}

export async function openE2EMetadataDatabase(paths: Pick<E2EPaths, "state">): Promise<AgentMetadataDatabase> {
    assertTemporaryStateDirectory(paths.state);
    return openAgentMetadataDatabase(paths.state);
}

export async function withE2EMetadataDatabase<T>(
    paths: Pick<E2EPaths, "state">,
    callback: (database: AgentMetadataDatabase) => T | Promise<T>,
): Promise<T> {
    const database = await openE2EMetadataDatabase(paths);
    try {
        return await callback(database);
    } finally {
        database.close();
    }
}

export function createE2EContext(paths: E2EPaths, overrides: Record<string, unknown> = {}): any {
    return {
        cwd: paths.repository,
        parentCwd: paths.repository,
        parentContext: {},
        ui: { notify: () => {} },
        ...overrides,
    };
}

export function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

export interface ScriptedChildOptions {
    output?: string;
    error?: string;
    question?: ParentQuestion;
    session?: SessionManager;
    onPrompt?: (prompt: string) => void | Promise<void>;
}

export interface ScriptedChild extends ChildAgentHandle {
    prompts: string[];
    isDisposed: boolean;
    abortCount: number;
}

export function createScriptedChild({
    output = "",
    error,
    question,
    session,
    onPrompt,
}: ScriptedChildOptions = {}): ScriptedChild {
    let currentOutput = output;
    let pendingQuestion = question;
    let disposed = false;
    let abortCount = 0;
    const prompts: string[] = [];
    return {
        prompts,
        get isDisposed() {
            return disposed;
        },
        get abortCount() {
            return abortCount;
        },
        sessionFile: session?.getSessionFile(),
        prompt: async (prompt: string) => {
            prompts.push(prompt);
            await onPrompt?.(prompt);
            if (session) {
                session.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
                session.appendMessage({
                    role: "assistant",
                    content: [{ type: "text", text: currentOutput }],
                    api: "test",
                    provider: "test",
                    model: "test-model",
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: Date.now(),
                } as any);
            }
        },
        abort: async () => {
            abortCount++;
        },
        dispose: () => {
            disposed = true;
        },
        takeParentQuestion: () => {
            const result = pendingQuestion;
            pendingQuestion = undefined;
            return result;
        },
        getProgress: () => ({ output: currentOutput, recentActivity: [] }),
        getFinalOutput: () => currentOutput,
        getError: () => error,
        getUsage: () => zeroUsage(),
        getSessionLeafId: () => session?.getLeafId(),
    };
}

export async function loadE2EPersistence(paths: E2EPaths, sessionManager: SessionManager) {
    return loadAgentRunPersistence(createE2EContext(paths, { sessionManager }), paths.sessions);
}

export async function createClaimedTaskWorkspace(
    paths: E2EPaths,
    {
        ownerSessionId = "owner",
        runId = "worker-1",
        runInstanceId = "worker-1-instance",
    }: { ownerSessionId?: string; runId?: string; runInstanceId?: string } = {},
): Promise<AgentWorkspace> {
    const created = await createAgentWorkspace(paths.repository, { workspacesDir: paths.state });
    const ready = await updateAgentWorkspace(created, { setupState: "skipped" }, { workspacesDir: paths.state });
    return claimAgentWorkspace(ready.id, {
        ownerSessionId,
        leaseRunId: runId,
        leaseRunInstanceId: runInstanceId,
        leaseKind: "task",
        workspacesDir: paths.state,
    });
}

export async function insertE2EAgentRun(
    paths: E2EPaths,
    overrides: Partial<AgentRunCatalogRecord> = {},
): Promise<void> {
    const record: AgentRunCatalogRecord = {
        ownerSessionId: "owner",
        ownerPid: process.pid,
        runId: "worker-1",
        runInstanceId: "worker-1-instance",
        parentCwd: paths.repository,
        executionCwd: paths.repository,
        title: "worker-1",
        agent: "worker",
        agentSource: "builtin",
        task: "test task",
        status: "running",
        background: true,
        mutating: true,
        startedAt: 1,
        updatedAt: Date.now(),
        usageSnapshot: zeroUsage(),
        ...overrides,
    };
    await withE2EMetadataDatabase(paths, (database) => {
        upsertAgentRunCatalogRecordInDatabase(database, record);
    });
}

export function initializeRepository(repository: string): string {
    runGit(repository, ["init", "--quiet"]);
    runGit(repository, ["config", "user.email", "test@example.com"]);
    runGit(repository, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repository, "README.md"), "base\n");
    runGit(repository, ["add", "README.md"]);
    runGit(repository, ["commit", "--quiet", "-m", "initial"]);
    return gitOutput(repository, ["rev-parse", "HEAD"]);
}

export function runGit(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
}

export function gitOutput(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function createParentSession(paths: E2EPaths, name = "parent"): SessionManager {
    const directory = path.join(paths.root, name);
    fs.mkdirSync(directory, { recursive: true });
    return SessionManager.create(paths.repository, directory);
}

export function removeE2EPaths(paths: E2EPaths): void {
    fs.rmSync(paths.root, { recursive: true, force: true });
}

export function appendParentCommit(repository: string, name: string, content: string): string {
    fs.writeFileSync(path.join(repository, name), content);
    runGit(repository, ["add", name]);
    runGit(repository, ["commit", "--quiet", "-m", `parent: ${name}`]);
    return gitOutput(repository, ["rev-parse", "HEAD"]);
}
