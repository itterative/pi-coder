import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerChildExtension } from "../../src/tools/agent/child/extension";
import { KEY, mockTheme } from "../helpers";

type Handler = (event: any, ctx: any) => unknown;

const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function setup(
    cwd: string,
    {
        safeBash = true,
        commandRunner = false,
        background = true,
        allowUserInteraction = true,
    }: {
        safeBash?: boolean;
        commandRunner?: boolean;
        background?: boolean;
        allowUserInteraction?: boolean;
    } = {},
) {
    const handlers: Record<string, Handler[]> = {};
    const tools: Array<{ name: string }> = [];
    const dialogs: any[] = [];
    const pi = {
        on(event: string, handler: Handler) {
            (handlers[event] ??= []).push(handler);
        },
        registerTool(tool: { name: string }) { tools.push(tool); },
    } as any;
    const tracker = {
        progress: { output: "", recentActivity: [] },
        lastUpdateAt: 0,
        changedFiles: new Set<string>(),
        readFiles: new Set<string>(),
        bashApproved: false,
        interrupted: false,
    } as any;

    const parentContext = {
        cwd,
        hasUI: commandRunner,
        mode: commandRunner ? "tui" : "print",
        ...(commandRunner
            ? {
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
            }
            : {}),
    } as any;

    registerChildExtension(
        tracker,
        parentContext,
        cwd,
        "scout",
        background,
        false,
        safeBash,
        "scout-1",
        "Bash safety",
        () => {},
        undefined,
        undefined,
        undefined,
        allowUserInteraction,
        undefined,
        false,
        commandRunner,
    )(pi);

    return { handlers, ctx: { cwd }, tools, dialogs };
}

