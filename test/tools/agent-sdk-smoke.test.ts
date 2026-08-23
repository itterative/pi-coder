import { describe, expect, it } from "vitest";
import {
    ModelRegistry,
    ModelRuntime,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    createAgentChild,
    createChildModelRuntime,
    shouldCopyParentApiKey,
} from "../../src/tools/agent/child";
import { BUILTIN_SCOUT } from "../../src/tools/agent/discovery";

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
        expect(shouldCopyParentApiKey({
            childHasAuth: true,
            parentHasApiKey: true,
            parentUsesOAuth: true,
        })).toBe(false);
        expect(shouldCopyParentApiKey({
            childHasAuth: false,
            parentHasApiKey: true,
            parentUsesOAuth: true,
        })).toBe(false);
        expect(shouldCopyParentApiKey({
            childHasAuth: false,
            parentHasApiKey: true,
            parentUsesOAuth: false,
        })).toBe(true);
    });
});
