import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => {
    const fsModule = process.getBuiltinModule("node:fs") as typeof import("node:fs");
    const osModule = process.getBuiltinModule("node:os") as typeof import("node:os");
    const pathModule = process.getBuiltinModule("node:path") as typeof import("node:path");
    const root = fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), "pi-coder-revise-e2e-"));
    return {
        root,
        sessions: pathModule.join(root, "agent-sessions"),
        workspaces: pathModule.join(root, "workspaces"),
    };
});

vi.mock("../../../src/common/constants", async () => {
    const actual = await vi.importActual<typeof import("../../../src/common/constants")>(
        "../../../src/common/constants",
    );
    return {
        ...actual,
        PI_CODER_STATE_DIR: testPaths.root,
        PI_CODER_AGENT_SESSIONS_DIR: testPaths.sessions,
        PI_CODER_WORKSPACES_DIR: testPaths.workspaces,
    };
});

import registerAgentTool from "../../../src/tools/agent";
import { createAgentWorkspaceCheckpoint } from "../../../src/tools/agent/workspaces/checkpoints";
import * as workspaceFinalization from "../../../src/tools/agent/workspaces/finalization";
import * as runCatalog from "../../../src/tools/agent/storage/run-catalog";
import {
    createAgentWorkspace,
    recycleAgentWorkspaceForReuse,
    updateAgentWorkspace,
} from "../../../src/tools/agent/workspaces/lifecycle";
import * as workspaceSetup from "../../../src/tools/agent/workspaces/setup";
import { claimAgentWorkspace, getAgentWorkspace } from "../../../src/tools/agent/workspaces/store";
import {
    createE2EPathsAtRoot,
    createParentSession,
    createScriptedChild,
    gitOutput,
    initializeRepository,
    removeE2EPaths,
    runGit,
} from "./helpers";

interface Handler {
    (event: any, ctx: any): Promise<unknown> | unknown;
}

const paths = createE2EPathsAtRoot(testPaths.root);

const handlersToClose: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of handlersToClose.splice(0)) await close();
    removeE2EPaths(paths);
});

