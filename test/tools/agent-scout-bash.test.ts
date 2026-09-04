import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { registerChildExtension } from "../../src/tools/agent/child/extension";
import { resolveChildGrant } from "../../src/tools/agent/child/grant";
import type { ChildAgentFactoryContext } from "../../src/tools/agent/contracts/runs";
import type { AgentDefinition } from "../../src/tools/agent/definitions/types";
import { getPermissionState } from "../../src/modules/sandbox/permission-state";
import { partialTracker } from "../helpers/agent-doubles";
import { KEY, mockTheme } from "../helpers";
import {
    createPiStub,
    stubContext,
    stubSessionManager,
    stubUiWithDialogs,
    type SessionManagerLike,
    type StubHandler,
} from "../helpers/pi-stub";

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
        isolated = false,
        sessionManager = stubSessionManager(),
        additionalPaths = [],
        safeBashCommands = [],
    }: {
        safeBash?: boolean;
        commandRunner?: boolean;
        background?: boolean;
        allowUserInteraction?: boolean;
        isolated?: boolean;
        sessionManager?: SessionManagerLike;
        additionalPaths?: string[];
        safeBashCommands?: string[];
    } = {},
) {
    const stub = createPiStub();
    // The parent's dialog surface, kept in one place: only an interactive parent can answer, so `ui` is
    // handed over together with `hasUI`/`mode` below and the dialogs it opens are collected here.
    const { ui, dialogs } = stubUiWithDialogs(mockTheme);
    const tracker = partialTracker();

    const parentContext = stubContext({
        cwd,
        sessionManager,
        hasUI: commandRunner,
        mode: commandRunner ? "tui" : "print",
        ...(commandRunner ? { ui } : {}),
    });

    // Grant resolution is the production path, so the knobs above become a definition plus a run
    // mode rather than a hand-assembled option bag. That keeps the assertions about what a given
    // capability set may do honest: they now exercise the resolution itself.
    const definition: AgentDefinition = {
        name: "scout",
        description: "Read-only reconnaissance",
        capabilities: commandRunner ? ["command-runner"] : safeBash ? ["safe-bash"] : [],
        systemPrompt: "",
        source: "builtin",
        allowUserInteraction,
        ...(additionalPaths.length > 0 ? { additionalPaths } : {}),
        ...(safeBashCommands.length > 0 ? { safeBashCommands } : {}),
    };
    const context: ChildAgentFactoryContext = {
        cwd,
        definition,
        parentContext,
        background,
        isolated,
        runId: "scout-1",
        runTitle: "Bash safety",
        onProgress: () => {},
    };
    const grant = resolveChildGrant(context, parentContext);
    registerChildExtension(tracker, parentContext, cwd, grant.extensionOptions)(stub.pi);

    // Read off the stub after every gate has registered, so each list stays in registration order. These
    // are the recorded handlers themselves rather than a `handlerView`: several assertions below call a
    // gate synchronously and expect its plain return value.
    const handlers: Record<"tool_call" | "tool_result" | "session_start", StubHandler[]> = {
        tool_call: stub.handlersFor("tool_call"),
        tool_result: stub.handlersFor("tool_result"),
        session_start: stub.handlersFor("session_start"),
    };

    return { handlers, ctx: { cwd, sessionManager }, tools: stub.tools, dialogs, sessionManager };
}

describe("child interaction tools", () => {
    it("registers both interaction tools for background children when allowed", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-background-tools-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, {
            background: true,
            allowUserInteraction: true,
            commandRunner: true,
        });

        expect(runtime.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["ask_user", "ask_parent"]),
        );
    });

    it("keeps ask_user disabled for definitions that disallow direct interaction", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-parent-only-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, {
            background: true,
            allowUserInteraction: false,
            commandRunner: true,
        });

        expect(runtime.tools.map((tool) => tool.name)).not.toContain("ask_user");
        expect(runtime.tools.map((tool) => tool.name)).toContain("ask_parent");
    });

    it("does not register ask_user when the parent is non-interactive", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-noninteractive-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { background: true, allowUserInteraction: true });

        expect(runtime.tools.map((tool) => tool.name)).not.toContain("ask_user");
        expect(runtime.tools.map((tool) => tool.name)).toContain("ask_parent");
    });
});

