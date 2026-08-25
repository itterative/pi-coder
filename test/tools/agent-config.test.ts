import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import agentConfig, { applyAgentConfig } from "../../src/tools/agent/config";
import { BUILTIN_SCOUT, BUILTIN_WORKER } from "../../src/tools/agent/definitions/discovery";

function clearCache(): void {
    (agentConfig as unknown as { _config: unknown })._config = null;
}

describe("agent configuration", () => {
    let root: string;
    let project: string;
    let globalPath: string;
    let previousGlobal: string | undefined;
    let previousProject: string | undefined;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-config-"));
        project = path.join(root, "project");
        fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
        globalPath = path.join(root, "global.json");
        previousGlobal = process.env.AGENT_CONFIG_PATH_GLOBAL;
        previousProject = process.env.AGENT_CONFIG_PATH;
        process.env.AGENT_CONFIG_PATH_GLOBAL = globalPath;
        delete process.env.AGENT_CONFIG_PATH;
        clearCache();
    });

    afterEach(() => {
        if (previousGlobal === undefined) delete process.env.AGENT_CONFIG_PATH_GLOBAL;
        else process.env.AGENT_CONFIG_PATH_GLOBAL = previousGlobal;
        if (previousProject === undefined) delete process.env.AGENT_CONFIG_PATH;
        else process.env.AGENT_CONFIG_PATH = previousProject;
        clearCache();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("merges global and project built-in model overrides", () => {
        fs.writeFileSync(globalPath, JSON.stringify({ models: { scout: "openai/gpt-4o", worker: "anthropic/sonnet" } }));
        fs.writeFileSync(path.join(project, ".pi", "agent-config.json"), JSON.stringify({ models: { scout: "openai/gpt-4.1" } }));

        expect(agentConfig.load(project)).toEqual({
            models: {
                scout: "openai/gpt-4.1",
                worker: "anthropic/sonnet",
            },
        });
    });

    it("applies overrides without mutating built-in definitions", () => {
        const result = applyAgentConfig([BUILTIN_SCOUT, BUILTIN_WORKER], {
            models: { scout: "openai/gpt-4.1", worker: "anthropic/sonnet" },
        });

        expect(result.map((agent) => agent.model)).toEqual(["openai/gpt-4.1", "anthropic/sonnet"]);
        expect(BUILTIN_SCOUT.model).toBeUndefined();
        expect(BUILTIN_WORKER.model).toBeUndefined();
    });

    it("persists a model override and removes it when parent model is selected", () => {
        agentConfig.setModel("scout", "openai/gpt-4.1", project);
        expect(JSON.parse(fs.readFileSync(globalPath, "utf8"))).toEqual({
            models: { scout: "openai/gpt-4.1" },
        });

        agentConfig.setModel("scout", undefined, project);
        expect(agentConfig.load(project)).toEqual({});
    });
});