describe("registered continuation lifecycle", () => {
    it("persists and continues the real isolated background start/collect session", async () => {
        const repository = paths.repository;
        initializeRepository(repository);
        const parentHead = gitOutput(repository, ["rev-parse", "HEAD"]);
        const parentSession = createParentSession(paths);
        const ownerSessionId = parentSession.getSessionId();

        const created = await createAgentWorkspace(repository, { workspacesDir: paths.state });
        const ready = await updateAgentWorkspace(
            created,
            { setupState: "skipped" },
            { workspacesDir: paths.state },
        );
        const provisional = await claimAgentWorkspace(ready.id, {
            ownerSessionId,
            leaseRunId: "setup-1",
            leaseKind: "setup",
            workspacesDir: paths.state,
            leaseRunInstanceId: "setup-instance-1",
        });
        const prompts: string[] = [];
        const factoryContexts: any[] = [];
        const childSessions: SessionManager[] = [];
        let invocation = 0;
        let failNextSetup = false;
        const fakeFactory = async (context: any) => {
            invocation++;
            const currentInvocation = invocation;
            if (failNextSetup) {
                failNextSetup = false;
                throw new Error("child session could not be reopened");
            }
            const childSession = context.childSessionFile
                ? SessionManager.open(
                      context.childSessionFile,
                      context.childSessionDir,
                      context.cwd,
                  )
                : SessionManager.create(context.cwd, context.childSessionDir);
            childSessions.push(childSession);
            factoryContexts.push(context);
            return createScriptedChild({
                output: currentInvocation === 1 ? "Initial result" : "Revised result",
                session: childSession,
                onPrompt: (prompt) => {
                    prompts.push(prompt);
                    fs.writeFileSync(
                        path.join(context.cwd, "revision-marker.txt"),
                        currentInvocation === 1 ? "initial\n" : "revised\n",
                    );
                },
            });
        };
        const handlers: Record<string, Handler[]> = {};
        let tool: any;
        const pi = {
            events: { emit() {} },
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool(definition: any) {
                tool = definition;
            },
            registerCommand() {},
            sendMessage() {},
        } as any;
        registerAgentTool(pi, fakeFactory);
        const ctx = {
            cwd: repository,
            isProjectTrusted: () => true,
            isIdle: () => true,
            sessionManager: parentSession,
            ui: { notify: () => {}, setWidget: () => {} },
        };
        vi.spyOn(workspaceSetup, "prepareIsolatedWorkspace").mockResolvedValue({
            workspace: provisional,
            ownerSessionId,
            provisionalLeaseRunId: "setup-1",
            provisionalLeaseRunInstanceId: "setup-instance-1",
        });
        handlersToClose.push(async () => handlers.session_shutdown?.[0]?.({}, ctx));
        await handlers.session_start[0]({}, ctx);

        const spawned = await tool.execute(
            "e2e-background-start",
            {
                action: "start",
                agent: "worker",
                task: "Create the marker",
                isolation: "worktree",
                background: true,
            },
            undefined,
            undefined,
            ctx,
        );
        await vi.waitFor(() => expect(prompts).toHaveLength(1));
        await vi.waitFor(async () => {
            const record = (await runCatalog.listAgentRunCatalog(repository)).find(
                (candidate) => candidate.runId === spawned.details.runId,
            );
            expect(record?.status).toBe("completed");
        });
        const collected = await tool.execute(
            "e2e-collect",
            { action: "collect", runId: spawned.details.runId },
            undefined,
            undefined,
            ctx,
        );
        const firstResult = collected.details.workspaceResult;
        expect(firstResult).toMatchObject({
            workspaceId: provisional.id,
            runId: spawned.details.runId,
            status: "prepared",
        });
        expect(gitOutput(repository, ["rev-parse", "HEAD"])).toBe(parentHead);
        expect(gitOutput(repository, ["status", "--porcelain"])).toBe("");
        expect(fs.existsSync(path.join(repository, "revision-marker.txt"))).toBe(false);

        const persistedSessionFile = childSessions[0]?.getSessionFile();
        expect(persistedSessionFile).toBeDefined();
        const catalogAfterCollect = await runCatalog.listAgentRunCatalog(repository);
        const firstRecord = catalogAfterCollect.find(
            (record) => record.runId === spawned.details.runId,
        );
        expect(firstRecord).toMatchObject({
            ownerSessionId: parentSession.getSessionId(),
            runInstanceId: spawned.details.runInstanceId,
            workspaceId: provisional.id,
            childSessionFile: persistedSessionFile,
            childSessionLeafId: childSessions[0]?.getLeafId(),
            definitionSnapshot: expect.objectContaining({
                name: "worker",
                capabilities: expect.arrayContaining(["edit"]),
            }),
            status: "removed",
        });

        const recycledForOtherWorker = await recycleAgentWorkspaceForReuse(provisional.id, {
            previousOwnerSessionId: ownerSessionId,
            previousLeaseRunId: spawned.details.runId,
            previousLeaseRunInstanceId: spawned.details.runInstanceId,
            ownerSessionId: "other-parent",
            leaseRunId: "worker-y",
            leaseRunInstanceId: "worker-y-instance",
            workspacesDir: paths.state,
        });
        fs.writeFileSync(
            path.join(recycledForOtherWorker.worktreePath, "other-worker.txt"),
            "other worker\n",
        );
        await createAgentWorkspaceCheckpoint(recycledForOtherWorker.id, {
            ownerSessionId: "other-parent",
            leaseRunId: "worker-y",
            runInstanceId: "worker-y-instance",
            kind: "intermediate",
            runStatus: "interrupted",
            childSessionLeafId: null,
            workspacesDir: paths.state,
        });

        const revised = await tool.execute(
            "e2e-revise",
            { action: "continue", runId: spawned.details.runId, guidance: "Apply the feedback" },
            undefined,
            undefined,
            ctx,
        );

        expect(prompts).toEqual(["Create the marker", "Apply the feedback"]);
        expect(factoryContexts[1]).toMatchObject({
            cwd: provisional.worktreePath,
            parentCwd: repository,
            workspaceId: provisional.id,
            childSessionFile: persistedSessionFile,
            childSessionLeafId: childSessions[0]?.getLeafId(),
        });
        expect(childSessions[1]?.getSessionFile()).toBe(persistedSessionFile);
        const continuedSession = SessionManager.open(
            persistedSessionFile!,
            childSessions[1]?.getSessionDir(),
            provisional.worktreePath,
        );
        const userMessages = continuedSession.getBranch().flatMap((entry) => {
            if (entry.type !== "message" || entry.message.role !== "user") return [];
            return [entry.message.content];
        });
        expect(userMessages).toEqual(["Create the marker", "Apply the feedback"]);
        expect(revised.details.runId).toBe(spawned.details.runId);
        expect(revised.details.runInstanceId).toBe(spawned.details.runInstanceId);
        expect(revised.details.workspaceResult).toMatchObject({
            workspaceId: provisional.id,
            runId: revised.details.runId,
            status: "prepared",
        });
        expect(revised.details.workspaceResult.id).not.toBe(firstResult.id);
        expect(
            fs.readFileSync(path.join(provisional.worktreePath, "revision-marker.txt"), "utf8"),
        ).toBe("revised\n");
        expect(gitOutput(repository, ["rev-parse", "HEAD"])).toBe(parentHead);
        expect(gitOutput(repository, ["status", "--porcelain"])).toBe("");
        expect(fs.existsSync(path.join(repository, "revision-marker.txt"))).toBe(false);

        const finalWorkspace = await getAgentWorkspace(provisional.id);
        expect(finalWorkspace).toMatchObject({
            status: "available",
            leaseOwnerSessionId: parentSession.getSessionId(),
            leaseRunId: revised.details.runId,
            leaseRunInstanceId: revised.details.runInstanceId,
            leaseKind: "task",
            latestResult: {
                runId: revised.details.runId,
                runInstanceId: revised.details.runInstanceId,
                status: "prepared",
            },
        });

        failNextSetup = true;
        const setupFailure = await tool.execute(
            "e2e-setup-failure",
            {
                action: "continue",
                runId: revised.details.runId,
                guidance: "Retry after setup failure",
            },
            undefined,
            undefined,
            ctx,
        );
        expect(setupFailure.details.status).toBe("failed");
        expect(setupFailure.details.setupFailed).toBe(true);
        expect(setupFailure.content[0].text).toContain("child session could not be reopened");
        const workspaceAfterSetupFailure = await getAgentWorkspace(provisional.id);
        expect(workspaceAfterSetupFailure).toMatchObject({
            leaseOwnerSessionId: parentSession.getSessionId(),
            leaseRunId: revised.details.runId,
            leaseRunInstanceId: revised.details.runInstanceId,
            latestResult: {
                id: revised.details.workspaceResult!.id,
                runId: revised.details.runId,
                runInstanceId: revised.details.runInstanceId,
                status: "prepared",
            },
        });

        const retried = await tool.execute(
            "e2e-setup-retry",
            {
                action: "continue",
                runId: revised.details.runId,
                guidance: "Retry the review after setup recovers",
            },
            undefined,
            undefined,
            ctx,
        );
        expect(retried.details.runId).toBe(revised.details.runId);
        expect(retried.details.runInstanceId).toBe(revised.details.runInstanceId);
        expect(prompts).toEqual([
            "Create the marker",
            "Apply the feedback",
            "Retry the review after setup recovers",
        ]);

        const finalizationError = new Error("revision finalization failed");
        vi.spyOn(workspaceFinalization, "prepareForegroundWorkspaceResult").mockRejectedValueOnce(
            finalizationError,
        );
        const finalizationFailure = await tool.execute(
            "e2e-finalization-failure",
            {
                action: "continue",
                runId: revised.details.runId,
                guidance: "Try finalization failure",
            },
            undefined,
            undefined,
            ctx,
        );
        expect(finalizationFailure.details.status).toBe("failed");
        expect(finalizationFailure.content[0].text).toContain(finalizationError.message);
        expect(await getAgentWorkspace(provisional.id)).toMatchObject({
            leaseOwnerSessionId: parentSession.getSessionId(),
            leaseRunId: revised.details.runId,
            leaseRunInstanceId: revised.details.runInstanceId,
            latestResult: {
                runId: revised.details.runId,
                runInstanceId: revised.details.runInstanceId,
                status: "prepared",
            },
        });
        expect(gitOutput(repository, ["rev-parse", "HEAD"])).toBe(parentHead);
        expect(gitOutput(repository, ["status", "--porcelain"])).toBe("");
        expect(fs.existsSync(path.join(repository, "revision-marker.txt"))).toBe(false);

        runGit(provisional.worktreePath, ["checkout", "--orphan", "divergent"]);
        runGit(provisional.worktreePath, [
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "divergent history",
        ]);
        const divergentHead = gitOutput(provisional.worktreePath, ["rev-parse", "HEAD"]);
        const continuedAfterDivergence = await tool.execute(
            "e2e-divergent-revise",
            { action: "continue", runId: revised.details.runId, guidance: "Try again" },
            undefined,
            undefined,
            ctx,
        );
        expect(continuedAfterDivergence.details.status).toBe("failed");
        expect(continuedAfterDivergence.content[0].text).toContain("differs from checkpoint");
        expect(invocation).toBe(5);
        expect(gitOutput(provisional.worktreePath, ["rev-parse", "HEAD"])).toBe(divergentHead);
        const preservedAfterDivergence = await getAgentWorkspace(provisional.id);
        expect(preservedAfterDivergence).toMatchObject({
            leaseOwnerSessionId: parentSession.getSessionId(),
            leaseRunId: revised.details.runId,
            leaseRunInstanceId: revised.details.runInstanceId,
            leaseKind: "task",
            latestResult: {
                runId: revised.details.runId,
                runInstanceId: revised.details.runInstanceId,
                status: "prepared",
            },
        });
    });
});
