import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import sandboxConfig from "../../src/common/config";
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

describe("declared file access roots", () => {
    const temporary: string[] = [];

    /**
     * One workspace with a config that declares a read root and a write root, and the two outside files.
     *
     * `honorPiPackage: false` keeps the running pi package out of the read list, so a case that expects a
     * prompt is really testing the declared lists and not wherever pi happens to be installed.
     */
    function workspace(options: { childAccess?: boolean } = {}) {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-roots-cwd-"));
        const declared = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-roots-declared-"));
        temporary.push(cwd, declared);
        fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
        // Both declared roots have to exist: the confinement check pairs each lexical root with its own
        // realpath, so a root that is only a planned path canonicalizes to nothing and the access falls back to
        // a prompt instead of being recognised as declared.
        fs.mkdirSync(path.join(declared, "readable"), { recursive: true });
        fs.mkdirSync(path.join(declared, "writable"), { recursive: true });
        fs.writeFileSync(
            path.join(cwd, ".pi", "bash-sandbox-config.json"),
            JSON.stringify({
                sandbox: { enabled: true, mounts: { [declared]: "readwrite" } },
                permissions: {},
                files: {
                    readRoots: [path.join(declared, "readable")],
                    writeRoots: [path.join(declared, "writable")],
                    honorPiPackage: false,
                },
            }),
        );
        sandboxConfig.load(cwd);

        const stub = createPiStub();
        registerFileToolHook(stub.pi, "write", {
            ...(options.childAccess ? { childAccess: true, state: createPermissionState() } : {}),
        });
        return { cwd, stub, declared };
    }

    afterEach(() => {
        for (const directory of temporary.splice(0)) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it("lets a parent write inside a declared write root without a prompt", async () => {
        const { cwd, stub, declared } = workspace();
        const ctx = stubContext({ cwd, hasUI: false, sessionManager: stubSessionManager() });

        const result = await invoke(
            stub.requireHandler("tool_call"),
            {
                toolName: "write",
                input: { path: path.join(declared, "writable", "report.md") },
            },
            ctx,
        );

        expect(result).toEqual({ block: false });
    });

    it("keeps a declared mount out of the write list while honouring the explicit one", async () => {
        // The mount says a sandboxed command may write there; that is not a grant for `edit`. The explicit
        // list is, so the two differ by exactly one config key and the case pins which is which.
        const { cwd, stub, declared } = workspace();
        fs.mkdirSync(path.join(declared, "mount-only"), { recursive: true });
        const ctx = stubContext({ cwd, hasUI: false, sessionManager: stubSessionManager() });

        await expect(
            invoke(
                stub.requireHandler("tool_call"),
                {
                    toolName: "write",
                    input: { path: path.join(declared, "mount-only", "notes.md") },
                },
                ctx,
            ),
        ).resolves.toMatchObject({ block: true });
    });

    it("does not give a child the parent's declared write roots", async () => {
        const { cwd, stub, declared } = workspace({ childAccess: true });
        const ctx = stubContext({ cwd, hasUI: false, sessionManager: stubSessionManager() });

        // A worker's writable surface comes from its definition; borrowing the parent's host grants would
        // turn a statement about the user's own session into a child capability.
        await expect(
            invoke(
                stub.requireHandler("tool_call"),
                {
                    toolName: "write",
                    input: { path: path.join(declared, "writable", "notes.md") },
                },
                ctx,
            ),
        ).resolves.toMatchObject({ block: true });
    });
});
