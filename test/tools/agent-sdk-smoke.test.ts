import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const memoryExtensionFactory = vi.hoisted(() => vi.fn());
const todoExtensionFactory = vi.hoisted(() => vi.fn());
vi.mock("../../src/modules/memory", () => ({ default: memoryExtensionFactory }));
vi.mock("../../src/modules/todolist", () => ({ default: todoExtensionFactory }));
import {
    ModelRegistry,
    ModelRuntime,
    SessionManager,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    createAgentChild,
    createChildModelRuntime,
    shouldCopyParentApiKey,
} from "../../src/tools/agent/child";
import {
    BUILTIN_ADVISOR,
    BUILTIN_REVIEWER,
    BUILTIN_SCOUT,
    BUILTIN_WORKER,
} from "../../src/tools/agent/definitions/discovery";
import { capabilityTools } from "../../src/tools/agent/child/capabilities";
import { ZERO_USAGE } from "../../src/tools/agent/runs/manager";

/**
 * Real construction needs a live model runtime plus a registry stub. The reopen tests below share
 * this so they differ only in the transcript arguments under test.
 */
async function smokeHarness(modelIndex = 0): Promise<{
    source: ModelRuntime;
    model: ReturnType<ModelRuntime["getModels"]>[number] | undefined;
    parentContext: Record<string, unknown>;
}> {
    const source = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
    const model = source.getModels()[modelIndex];
    const parentContext = {
        model,
        mode: "print",
        hasUI: false,
        thinkingLevel: "off",
        modelRegistry: {
            getRegisteredNativeProvider: () => undefined,
            getRegisteredProviderConfig: () => undefined,
            getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "smoke-test" }),
            isUsingOAuth: () => false,
            find: (provider: string, id: string) => source.getModel(provider, id),
            getAll: () => [...source.getModels()],
        },
    };
    return { source, model, parentContext };
}

