import { describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createAgentChild } from "../../src/tools/agent/child";
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
});
