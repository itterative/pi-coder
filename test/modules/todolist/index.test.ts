import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import registerTodoListExtension from "../../../src/modules/todolist";
import registerScratchpadExtension, { getScratchpadPath } from "../../../src/modules/scratchpad";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const temporaryDirectories: string[] = [];


afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function harness(): {
    pi: ExtensionAPI;
    handler(name: string): Handler;
} {
    const handlers = new Map<string, Handler[]>();
    const pi = {
        on(name: string, callback: Handler) {
            const registered = handlers.get(name) ?? [];
            registered.push(callback);
            handlers.set(name, registered);
        },
    } as unknown as ExtensionAPI;

    return {
        pi,
        handler(name) {
            const registered = handlers.get(name);
            if (!registered?.length) throw new Error(`Missing handler: ${name}`);
            return async (event: unknown, ctx: ExtensionContext) => {
                let result: unknown;
                for (const callback of registered) {
                    result = await callback(event, ctx);
                    if ((result as { block?: boolean } | undefined)?.block) return result;
                }
                return result;
            };
        },
    };
}

function runtimeContext(sessionManager: object): ExtensionContext {
    return {
        cwd: process.cwd(),
        sessionManager,
    } as ExtensionContext;
}

const validDocument = `---
version: 1
todos:
  - id: inspect
    title: Inspect the implementation
    status: pending
---

# Notes
`;

describe("TODO runtime extension", () => {
    it("adds the prompt and validates writes to the runtime TODO path", async () => {
        const { pi, handler } = harness();
        const sessionManager = {};
        const ctx = runtimeContext(sessionManager);
        registerScratchpadExtension(pi);
        registerTodoListExtension(pi);
        await handler("session_start")({ reason: "startup" }, ctx);

        const scratchpadPath = getScratchpadPath(sessionManager)!;
        temporaryDirectories.push(scratchpadPath);
        const todoPath = path.join(scratchpadPath, "TODO.md");

        const prompt = await handler("before_agent_start")({
            systemPrompt: "<project_context>\nProject\n</project_context>",
        }, ctx) as { systemPrompt: string };
        expect(prompt.systemPrompt).toContain("<todolist_system>");
        expect(prompt.systemPrompt).toContain(todoPath);

        await expect(handler("tool_call")({
            toolName: "write",
            input: { path: todoPath, content: validDocument },
        }, ctx)).resolves.toEqual({ block: false });

        await expect(handler("tool_call")({
            toolName: "write",
            input: { path: todoPath, content: "---\nversion: 1\ntodos: nope\n---\n" },
        }, ctx)).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("todos"),
        });
    });

    it("validates prospective edits but ignores unrelated TODO.md files", async () => {
        const { pi, handler } = harness();
        const sessionManager = {};
        const ctx = runtimeContext(sessionManager);
        registerScratchpadExtension(pi);
        registerTodoListExtension(pi);
        await handler("session_start")({ reason: "startup" }, ctx);

        const scratchpadPath = getScratchpadPath(sessionManager)!;
        temporaryDirectories.push(scratchpadPath);
        const todoPath = path.join(scratchpadPath, "TODO.md");
        fs.writeFileSync(todoPath, validDocument);

        await expect(handler("tool_call")({
            toolName: "edit",
            input: {
                path: todoPath,
                edits: [{ oldText: "# Notes", newText: "# Updated notes" }],
            },
        }, ctx)).resolves.toEqual({ block: false });

        await expect(handler("tool_call")({
            toolName: "edit",
            input: {
                path: todoPath,
                edits: [{ oldText: "status: pending", newText: "status: invalid" }],
            },
        }, ctx)).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("status"),
        });

        await expect(handler("tool_call")({
            toolName: "write",
            input: { path: path.join(process.cwd(), "TODO.md"), content: "not managed here" },
        }, ctx)).resolves.toEqual({ block: false });
    });

    it("rejects a symlink at the managed TODO path", async () => {
        const { pi, handler } = harness();
        const sessionManager = {};
        const ctx = runtimeContext(sessionManager);
        registerScratchpadExtension(pi);
        registerTodoListExtension(pi);
        await handler("session_start")({ reason: "startup" }, ctx);

        const scratchpadPath = getScratchpadPath(sessionManager)!;
        temporaryDirectories.push(scratchpadPath);
        const todoPath = path.join(scratchpadPath, "TODO.md");
        const outsidePath = path.join(os.tmpdir(), `pi-coder-todo-outside-${Date.now()}.md`);
        fs.writeFileSync(outsidePath, validDocument);
        temporaryDirectories.push(outsidePath);
        fs.symlinkSync(outsidePath, todoPath);

        await expect(handler("tool_call")({
            toolName: "write",
            input: { path: todoPath, content: validDocument },
        }, ctx)).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("canonical"),
        });
    });
});
