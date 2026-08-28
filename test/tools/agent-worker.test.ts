import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import registerScratchpadExtension, { getScratchpadPath } from "../../src/modules/scratchpad";
import { registerChildExtension } from "../../src/tools/agent/child/extension";
import registerFileToolHook from "../../src/tools/file-permissions";
import { registerCommandPermissionHooks } from "../../src/tools/agent/child/command-permissions";
import { createPermissionState, getPermissionState } from "../../src/modules/sandbox/permission-state";
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

async function waitForDialogs(dialogs: readonly unknown[], count: number): Promise<void> {
    await vi.waitFor(() => {
        expect(dialogs.length).toBeGreaterThanOrEqual(count);
    });
}

describe("command and edit permission gate", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
        tempDirs.length = 0;
    });

    function setup(cwd: string, options: {
        isolated?: boolean;
        permissionState?: ReturnType<typeof createPermissionState>;
        registerFileHook?: boolean;
    } = {}) {
        const handlers: Record<string, Handler[]> = {};
        const dialogs: any[] = [];
        const changedFiles: string[] = [];
        const pending: boolean[] = [];
        const sessionManager = {};
        const parentContext = {
            cwd,
            hasUI: true,
            sessionManager,
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
            isolated: options.isolated ?? false,
            permissionState,
            agentName: "worker",
            permissionPending(value: boolean) { pending.push(value); },
            fileChanged(filePath: string) { changedFiles.push(filePath); },
            bashApproved() {},
        });
        return {
            pi,
            handlers,
            dialogs,
            changedFiles,
            pending,
            ctx: { cwd, signal: undefined, sessionManager },
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

    function bashEvent(id: string, command: string) {
        return {
            type: "tool_call",
            toolName: "bash",
            toolCallId: id,
            input: { command },
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

    it("tracks successful cwd edits without a mutation prompt", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd);
        const event = editEvent("edit-1", "src/example.ts");

        await expect(runtime.handlers.tool_call[0](event, runtime.ctx)).resolves.toEqual({ block: false });
        expect(runtime.dialogs).toHaveLength(0);
        await runtime.handlers.tool_result[0]({
            type: "tool_result",
            toolName: "edit",
            toolCallId: "edit-1",
            input: event.input,
            content: [{ type: "text", text: "done" }],
            isError: false,
        });
        expect(runtime.changedFiles).toEqual(["src/example.ts"]);
        expect(runtime.pending).toEqual([]);
    });

    it("allows cwd writes without prompting", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { isolated: true });
        const event = writeEvent("write-1", "src/example.ts");

        await expect(runtime.handlers.tool_call[0](event, runtime.ctx)).resolves.toEqual({ block: false });
        expect(runtime.dialogs).toHaveLength(0);
    });

    it("allows isolated worker writes inside its scratchpad without prompting", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { isolated: true });
        registerScratchpadExtension(runtime.pi);
        await runtime.handlers.session_start[0]({}, runtime.ctx);
        const scratchpad = getScratchpadPath(runtime.ctx.sessionManager)!;
        tempDirs.push(scratchpad);

        const event = writeEvent("write-scratchpad-1", path.join(scratchpad, ".env"));
        await expect(runtime.handlers.tool_call[0](event, runtime.ctx)).resolves.toEqual({ block: false });
        expect(runtime.dialogs).toHaveLength(0);
    });

    it("treats a workspace id as isolated for restored worker permissions", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const sessionManager = {};
        const parentState = getPermissionState(sessionManager);
        parentState.bashRules["unrecognized-command"] = "allow";
        const handlers: Record<string, Handler[]> = {};
        const dialogs: any[] = [];
        const parentContext = {
            cwd,
            hasUI: true,
            mode: "tui",
            sessionManager,
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
            registerTool() {},
        } as any;
        const tracker = {
            progress: { output: "", recentActivity: [] },
            lastUpdateAt: 0,
            changedFiles: new Set<string>(),
            readFiles: new Set<string>(),
            bashApproved: false,
            interrupted: false,
        } as any;
        registerChildExtension(
            tracker,
            parentContext,
            cwd,
            {
                agentName: "worker",
                background: false,
                canEdit: true,
                safeBash: true,
                runId: "worker-restored-1",
                runTitle: "Restored worker",
                onProgress: () => {},
                allowUserInteraction: true,
                workspaceId: "workspace-1",
                isolated: false,
                commandRunner: true,
            },
        )(pi);

        const permission = handlers.tool_call[0](
            bashEvent("bash-restored-1", "unrecognized-command"),
            { cwd, signal: undefined, sessionManager },
        );
        await waitForDialogs(dialogs, 1);
        expect(dialogs).toHaveLength(1);
        await waitForPermissionInput();
        dialogs[0].handleInput(KEY.escape);
        await expect(permission).resolves.toMatchObject({ block: true });
    });

    it("allows same-checkout edits and writes without a second mutation prompt", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { isolated: false });

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
        const runtime = setup(cwd, { isolated: false, registerFileHook: true });
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
        const runtime = setup(cwd, { isolated: false, registerFileHook: true });
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
        const runtime = setup(cwd, { isolated: false, permissionState: state });

        await expect(runtime.handlers.tool_call[0]({
            type: "tool_call",
            toolName: "bash",
            toolCallId: "bash-1",
            input: { command: "echo hello" },
        }, runtime.ctx)).resolves.toEqual({ block: false });
    });

    it("closes an active Bash permission gate when the child run is aborted", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { isolated: false });
        const controller = new AbortController();
        runtime.ctx.signal = controller.signal;

        const permission = runtime.handlers.tool_call[0](
            bashEvent("bash-1", "unrecognized-command"),
            runtime.ctx,
        );
        await waitForDialogs(runtime.dialogs, 1);
        expect(runtime.dialogs).toHaveLength(1);
        controller.abort();

        await expect(permission).resolves.toMatchObject({ block: true });
        expect(runtime.pending).toEqual([true, false]);
    });

    it("holds the next Bash permission prompt until the previous command settles", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-cwd-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { isolated: false });
        const firstEvent = bashEvent("bash-1", "unrecognized-command");
        const secondEvent = bashEvent("bash-2", "unrecognized-command");

        const first = runtime.handlers.tool_call[0](firstEvent, runtime.ctx);
        const second = runtime.handlers.tool_call[0](secondEvent, runtime.ctx);
        await waitForDialogs(runtime.dialogs, 1);
        expect(runtime.dialogs).toHaveLength(1);
        await waitForPermissionInput();
        runtime.dialogs[0].handleInput(KEY.enter);
        await expect(first).resolves.toEqual({ block: false });
        await flush();
        expect(runtime.dialogs).toHaveLength(1);

        await runtime.handlers.tool_result[0]({
            type: "tool_result",
            toolName: "bash",
            toolCallId: firstEvent.toolCallId,
            input: firstEvent.input,
            content: [],
            isError: false,
        });
        await waitForDialogs(runtime.dialogs, 2);
        expect(runtime.dialogs).toHaveLength(2);
        await waitForPermissionInput();
        runtime.dialogs[1].handleInput(KEY.escape);
        await expect(second).resolves.toMatchObject({ block: true });
    });

});