describe("child Bash permissions", () => {
    it("permits only heuristic-classified read-only commands", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        fs.writeFileSync(path.join(cwd, "safe.txt"), "safe");
        const runtime = setup(cwd);
        const check = runtime.handlers.tool_call[0]!;

        await expect(
            check({ toolName: "bash", input: { command: "cat safe.txt" } }, runtime.ctx),
        ).resolves.toBeUndefined();
        await expect(
            check({ toolName: "bash", input: { command: "echo changed > safe.txt" } }, runtime.ctx),
        ).resolves.toMatchObject({ block: true, reason: expect.stringContaining("SAFE_READONLY") });
        await expect(
            check({ toolName: "bash", input: { command: "cat /etc/passwd" } }, runtime.ctx),
        ).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining(
                "a path is outside the working directory [OUTSIDE_CWD]",
            ),
        });
        await expect(
            check({ toolName: "bash", input: { command: "unrecognized-command" } }, runtime.ctx),
        ).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("UNKNOWN_COMMAND"),
        });
    });

    it("allows exact custom safe-Bash patterns while retaining path checks", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-custom-bash-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, {
            safeBashCommands: ["ast-outline digest *"],
        });
        const check = runtime.handlers.tool_call[0]!;

        await expect(
            check({ toolName: "bash", input: { command: "ast-outline digest src" } }, runtime.ctx),
        ).resolves.toBeUndefined();
        await expect(
            check(
                { toolName: "bash", input: { command: "ast-outline show src/index.ts" } },
                runtime.ctx,
            ),
        ).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("UNKNOWN_COMMAND"),
        });
        await expect(
            check({ toolName: "bash", input: { command: "ast-outline digest /etc" } }, runtime.ctx),
        ).resolves.toMatchObject({ block: true, reason: expect.stringContaining("OUTSIDE_CWD") });
    });

    it("allows configured additional paths for direct reads and safe Bash", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const additionalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-additional-"));
        tempDirs.push(cwd, additionalDirectory);
        const additionalPath = path.join(additionalDirectory, "memory.md");
        const sensitivePath = path.join(additionalDirectory, ".env");
        fs.writeFileSync(additionalPath, "memory");
        fs.writeFileSync(sensitivePath, "secret");
        const runtime = setup(cwd, { additionalPaths: [additionalDirectory] });
        const check = runtime.handlers.tool_call[0]!;

        expect(
            check({ toolName: "read", input: { path: additionalPath } }, runtime.ctx),
        ).toBeUndefined();
        await expect(
            check({ toolName: "bash", input: { command: `cat ${additionalPath}` } }, runtime.ctx),
        ).resolves.toBeUndefined();
        expect(
            check({ toolName: "read", input: { path: sensitivePath } }, runtime.ctx),
        ).toMatchObject({ block: true });
        await expect(
            check({ toolName: "bash", input: { command: `cat ${sensitivePath}` } }, runtime.ctx),
        ).resolves.toMatchObject({ block: true });

        const commandRunner = setup(cwd, {
            commandRunner: true,
            background: false,
            additionalPaths: [additionalDirectory],
        });
        await expect(
            commandRunner.handlers.tool_call[0]!(
                { toolName: "bash", input: { command: `cat ${additionalPath}` } },
                commandRunner.ctx,
            ),
        ).resolves.toEqual({ block: false });
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

        await result(
            {
                type: "tool_result",
                toolName: "bash",
                toolCallId: "bash-1",
                input: { command: "cat large.log" },
                content: [],
                isError: false,
                details: { fullOutputPath: outputPath },
            },
            runtime.ctx,
        );

        expect(
            check({ toolName: "read", input: { path: outputPath } }, runtime.ctx),
        ).toBeUndefined();
        expect(
            check({ toolName: "read", input: { path: outsidePath } }, runtime.ctx),
        ).toMatchObject({ block: true });
        expect(
            check(
                { toolName: "read", input: { path: path.join(os.tmpdir(), "unrelated.log") } },
                runtime.ctx,
            ),
        ).toMatchObject({ block: true });
        await expect(
            check({ toolName: "bash", input: { command: `cat ${outputPath}` } }, runtime.ctx),
        ).resolves.toMatchObject({ block: true });
    });

    it("reconstructs readable Bash output paths from a resumed child transcript", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-"));
        tempDirs.push(cwd, outputDirectory);
        const outputPath = path.join(outputDirectory, "bash-output.log");
        fs.writeFileSync(outputPath, "full output");
        const runtime = setup(cwd);
        const sessionManager = {
            getBranch: () => [
                {
                    type: "message",
                    message: {
                        role: "toolResult",
                        toolName: "bash",
                        details: { fullOutputPath: outputPath },
                    },
                },
            ],
        };
        await runtime.handlers.session_start[0]!({}, { cwd, sessionManager });

        expect(
            runtime.handlers.tool_call[0]!(
                {
                    toolName: "read",
                    input: { path: outputPath },
                },
                { cwd },
            ),
        ).toBeUndefined();
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
            await result(
                {
                    type: "tool_result",
                    toolName: "bash",
                    toolCallId: outputPath,
                    input: { command: "cat large.log" },
                    content: [],
                    isError: false,
                    details: { fullOutputPath: outputPath },
                },
                runtime.ctx,
            );
        }

        expect(
            check({ toolName: "read", input: { path: outputPaths[0] } }, runtime.ctx),
        ).toBeUndefined();
        expect(
            check({ toolName: "read", input: { path: outputPaths.at(-1) } }, runtime.ctx),
        ).toBeUndefined();
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
        await runtime.handlers.tool_result[0]!(
            {
                type: "tool_result",
                toolName: "bash",
                toolCallId: "bash-1",
                input: { command: "cat large.log" },
                content: [],
                isError: false,
                details: { fullOutputPath: outputPath },
            },
            runtime.ctx,
        );
        fs.rmSync(outputPath);
        fs.symlinkSync(outsidePath, outputPath);

        expect(
            runtime.handlers.tool_call[0]!(
                {
                    toolName: "read",
                    input: { path: outputPath },
                },
                runtime.ctx,
            ),
        ).toMatchObject({ block: true });
    });

    it("routes command-runner commands through the permission gate", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-runner-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { commandRunner: true, background: false });
        const check = runtime.handlers.tool_call[0]!;
        const pending = check(
            {
                toolName: "bash",
                toolCallId: "bash-1",
                input: { command: "npm run test:run" },
            },
            runtime.ctx,
        );

        await vi.waitFor(() => expect(runtime.dialogs).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 260));
        runtime.dialogs[0].handleInput(KEY.enter);

        await expect(pending).resolves.toEqual({ block: false });
    });

    it("propagates an explicitly remembered isolated Bash rule to the parent session", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-bash-"));
        tempDirs.push(cwd);
        const sessionManager = stubSessionManager();
        const runtime = setup(cwd, {
            commandRunner: true,
            background: false,
            isolated: true,
            sessionManager,
        });
        const pending = runtime.handlers.tool_call[0]!(
            {
                toolName: "bash",
                toolCallId: "bash-remember-1",
                input: { command: "npm run test:run" },
            },
            runtime.ctx,
        );

        await vi.waitFor(() => expect(runtime.dialogs).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 260));
        runtime.dialogs[0].handleInput(KEY.down);
        runtime.dialogs[0].handleInput(KEY.enter);

        await expect(pending).resolves.toEqual({ block: false });
        const parentRule = getPermissionState(sessionManager).bashRules["npm run test:run"];
        expect(["allow", "allow:sandbox"]).toContain(parentRule);
    });

    it("permits built-in fsmonitor but blocks an external status hook", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        execFileSync("git", ["init", "-q"], { cwd });
        const runtime = setup(cwd);
        const check = runtime.handlers.tool_call[0]!;

        execFileSync("git", ["config", "core.fsmonitor", "true"], { cwd });
        await expect(
            check({ toolName: "bash", input: { command: "git status --short" } }, runtime.ctx),
        ).resolves.toBeUndefined();

        const sentinel = path.join(cwd, "fsmonitor-sentinel");
        const marker = path.join(cwd, "fsmonitor-ran");
        fs.writeFileSync(sentinel, `#!/bin/sh\ntouch ${marker}\n`);
        fs.chmodSync(sentinel, 0o755);
        execFileSync("git", ["config", "core.fsmonitor", sentinel], { cwd });

        await expect(
            check({ toolName: "bash", input: { command: "git status --short" } }, runtime.ctx),
        ).resolves.toMatchObject({
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

        await expect(
            check({ toolName: "bash", input: { command: "cat safe.txt" } }, runtime.ctx),
        ).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("safe-bash capability is not enabled"),
        });
    });

    it("omits direct user interaction when the child policy disables it", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { background: false, allowUserInteraction: false });

        expect(runtime.tools.map((tool) => tool.name)).not.toContain("ask_user");
    });
});
