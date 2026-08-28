import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { renderText } from "../../helpers";

import registerTodoListExtension from "../../../src/modules/todolist";
import registerScratchpadExtension, { getScratchpadPath } from "../../../src/modules/scratchpad";
import { TodoListWidget } from "../../../src/tui/todolist-widget";

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
                let currentEvent = event as Record<string, unknown>;
                for (const callback of registered) {
                    result = await callback(currentEvent, ctx);
                    if ((result as { block?: boolean } | undefined)?.block) return result;
                    if (name === "tool_result" && result && typeof result === "object") {
                        currentEvent = { ...currentEvent, ...(result as Record<string, unknown>) };
                    }
                }
                return name === "tool_result" ? currentEvent : result;
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

    it("guards Bash changes, restores invalid existing files, and removes invalid creations", async () => {
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
        const updatedDocument = validDocument.replace("status: pending", "status: completed");

        await handler("tool_execution_start")({
            type: "tool_execution_start",
            toolCallId: "bash-valid",
            toolName: "bash",
            args: { command: "update TODO.md" },
        }, ctx);
        fs.writeFileSync(todoPath, updatedDocument);
        await expect(handler("tool_result")({
            type: "tool_result",
            toolCallId: "bash-valid",
            toolName: "bash",
            input: { command: "update TODO.md" },
            content: [{ type: "text", text: "updated" }],
            isError: false,
            details: undefined,
        }, ctx)).resolves.toMatchObject({
            content: [{ type: "text", text: "updated" }],
        });
        expect(fs.readFileSync(todoPath, "utf8")).toBe(updatedDocument);

        await handler("tool_execution_start")({
            type: "tool_execution_start",
            toolCallId: "bash-existing",
            toolName: "bash",
            args: { command: "printf invalid > TODO.md" },
        }, ctx);
        fs.writeFileSync(todoPath, "---\nversion: 1\ntodos: invalid\n---\n");
        const restored = await handler("tool_result")({
            type: "tool_result",
            toolCallId: "bash-existing",
            toolName: "bash",
            input: { command: "printf invalid > TODO.md" },
            content: [{ type: "text", text: "stdout" }],
            isError: false,
            details: undefined,
        }, ctx) as { content: Array<{ type: "text"; text: string }> };
        expect(fs.readFileSync(todoPath, "utf8")).toBe(updatedDocument);
        expect(restored.content[0]?.text).toContain("previous valid TODO.md was restored");
        expect(restored.content[1]?.text).toBe("stdout");

        fs.unlinkSync(todoPath);
        await handler("tool_execution_start")({
            type: "tool_execution_start",
            toolCallId: "bash-create",
            toolName: "bash",
            args: { command: "printf invalid > TODO.md" },
        }, ctx);
        fs.writeFileSync(todoPath, "not TODO frontmatter");
        const removed = await handler("tool_result")({
            type: "tool_result",
            toolCallId: "bash-create",
            toolName: "bash",
            input: { command: "printf invalid > TODO.md" },
            content: [{ type: "text", text: "created" }],
            isError: true,
            details: undefined,
        }, ctx) as { content: Array<{ type: "text"; text: string }> };
        expect(fs.existsSync(todoPath)).toBe(false);
        expect(removed.content[0]?.text).toContain("was removed");
    });

    it("leaves an invalid Bash change in place when another TODO mutation is outstanding", async () => {
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
        const bashInput = { command: "printf invalid > TODO.md" };

        await handler("tool_execution_start")({
            type: "tool_execution_start",
            toolCallId: "bash-concurrent-a",
            toolName: "bash",
            args: bashInput,
        }, ctx);
        await handler("tool_execution_start")({
            type: "tool_execution_start",
            toolCallId: "bash-concurrent-b",
            toolName: "bash",
            args: bashInput,
        }, ctx);
        fs.writeFileSync(todoPath, "---\nversion: 1\ntodos: invalid\n---\n");
        const result = await handler("tool_result")({
            type: "tool_result",
            toolCallId: "bash-concurrent-a",
            toolName: "bash",
            input: bashInput,
            content: [{ type: "text", text: "stdout" }],
            isError: false,
            details: undefined,
        }, ctx) as { content: Array<{ type: "text"; text: string }> };

        expect(fs.readFileSync(todoPath, "utf8")).toContain("todos: invalid");
        expect(result.content[0]?.text).toContain("could not be safely restored");
    });

    it("cleans Bash snapshots when execution ends without a result", async () => {
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
        const bashInput = { command: "printf invalid > TODO.md" };

        await handler("tool_execution_start")({
            type: "tool_execution_start",
            toolCallId: "bash-aborted",
            toolName: "bash",
            args: bashInput,
        }, ctx);
        await handler("tool_execution_end")({
            type: "tool_execution_end",
            toolCallId: "bash-aborted",
            toolName: "bash",
            args: bashInput,
            result: undefined,
            isError: true,
        }, ctx);
        fs.writeFileSync(todoPath, "---\nversion: 1\ntodos: invalid\n---\n");

        await handler("tool_result")({
            type: "tool_result",
            toolCallId: "bash-aborted",
            toolName: "bash",
            input: bashInput,
            content: [{ type: "text", text: "stdout" }],
            isError: true,
            details: undefined,
        }, ctx);
        expect(fs.readFileSync(todoPath, "utf8")).toContain("todos: invalid");
    });

    it("refreshes and clears the parent widget around valid and invalid updates", async () => {
        const { pi, handler } = harness();
        const registrations: Array<{ key: string; content: unknown }> = [];
        const sessionManager = {};
        const ctx = {
            ...runtimeContext(sessionManager),
            mode: "tui",
            hasUI: true,
            ui: {
                setWidget(key: string, content: unknown) {
                    registrations.push({ key, content });
                },
            },
        } as unknown as ExtensionContext;
        registerScratchpadExtension(pi);
        registerTodoListExtension(pi);
        await handler("session_start")({ reason: "startup" }, ctx);

        const scratchpadPath = getScratchpadPath(sessionManager)!;
        temporaryDirectories.push(scratchpadPath);
        const todoPath = path.join(scratchpadPath, "TODO.md");
        fs.writeFileSync(todoPath, validDocument);
        await handler("tool_result")({ toolName: "write" }, ctx);

        const widgetRegistration = registrations.findLast((entry) => entry.content !== undefined);
        expect(widgetRegistration?.key).toBe("pi-coder-todolist");
        const widget = (widgetRegistration?.content as (tui: unknown) => TodoListWidget)({
            requestRender() {},
        });
        expect(renderText(widget, 80)).toContain("TODO 0/1 · Inspect the implementation");

        fs.writeFileSync(todoPath, "---\nversion: 1\ntodos: invalid\n---\n");
        await handler("tool_result")({ toolName: "write" }, ctx);
        expect(renderText(widget, 80)).toContain("TODO 0/1 · Inspect the implementation");

        fs.unlinkSync(todoPath);
        await handler("tool_result")({ toolName: "bash" }, ctx);
        expect(registrations.at(-1)?.content).toBeUndefined();
        widget.dispose();
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