describe("child Bash permissions", () => {
    it("permits only heuristic-classified read-only commands", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        fs.writeFileSync(path.join(cwd, "safe.txt"), "safe");
        const runtime = setup(cwd);
        const check = runtime.handlers.tool_call[0]!;

        await expect(check({ toolName: "bash", input: { command: "cat safe.txt" } }, runtime.ctx))
            .resolves.toBeUndefined();
        await expect(check({ toolName: "bash", input: { command: "echo changed > safe.txt" } }, runtime.ctx))
            .resolves.toMatchObject({ block: true, reason: expect.stringContaining("SAFE_READONLY") });
        await expect(check({ toolName: "bash", input: { command: "cat /etc/passwd" } }, runtime.ctx))
            .resolves.toMatchObject({
                block: true,
                reason: expect.stringContaining("a path is outside the working directory [OUTSIDE_CWD]"),
            });
        await expect(check({ toolName: "bash", input: { command: "unrecognized-command" } }, runtime.ctx))
            .resolves.toMatchObject({ block: true, reason: expect.stringContaining("UNKNOWN_COMMAND") });
    });

    it("allows reading a current child Bash output file without allowing general temp access", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-outside-"));
        tempDirs.push(cwd, outputDirectory, outside);
        const outputPath = path.join(outputDirectory, "bash-output.log");
        const outsidePath = path.join(outside, "secret.txt");
        fs.writeFileSync(outputPath, "full output");
        fs.writeFileSync(outsidePath, "secret");
        const runtime = setup(cwd);
        const result = runtime.handlers.tool_result[0]!;
        const check = runtime.handlers.tool_call[0]!;

        await result({
            type: "tool_result",
            toolName: "bash",
            toolCallId: "bash-1",
            input: { command: "cat large.log" },
            content: [],
            isError: false,
            details: { fullOutputPath: outputPath },
        }, runtime.ctx);

        expect(check({ toolName: "read", input: { path: outputPath } }, runtime.ctx))
            .toBeUndefined();
        expect(check({ toolName: "read", input: { path: outsidePath } }, runtime.ctx))
            .toMatchObject({ block: true });
        expect(check({ toolName: "read", input: { path: path.join(os.tmpdir(), "unrelated.log") } }, runtime.ctx))
            .toMatchObject({ block: true });
        await expect(check({ toolName: "bash", input: { command: `cat ${outputPath}` } }, runtime.ctx))
            .resolves.toMatchObject({ block: true });
    });

    it("reconstructs readable Bash output paths from a resumed child transcript", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-"));
        tempDirs.push(cwd, outputDirectory);
        const outputPath = path.join(outputDirectory, "bash-output.log");
        fs.writeFileSync(outputPath, "full output");
        const runtime = setup(cwd);
        const sessionManager = {
            getBranch: () => [{
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "bash",
                    details: { fullOutputPath: outputPath },
                },
            }],
        };
        await runtime.handlers.session_start[0]!({}, { cwd, sessionManager });

        expect(runtime.handlers.tool_call[0]!({
            toolName: "read",
            input: { path: outputPath },
        }, { cwd })).toBeUndefined();
    });

    it("retains all active truncated Bash output paths", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-"));
        tempDirs.push(cwd, outputDirectory);
        const outputPaths = Array.from({ length: 100 }, (_, index) => {
            const outputPath = path.join(outputDirectory, `bash-output-${index}.log`);
            fs.writeFileSync(outputPath, `full output ${index}`);
            return outputPath;
        });
        const runtime = setup(cwd);
        const result = runtime.handlers.tool_result[0]!;
        const check = runtime.handlers.tool_call[0]!;

        for (const outputPath of outputPaths) {
            await result({
                type: "tool_result",
                toolName: "bash",
                toolCallId: outputPath,
                input: { command: "cat large.log" },
                content: [],
                isError: false,
                details: { fullOutputPath: outputPath },
            }, runtime.ctx);
        }

        expect(check({ toolName: "read", input: { path: outputPaths[0] } }, runtime.ctx))
            .toBeUndefined();
        expect(check({ toolName: "read", input: { path: outputPaths.at(-1) } }, runtime.ctx))
            .toBeUndefined();
    });

    it("rejects a Bash output path after it is replaced by a symlink", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-outside-"));
        tempDirs.push(cwd, outputDirectory, outside);
        const outputPath = path.join(outputDirectory, "bash-output.log");
        const outsidePath = path.join(outside, "secret.txt");
        fs.writeFileSync(outputPath, "full output");
        fs.writeFileSync(outsidePath, "secret");
        const runtime = setup(cwd);
        await runtime.handlers.tool_result[0]!({
            type: "tool_result",
            toolName: "bash",
            toolCallId: "bash-1",
            input: { command: "cat large.log" },
            content: [],
            isError: false,
            details: { fullOutputPath: outputPath },
        }, runtime.ctx);
        fs.rmSync(outputPath);
        fs.symlinkSync(outsidePath, outputPath);

        expect(runtime.handlers.tool_call[0]!({
            toolName: "read",
            input: { path: outputPath },
        }, runtime.ctx)).toMatchObject({ block: true });
    });

    it("routes command-runner commands through the permission gate", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-runner-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { commandRunner: true, background: false });
        const check = runtime.handlers.tool_call[0]!;
        const pending = check({
            toolName: "bash",
            toolCallId: "bash-1",
            input: { command: "npm run test:run" },
        }, runtime.ctx);

        for (let index = 0; index < 8; index++) {
            await Promise.resolve();
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(runtime.dialogs).toHaveLength(1);
        await new Promise((resolve) => setTimeout(resolve, 260));
        runtime.dialogs[0].handleInput(KEY.enter);

        await expect(pending).resolves.toEqual({ block: false });
    });

    it("permits built-in fsmonitor but blocks an external status hook", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        execFileSync("git", ["init", "-q"], { cwd });
        const runtime = setup(cwd);
        const check = runtime.handlers.tool_call[0]!;

        execFileSync("git", ["config", "core.fsmonitor", "true"], { cwd });
        await expect(check({ toolName: "bash", input: { command: "git status --short" } }, runtime.ctx))
            .resolves.toBeUndefined();

        const sentinel = path.join(cwd, "fsmonitor-sentinel");
        const marker = path.join(cwd, "fsmonitor-ran");
        fs.writeFileSync(sentinel, `#!/bin/sh\ntouch ${marker}\n`);
        fs.chmodSync(sentinel, 0o755);
        execFileSync("git", ["config", "core.fsmonitor", sentinel], { cwd });

        await expect(check({ toolName: "bash", input: { command: "git status --short" } }, runtime.ctx))
            .resolves.toMatchObject({
                block: true,
                reason: expect.stringContaining("unsupported core.fsmonitor value"),
            });
        expect(fs.existsSync(marker)).toBe(false);
    });

    it("blocks bash when safe-bash is absent", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { safeBash: false });
        const check = runtime.handlers.tool_call[0]!;

        await expect(check({ toolName: "bash", input: { command: "cat safe.txt" } }, runtime.ctx))
            .resolves.toMatchObject({ block: true, reason: expect.stringContaining("safe-bash capability is not enabled") });
    });

    it("omits direct user interaction when the child policy disables it", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { background: false, allowUserInteraction: false });

        expect(runtime.tools.map((tool) => tool.name)).not.toContain("ask_user");
    });
});
