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

function setup(cwd: string) {
    const handlers: Record<string, Handler[]> = {};
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
        { cwd, hasUI: false, mode: "print" } as any,
        "scout",
        true,
        false,
        "scout-1",
        "Bash safety",
        () => {},
    )(pi);

    return { handlers, ctx: { cwd } };
}

describe("scout restricted bash", () => {
    it("permits only heuristic-classified read-only commands", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        fs.writeFileSync(path.join(cwd, "safe.txt"), "safe");
        const runtime = setup(cwd);
        const check = runtime.handlers.tool_call[0]!;

        expect(check({ toolName: "bash", input: { command: "cat safe.txt" } }, runtime.ctx))
            .toBeUndefined();
        expect(check({ toolName: "bash", input: { command: "echo changed > safe.txt" } }, runtime.ctx))
            .toMatchObject({ block: true, reason: expect.stringContaining("SAFE_READONLY") });
        expect(check({ toolName: "bash", input: { command: "cat /etc/passwd" } }, runtime.ctx))
            .toMatchObject({
                block: true,
                reason: expect.stringContaining("a path is outside the working directory [OUTSIDE_CWD]"),
            });
        expect(check({ toolName: "bash", input: { command: "unrecognized-command" } }, runtime.ctx))
            .toMatchObject({ block: true, reason: expect.stringContaining("UNKNOWN_COMMAND") });
    });

    it("explains SAFE_READONLY in the scout protocol", () => {
        const prompt = childProtocolPrompt(false, false, true);

        expect(prompt).toContain("SAFE_READONLY means every part of the command uses a curated non-mutating form");
        expect(prompt).toContain("do not retry variants hoping to bypass it");
    });
});
