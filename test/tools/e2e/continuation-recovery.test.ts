import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { BUILTIN_SCOUT } from "../../../src/tools/agent/definitions/discovery";
import { createAgentWorkspaceCheckpointCallback } from "../../../src/tools/agent/workspaces/checkpoints";
import { recycleAgentWorkspaceForReuse } from "../../../src/tools/agent/workspaces/lifecycle";
import { AgentRunManager, type ChildAgentHandle } from "../../../src/tools/agent/runs/manager";
import { getAgentWorkspace } from "../../../src/tools/agent/workspaces/store";
import {
    createClaimedTaskWorkspace,
    createE2EContext,
    createE2EPaths,
    createParentSession,
    createScriptedChild,
    initializeRepository,
    loadE2EPersistence,
    removeE2EPaths,
    type E2EPaths,
} from "./helpers";

const pathsInUse: E2EPaths[] = [];

afterEach(() => {
    for (const paths of pathsInUse.splice(0)) removeE2EPaths(paths);
});

describe("isolated continuation recovery e2e", () => {
    it("serializes concurrent starts for one physical run identity", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        initializeRepository(paths.repository);
        const parent = createParentSession(paths);
        const firstPersistence = await loadE2EPersistence(paths, parent);
        const secondPersistence = await loadE2EPersistence(paths, parent);
        expect(firstPersistence).toBeDefined();
        expect(secondPersistence).toBeDefined();

        let enteredFactory: (() => void) | undefined;
        const factoryEntered = new Promise<void>((resolve) => { enteredFactory = resolve; });
        let releaseFactory: (() => void) | undefined;
        const factoryRelease = new Promise<void>((resolve) => { releaseFactory = resolve; });
        const childFactory = async (): Promise<ChildAgentHandle> => {
            enteredFactory?.();
            await factoryRelease;
            return createScriptedChild({ output: "completed" });
        };
        const firstManager = new AgentRunManager(childFactory);
        const secondManager = new AgentRunManager(async () => {
            throw new Error("the competing continuation must not create a child");
        });
        firstManager.setPersistence(firstPersistence!.persistence);
        secondManager.setPersistence(secondPersistence!.persistence);
        const context = createE2EContext(paths);
        const identity = firstManager.reserveRunIdentity(BUILTIN_SCOUT, "shared identity", context, "scout-1", "shared-instance");
        const firstStart = firstManager.start(BUILTIN_SCOUT, "shared identity", context, { identity });
        await factoryEntered;

        await expect(secondManager.start(BUILTIN_SCOUT, "shared identity", context, { identity }))
            .rejects.toThrow(/continuation|reserve/i);
        releaseFactory?.();
        await expect(firstStart).resolves.toMatchObject({ details: { status: "completed", runInstanceId: "shared-instance" } });

        firstPersistence!.persistence.close?.();
        secondPersistence!.persistence.close?.();
        await firstManager.shutdown();
        await secondManager.shutdown();
    });

    it("parks a waiting isolated run durably before its workspace is reused", async () => {
        const paths = createE2EPaths();
        pathsInUse.push(paths);
        initializeRepository(paths.repository);
        const parent = createParentSession(paths);
        const ownerSessionId = parent.getSessionId();
        const ready = await createClaimedTaskWorkspace(paths, {
            ownerSessionId,
            runId: "scout-1",
            runInstanceId: "scout-1-instance",
        });
        const manager = new AgentRunManager(async (context): Promise<ChildAgentHandle> => {
            const child = SessionManager.create(context.cwd, context.childSessionDir);
            const scripted = createScriptedChild({
                output: "Waiting for parent",
                question: { question: "Should I continue?" },
                session: child,
            });
            context.onSessionCreated?.(child.getSessionFile(), child.getLeafId() ?? null);
            return scripted;
        });
        const persistence = await loadE2EPersistence(paths, parent);
        expect(persistence).toBeDefined();
        manager.setPersistence(persistence!.persistence);
        const context = createE2EContext(paths, { workspaceId: ready.id });
        const identity = manager.reserveRunIdentity(BUILTIN_SCOUT, "Inspect the workspace", context, "scout-1", "scout-1-instance");
        const waiting = await manager.start(BUILTIN_SCOUT, "Inspect the workspace", context, {
            identity,
            onWorkspaceCheckpoint: createAgentWorkspaceCheckpointCallback(ownerSessionId, paths.state),
        });
        expect(waiting.details.status).toBe("waiting_for_parent");
        expect((await getAgentWorkspace(ready.id, { workspacesDir: paths.state }))?.leaseActive).toBe(true);

        expect(await manager.parkWorkspaceRunForReuse(ready.id, identity.runId)).toBe(true);
        const parked = await getAgentWorkspace(ready.id, { workspacesDir: paths.state });
        expect(parked?.leaseRunId).toBe(identity.runId);
        expect(parked?.leaseActive).toBe(false);

        const recycled = await recycleAgentWorkspaceForReuse(ready.id, {
            previousOwnerSessionId: ownerSessionId,
            previousLeaseRunId: identity.runId,
            previousLeaseRunInstanceId: identity.runInstanceId,
            ownerSessionId: "new-parent",
            leaseRunId: "worker-2",
            leaseRunInstanceId: "worker-2-instance",
            workspacesDir: paths.state,
        });
        expect(recycled.leaseRunId).toBe("worker-2");
        expect(recycled.leaseOwnerSessionId).toBe("new-parent");
        expect(fs.existsSync(path.join(recycled.worktreePath, "unexpected-worker-file"))).toBe(false);

        persistence!.persistence.close?.();
        await manager.shutdown();
    });
});
