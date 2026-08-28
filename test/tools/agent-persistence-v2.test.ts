import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { BUILTIN_SCOUT, fingerprintAgentDefinition } from "../../src/tools/agent/definitions/discovery";
import { selectChildSessionLeaf } from "../../src/tools/agent/child";
import {
    createAgentRunStateWriter,
    getAgentCwdSessionDir,
    loadAgentRunPersistence,
} from "../../src/tools/agent/runs/persistence";
import {
    AgentRunManager,
    ZERO_USAGE,
    type ChildAgentHandle,
    type PersistedAgentRun,
} from "../../src/tools/agent/runs/manager";
import { AGENT_RUN_SNAPSHOT_MARKER } from "../../src/tools/agent/storage/run-markers";
import { openAgentMetadataDatabase } from "../../src/tools/agent/storage/metadata";
import { upsertAgentRunCatalogRecord } from "../../src/tools/agent/storage/run-catalog";
import { listPastAgentSessions, loadAgentSessionTranscriptForItem } from "../../src/tools/agent/presentation/sessions";

const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function record(
    runInstanceId: string,
    ownerSessionId: string,
    childSessionFile?: string,
    childSessionLeafId: string | null = null,
): PersistedAgentRun {
    return {
        version: 1,
        ownerSessionId,
        runId: "scout-1",
        runInstanceId,
        title: "Snapshot test",
        agent: "scout",
        agentSource: "builtin",
        definitionFingerprint: fingerprintAgentDefinition(BUILTIN_SCOUT),
        definitionSnapshot: BUILTIN_SCOUT,
        task: "Inspect",
        status: "waiting_for_parent",
        background: true,
        mutating: false,
        question: { question: "Continue?" },
        progress: { output: "", recentActivity: [] },
        usageCheckpoint: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        usageSnapshot: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        startedAt: 1,
        updatedAt: Date.now(),
        childSessionFile,
        childSessionLeafId,
    };
}