describe("in-process scout SDK session", () => {
    it("constructs and disposes without a provider call or discovered parent extensions", async () => {
        const source = await ModelRuntime.create({
            refreshOnCreate: false,
            modelsPath: null,
        });
        const model = source.getModels()[0];
        expect(model).toBeDefined();
        if (!model) return;

        const parentContext = {
            model,
            mode: "tui",
            hasUI: true,
            thinkingLevel: "off",
            modelRegistry: {
                getRegisteredNativeProvider: () => undefined,
                getRegisteredProviderConfig: () => undefined,
                getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "smoke-test" }),
                isUsingOAuth: () => false,
                find: (provider: string, id: string) => source.getModel(provider, id),
                getAll: () => [...source.getModels()],
            },
        };

        const child = await createAgentChild({
            cwd: process.cwd(),
            definition: BUILTIN_SCOUT,
            parentContext,
            onProgress: () => {},
        });

        expect(child.getError()).toBeUndefined();
        expect(child.getUsage().totalTokens).toBe(0);
        child.dispose();

        const backgroundEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const backgroundChild = await createAgentChild({
            cwd: process.cwd(),
            definition: BUILTIN_SCOUT,
            parentContext,
            background: true,
            onProgress: () => {},
            onTrace: (type, data) => backgroundEvents.push({ type, data }),
        });
        expect(backgroundEvents).toContainEqual({
            type: "session.created",
            data: { toolCount: capabilityTools(BUILTIN_SCOUT).length + 2 },
        });
        expect(backgroundEvents).toContainEqual({
            type: "resources.loaded",
            data: {
                readOnlyToolCount: capabilityTools(BUILTIN_SCOUT).length,
                directUserUI: true,
                background: true,
            },
        });
        backgroundChild.dispose();

        const reviewerEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const reviewer = await createAgentChild({
            cwd: process.cwd(),
            definition: BUILTIN_REVIEWER,
            parentContext,
            background: true,
            onProgress: () => {},
            onTrace: (type, data) => reviewerEvents.push({ type, data }),
        });
        expect(reviewerEvents).toContainEqual({
            type: "session.created",
            data: { toolCount: capabilityTools(BUILTIN_REVIEWER).length + 2 },
        });
        reviewer.dispose();

        const workerEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const worker = await createAgentChild({
            cwd: process.cwd(),
            definition: BUILTIN_WORKER,
            parentContext,
            background: true,
            runId: "worker-smoke",
            onProgress: () => {},
            onTrace: (type, data) => workerEvents.push({ type, data }),
        });
        expect(workerEvents).toContainEqual({
            type: "session.created",
            data: { toolCount: capabilityTools(BUILTIN_WORKER).length + 2 },
        });
        expect(worker.getMutationReport?.()).toEqual({ changedFiles: [], bashApproved: false });
        expect(todoExtensionFactory).toHaveBeenCalledTimes(1);
        worker.dispose();

        const advisorEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const advisor = await createAgentChild({
            cwd: process.cwd(),
            definition: BUILTIN_ADVISOR,
            parentContext,
            background: true,
            onProgress: () => {},
            onTrace: (type, data) => advisorEvents.push({ type, data }),
        });
        expect(advisorEvents).toContainEqual({
            type: "session.created",
            data: { toolCount: capabilityTools(BUILTIN_ADVISOR).length + 1 },
        });
        advisor.dispose();
    });

    it("loads the memory extension according to the memories capability", async () => {
        memoryExtensionFactory.mockClear();
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-memory-"));
        try {
            const source = await ModelRuntime.create({
                refreshOnCreate: false,
                modelsPath: null,
            });
            const model = source.getModels()[0];
            expect(model).toBeDefined();
            if (!model) return;

            const child = await createAgentChild({
                cwd,
                definition: {
                    ...BUILTIN_SCOUT,
                    capabilities: BUILTIN_SCOUT.capabilities.filter(
                        (capability) => capability !== "memories",
                    ),
                },
                parentContext: {
                    model,
                    thinkingLevel: "off",
                    modelRegistry: {
                        getRegisteredNativeProvider: () => undefined,
                        getRegisteredProviderConfig: () => undefined,
                        getApiKeyAndHeaders: async () => ({
                            ok: true as const,
                            apiKey: "smoke-test",
                        }),
                        isUsingOAuth: () => false,
                        find: (provider: string, id: string) => source.getModel(provider, id),
                        getAll: () => [...source.getModels()],
                    },
                },
                onProgress: () => {},
            });

            expect(memoryExtensionFactory).not.toHaveBeenCalled();
            child.dispose();

            const memoryChild = await createAgentChild({
                cwd,
                definition: BUILTIN_SCOUT,
                parentContext: {
                    model,
                    thinkingLevel: "off",
                    modelRegistry: {
                        getRegisteredNativeProvider: () => undefined,
                        getRegisteredProviderConfig: () => undefined,
                        getApiKeyAndHeaders: async () => ({
                            ok: true as const,
                            apiKey: "smoke-test",
                        }),
                        isUsingOAuth: () => false,
                        find: (provider: string, id: string) => source.getModel(provider, id),
                        getAll: () => [...source.getModels()],
                    },
                },
                onProgress: () => {},
            });

            expect(memoryExtensionFactory).toHaveBeenCalledTimes(1);
            memoryChild.dispose();
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });

    it("reopens a persisted child transcript without a provider call", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-session-"));
        try {
            const source = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
            const model = source.getModels()[0];
            expect(model).toBeDefined();
            if (!model) return;
            const sessionManager = SessionManager.create(process.cwd(), directory);
            sessionManager.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: "Persisted child context" }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
                stopReason: "stop",
                timestamp: Date.now(),
            });
            const sessionFile = sessionManager.getSessionFile();
            expect(sessionFile).toBeDefined();

            const child = await createAgentChild({
                cwd: process.cwd(),
                definition: BUILTIN_SCOUT,
                parentContext: {
                    model,
                    thinkingLevel: "off",
                    modelRegistry: {
                        getRegisteredNativeProvider: () => undefined,
                        getRegisteredProviderConfig: () => undefined,
                        getApiKeyAndHeaders: async () => ({
                            ok: true as const,
                            apiKey: "smoke-test",
                        }),
                        isUsingOAuth: () => false,
                        find: (provider: string, id: string) => source.getModel(provider, id),
                        getAll: () => [...source.getModels()],
                    },
                },
                childSessionDir: directory,
                childSessionFile: sessionFile,
                onProgress: () => {},
            });

            expect(child.sessionFile).toBe(sessionFile);
            expect(child.getFinalOutput()).toBe("Persisted child context");
            child.dispose();
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it("uses the persisted child model when the current definition selects another model", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-model-"));
        try {
            const source = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
            const models = source.getModels();
            const originalModel = models[0];
            const currentModel = models[1];
            expect(originalModel).toBeDefined();
            expect(currentModel).toBeDefined();
            if (!originalModel || !currentModel) return;

            const sessionManager = SessionManager.create(process.cwd(), directory);
            sessionManager.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: "Original model response" }],
                api: originalModel.api,
                provider: originalModel.provider,
                model: originalModel.id,
                usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
                stopReason: "stop",
                timestamp: Date.now(),
            });
            const sessionFile = sessionManager.getSessionFile();
            const resolvedModels: string[] = [];
            const child = await createAgentChild({
                cwd: process.cwd(),
                definition: {
                    ...BUILTIN_SCOUT,
                    model: `${currentModel.provider}/${currentModel.id}`,
                },
                parentContext: {
                    model: currentModel,
                    modelRegistry: {
                        getRegisteredNativeProvider: () => undefined,
                        getRegisteredProviderConfig: () => undefined,
                        getApiKeyAndHeaders: async () => ({
                            ok: true as const,
                            apiKey: "smoke-test",
                        }),
                        isUsingOAuth: () => false,
                        find: (provider: string, id: string) => source.getModel(provider, id),
                        getAll: () => [...source.getModels()],
                    },
                },
                childSessionDir: directory,
                childSessionFile: sessionFile,
                onProgress: () => {},
                onTrace: (type, data) => {
                    if (type === "model.resolved")
                        resolvedModels.push(`${data?.provider}/${data?.model}`);
                },
            });

            expect(resolvedModels).toContain(`${originalModel.provider}/${originalModel.id}`);
            child.dispose();
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    /**
     * `SessionManager.open()` points at the newest physical leaf, so restoration must select the
     * persisted leaf *before* the session context is built. Two identical transcripts, constructed
     * the same way except for the leaf argument: the visible difference is which assistant turn the
     * child can see, which is what proves the ordering. Selecting after the context build would show
     * the newest turn. Each arm gets its own directory because selection writes a branch into the
     * transcript, and a shared file would let the first arm decide the second one's result.
     */
    it("builds the child context from the persisted leaf, not the newest one", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-leaf-"));
        try {
            const { model, parentContext } = await smokeHarness();
            expect(model).toBeDefined();
            if (!model) return;

            const transcript = (
                name: string,
            ): { dir: string; file: string; firstLeaf: string | null } => {
                const dir = fs.mkdtempSync(path.join(root, name));
                const writer = SessionManager.create(process.cwd(), dir);
                const append = (text: string): void => {
                    writer.appendMessage({
                        role: "assistant",
                        content: [{ type: "text", text }],
                        api: model.api,
                        provider: model.provider,
                        model: model.id,
                        usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
                        stopReason: "stop",
                        timestamp: Date.now(),
                    });
                };
                append("First turn");
                const firstLeaf = writer.getLeafId();
                append("Second turn");
                return { dir, file: writer.getSessionFile() ?? "", firstLeaf };
            };

            const newest = transcript("newest");
            const unselected = await createAgentChild({
                cwd: process.cwd(),
                definition: BUILTIN_SCOUT,
                parentContext,
                childSessionDir: newest.dir,
                childSessionFile: newest.file,
                onProgress: () => {},
            });
            expect(unselected.getFinalOutput()).toBe("Second turn");
            unselected.dispose();

            const selected = transcript("selected");
            const resumed = await createAgentChild({
                cwd: process.cwd(),
                definition: BUILTIN_SCOUT,
                parentContext,
                childSessionDir: selected.dir,
                childSessionFile: selected.file,
                childSessionLeafId: selected.firstLeaf,
                onProgress: () => {},
            });
            expect(resumed.getFinalOutput()).toBe("First turn");
            // Constructing the session appends to the branch, so the pointer has moved on; the
            // proof is the context content asserted above, not the leaf id.
            resumed.dispose();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    /** The middle arm of the session bootstrap: a directory with no transcript yet on disk. */
    it("materializes a persistent transcript when only a session directory is given", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-materialize-"));
        try {
            const { model, parentContext } = await smokeHarness();
            expect(model).toBeDefined();
            if (!model) return;

            const child = await createAgentChild({
                cwd: process.cwd(),
                definition: BUILTIN_SCOUT,
                parentContext,
                childSessionDir: directory,
                onProgress: () => {},
            });

            expect(child.sessionFile).toBeDefined();
            expect(fs.existsSync(child.sessionFile!)).toBe(true);
            child.dispose();
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    /**
     * Disposal is reachable from both the run manager and the factory's own rollback path, so the
     * guard flag is what keeps an unsubscribe from running twice against one session.
     */
    it("releases the session once when dispose is called twice", async () => {
        const { model, parentContext } = await smokeHarness();
        expect(model).toBeDefined();
        if (!model) return;

        const events: string[] = [];
        const child = await createAgentChild({
            cwd: process.cwd(),
            definition: BUILTIN_SCOUT,
            parentContext,
            onProgress: () => {},
            onTrace: (type) => {
                events.push(type);
            },
        });

        child.dispose();
        child.dispose();

        expect(events.filter((type) => type === "session.dispose_called")).toHaveLength(1);
    });

    it("preserves persisted OpenAI Codex OAuth when available", async () => {
        const parentRuntime = await ModelRuntime.create({ refreshOnCreate: false });
        const model = parentRuntime.getModels("openai-codex")[0];
        if (!model || !(await parentRuntime.getAuth(model))) return;

        const parentContext = {
            modelRegistry: new ModelRegistry(parentRuntime),
        } as ExtensionContext;
        const childRuntime = await createChildModelRuntime(parentContext, model);
        const childModel = childRuntime.getModel(model.provider, model.id);
        const childAuth = childModel ? await childRuntime.getAuth(childModel) : undefined;

        expect(childAuth?.auth.apiKey || childAuth?.auth.headers).toBeTruthy();
        expect(childRuntime.isUsingOAuth("openai-codex")).toBe(true);
    });

    it("does not replace child OAuth auth with an API-key credential", () => {
        expect(
            shouldCopyParentApiKey({
                childHasAuth: true,
                parentHasApiKey: true,
                parentUsesOAuth: true,
            }),
        ).toBe(false);
        expect(
            shouldCopyParentApiKey({
                childHasAuth: false,
                parentHasApiKey: true,
                parentUsesOAuth: true,
            }),
        ).toBe(false);
        expect(
            shouldCopyParentApiKey({
                childHasAuth: false,
                parentHasApiKey: true,
                parentUsesOAuth: false,
            }),
        ).toBe(true);
    });
});
