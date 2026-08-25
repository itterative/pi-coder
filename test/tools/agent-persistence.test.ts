import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { fingerprintAgentDefinition, BUILTIN_SCOUT } from "../../src/tools/agent/definitions/discovery";
import {
    getAgentCwdSessionDir,
    loadAgentRunPersistence,
    normalizeCwdForSessionDirectory,
} from "../../src/tools/agent/runs/persistence";
import { ZERO_USAGE, type PersistedAgentRun } from "../../src/tools/agent/runs/manager";
import {
    listAgentRunCatalog,
    upsertAgentRunCatalogRecord,
} from "../../src/tools/agent/storage/run-catalog";
import { openAgentMetadataDatabase } from "../../src/tools/agent/storage/metadata";
import { upsertAgentRunStateInDatabase } from "../../src/tools/agent/storage/run-state";
import { listPastAgentSessions } from "../../src/tools/agent/presentation/sessions";

const tempDirs: string[] = [];
afterEach(() => {
    for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function record(ownerSessionId: string, childSessionFile?: string): PersistedAgentRun {
    return {
        version: 1,
        ownerSessionId,
        runId: "scout-1",
        title: "Persistence scan",
        agent: "scout",
        agentSource: "builtin",
        definitionFingerprint: fingerprintAgentDefinition(BUILTIN_SCOUT),
        task: "Inspect",
        status: "waiting_for_parent",
        background: true,
        mutating: false,
        question: { question: "Continue?" },
        progress: { output: "Partial", recentActivity: ["Reading src/index.ts"] },
        usageCheckpoint: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        usageSnapshot: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        startedAt: 1,
        updatedAt: 2,
        childSessionFile,
    };
}

async function seedState(
    state: PersistedAgentRun,
    branchEntryId: string,
    workspacesDir: string,
): Promise<void> {
    const database = await openAgentMetadataDatabase(workspacesDir);
    try {
        upsertAgentRunStateInDatabase(database, state, branchEntryId);
    } finally {
        database.close();
    }
}

function context(entries: any[], sessionFile: string | undefined, ownerSessionId = "parent-1") {
    return {
        cwd: process.cwd(),
        ui: { notify: vi.fn() },
        sessionManager: {
            getSessionFile: () => sessionFile,
            getSessionId: () => ownerSessionId,
            getLeafId: () => entries.at(-1)?.id ?? null,
            getBranch: () => entries,
        },
    } as any;
}

describe("durable agent run persistence", () => {
    it("lists persisted child transcripts across parent-session directories", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-persistence-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), sessionsDir), "parent-1");
        fs.mkdirSync(parentDir, { recursive: true });
        const child = SessionManager.create(process.cwd(), parentDir);
        child.appendMessage({
            role: "user",
            content: [{ type: "text", text: "Review the persisted child session" }],
            timestamp: Date.now(),
        });
        child.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "I will review it." }],
            api: "test",
            provider: "test",
            model: "test",
            usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
            stopReason: "stop",
            timestamp: Date.now(),
        });
        expect(child.getSessionFile()).toBeDefined();
        await upsertAgentRunCatalogRecord({
            ownerSessionId: "parent-1",
            runId: "scout-1",
            parentCwd: process.cwd(),
            title: "Persisted child",
            agent: "scout",
            agentSource: "builtin",
            task: "Review the persisted child session",
            status: "running",
            background: false,
            mutating: false,
            childSessionFile: child.getSessionFile()!,
            startedAt: 1,
            updatedAt: 2,
            usageSnapshot: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        }, path.join(stateDir, "workspaces"));
        expect(fs.readdirSync(parentDir)).not.toHaveLength(0);

        const sessions = await listPastAgentSessions(process.cwd(), sessionsDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
            kind: "past",
            parentSessionId: "parent-1",
            firstMessage: "Review the persisted child session",
            messageCount: 2,
            status: "interrupted",
        });
        expect(sessions[0]?.transcript).toContain("> Review the persisted child session");
        expect(sessions[0]?.transcript).toContain("I will review it.");
    });

    it("normalizes cwd paths with the pi session-directory format", () => {
        expect(normalizeCwdForSessionDirectory("/home/example/project")).toBe("--home-example-project--");
    });

    it("is disabled for an ephemeral parent session", async () => {
        expect(await loadAgentRunPersistence(context([], undefined))).toBeUndefined();
    });

    it("restores the latest valid state on the active parent branch", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-persistence-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const workspacesDir = path.join(stateDir, "workspaces");
        const childDir = path.join(getAgentCwdSessionDir(process.cwd(), sessionsDir), "parent-1");
        fs.mkdirSync(childDir, { recursive: true });
        const childFile = path.join(childDir, "child.jsonl");
        fs.writeFileSync(childFile, "{}\n");
        const older = record("parent-1", childFile);
        const newer = { ...record("parent-1", childFile), status: "interrupted" as const, updatedAt: 3 };
        const foreign = { ...record("other-parent", childFile), updatedAt: 4 };
        await seedState(older, "entry-1", workspacesDir);
        await seedState(newer, "entry-2", workspacesDir);
        await seedState(foreign, "entry-2", workspacesDir);
        const entries = [{ id: "entry-1" }, { id: "entry-2" }];
        const loaded = await loadAgentRunPersistence(
            context(entries, "/parent.jsonl"),
            sessionsDir,
        );

        expect(loaded?.persistence.childSessionDir).toBe(childDir);
        expect(path.basename(path.dirname(childDir))).toBe(normalizeCwdForSessionDirectory(process.cwd()));
        expect(loaded?.records).toHaveLength(1);
        expect(loaded?.records[0]).toMatchObject({ status: "interrupted", childSessionFile: childFile });
        expect(fs.statSync(childDir).mode & 0o777).toBe(0o700);
        loaded?.persistence.save(newer);
        await loaded?.persistence.flush?.();
        expect(await listAgentRunCatalog(process.cwd(), workspacesDir)).toMatchObject([{
            ownerSessionId: "parent-1",
            runId: "scout-1",
            title: "Persistence scan",
            status: "interrupted",
            responsePreview: "Partial",
        }]);
    });

    it("saves synchronously, rejects closed storage, and preserves newer snapshots", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-persistence-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const parentContext = context([{ id: "entry-1" }], "/parent.jsonl");
        const loaded = await loadAgentRunPersistence(parentContext, sessionsDir);
        const older = record("parent-1");
        const newer = { ...older, status: "interrupted" as const, updatedAt: 3 };

        expect(loaded?.persistence.save(newer)).toBe(true);
        expect(loaded?.persistence.save(older)).toBe(true);
        const restored = await loadAgentRunPersistence(
            context([{ id: "entry-1" }], "/parent.jsonl"),
            sessionsDir,
        );
        expect(restored?.records[0]).toMatchObject({ status: "interrupted", updatedAt: 3 });

        loaded?.persistence.close?.();
        expect(loaded?.persistence.save(newer)).toBe(false);
        expect(parentContext.ui.notify).toHaveBeenCalledOnce();
        restored?.persistence.close?.();
    });

    it("rejects transcript paths outside the private child directory", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-persistence-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const workspacesDir = path.join(stateDir, "workspaces");
        const outside = path.join(stateDir, "outside.jsonl");
        fs.writeFileSync(outside, "{}\n");
        await seedState(record("parent-1", outside), "entry-1", workspacesDir);
        const loaded = await loadAgentRunPersistence(
            context([{ id: "entry-1" }], "/parent.jsonl"),
            sessionsDir,
        );

        expect(loaded?.records[0]?.childSessionFile).toBeUndefined();
        loaded?.persistence.deleteChildSession(outside);
        expect(fs.existsSync(outside)).toBe(true);
    });
});
