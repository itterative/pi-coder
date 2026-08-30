import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const testPaths = vi.hoisted(() => {
    const fsModule = process.getBuiltinModule("node:fs") as typeof import("node:fs");
    const osModule = process.getBuiltinModule("node:os") as typeof import("node:os");
    const pathModule = process.getBuiltinModule("node:path") as typeof import("node:path");
    const root = fsModule.mkdtempSync(
        pathModule.join(osModule.tmpdir(), "pi-coder-agent-restart-e2e-"),
    );
    return {
        root,
        repository: pathModule.join(root, "repo"),
        state: pathModule.join(root, "workspaces"),
        sessions: pathModule.join(root, "agent-sessions"),
    };
});
const testRoot = testPaths.root;

vi.mock("../../../src/common/constants", async () => {
    const actual = await vi.importActual<typeof import("../../../src/common/constants")>(
        "../../../src/common/constants",
    );
    return {
        ...actual,
        PI_CODER_STATE_DIR: testPaths.root,
        PI_CODER_AGENT_SESSIONS_DIR: testPaths.sessions,
        PI_CODER_WORKSPACES_DIR: testPaths.state,
    };
});

import {
    BUILTIN_SCOUT,
    fingerprintAgentDefinition,
} from "../../../src/tools/agent/definitions/discovery";
import { createAgentWorkspaceCheckpoint } from "../../../src/tools/agent/workspaces/checkpoints";
import { recycleAgentWorkspaceForReuse } from "../../../src/tools/agent/workspaces/lifecycle";
import {
    AgentRunManager,
    type ChildAgentHandle,
    type PersistedAgentRun,
} from "../../../src/tools/agent/runs/manager";
import { getAgentCwdSessionDir } from "../../../src/tools/agent/runs/persistence";
import { getAgentWorkspace } from "../../../src/tools/agent/workspaces/store";
import {
    createClaimedTaskWorkspace,
    createE2EContext,
    createE2EPathsAtRoot,
    initializeRepository,
    loadE2EPersistence,
    removeE2EPaths,
    withE2EMetadataDatabase,
    zeroUsage,
    type E2EPaths,
} from "./helpers";

let paths: E2EPaths;

beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    paths = createE2EPathsAtRoot(testRoot);
});

afterAll(() => {
    removeE2EPaths(paths ?? createE2EPathsAtRoot(testRoot));
});

describe("isolated workspace restart e2e", () => {
    it("does not restore a parked run into a workspace reused by another worker", async () => {
        initializeRepository(paths.repository);
        const parent = SessionManager.create(paths.repository, path.join(paths.root, "parent"));
        const ownerSessionId = parent.getSessionId();
        const leased = await createClaimedTaskWorkspace(paths, {
            ownerSessionId,
            runId: "scout-1",
            runInstanceId: "scout-1-instance",
        });

        const childDir = path.join(
            getAgentCwdSessionDir(paths.repository, { agentSessionsDir: paths.sessions }),
            ownerSessionId,
        );
        fs.mkdirSync(childDir, { recursive: true });
        const child = SessionManager.create(leased.worktreePath, childDir);
        const userLeaf = child.appendMessage({
            role: "user",
            content: "Inspect the workspace",
            timestamp: Date.now(),
        });
        child.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "Waiting" }],
            api: "test",
            provider: "test",
            model: "test-model",
            usage: zeroUsage(),
            stopReason: "stop",
            timestamp: Date.now(),
        } as any);
        const childFile = child.getSessionFile();
        expect(childFile).toBeDefined();
        await createAgentWorkspaceCheckpoint(leased.id, {
            ownerSessionId,
            leaseRunId: "scout-1",
            runInstanceId: "scout-1-instance",
            kind: "intermediate",
            runStatus: "waiting_for_parent",
            childSessionFile: childFile,
            childSessionLeafId: userLeaf,
            workspacesDir: paths.state,
        });

        const loaded = await loadE2EPersistence(paths, parent);
        expect(loaded).toBeDefined();
        const record: PersistedAgentRun = {
            version: 1,
            ownerSessionId,
            runId: "scout-1",
            runInstanceId: "scout-1-instance",
            title: "Inspect the workspace",
            agent: "scout",
            agentSource: "builtin",
            definitionFingerprint: fingerprintAgentDefinition(BUILTIN_SCOUT),
            definitionSnapshot: BUILTIN_SCOUT,
            task: "Inspect the workspace",
            status: "waiting_for_parent",
            background: true,
            mutating: false,
            workspaceId: leased.id,
            question: { question: "Continue?" },
            progress: { output: "Waiting", recentActivity: [] },
            usageCheckpoint: zeroUsage(),
            usageSnapshot: zeroUsage(),
            startedAt: 1,
            updatedAt: Date.now(),
            parentCwd: paths.repository,
            cwd: leased.worktreePath,
            childSessionFile: childFile,
            childSessionLeafId: child.getLeafId(),
        };
        expect(await loaded.persistence.save(record)).toBe(true);
        await withE2EMetadataDatabase(paths, async (catalogDatabase) => {
            await catalogDatabase.run(
                "UPDATE agent_runs SET status = 'removed' WHERE run_instance_id = ?",
                "scout-1-instance",
            );
        });
        const records = (await loadE2EPersistence(paths, parent))?.records ?? [];

        const recycled = await recycleAgentWorkspaceForReuse(leased.id, {
            previousOwnerSessionId: ownerSessionId,
            previousLeaseRunId: "scout-1",
            previousLeaseRunInstanceId: "scout-1-instance",
            ownerSessionId: "other-parent",
            leaseRunId: "worker-2",
            leaseRunInstanceId: "worker-2-instance",
            workspacesDir: paths.state,
        });
        fs.writeFileSync(path.join(recycled.worktreePath, "worker-2.txt"), "occupant\n");

        let factoryCalls = 0;
        const manager = new AgentRunManager(async (): Promise<ChildAgentHandle> => {
            factoryCalls++;
            throw new Error("the parked run must not be reopened");
        });
        const persistence = await loadE2EPersistence(paths, parent);
        manager.setPersistence(persistence?.persistence);
        const restoration = await manager.restore(
            records,
            [BUILTIN_SCOUT],
            createE2EContext(paths),
        );

        expect(restoration.restored).toBe(0);
        expect(restoration.diagnostics).toContain(
            `Could not restore scout-1: its original workspace is parked or occupied; continue it explicitly after reclaiming that workspace.`,
        );
        expect(factoryCalls).toBe(0);
        expect(fs.readFileSync(path.join(recycled.worktreePath, "worker-2.txt"), "utf8")).toBe(
            "occupant\n",
        );
        expect(
            (await getAgentWorkspace(leased.id, { workspacesDir: paths.state }))?.leaseRunId,
        ).toBe("worker-2");

        loaded.persistence.close?.();
        persistence?.persistence.close?.();
        await manager.shutdown();
    });
});
