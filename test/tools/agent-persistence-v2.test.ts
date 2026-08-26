import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { BUILTIN_SCOUT, fingerprintAgentDefinition } from "../../src/tools/agent/definitions/discovery";
import { selectChildSessionLeaf } from "../../src/tools/agent/child";
import { getAgentCwdSessionDir, loadAgentRunPersistence } from "../../src/tools/agent/runs/persistence";
import { ZERO_USAGE, type PersistedAgentRun } from "../../src/tools/agent/runs/manager";
import { AGENT_RUN_SNAPSHOT_MARKER } from "../../src/tools/agent/storage/run-markers";
import { openAgentMetadataDatabase } from "../../src/tools/agent/storage/metadata";
import { upsertAgentRunCatalogRecord } from "../../src/tools/agent/storage/run-catalog";
import { listPastAgentSessions } from "../../src/tools/agent/presentation/sessions";

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
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), sessionsDir), "parent-1");
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

    it("restores V2 branch checkpoints and browses their exact child leaves", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-browser-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), sessionsDir), "parent-1");
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
        const childDir = path.join(getAgentCwdSessionDir(process.cwd(), sessionsDir), parent.getSessionId());
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

        const current = await listPastAgentSessions(process.cwd(), sessionsDir, {
            parentSessionId: ownerSessionId,
            parentSessionFile: parent.getSessionFile(),
            parentSessionLeafId: secondMarker,
            activeBranchOnly: true,
        });
        expect(current).toHaveLength(1);
        expect(current[0]).toMatchObject({
            transcript: expect.stringContaining("second checkpoint response"),
        });
        expect(current[0]?.transcript).not.toContain("first checkpoint response");

        const historical = await listPastAgentSessions(process.cwd(), sessionsDir, {
            parentSessionId: ownerSessionId,
            parentSessionFile: parent.getSessionFile(),
            parentSessionLeafId: firstMarker,
            activeBranchOnly: true,
        });
        expect(historical).toHaveLength(1);
        expect(historical[0]).toMatchObject({
            transcript: expect.stringContaining("first checkpoint response"),
            readOnlyReason: "continued on another branch",
        });
        expect(historical[0]?.transcript).not.toContain("second checkpoint response");
    });

    it("reports a selected checkpoint as unavailable when its leaf is missing", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-v2-missing-leaf-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), sessionsDir), "parent-1");
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

        const sessions = await listPastAgentSessions(process.cwd(), sessionsDir);
        expect(sessions[0]?.transcript).toBe("Transcript unavailable for the selected child checkpoint.");
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
