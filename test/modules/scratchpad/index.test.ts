import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import registerScratchpadExtension, {
    getScratchpadPath,
} from "../../../src/modules/scratchpad";

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
    const handlers = new Map<string, Handler>();
    const pi = {
        on(name: string, callback: Handler) {
            handlers.set(name, callback);
        },
    } as unknown as ExtensionAPI;

    return {
        pi,
        handler(name) {
            const callback = handlers.get(name);
            if (!callback) throw new Error(`Missing handler: ${name}`);
            return callback;
        },
    };
}

function context(sessionManager: object): ExtensionContext {
    return {
        cwd: process.cwd(),
        sessionManager,
    } as ExtensionContext;
}

describe("temporary scratchpad extension", () => {
    it("creates a private temporary directory and explains its lifetime", async () => {
        const { pi, handler } = harness();
        const sessionManager = {};
        const runtimeContext = context(sessionManager);
        registerScratchpadExtension(pi);

        await handler("session_start")({ reason: "startup" }, runtimeContext);

        const scratchpadPath = getScratchpadPath(sessionManager);
        expect(scratchpadPath).toBeDefined();
        expect(scratchpadPath).toContain(path.join(os.tmpdir(), "pi-coder-scratchpad-"));
        expect(fs.statSync(scratchpadPath!).mode & 0o777).toBe(0o700);
        temporaryDirectories.push(scratchpadPath!);

        const result = handler("before_agent_start")({
            systemPrompt: "<project_context>\nProject\n</project_context>",
        }, runtimeContext) as { systemPrompt: string };
        expect(result.systemPrompt).toContain("<scratchpad_system>");
        expect(result.systemPrompt).toContain(scratchpadPath!);
        expect(result.systemPrompt).toContain("are not managed or deleted by pi-coder");
    });

    it("keeps parent and child runtime scratchpads isolated", async () => {
        const { pi, handler } = harness();
        const parentManager = {};
        const childManager = {};
        registerScratchpadExtension(pi);

        await handler("session_start")({ reason: "startup" }, context(parentManager));
        const parentPath = getScratchpadPath(parentManager);
        await handler("session_start")({ reason: "startup" }, context(childManager));
        const childPath = getScratchpadPath(childManager);

        expect(parentPath).toBeDefined();
        expect(childPath).toBeDefined();
        temporaryDirectories.push(parentPath!, childPath!);
        expect(childPath).not.toBe(parentPath);
        expect(getScratchpadPath(parentManager)).toBe(parentPath);
    });

    it("releases only registry state at shutdown and leaves the directory for OS cleanup", async () => {
        const { pi, handler } = harness();
        const sessionManager = {};
        const runtimeContext = context(sessionManager);
        registerScratchpadExtension(pi);
        await handler("session_start")({ reason: "startup" }, runtimeContext);

        const scratchpadPath = getScratchpadPath(sessionManager)!;
        temporaryDirectories.push(scratchpadPath);
        await handler("session_shutdown")({}, runtimeContext);

        expect(getScratchpadPath(sessionManager)).toBeUndefined();
        expect(fs.existsSync(scratchpadPath)).toBe(true);
    });
});
