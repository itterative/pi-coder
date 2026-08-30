import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ALLOWED_FILE_ENTRY_TYPE } from "../../src/common/audit";
import { getUserMemoryDirectory } from "../../src/common/constants";
import registerScratchpadExtension, { getScratchpadPath } from "../../src/modules/scratchpad";
import registerFileToolHook from "../../src/tools/file-permissions";
import registerReadToolHook from "../../src/tools/read";
import { createPermissionState } from "../../src/modules/sandbox/permission-state";

interface Handler {
    (event: any, ctx: any): Promise<unknown> | unknown;
}

describe("file permission session entries", () => {
    let temporaryDirectories: string[] = [];

    it.each(["read", "write"] as const)(
        "allows scratchpad %s access without prompting",
        async (operation) => {
            const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-scratchpad-cwd-"));
            temporaryDirectories.push(cwd);

            const handlers: Record<string, Handler[]> = {};
            const pi = {
                on(event: string, handler: Handler) {
                    (handlers[event] ??= []).push(handler);
                },
                appendEntry() {},
            } as any;
            registerScratchpadExtension(pi);
            registerFileToolHook(pi, operation);

            const sessionManager = {};
            const ctx = { cwd, hasUI: false, sessionManager };
            await handlers.session_start[0]({}, ctx);
            const scratchpad = getScratchpadPath(sessionManager)!;
            temporaryDirectories.push(scratchpad);

            const result = await handlers.tool_call[0](
                {
                    toolName: operation,
                    input: { path: path.join(scratchpad, ".env") },
                },
                ctx,
            );

            expect(result).toEqual({ block: false });
        },
    );

    afterEach(() => {
        for (const directory of temporaryDirectories) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
        temporaryDirectories = [];
    });

    it("allows dynamic read roots only for read operations", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-session-"));
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-output-"));
        temporaryDirectories.push(cwd, outputDirectory);
        const outputPath = path.join(outputDirectory, "bash-output.log");
        fs.writeFileSync(outputPath, "full output");

        const handlers: Record<string, Handler[]> = {};
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            appendEntry() {},
        } as any;
        const additionalReadRoots = () => [outputPath];
        registerFileToolHook(pi, "read", { additionalReadRoots });
        const ctx = { cwd, hasUI: false, sessionManager: {} };

        await expect(
            handlers.tool_call[0]!(
                {
                    toolName: "read",
                    input: { path: outputPath },
                },
                ctx,
            ),
        ).resolves.toEqual({ block: false });

        const writeHandlers: Record<string, Handler[]> = {};
        const writePi = {
            on(event: string, handler: Handler) {
                (writeHandlers[event] ??= []).push(handler);
            },
            appendEntry() {},
        } as any;
        registerFileToolHook(writePi, "write", { additionalReadRoots });
        await expect(
            writeHandlers.tool_call[0]!(
                {
                    toolName: "write",
                    input: { path: outputPath },
                },
                ctx,
            ),
        ).resolves.toMatchObject({ block: true });
    });

    it("allows parent reads from user memories but not writes", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-memory-cwd-"));
        temporaryDirectories.push(cwd);

        const readHandlers: Record<string, Handler[]> = {};
        const readPi = {
            on(event: string, handler: Handler) {
                (readHandlers[event] ??= []).push(handler);
            },
            appendEntry() {},
        } as any;
        registerReadToolHook(readPi);

        const memoryPath = path.join(getUserMemoryDirectory(), "permission-test.md");
        const ctx = { cwd, hasUI: false, sessionManager: {} };
        await expect(
            readHandlers.tool_call[0]!(
                {
                    toolName: "read",
                    input: { path: memoryPath },
                },
                ctx,
            ),
        ).resolves.toEqual({ block: false });

        const writeHandlers: Record<string, Handler[]> = {};
        const writePi = {
            on(event: string, handler: Handler) {
                (writeHandlers[event] ??= []).push(handler);
            },
            appendEntry() {},
        } as any;
        registerFileToolHook(writePi, "write");

        await expect(
            writeHandlers.tool_call[0]!(
                {
                    toolName: "write",
                    input: { path: memoryPath },
                },
                ctx,
            ),
        ).resolves.toMatchObject({ block: true });
    });

    it("keeps remembered folders isolated between extension runtimes", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-session-"));
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-approved-"));
        temporaryDirectories.push(cwd, folder);

        const createRuntime = () => {
            const handlers: Record<string, Handler[]> = {};
            const pi = {
                on(event: string, handler: Handler) {
                    (handlers[event] ??= []).push(handler);
                },
                appendEntry() {},
            } as any;
            registerFileToolHook(pi, "read");
            return handlers;
        };
        const first = createRuntime();
        const second = createRuntime();
        const context = (entries: unknown[]) => ({
            cwd,
            hasUI: false,
            sessionManager: { getBranch: () => entries },
        });
        const allowedEntry = {
            type: "custom",
            customType: ALLOWED_FILE_ENTRY_TYPE,
            data: { operation: "read", folder },
        };
        const firstCtx = context([allowedEntry]);
        const secondCtx = context([]);

        await first.session_start[0]({}, firstCtx);
        await second.session_start[0]({}, secondCtx);
        const result = await first.tool_call[0](
            {
                toolName: "read",
                input: { path: path.join(folder, "notes.txt") },
            },
            firstCtx,
        );

        expect(result).toEqual({ block: false });
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
                getBranch: () => [
                    {
                        type: "custom",
                        customType: ALLOWED_FILE_ENTRY_TYPE,
                        data: { operation: "read", folder },
                    },
                ],
            },
        };

        await handlers.session_start[0]({}, ctx);
        const result = await handlers.tool_call[0](
            {
                toolName: "read",
                input: { path: path.join(folder, "notes.txt") },
            },
            ctx,
        );

        expect(result).toEqual({ block: false });
    });

    it("uses cwd when search tools omit their optional path", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-search-"));
        temporaryDirectories.push(cwd);

        const handlers: Record<string, Handler[]> = {};
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            appendEntry() {},
        } as any;
        registerFileToolHook(pi, "read");

        const result = await handlers.tool_call[0](
            {
                toolName: "grep",
                input: { pattern: "needle" },
            },
            { cwd, hasUI: false },
        );

        expect(result).toEqual({ block: false });
    });

    it("shares a remembered outside folder with a child hook", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-session-"));
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-approved-"));
        temporaryDirectories.push(cwd, folder);

        const handlers: Record<string, Handler[]> = {};
        let prompts = 0;
        const state = createPermissionState();
        const ctx = {
            cwd,
            hasUI: true,
            ui: {
                theme: { bold: (value: string) => value },
                setWorkingVisible() {},
                notify() {},
                custom: async () => {
                    prompts++;
                    return {
                        value: { kind: "remember", folder },
                        displayText: "Yes, and always allow",
                    };
                },
            },
        } as any;
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            appendEntry() {},
        } as any;
        registerFileToolHook(pi, "read", {
            state,
            promptContext: ctx,
            restoreSession: false,
            persistSession: false,
        });

        const event = { toolName: "read", input: { path: path.join(folder, "notes.txt") } };
        await expect(handlers.tool_call[0](event, ctx)).resolves.toEqual({ block: false });
        await expect(handlers.tool_call[0](event, ctx)).resolves.toEqual({ block: false });
        expect(prompts).toBe(1);
    });

    it.each(["read", "write"] as const)(
        "includes a refusal message in blocked %s reasons",
        async (operation) => {
            const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-session-"));
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-outside-"));
            temporaryDirectories.push(cwd, outside);

            const handlers: Record<string, Handler[]> = {};
            const pi = {
                on(event: string, handler: Handler) {
                    (handlers[event] ??= []).push(handler);
                },
                appendEntry() {},
            } as any;
            registerFileToolHook(pi, operation);
            const refusalMessage = "do not access that folder";
            const ctx = {
                cwd,
                hasUI: true,
                ui: {
                    theme: { bold: (value: string) => value },
                    setWorkingVisible() {},
                    custom: async () => ({
                        value: { kind: "no" },
                        message: refusalMessage,
                        displayText: "No, do not access that folder",
                    }),
                },
            };

            const result = await handlers.tool_call[0](
                {
                    toolName: operation,
                    input: { path: path.join(outside, "notes.txt") },
                },
                ctx,
            );

            expect(result).toEqual({
                block: true,
                reason: `File ${operation} blocked by user; path is outside the allowed working directory. User message: ${refusalMessage}`,
            });
        },
    );

    it.each(["read", "write"] as const)(
        "keeps the generic blocked %s reason without a refusal message",
        async (operation) => {
            const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-session-"));
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-outside-"));
            temporaryDirectories.push(cwd, outside);

            const handlers: Record<string, Handler[]> = {};
            const pi = {
                on(event: string, handler: Handler) {
                    (handlers[event] ??= []).push(handler);
                },
                appendEntry() {},
            } as any;
            registerFileToolHook(pi, operation);
            const ctx = {
                cwd,
                hasUI: true,
                ui: {
                    theme: { bold: (value: string) => value },
                    setWorkingVisible() {},
                    custom: async () => ({
                        value: { kind: "no" },
                        displayText: "No",
                    }),
                },
            };

            const result = await handlers.tool_call[0](
                {
                    toolName: operation,
                    input: { path: path.join(outside, "notes.txt") },
                },
                ctx,
            );

            expect(result).toEqual({
                block: true,
                reason: `File ${operation} blocked by user; path is outside the allowed working directory.`,
            });
        },
    );
});
