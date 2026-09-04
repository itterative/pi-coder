import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { ALLOWED_FILE_ENTRY_TYPE } from "../../src/common/audit";
import { getUserMemoryDirectory } from "../../src/common/constants";
import registerScratchpadExtension, { getScratchpadPath } from "../../src/modules/scratchpad";
import registerFileToolHook from "../../src/tools/file-permissions";
import registerReadToolHook from "../../src/tools/read";
import { createPermissionState } from "../../src/modules/sandbox/permission-state";
import { createPiStub, invoke, stubContext, stubSessionManager, stubUi } from "../helpers/pi-stub";

/** Only `bold` is used by the prompts these tests drive; the rest of the theme stays unmodelled. */
const theme = { bold: (value: string) => value } as ExtensionUIContext["theme"];

describe("file permission session entries", () => {
    let temporaryDirectories: string[] = [];

    it.each(["read", "write"] as const)(
        "allows scratchpad %s access without prompting",
        async (operation) => {
            const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-scratchpad-cwd-"));
            temporaryDirectories.push(cwd);

            const stub = createPiStub();
            registerScratchpadExtension(stub.pi);
            registerFileToolHook(stub.pi, operation);

            const sessionManager = stubSessionManager();
            const ctx = stubContext({ cwd, hasUI: false, sessionManager });
            await invoke(stub.requireHandler("session_start"), {}, ctx);
            const scratchpad = getScratchpadPath(sessionManager)!;
            temporaryDirectories.push(scratchpad);

            const result = await invoke(
                stub.requireHandler("tool_call"),
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

        const readStub = createPiStub();
        const additionalReadRoots = () => [outputPath];
        registerFileToolHook(readStub.pi, "read", { additionalReadRoots });
        const ctx = stubContext({ cwd, hasUI: false, sessionManager: stubSessionManager() });

        await expect(
            invoke(
                readStub.requireHandler("tool_call"),
                {
                    toolName: "read",
                    input: { path: outputPath },
                },
                ctx,
            ),
        ).resolves.toEqual({ block: false });

        const writeStub = createPiStub();
        registerFileToolHook(writeStub.pi, "write", { additionalReadRoots });
        await expect(
            invoke(
                writeStub.requireHandler("tool_call"),
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

        const readStub = createPiStub();
        registerReadToolHook(readStub.pi);

        const memoryPath = path.join(getUserMemoryDirectory(), "permission-test.md");
        const ctx = stubContext({ cwd, hasUI: false, sessionManager: stubSessionManager() });
        await expect(
            invoke(
                readStub.requireHandler("tool_call"),
                {
                    toolName: "read",
                    input: { path: memoryPath },
                },
                ctx,
            ),
        ).resolves.toEqual({ block: false });

        const writeStub = createPiStub();
        registerFileToolHook(writeStub.pi, "write");
        await expect(
            invoke(
                writeStub.requireHandler("tool_call"),
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
            const stub = createPiStub();
            registerFileToolHook(stub.pi, "read");
            return stub;
        };
        const first = createRuntime();
        const second = createRuntime();
        const context = (entries: SessionEntry[]) =>
            stubContext({
                cwd,
                hasUI: false,
                sessionManager: stubSessionManager({ getBranch: () => entries }),
            });
        // Only `type`, `customType`, and `data` are read (src/tools/file-permissions.ts:71); the entry
        // base fields are irrelevant to this path, so the literal stays as small as it was before.
        const allowedEntry = {
            type: "custom",
            customType: ALLOWED_FILE_ENTRY_TYPE,
            data: { operation: "read", folder },
        } as SessionEntry;
        const firstCtx = context([allowedEntry]);
        const secondCtx = context([]);

        await invoke(first.requireHandler("session_start"), {}, firstCtx);
        await invoke(second.requireHandler("session_start"), {}, secondCtx);
        const result = await invoke(
            first.requireHandler("tool_call"),
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

        const stub = createPiStub();
        registerFileToolHook(stub.pi, "read");

        const ctx = stubContext({
            cwd,
            hasUI: false,
            sessionManager: stubSessionManager({
                getBranch: () => [
                    {
                        type: "custom",
                        customType: ALLOWED_FILE_ENTRY_TYPE,
                        data: { operation: "read", folder },
                    } as SessionEntry,
                ],
            }),
        });

        await invoke(stub.requireHandler("session_start"), {}, ctx);
        const result = await invoke(
            stub.requireHandler("tool_call"),
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

        const stub = createPiStub();
        registerFileToolHook(stub.pi, "read");

        const result = await invoke(
            stub.requireHandler("tool_call"),
            {
                toolName: "grep",
                input: { pattern: "needle" },
            },
            stubContext({ cwd, hasUI: false }),
        );

        expect(result).toEqual({ block: false });
    });

    it("shares a remembered outside folder with a child hook", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-session-"));
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-approved-"));
        temporaryDirectories.push(cwd, folder);

        const stub = createPiStub();
        let prompts = 0;
        const state = createPermissionState();
        const ctx = stubContext({
            cwd,
            hasUI: true,
            ui: stubUi({
                theme,
                setWorkingVisible() {},
                notify() {},
                custom: async () => {
                    prompts++;
                    return {
                        value: { kind: "remember", folder },
                        displayText: "Yes, and always allow",
                    };
                },
            }),
        });
        registerFileToolHook(stub.pi, "read", {
            state,
            promptContext: ctx,
            restoreSession: false,
            persistSession: false,
        });

        const event = { toolName: "read", input: { path: path.join(folder, "notes.txt") } };
        await expect(invoke(stub.requireHandler("tool_call"), event, ctx)).resolves.toEqual({
            block: false,
        });
        await expect(invoke(stub.requireHandler("tool_call"), event, ctx)).resolves.toEqual({
            block: false,
        });
        expect(prompts).toBe(1);
    });

    it.each(["read", "write"] as const)(
        "includes a refusal message in blocked %s reasons",
        async (operation) => {
            const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-session-"));
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-outside-"));
            temporaryDirectories.push(cwd, outside);

            const stub = createPiStub();
            registerFileToolHook(stub.pi, operation);
            const refusalMessage = "do not access that folder";
            const ctx = stubContext({
                cwd,
                hasUI: true,
                ui: stubUi({
                    theme,
                    setWorkingVisible() {},
                    custom: async () => ({
                        value: { kind: "no" },
                        message: refusalMessage,
                        displayText: "No, do not access that folder",
                    }),
                }),
            });

            const result = await invoke(
                stub.requireHandler("tool_call"),
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

            const stub = createPiStub();
            registerFileToolHook(stub.pi, operation);
            const ctx = stubContext({
                cwd,
                hasUI: true,
                ui: stubUi({
                    theme,
                    setWorkingVisible() {},
                    custom: async () => ({
                        value: { kind: "no" },
                        displayText: "No",
                    }),
                }),
            });

            const result = await invoke(
                stub.requireHandler("tool_call"),
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
