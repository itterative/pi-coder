import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
    countParentPrompts,
    materializePersistentSession,
    repairInterruptedToolCalls,
} from "../../src/tools/agent/child";
import { ZERO_USAGE } from "../../src/tools/agent/runs/manager";

const tempDirs: string[] = [];
afterEach(() => {
    for (const directory of tempDirs.splice(0))
        fs.rmSync(directory, { recursive: true, force: true });
});

describe("persistent child transcript repair", () => {
    it("materializes a durable child session header immediately", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-session-"));
        tempDirs.push(directory);
        const session = materializePersistentSession(
            SessionManager.create(process.cwd(), directory),
            directory,
            process.cwd(),
        );
        const file = session.getSessionFile();
        expect(file).toBeDefined();
        expect(fs.statSync(file!).isFile()).toBe(true);
        expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
        expect(session.getHeader()?.cwd).toBe(process.cwd());
    });
    it("adds uncertain error results only for unmatched tool calls", () => {
        const sessionManager = SessionManager.inMemory(process.cwd());
        sessionManager.appendMessage({
            role: "assistant",
            content: [
                { type: "toolCall", id: "matched", name: "read", arguments: { path: "a.ts" } },
                { type: "toolCall", id: "unmatched", name: "edit", arguments: { path: "b.ts" } },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
            stopReason: "toolUse",
            timestamp: Date.now(),
        });
        sessionManager.appendMessage({
            role: "toolResult",
            toolCallId: "matched",
            toolName: "read",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: Date.now(),
        });

        expect(repairInterruptedToolCalls(sessionManager)).toBe(1);
        const messages = sessionManager.buildSessionContext().messages;
        const repaired = messages.at(-1);
        expect(repaired).toMatchObject({
            role: "toolResult",
            toolCallId: "unmatched",
            toolName: "edit",
            isError: true,
        });
        expect(JSON.stringify(repaired)).toContain("outcome is uncertain");
        expect(repairInterruptedToolCalls(sessionManager)).toBe(0);
    });
});

describe("child parent-prompt counting", () => {
    it("counts user messages on the exact selected branch", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-prompts-"));
        tempDirs.push(directory);
        const session = materializePersistentSession(
            SessionManager.create(process.cwd(), directory),
            directory,
            process.cwd(),
        );
        session.appendMessage({ role: "user", content: "First task", timestamp: 1 });
        const firstLeaf = session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "Working" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
            stopReason: "stop",
            timestamp: 2,
        });
        session.appendMessage({ role: "user", content: "Second task", timestamp: 3 });
        const secondLeaf = session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
            stopReason: "stop",
            timestamp: 4,
        });
        const file = session.getSessionFile()!;

        expect(countParentPrompts(file, secondLeaf)).toBe(2);
        expect(countParentPrompts(file, firstLeaf)).toBe(1);
    });

    it("returns undefined for a missing transcript or leaf", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-prompts-"));
        tempDirs.push(directory);
        const session = materializePersistentSession(
            SessionManager.create(process.cwd(), directory),
            directory,
            process.cwd(),
        );
        const file = session.getSessionFile()!;

        expect(countParentPrompts(file, "missing-leaf")).toBeUndefined();
        expect(countParentPrompts(path.join(directory, "missing.jsonl"), null)).toBeUndefined();
    });
});
