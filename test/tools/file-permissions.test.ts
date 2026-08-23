import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ALLOWED_FILE_ENTRY_TYPE } from "../../src/common/audit";
import registerFileToolHook from "../../src/tools/file-permissions";

interface Handler {
    (event: any, ctx: any): Promise<unknown> | unknown;
}

describe("file permission session entries", () => {
    let temporaryDirectories: string[] = [];

    afterEach(() => {
        for (const directory of temporaryDirectories) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
        temporaryDirectories = [];
    });

    it("restores remembered folders when resuming a session", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-session-"));
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-approved-"));
        temporaryDirectories.push(cwd, folder);

        const handlers: Record<string, Handler[]> = {};
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            appendEntry() {},
        } as any;
        registerFileToolHook(pi, "read");

        const ctx = {
            cwd,
            hasUI: false,
            sessionManager: {
                getBranch: () => [{
                    type: "custom",
                    customType: ALLOWED_FILE_ENTRY_TYPE,
                    data: { operation: "read", folder },
                }],
            },
        };

        await handlers.session_start[0]({}, ctx);
        const result = await handlers.tool_call[0]({
            toolName: "read",
            input: { path: path.join(folder, "notes.txt") },
        }, ctx);

        expect(result).toEqual({ block: false });
    });
});
