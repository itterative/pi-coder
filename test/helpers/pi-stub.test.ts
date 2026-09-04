import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { zeroUsage } from "./agent-doubles";
import { createPiStub, stubContext, stubSessionManager, stubUi } from "./pi-stub";

/**
 * These cover the doubles' *ordering* and *presence* contracts — the two things that fail silently.
 * Wiring (that one field copies another) is deliberately not asserted.
 */

function toolDefinition(name: string): ToolDefinition {
    return {
        name,
        label: name.toUpperCase(),
        description: `${name} description`,
        parameters: {},
        execute: async (toolCallId: string) => ({
            content: [{ type: "text", text: `${name}:${toolCallId}` }],
            details: undefined,
        }),
    } as unknown as ToolDefinition;
}

describe("createPiStub", () => {
    it("logs registration order across members and keeps handlers per event", () => {
        const stub = createPiStub();
        const first = vi.fn(() => ({ block: false }));
        const second = vi.fn(() => ({ block: true, reason: "no" }));

        stub.pi.on("tool_call", first as never);
        stub.pi.registerTool(toolDefinition("agent"));
        stub.pi.on("tool_call", second as never);
        stub.pi.registerCommand("agents", { description: "Browse", handler: async () => {} });

        // Handler order is permission precedence in child/gates/, so the double must preserve it.
        expect(stub.order).toEqual([
            "on:tool_call",
            "tool:agent",
            "on:tool_call",
            "command:agents",
        ]);
        const handlers = stub.handlersFor("tool_call");
        expect(handlers[0]({ toolName: "bash" }, {})).toEqual({ block: false });
        expect(handlers[1]({ toolName: "bash" }, {})).toEqual({ block: true, reason: "no" });
        expect(stub.handlersFor("session_start")).toEqual([]);
        expect(() => stub.requireTool("missing")).toThrow(/saw: agent/);
    });

    it("leaves unmodelled members absent, because production feature-detects them", () => {
        const stub = createPiStub();

        // `src/tools/agent/index.ts` does `pi.registerShortcut?.(...)`, and persistence decides whether
        // a session has an entry index with `typeof sessionManager.getEntries === "function"`. A
        // placeholder function here would satisfy both and change which code a test exercises.
        expect(stub.pi.setModel).toBeUndefined();
        expect(typeof stub.pi.registerShortcut).toBe("function");
        // The opt-out has to be *absence*, not a falsy value: `pi.events?.on(...)` must skip.
        expect(createPiStub({ eventBus: null }).pi.events).toBeUndefined();
    });

    it("lets a test assign real behavior over a recorder", () => {
        const store: unknown[] = [];
        const stub = createPiStub();

        stub.pi.appendEntry = (customType: string, data?: unknown) => {
            store.push({ customType, data });
        };
        stub.pi.appendEntry("pi-agent/refused-command", { command: "ls" });

        expect(store).toEqual([
            { customType: "pi-agent/refused-command", data: { command: "ls" } },
        ]);
        expect(stub.entries).toEqual([]);
    });
});

describe("stubContext", () => {
    it("supplies pi's required members so production can read them directly", () => {
        const ctx = stubContext();

        expect(ctx.cwd).toBe("/tmp/project");
        expect(ctx.mode).toBe("print");
        expect(ctx.isProjectTrusted()).toBe(false);
        ctx.ui.notify("hi", "info");
    });

    it("keeps a partial session manager faithful about what it does not model", () => {
        const entries = [{ id: "entry-1" }];
        const ctx = stubContext({
            sessionManager: stubSessionManager({
                getBranch: () => entries as never,
                getLeafId: () => entries.at(-1)?.id ?? null,
            }),
        });

        expect(ctx.sessionManager.getLeafId()).toBe("entry-1");
        // Absent, not callable: this is how `loadAgentRunPersistence` picks its marker-collection path.
        expect(ctx.sessionManager.getEntries).toBeUndefined();
    });

    it("accepts a real session manager and an observing ui", () => {
        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stub-context-"));
        const sessionManager = SessionManager.create("/tmp/project", sessionDir);
        const notify = vi.fn();
        const ctx = stubContext({
            cwd: "/repo",
            ui: stubUi({ notify }),
            sessionManager,
        });

        expect(ctx.cwd).toBe("/repo");
        expect(ctx.sessionManager.getSessionId()).toBe(sessionManager.getSessionId());
        ctx.ui.notify("done", "info");
        expect(notify).toHaveBeenCalledWith("done", "info");
    });
});

describe("zeroUsage", () => {
    it("keeps nested cost independent between frames", () => {
        const first = zeroUsage();
        first.cost.total = 5;

        // A shared `cost` object would let one test's mutation leak into another's assertion.
        expect(zeroUsage().cost.total).toBe(0);
    });
});
