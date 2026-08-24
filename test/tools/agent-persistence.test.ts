import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { fingerprintAgentDefinition, BUILTIN_SCOUT } from "../../src/tools/agent/discovery";
import {
    AGENT_RUN_STATE_ENTRY,
    getAgentCwdSessionDir,
    readAgentSessionMetadata,
    loadAgentRunPersistence,
    normalizeCwdForSessionDirectory,
} from "../../src/tools/agent/persistence";
import { ZERO_USAGE, type PersistedAgentRun } from "../../src/tools/agent/runtime";
import { listPastAgentSessions } from "../../src/tools/agent/sessions";

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

function context(entries: any[], sessionFile: string | undefined, ownerSessionId = "parent-1") {
    return {
        cwd: process.cwd(),
        sessionManager: {
            getSessionFile: () => sessionFile,
            getSessionId: () => ownerSessionId,
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
        fs.writeFileSync(`${child.getSessionFile()}.meta.json`, JSON.stringify({
            version: 1,
            ownerSessionId: "parent-1",
            runId: "scout-1",
            title: "Persisted child",
            agent: "scout",
            task: "Review the persisted child session",
            status: "running",
            startedAt: 1,
            updatedAt: 2,
        }));
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
    });

    it("normalizes cwd paths with the pi session-directory format", () => {
        expect(normalizeCwdForSessionDirectory("/home/example/project")).toBe("--home-example-project--");
    });

    it("is disabled for an ephemeral parent session", () => {
        const pi = { appendEntry() { throw new Error("unexpected"); } } as any;
        expect(loadAgentRunPersistence(pi, context([], undefined))).toBeUndefined();
    });

    it("restores only the latest valid state owned by the exact parent session", () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-persistence-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const childDir = path.join(getAgentCwdSessionDir(process.cwd(), sessionsDir), "parent-1");
        fs.mkdirSync(childDir, { recursive: true });
        const childFile = path.join(childDir, "child.jsonl");
        fs.writeFileSync(childFile, "{}\n");
        const older = record("parent-1", childFile);
        const newer = { ...record("parent-1", childFile), status: "interrupted" as const, updatedAt: 3 };
        const foreign = { ...record("other-parent", childFile), updatedAt: 4 };
        const entries = [older, foreign, newer].map((data) => ({
            type: "custom",
            customType: AGENT_RUN_STATE_ENTRY,
            data,
        }));
        const appended: unknown[] = [];
        const loaded = loadAgentRunPersistence(
            { appendEntry: (_type: string, data: unknown) => appended.push(data) } as any,
            context(entries, "/parent.jsonl"),
            sessionsDir,
        );

        expect(loaded?.persistence.childSessionDir).toBe(childDir);
        expect(path.basename(path.dirname(childDir))).toBe(normalizeCwdForSessionDirectory(process.cwd()));
        expect(loaded?.records).toHaveLength(1);
        expect(loaded?.records[0]).toMatchObject({ status: "interrupted", childSessionFile: childFile });
        expect(fs.statSync(childDir).mode & 0o777).toBe(0o700);
        loaded?.persistence.save(newer);
        expect(appended).toEqual([newer]);
        expect(readAgentSessionMetadata(childFile)).toMatchObject({
            ownerSessionId: "parent-1",
            runId: "scout-1",
            title: "Persistence scan",
            status: "interrupted",
            responsePreview: "Partial",
        });
    });

    it("rejects transcript paths outside the private child directory", () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-persistence-"));
        tempDirs.push(stateDir);
        const sessionsDir = path.join(stateDir, "agent-sessions");
        const outside = path.join(stateDir, "outside.jsonl");
        fs.writeFileSync(outside, "{}\n");
        const entries = [{
            type: "custom",
            customType: AGENT_RUN_STATE_ENTRY,
            data: record("parent-1", outside),
        }];
        const loaded = loadAgentRunPersistence(
            { appendEntry() {} } as any,
            context(entries, "/parent.jsonl"),
            sessionsDir,
        );

        expect(loaded?.records[0]?.childSessionFile).toBeUndefined();
        loaded?.persistence.deleteChildSession(outside);
        expect(fs.existsSync(outside)).toBe(true);
    });
});
