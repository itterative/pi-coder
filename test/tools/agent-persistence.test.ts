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
import {
    listAgentPastSessionLists,
    listPastAgentSessions,
    loadAgentSessionTranscriptForItem,
    loadAgentSessionTranscripts,
} from "../../src/tools/agent/presentation/sessions";

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
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir }), "parent-1");
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

        const sessions = await listPastAgentSessions(process.cwd(), { agentSessionsDir: sessionsDir });
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
            kind: "past",
            parentSessionId: "parent-1",
            title: "Persisted child",
            status: "interrupted",
        });
        expect(sessions[0]?.transcript).toContain("Transcript unavailable: no exact child transcript leaf is recorded.");
        // The row comes from the catalog: transcript and message count are
        // loaded lazily, not prebuilt during enumeration.
        expect(sessions[0]?.messageCount).toBeUndefined();
    });

    it("enumerates catalog rows without transcript scans and loads them lazily", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-persistence-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const parentDir = path.join(getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir }), "parent-1");
        fs.mkdirSync(parentDir, { recursive: true });
        const child = SessionManager.create(process.cwd(), parentDir);
        child.appendMessage({
            role: "user",
            content: [{ type: "text", text: "Catalog-backed task" }],
            timestamp: 1,
        });
        const leaf = child.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "Catalog-backed response" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
            stopReason: "stop",
            timestamp: 2,
        });
        const childFile = child.getSessionFile()!;
        await upsertAgentRunCatalogRecord({
            ownerSessionId: "parent-1",
            runId: "scout-2",
            parentCwd: process.cwd(),
            title: "Catalog run",
            agent: "scout",
            agentSource: "builtin",
            task: "Inspect the catalog-backed run",
            status: "removed",
            terminalStatus: "completed",
            background: false,
            mutating: false,
            childSessionFile: childFile,
            childSessionLeafId: leaf,
            startedAt: 1,
            updatedAt: 3,
            usageSnapshot: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        }, path.join(stateDir, "workspaces"));

        const lists = await listAgentPastSessionLists(process.cwd(), { agentSessionsDir: sessionsDir });
        expect(lists.all).toHaveLength(1);
        expect(lists.all[0]).toMatchObject({
            kind: "past",
            id: "scout-2",
            title: "Catalog run",
            task: "Inspect the catalog-backed run",
            parentSessionId: "parent-1",
            sessionFile: childFile,
            childSessionLeafId: leaf,
            status: "completed",
        });
        // Enumeration stays a single catalog query: no transcript text or
        // message count is prebuilt for the row.
        expect(lists.all[0]?.transcript).toBeUndefined();
        expect(lists.all[0]?.messageCount).toBeUndefined();

        const loaded = await loadAgentSessionTranscriptForItem(lists.all[0]!);
        expect(loaded?.transcript).toContain("Catalog-backed response");
        expect(loaded?.messageCount).toBe(2);
        expect(await loadAgentSessionTranscriptForItem(loaded!)).toBe(loaded);
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
        const childDir = path.join(getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir }), "parent-1");
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

    it("enumerates past sessions once and derives scoped and active-branch views", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-persistence-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const cwdSessionDir = getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir });
        for (const [parent, timestamp] of [["parent-1", 1000], ["parent-2", 2000]] as const) {
            const directory = path.join(cwdSessionDir, parent);
            fs.mkdirSync(directory, { recursive: true });
            const child = SessionManager.create(process.cwd(), directory);
            child.appendMessage({
                role: "user",
                content: `Task for ${parent}`,
                timestamp,
            });
            // Session files are not written until the first assistant message.
            child.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: `Response for ${parent}` }],
                api: "test",
                provider: "test",
                model: "test",
                usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
                stopReason: "stop",
                timestamp: timestamp + 1,
            });
        }

        const lists = await listAgentPastSessionLists(process.cwd(), { agentSessionsDir: sessionsDir });

        expect(lists.all.map((item) => item.parentSessionId)).toEqual(["parent-2", "parent-1"]);
        expect(lists.all.map((item) => item.firstMessage)).toEqual(["Task for parent-2", "Task for parent-1"]);
        expect(lists.activeBranch).toHaveLength(0);

        const scoped = lists.all.filter((item) => item.parentSessionId === "parent-1");
        expect(scoped).toHaveLength(1);
        expect(await listPastAgentSessions(process.cwd(), {
            agentSessionsDir: sessionsDir,
            parentSessionId: "parent-1",
        })).toEqual(scoped);
        expect(await listPastAgentSessions(process.cwd(), { agentSessionsDir: sessionsDir })).toEqual(lists.all);
    });

    it("falls back to the latest catalog leaf for visual transcript loading", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-persistence-leaf-fallback-"));
        tempDirs.push(stateDir);
        const child = SessionManager.create(process.cwd(), stateDir);
        child.appendMessage({ role: "user", content: "Review the changes", timestamp: 1 });
        child.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "Latest review response" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
            stopReason: "stop",
            timestamp: 2,
        });
        const latestLeaf = child.getLeafId();
        expect(latestLeaf).toBeDefined();

        const loaded = await loadAgentSessionTranscriptForItem({
            kind: "past",
            id: "reviewer-1",
            title: "Review",
            agent: "reviewer",
            status: "completed",
            task: "Review the changes",
            updatedAt: 2,
            sessionFile: child.getSessionFile(),
            childSessionLeafId: "historical-leaf-no-longer-present",
            fallbackChildSessionLeafId: latestLeaf,
        });

        expect(loaded?.transcript).toContain("Latest review response");
        expect(loaded?.messageCount).toBe(2);
    });

    it("loads current-run transcripts without scanning sibling sessions", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-persistence-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const directory = path.join(getAgentCwdSessionDir(process.cwd(), { agentSessionsDir: sessionsDir }), "parent-1");
        fs.mkdirSync(directory, { recursive: true });
        const child = SessionManager.create(process.cwd(), directory);
        child.appendMessage({ role: "user", content: "Live run task", timestamp: 1 });
        child.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "Live run response" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
            stopReason: "stop",
            timestamp: 2,
        });
        const leafId = child.getLeafId();
        expect(leafId).toBeDefined();
        const sessionFile = child.getSessionFile()!;
        // A sibling transcript shares the directory; loading the live run must
        // not depend on scanning it.
        const sibling = SessionManager.create(process.cwd(), directory);
        sibling.appendMessage({ role: "user", content: "Sibling task", timestamp: 3 });
        sibling.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "Sibling response" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
            stopReason: "stop",
            timestamp: 4,
        });

        const loaded = await loadAgentSessionTranscripts([
            {
                kind: "current",
                id: "run-1",
                title: "Live",
                agent: "scout",
                status: "running",
                task: "Live run task",
                updatedAt: 2,
                sessionFile,
                childSessionLeafId: leafId,
            },
            {
                kind: "current",
                id: "run-missing",
                title: "Missing",
                agent: "scout",
                status: "interrupted",
                task: "Missing file",
                updatedAt: 2,
                sessionFile: path.join(directory, "missing.jsonl"),
                childSessionLeafId: leafId,
            },
            {
                kind: "current",
                id: "run-no-leaf",
                title: "No leaf",
                agent: "scout",
                status: "interrupted",
                task: "No leaf",
                updatedAt: 2,
                sessionFile,
            },
        ]);

        expect(loaded[0]?.transcript).toContain("Live run response");
        expect(loaded[0]?.transcriptCollapsed).toBeDefined();
        expect(loaded[1]?.transcript).toBeUndefined();
        expect(loaded[2]?.transcript).toContain("Transcript unavailable: no exact child transcript leaf is recorded.");
    });
});
