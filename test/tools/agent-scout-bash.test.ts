import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    childProtocolPrompt,
    registerChildExtension,
} from "../../src/tools/agent/child/extension";

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
        background = true,
        allowUserInteraction = true,
    }: { safeBash?: boolean; background?: boolean; allowUserInteraction?: boolean } = {},
) {
    const handlers: Record<string, Handler[]> = {};
    const tools: Array<{ name: string }> = [];
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

    registerChildExtension(
        tracker,
        { cwd, hasUI: false, mode: "print" } as any,
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
    )(pi);

    return { handlers, ctx: { cwd }, tools };
}

describe("scout restricted bash", () => {
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

    it("explains SAFE_READONLY in the scout protocol", () => {
        const prompt = childProtocolPrompt(false, false, true);

        expect(prompt).toContain("safe-bash permits only cwd-confined commands classified SAFE_READONLY");
        expect(prompt).toContain("do not retry variants hoping to bypass it");
    });

    it("omits direct user interaction when the child policy disables it", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { background: false, allowUserInteraction: false });
        const prompt = childProtocolPrompt(false, false, true, false);

        expect(runtime.tools.map((tool) => tool.name)).not.toContain("ask_user");
        expect(prompt).toContain("Direct end-user dialogs are unavailable for this child");
        expect(prompt).not.toContain("Use ask_user when");
    });
});
