import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import registerFileToolHook from "../../src/tools/file-permissions";
import { registerCommandPermissionHooks } from "../../src/tools/agent/child/command-permissions";
import { createPermissionState } from "../../src/modules/sandbox/permission-state";
import { KEY, mockTheme } from "../helpers";

interface Handler {
    (event: any, ctx: any): Promise<any> | any;
}

async function flush(): Promise<void> {
    for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function waitForPermissionInput(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 260));
}

describe("command and edit permission gate", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
        tempDirs.length = 0;
    });

    function setup(cwd: string, options: {
        nonIsolated?: boolean;
        permissionState?: ReturnType<typeof createPermissionState>;
        registerFileHook?: boolean;
    } = {}) {
        const handlers: Record<string, Handler[]> = {};
        const dialogs: any[] = [];
        const changedFiles: string[] = [];
        const pending: boolean[] = [];
        const parentContext = {
            cwd,
            hasUI: true,
            mode: "tui",
            ui: {
                theme: mockTheme,
                setWorkingVisible() {},
                custom(factory: any) {
                    return new Promise((resolve) => {
                        const component = factory(undefined, mockTheme, undefined, resolve);
                        component.focused = true;
                        dialogs.push(component);
                    });
                },
            },
        } as any;
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            appendEntry() {},
        } as any;
        const permissionState = options.permissionState ?? createPermissionState();
        if (options.registerFileHook) {
            registerFileToolHook(pi, "write", {
                state: permissionState,
                promptContext: parentContext,
                restoreSession: false,
                persistSession: false,
                childAccess: true,
                confinement: {
                    enabled: true,
                    permission: "allow",
                    resolveSymlinks: true,
                },
            });
        }
        registerCommandPermissionHooks(pi, {
            parentContext,
            runId: "worker-7",
            nonIsolated: options.nonIsolated,
            permissionState,
            agentName: "worker",
            permissionPending(value: boolean) { pending.push(value); },
            fileChanged(filePath: string) { changedFiles.push(filePath); },
            bashApproved() {},
        });
        return {
            handlers,
            dialogs,
            changedFiles,
            pending,
            ctx: { cwd, signal: undefined },
        };
    }

    function editEvent(id: string, filePath: string) {
        return {
            type: "tool_call",
            toolName: "edit",
            toolCallId: id,
            input: {
                path: filePath,
                edits: [{ oldText: "before", newText: "after" }],
            },
        };
    }

    function writeEvent(id: string, filePath: string) {
        return {
            type: "tool_call",
            toolName: "write",
            toolCallId: id,
            input: {
                path: filePath,
                content: "after",
            },
        };
    }

    it("blocks paths outside cwd without opening a dialog", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-outside-"));
        tempDirs.push(cwd, outside);
        const runtime = setup(cwd);

        const result = await runtime.handlers.tool_call[0](
            editEvent("edit-1", path.join(outside, "file.ts")),
            runtime.ctx,
        );

        expect(result).toMatchObject({ block: true });
        expect(runtime.dialogs).toHaveLength(0);
    });

    it("labels prompts with the worker run and tracks successful file changes", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd);
        const event = editEvent("edit-1", "src/example.ts");

        const permission = runtime.handlers.tool_call[0](event, runtime.ctx);
        await flush();
        expect(runtime.dialogs).toHaveLength(1);
        expect(runtime.dialogs[0].render(100).join("\n")).toContain("[worker-7] worker: allow edit?");
        await waitForPermissionInput();
        runtime.dialogs[0].handleInput(KEY.enter);
        await expect(permission).resolves.toEqual({ block: false });

        await runtime.handlers.tool_result[0]({
            type: "tool_result",
            toolName: "edit",
            toolCallId: "edit-1",
            input: event.input,
            content: [{ type: "text", text: "done" }],
            isError: false,
        });
        expect(runtime.changedFiles).toEqual(["src/example.ts"]);
        expect(runtime.pending).toEqual([true, false]);
    });

    it("prompts isolated writes while preserving the isolated permission gate", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd);
        const event = writeEvent("write-1", "src/example.ts");

        const permission = runtime.handlers.tool_call[0](event, runtime.ctx);
        await flush();
        expect(runtime.dialogs).toHaveLength(1);
        expect(runtime.dialogs[0].render(100).join("\\n")).toContain("[worker-7] worker: allow write?");
        await waitForPermissionInput();
        runtime.dialogs[0].handleInput(KEY.enter);
        await expect(permission).resolves.toEqual({ block: false });
    });

    it("allows same-checkout edits and writes without a second mutation prompt", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { nonIsolated: true });

        const edit = editEvent("edit-1", "src/example.ts");
        await expect(runtime.handlers.tool_call[0](edit, runtime.ctx)).resolves.toEqual({ block: false });
        expect(runtime.dialogs).toHaveLength(0);
        await runtime.handlers.tool_result[0]({
            type: "tool_result",
            toolName: "edit",
            toolCallId: "edit-1",
            input: edit.input,
            content: [],
            isError: false,
        });

        const write = writeEvent("write-1", "src/example.ts");
        await expect(runtime.handlers.tool_call[0](write, runtime.ctx)).resolves.toEqual({ block: false });
        expect(runtime.dialogs).toHaveLength(0);
        await runtime.handlers.tool_result[0]({
            type: "tool_result",
            toolName: "write",
            toolCallId: "write-1",
            input: write.input,
            content: [],
            isError: false,
        });
    });

    it("allows an approved outside write through the complete child hook chain", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-outside-"));
        tempDirs.push(cwd, outside);
        const runtime = setup(cwd, { nonIsolated: true, registerFileHook: true });
        const event = writeEvent("write-1", path.join(outside, "file.ts"));

        const filePermission = runtime.handlers.tool_call[0](event, runtime.ctx);
        await flush();
        expect(runtime.dialogs).toHaveLength(1);
        await waitForPermissionInput();
        runtime.dialogs[0].handleInput(KEY.enter);
        await expect(filePermission).resolves.toEqual({ block: false });
        await expect(runtime.handlers.tool_call[1](event, runtime.ctx)).resolves.toEqual({ block: false });
        expect(runtime.dialogs).toHaveLength(1);
    });

    it("blocks an outside symlink before a one-shot approval can bypass child protection", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-outside-"));
        const target = path.join(outside, "target.ts");
        const link = path.join(outside, "link.ts");
        fs.writeFileSync(target, "outside");
        fs.symlinkSync(target, link);
        tempDirs.push(cwd, outside);
        const runtime = setup(cwd, { nonIsolated: true, registerFileHook: true });
        const event = writeEvent("write-1", link);

        await expect(runtime.handlers.tool_call[0](event, runtime.ctx)).resolves.toMatchObject({ block: true });
        await expect(runtime.handlers.tool_call[1](event, runtime.ctx)).resolves.toMatchObject({ block: true });
        expect(runtime.dialogs).toHaveLength(0);
    });

    it("uses inherited allow rules without prompting for bash", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const state = createPermissionState();
        state.bashRules["echo *"] = "allow";
        const runtime = setup(cwd, { nonIsolated: true, permissionState: state });

        await expect(runtime.handlers.tool_call[0]({
            type: "tool_call",
            toolName: "bash",
            toolCallId: "bash-1",
            input: { command: "echo hello" },
        }, runtime.ctx)).resolves.toEqual({ block: false });
    });

    it("closes an active permission gate when the child run is aborted", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd);
        const controller = new AbortController();
        runtime.ctx.signal = controller.signal;

        const permission = runtime.handlers.tool_call[0](
            editEvent("edit-1", "src/example.ts"),
            runtime.ctx,
        );
        await flush();
        expect(runtime.dialogs).toHaveLength(1);
        controller.abort();

        await expect(permission).resolves.toMatchObject({ block: true });
        expect(runtime.pending).toEqual([true, false]);
    });

    it("holds the next mutation prompt until the previous tool settles", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd);
        const firstEvent = editEvent("edit-1", "src/one.ts");
        const secondEvent = editEvent("edit-2", "src/two.ts");

        const first = runtime.handlers.tool_call[0](firstEvent, runtime.ctx);
        const second = runtime.handlers.tool_call[0](secondEvent, runtime.ctx);
        await flush();
        expect(runtime.dialogs).toHaveLength(1);
        await waitForPermissionInput();
        runtime.dialogs[0].handleInput(KEY.enter);
        await expect(first).resolves.toEqual({ block: false });
        await flush();
        expect(runtime.dialogs).toHaveLength(1);

        await runtime.handlers.tool_result[0]({
            type: "tool_result",
            toolName: "edit",
            toolCallId: "edit-1",
            input: firstEvent.input,
            content: [],
            isError: false,
        });
        await flush();
        expect(runtime.dialogs).toHaveLength(2);
        await waitForPermissionInput();
        runtime.dialogs[1].handleInput(KEY.escape);
        await expect(second).resolves.toMatchObject({ block: true });
    });
});