describe("delegated-agent V2 persistence", () => {
    it("commits immutable snapshots through parent markers and rejects stale branch resume", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir }), "parent-1");
        fs.mkdirSync(parentDir, { recursive: true });
        const parent = SessionManager.create(process.cwd(), parentDir);
        const context = {
            cwd: process.cwd(),
            ui: { notify: vi.fn() },
            sessionManager: parent,
        } as any;
        const loaded = await loadAgentRunPersistence(context, sessionsDir);
        expect(loaded).toBeDefined();

        const ownerSessionId = parent.getSessionId();
        expect(loaded!.persistence.save(record("instance-1", ownerSessionId))).toBe(true);
        const firstMarker = parent.getLeafId();
        expect(parent.getEntry(firstMarker!)?.customType).toBe(AGENT_RUN_SNAPSHOT_MARKER);
        expect(loaded!.persistence.save({ ...record("instance-1", ownerSessionId), updatedAt: Date.now() + 1 })).toBe(true);
        const secondMarker = parent.getLeafId();
        expect(secondMarker).not.toBe(firstMarker);

        const database = await openAgentMetadataDatabase(path.join(stateDir, "workspaces"));
        const snapshotCount = (database.prepare("SELECT COUNT(*) AS count FROM agent_run_snapshots").get() as { count: number }).count;
        database.close();
        expect(snapshotCount).toBe(2);

        parent.branch(firstMarker!);
        const stale = await loadAgentRunPersistence(context, sessionsDir);
        expect(stale?.records).toHaveLength(1);
        expect(stale?.records[0]).toMatchObject({
            runInstanceId: "instance-1",
            resumable: false,
            readOnlyReason: "continued on another branch",
        });
    });

    it("does not install or resume a stale checkpoint", async () => {
        let childCreated = false;
        const manager = new AgentRunManager(async () => {
            childCreated = true;
            throw new Error("stale checkpoints must not reopen child sessions");
        });
        manager.setPersistence({
            ownerSessionId: "parent-1",
            childSessionDir: "/tmp/agent-child-sessions",
            save: () => true,
            deleteChildSession: () => {},
        });
        const restoration = await manager.restore([
            {
                ...record("instance-stale", "parent-1"),
                resumable: false,
                readOnlyReason: "continued on another branch",
            },
        ], [BUILTIN_SCOUT], { cwd: process.cwd(), parentContext: {} });

        expect(restoration).toEqual({
            restored: 0,
            diagnostics: ["Could not restore scout-1: this checkpoint is historical and was continued on another parent branch."],
        });
        expect(childCreated).toBe(false);
        await expect(manager.resume("scout-1", { guidance: "Continue" })).rejects.toThrow("Unknown or stale");
    });

    it("isolates true sibling branches and physical runs with the same display ID", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-siblings-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir }), "parent-1");
        fs.mkdirSync(parentDir, { recursive: true });
        const parent = SessionManager.create(process.cwd(), parentDir);
        parent.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "common parent point" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: 1,
        });
        const commonLeaf = parent.getLeafId();
        const context = {
            cwd: process.cwd(),
            ui: { notify: vi.fn() },
            sessionManager: parent,
        } as any;
        const loaded = await loadAgentRunPersistence(context, sessionsDir);
        expect(loaded).toBeDefined();

        expect(loaded!.persistence.save({ ...record("instance-a", parent.getSessionId()), updatedAt: 2 })).toBe(true);
        const branchAMarker = parent.getLeafId();
        parent.branch(commonLeaf!);
        expect(loaded!.persistence.save({ ...record("instance-b", parent.getSessionId()), updatedAt: 3 })).toBe(true);
        const branchBMarker = parent.getLeafId();
        expect(branchBMarker).not.toBe(branchAMarker);

        const branchB = await loadAgentRunPersistence(context, sessionsDir);
        expect(branchB?.records).toHaveLength(1);
        expect(branchB?.records[0]).toMatchObject({ runId: "scout-1", runInstanceId: "instance-b", resumable: true });

        parent.branch(branchAMarker!);
        const branchA = await loadAgentRunPersistence(context, sessionsDir);
        expect(branchA?.records).toHaveLength(1);
        expect(branchA?.records[0]).toMatchObject({ runId: "scout-1", runInstanceId: "instance-a", resumable: true });

        parent.branch(commonLeaf!);
        expect(loaded!.persistence.save({ ...record("instance-a", parent.getSessionId()), updatedAt: 4 })).toBe(true);
        const staleSiblingMarker = parent.getLeafId();
        expect(staleSiblingMarker).not.toBe(branchAMarker);
        parent.branch(branchAMarker!);
        const staleBranch = await loadAgentRunPersistence(context, sessionsDir);
        expect(staleBranch?.records).toHaveLength(1);
        expect(staleBranch?.records[0]).toMatchObject({
            runId: "scout-1",
            runInstanceId: "instance-a",
            resumable: false,
            readOnlyReason: "continued on another branch",
        });
    });

    it("restores interrupted V2 runs without repairing an unmarked child tail", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-repair-"));
        tempDirs.push(directory);
        const child = SessionManager.create(process.cwd(), directory);
        child.appendMessage({ role: "user", content: "committed child point", timestamp: 1 });
        const committedLeaf = child.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "committed response" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: 2,
        });
        child.resetLeaf();
        child.appendMessage({ role: "user", content: "unmarked crash tail", timestamp: 3 });
        const childFile = child.getSessionFile();
        expect(childFile).toBeDefined();

        let repairCalls = 0;
        let restoredContext: any;
        const restoredChild: ChildAgentHandle = {
            sessionFile: childFile,
            prompt: async () => {},
            abort: async () => {},
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => ({ output: "", recentActivity: [] }),
            getFinalOutput: () => "",
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
            getSessionLeafId: () => committedLeaf,
            repairInterrupted: () => {
                repairCalls++;
                return 1;
            },
        };
        const manager = new AgentRunManager(async (context) => {
            restoredContext = context;
            return restoredChild;
        });
        manager.setPersistence({
            ownerSessionId: "parent-1",
            usesSnapshotMarkers: true,
            childSessionDir: directory,
            save: () => true,
            deleteChildSession: () => {},
        });
        const restoration = await manager.restore([
            {
                ...record("instance-interrupted", "parent-1", childFile, committedLeaf),
                status: "interrupted",
            },
        ], [BUILTIN_SCOUT], { cwd: process.cwd(), parentContext: {} });

        expect(restoration).toEqual({ restored: 1, diagnostics: [] });
        expect(restoredContext).toMatchObject({
            childSessionFile: childFile,
            childSessionLeafId: committedLeaf,
            repairInterrupted: false,
        });
        expect(repairCalls).toBe(0);
        expect(restoredChild.getSessionLeafId?.()).toBe(committedLeaf);
        await expect(manager.resume("scout-1", {})).resolves.toMatchObject({
            details: { status: "running" },
        });
        expect(repairCalls).toBe(1);
    });

    it("restores starting and running checkpoints as interrupted without replaying them", async () => {
        const restoredContexts: any[] = [];
        const repairCalls = new Map<string, number>();
        const manager = new AgentRunManager(async (context) => {
            restoredContexts.push(context);
            const runId = context.childSessionFile?.includes("running") ? "scout-2" : "scout-1";
            return {
                sessionFile: context.childSessionFile,
                prompt: async () => {},
                abort: async () => {},
                dispose: () => {},
                takeParentQuestion: () => undefined,
                getProgress: () => ({ output: "", recentActivity: [] }),
                getFinalOutput: () => "",
                getError: () => undefined,
                getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
                getSessionLeafId: () => context.childSessionLeafId,
                repairInterrupted: () => {
                    repairCalls.set(runId, (repairCalls.get(runId) ?? 0) + 1);
                    return 1;
                },
            };
        });
        manager.setPersistence({
            ownerSessionId: "parent-1",
            usesSnapshotMarkers: true,
            childSessionDir: "/tmp/agent-child-sessions",
            save: () => true,
            deleteChildSession: () => {},
        });

        const restoration = await manager.restore([
            { ...record("instance-starting", "parent-1", "/tmp/starting-child.jsonl", "starting-leaf"), status: "starting" },
            { ...record("instance-running", "parent-1", "/tmp/running-child.jsonl", "running-leaf"), runId: "scout-2", status: "running" },
        ], [BUILTIN_SCOUT], { cwd: process.cwd(), parentContext: {} });

        expect(restoration).toEqual({ restored: 2, diagnostics: [] });
        expect(manager.listRuns()).toEqual([
            expect.objectContaining({ runId: "scout-1", status: "interrupted" }),
            expect.objectContaining({ runId: "scout-2", status: "interrupted" }),
        ]);
        expect(restoredContexts).toEqual(expect.arrayContaining([
            expect.objectContaining({ childSessionLeafId: "starting-leaf", repairInterrupted: false }),
            expect.objectContaining({ childSessionLeafId: "running-leaf", repairInterrupted: false }),
        ]));
        expect(repairCalls).toEqual(new Map());
    });

    it("restores V2 branch checkpoints and browses their exact child leaves", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-browser-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir }), "parent-1");
        fs.mkdirSync(parentDir, { recursive: true });
        const parent = SessionManager.create(process.cwd(), parentDir);
        parent.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "parent checkpoint" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: 1,
        });
        const childDir = path.join(getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir }), parent.getSessionId());
        fs.mkdirSync(childDir, { recursive: true });
        const child = SessionManager.create(process.cwd(), childDir);
        const firstUser = child.appendMessage({
            role: "user",
            content: [{ type: "text", text: "first child branch" }],
            timestamp: 1,
        });
        const firstLeaf = child.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "first checkpoint response" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: 2,
        });
        expect(firstLeaf).not.toBe(firstUser);
        child.resetLeaf();
        child.appendMessage({
            role: "user",
            content: [{ type: "text", text: "second child branch" }],
            timestamp: 3,
        });
        const secondLeaf = child.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "second checkpoint response" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: 4,
        });
        const childFile = child.getSessionFile();
        expect(childFile).toBeDefined();

        const context = {
            cwd: process.cwd(),
            ui: { notify: vi.fn() },
            sessionManager: parent,
        } as any;
        const loaded = await loadAgentRunPersistence(context, sessionsDir);
        expect(loaded).toBeDefined();
        const ownerSessionId = parent.getSessionId();
        const base = record("instance-1", ownerSessionId, childFile, firstLeaf);
        expect(loaded!.persistence.save(base)).toBe(true);
        const firstMarker = parent.getLeafId();
        expect(loaded!.persistence.save({
            ...base,
            childSessionLeafId: secondLeaf,
            updatedAt: 2,
        })).toBe(true);
        const secondMarker = parent.getLeafId();
        expect(secondMarker).not.toBe(firstMarker);

        const restored = await loadAgentRunPersistence(context, sessionsDir);
        expect(restored?.records[0]).toMatchObject({
            childSessionFile: childFile,
            childSessionLeafId: secondLeaf,
            resumable: true,
        });

        const current = await listPastAgentSessions(process.cwd(), {
            agentSessionsDir: sessionsDir,
            parentSessionId: ownerSessionId,
            parentSessionFile: parent.getSessionFile(),
            parentSessionLeafId: secondMarker,
            activeBranchOnly: true,
        });
        expect(current).toHaveLength(1);
        expect(current[0]?.transcript).toBeUndefined();
        const loadedCurrent = await loadAgentSessionTranscriptForItem(current[0]!);
        expect(loadedCurrent?.transcript).toContain("second checkpoint response");
        expect(loadedCurrent?.transcript).not.toContain("first checkpoint response");

        const historical = await listPastAgentSessions(process.cwd(), {
            agentSessionsDir: sessionsDir,
            parentSessionId: ownerSessionId,
            parentSessionFile: parent.getSessionFile(),
            parentSessionLeafId: firstMarker,
            activeBranchOnly: true,
        });
        expect(historical).toHaveLength(1);
        expect(historical[0]).toMatchObject({
            readOnlyReason: "continued on another branch",
        });
        const loadedHistorical = await loadAgentSessionTranscriptForItem(historical[0]!);
        expect(loadedHistorical?.transcript).toContain("first checkpoint response");
        expect(loadedHistorical?.transcript).not.toContain("second checkpoint response");
    });

    it("reports a selected checkpoint as unavailable when its leaf is missing", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-missing-leaf-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir }), "parent-1");
        fs.mkdirSync(parentDir, { recursive: true });
        const child = SessionManager.create(process.cwd(), parentDir);
        child.appendMessage({ role: "user", content: "available child transcript", timestamp: 1 });
        child.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "available response" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: 2,
        });
        const childFile = child.getSessionFile();
        expect(childFile).toBeDefined();
        await upsertAgentRunCatalogRecord({
            ownerSessionId: "parent-1",
            runId: "scout-1",
            runInstanceId: "instance-1",
            parentCwd: process.cwd(),
            title: "Missing leaf",
            agent: "scout",
            agentSource: "builtin",
            task: "Inspect",
            status: "interrupted",
            background: false,
            mutating: false,
            childSessionFile: childFile,
            childSessionLeafId: "missing-leaf",
            startedAt: 1,
            updatedAt: 1,
            usageSnapshot: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        }, path.join(stateDir, "workspaces"));

        const sessions = await listPastAgentSessions(process.cwd(), { agentSessionsDir: sessionsDir });
        expect(sessions[0]?.transcript).toBeUndefined();
        const loaded = await loadAgentSessionTranscriptForItem(sessions[0]!);
        expect(loaded?.transcript).toBe("Transcript unavailable for the selected child checkpoint.");
    });

    it("preserves commit ordering when snapshot, marker, or catalog writes fail", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-failures-"));
        tempDirs.push(stateDir);
        const database = await openAgentMetadataDatabase(path.join(stateDir, "workspaces"));
        const markers: unknown[] = [];
        const writer = createAgentRunStateWriter(
            process.cwd(),
            database,
            (marker) => {
                markers.push(marker);
                return `marker-${markers.length}`;
            },
        );
        const firstFailure = record("instance-snapshot-failure", "parent-1");
        database.exec(`
            CREATE TRIGGER fail_snapshot_insert
            BEFORE INSERT ON agent_run_snapshots
            BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END;
        `);
        expect(writer.save(firstFailure).ok).toBe(false);
        expect(markers).toHaveLength(0);
        expect((database.prepare("SELECT COUNT(*) AS count FROM agent_run_snapshots").get() as { count: number }).count).toBe(0);
        database.exec("DROP TRIGGER fail_snapshot_insert");

        database.exec(`
            CREATE TRIGGER fail_catalog_insert
            BEFORE INSERT ON agent_runs
            BEGIN SELECT RAISE(ABORT, 'catalog failure'); END;
        `);
        expect(writer.save(record("instance-catalog-failure", "parent-1"))).toMatchObject({ ok: true });
        expect(markers).toHaveLength(1);
        expect((database.prepare("SELECT COUNT(*) AS count FROM agent_run_snapshots").get() as { count: number }).count).toBe(1);
        expect((database.prepare("SELECT COUNT(*) AS count FROM agent_runs").get() as { count: number }).count).toBe(0);
        writer.close();

        const markerFailureDatabase = await openAgentMetadataDatabase(path.join(stateDir, "marker-state", "workspaces"));
        const markerFailureWriter = createAgentRunStateWriter(
            process.cwd(),
            markerFailureDatabase,
            () => { throw new Error("marker failure"); },
        );
        expect(markerFailureWriter.save(record("instance-marker-failure", "parent-1")).ok).toBe(false);
        expect((markerFailureDatabase.prepare("SELECT COUNT(*) AS count FROM agent_run_snapshots").get() as { count: number }).count).toBe(1);
        expect((markerFailureDatabase.prepare("SELECT COUNT(*) AS count FROM agent_runs").get() as { count: number }).count).toBe(0);
        markerFailureWriter.close();

        const optionalMarkerDatabase = await openAgentMetadataDatabase(path.join(stateDir, "optional-marker", "workspaces"));
        const optionalMarkerWriter = createAgentRunStateWriter(
            process.cwd(),
            optionalMarkerDatabase,
            () => undefined,
            { requireMarker: false },
        );
        expect(optionalMarkerWriter.save(record("instance-optional-marker", "parent-1"))).toMatchObject({ ok: true });
        optionalMarkerWriter.close();
    });

    it("keeps a committed snapshot when head projection commit fails after marker append", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-head-failure-"));
        tempDirs.push(stateDir);
        const database = await openAgentMetadataDatabase(path.join(stateDir, "workspaces"));
        database.exec(`
            CREATE TRIGGER fail_continuation_head_insert
            BEFORE INSERT ON agent_run_continuation_heads
            WHEN NEW.pending = 0
            BEGIN SELECT RAISE(ABORT, 'head projection failure'); END;
        `);
        const markers: unknown[] = [];
        const writer = createAgentRunStateWriter(
            process.cwd(),
            database,
            (marker) => {
                markers.push(marker);
                return `marker-${markers.length}`;
            },
        );

        expect(writer.save(record("instance-head-failure", "parent-1"))).toMatchObject({ ok: true });
        expect(markers).toHaveLength(1);
        expect((database.prepare("SELECT COUNT(*) AS count FROM agent_run_snapshots").get() as { count: number }).count).toBe(1);
        expect((database.prepare("SELECT COUNT(*) AS count FROM agent_run_continuation_heads WHERE pending = 1").get() as { count: number }).count).toBe(1);
        writer.close();
    });

    it("serializes continuation leases and rejects a stale writer after another process advances the head", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-contention-"));
        tempDirs.push(stateDir);
        const workspacesDir = path.join(stateDir, "workspaces");
        const databaseA = await openAgentMetadataDatabase(workspacesDir);
        const databaseB = await openAgentMetadataDatabase(workspacesDir);
        databaseA.prepare(`
            INSERT INTO agent_run_continuation_heads (
                run_instance_id, owner_session_id, run_id, snapshot_id, updated_at, created_sequence
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run("instance-contention", "parent-1", "scout-1", "old-snapshot", 1, 1);
        const markersA: unknown[] = [];
        const markersB: unknown[] = [];
        const initialHead = new Map([["instance-contention", "old-snapshot"]]);
        const writerA = createAgentRunStateWriter(process.cwd(), databaseA, (marker) => {
            markersA.push(marker);
            return `marker-${markersA.length}`;
        }, { initialHeads: initialHead });
        const writerB = createAgentRunStateWriter(process.cwd(), databaseB, (marker) => {
            markersB.push(marker);
            return `marker-${markersB.length}`;
        }, { initialHeads: initialHead });
        const releaseA = writerA.acquireContinuationLease?.("instance-contention");
        expect(() => writerB.acquireContinuationLease?.("instance-contention")).toThrow("already owned");
        expect(writerB.save({ ...record("instance-contention", "parent-1"), updatedAt: 2 })).toMatchObject({ ok: false });
        expect(markersB).toHaveLength(0);

        expect(writerA.save({ ...record("instance-contention", "parent-1"), updatedAt: 2 })).toMatchObject({ ok: true });
        releaseA?.release();
        expect((databaseA.prepare("SELECT COUNT(*) AS count FROM agent_run_continuation_leases").get() as { count: number }).count).toBe(0);
        expect(writerB.save({ ...record("instance-contention", "parent-1"), updatedAt: 3 })).toMatchObject({ ok: false });
        expect(markersA).toHaveLength(1);
        expect(markersB).toHaveLength(0);
        expect((databaseA.prepare("SELECT COUNT(*) AS count FROM agent_run_snapshots").get() as { count: number }).count).toBe(1);
        writerA.close();
        writerB.close();
    });

    it("reclaims an active lease when its recorded owner PID is dead", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-pid-recovery-"));
        tempDirs.push(stateDir);
        const workspacesDir = path.join(stateDir, "workspaces");
        const databaseA = await openAgentMetadataDatabase(workspacesDir);
        const databaseB = await openAgentMetadataDatabase(workspacesDir);
        databaseA.prepare(`
            INSERT INTO agent_run_continuation_heads (
                run_instance_id, owner_session_id, run_id, snapshot_id, updated_at, created_sequence
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run("instance-pid-recovery", "parent-1", "scout-1", "old-snapshot", 1, 1);
        const initialHead = new Map([["instance-pid-recovery", "old-snapshot"]]);
        const writerA = createAgentRunStateWriter(process.cwd(), databaseA, () => "marker-a", { initialHeads: initialHead });
        const writerB = createAgentRunStateWriter(process.cwd(), databaseB, () => "marker-b", { initialHeads: initialHead });
        const leaseA = writerA.acquireContinuationLease?.("instance-pid-recovery");
        databaseA.prepare(`
            UPDATE agent_run_continuation_leases SET owner_pid = ? WHERE run_instance_id = ?
        `).run(424242, "instance-pid-recovery");

        const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
            if (pid === 424242) throw Object.assign(new Error("process missing"), { code: "ESRCH" });
        }) as typeof process.kill);
        try {
            const leaseB = writerB.acquireContinuationLease?.("instance-pid-recovery");
            expect(leaseB).toBeDefined();
            leaseB?.release();
        } finally {
            kill.mockRestore();
            leaseA?.release();
            writerA.close();
            writerB.close();
        }
    });

    it("reports lease loss when renewal can no longer update the database", async () => {
        vi.useFakeTimers();
        try {
            const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-lease-loss-"));
            tempDirs.push(stateDir);
            const database = await openAgentMetadataDatabase(path.join(stateDir, "workspaces"));
            let lost = 0;
            const writer = createAgentRunStateWriter(
                process.cwd(),
                database,
                () => "marker-1",
            );
            const lease = writer.acquireContinuationLease?.("instance-lease-loss", () => { lost++; });

            database.prepare("DELETE FROM agent_run_continuation_leases WHERE run_instance_id = ?")
                .run("instance-lease-loss");
            await vi.advanceTimersByTimeAsync(10_000);

            expect(lost).toBe(1);
            expect(() => writer.acquireContinuationLease?.("instance-lease-loss"))
                .toThrow("lease was lost");
            lease?.release();
            writer.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects a V2 checkpoint when the parent marker append is unavailable", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-no-marker-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const context = {
            cwd: process.cwd(),
            ui: { notify: vi.fn() },
            sessionManager: {
                getSessionFile: () => "/parent.jsonl",
                getSessionId: () => "parent-1",
                getEntries: () => [],
                getBranch: () => [],
                getLeafId: () => null,
            },
        } as any;
        const loaded = await loadAgentRunPersistence(context, sessionsDir);
        expect(loaded?.persistence.save(record("instance-no-marker", "parent-1"))).toBe(false);
        loaded?.persistence.close?.();
    });

    it("reports a marker that references a missing snapshot without restoring it", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-missing-snapshot-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir }), "parent-1");
        fs.mkdirSync(parentDir, { recursive: true });
        const parent = SessionManager.create(process.cwd(), parentDir);
        parent.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "parent checkpoint" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: 1,
        });
        const context = {
            cwd: process.cwd(),
            ui: { notify: vi.fn() },
            sessionManager: parent,
        } as any;
        const loaded = await loadAgentRunPersistence(context, sessionsDir);
        expect(loaded).toBeDefined();
        parent.appendCustomEntry(AGENT_RUN_SNAPSHOT_MARKER, {
            version: 2,
            snapshotId: "missing-snapshot",
            runInstanceId: "missing-instance",
            runId: "scout-1",
        });

        const restored = await loadAgentRunPersistence(context, sessionsDir);
        expect(restored?.records).toHaveLength(0);
        expect(restored?.diagnostics).toContain(
            "Could not restore scout-1: parent marker references a missing SQLite snapshot.",
        );
        loaded?.persistence.close?.();
        restored?.persistence.close?.();
    });

    it("selects the persisted child leaf rather than the latest physical leaf", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-leaf-"));
        tempDirs.push(directory);
        const child = SessionManager.create(process.cwd(), directory);
        const first = child.appendMessage({ role: "user", content: "first", timestamp: 1 });
        const second = child.appendMessage({ role: "assistant", content: [{ type: "text", text: "second" }], api: "test", provider: "test", model: "test", usage: ZERO_USAGE, stopReason: "stop", timestamp: 2 });
        expect(second).not.toBe(first);
        selectChildSessionLeaf(child, first);
        expect(child.getLeafId()).toBe(first);
        expect(child.getBranch().at(-1)?.id).toBe(first);
        expect(() => selectChildSessionLeaf(child, "missing-leaf")).toThrow(/missing/);
        expect(() => selectChildSessionLeaf(child, null)).not.toThrow();
        expect(child.getLeafId()).toBeNull();
    });
});
