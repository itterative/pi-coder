import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import agentConfig, {
    applyAgentConfig,
    isAdvisorEnabled,
    maxWorkspacesPerRepo,
    shouldNotifyBusyWorkerChanges,
} from "../../src/tools/agent/config";
import {
    BUILTIN_ADVISOR,
    BUILTIN_SCOUT,
    BUILTIN_WORKER,
} from "../../src/tools/agent/definitions/discovery";

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
        fs.writeFileSync(
            globalPath,
            JSON.stringify({ models: { scout: "openai/gpt-4o", worker: "anthropic/sonnet" } }),
        );
        fs.writeFileSync(
            path.join(project, ".pi", "agent-config.json"),
            JSON.stringify({ models: { scout: "openai/gpt-4.1" } }),
        );

        expect(agentConfig.load(project)).toEqual({
            models: {
                scout: "openai/gpt-4.1",
                worker: "anthropic/sonnet",
            },
        });
    });

    it("merges and defaults advisor availability", () => {
        fs.writeFileSync(globalPath, JSON.stringify({ advisorEnabled: true }));
        expect(isAdvisorEnabled(agentConfig.load(project))).toBe(true);

        fs.writeFileSync(
            path.join(project, ".pi", "agent-config.json"),
            JSON.stringify({ advisorEnabled: false }),
        );
        expect(isAdvisorEnabled(agentConfig.load(project))).toBe(false);
        expect(isAdvisorEnabled({})).toBe(false);
    });

    it("merges and defaults busy worker change notifications", () => {
        fs.writeFileSync(globalPath, JSON.stringify({ notifyBusyWorkerChanges: false }));
        expect(shouldNotifyBusyWorkerChanges(agentConfig.load(project))).toBe(false);

        fs.writeFileSync(
            path.join(project, ".pi", "agent-config.json"),
            JSON.stringify({ notifyBusyWorkerChanges: true }),
        );
        expect(shouldNotifyBusyWorkerChanges(agentConfig.load(project))).toBe(true);
    });

    it("merges and defaults the workspace capacity", () => {
        expect(maxWorkspacesPerRepo(agentConfig.load(project))).toBe(3);

        fs.writeFileSync(globalPath, JSON.stringify({ maxWorkspacesPerRepo: 6 }));
        expect(maxWorkspacesPerRepo(agentConfig.load(project))).toBe(6);

        fs.writeFileSync(
            path.join(project, ".pi", "agent-config.json"),
            JSON.stringify({ maxWorkspacesPerRepo: 2 }),
        );
        expect(maxWorkspacesPerRepo(agentConfig.load(project))).toBe(2);
    });

    it("preserves inherited values when saving project overrides", () => {
        const projectConfigPath = path.join(project, ".pi", "agent-config.json");
        fs.writeFileSync(
            globalPath,
            JSON.stringify({
                models: { scout: "global/scout", reviewer: "global/reviewer" },
                advisorEnabled: true,
                notifyBusyWorkerChanges: false,
            }),
        );
        fs.writeFileSync(
            projectConfigPath,
            JSON.stringify({
                models: { worker: "project/worker" },
                advisorEnabled: false,
            }),
        );

        agentConfig.setNotifyBusyWorkerChanges(true, project);
        expect(JSON.parse(fs.readFileSync(projectConfigPath, "utf8"))).toEqual({
            models: { worker: "project/worker" },
            advisorEnabled: false,
            notifyBusyWorkerChanges: true,
        });
        expect(JSON.parse(fs.readFileSync(globalPath, "utf8"))).toEqual({
            models: { scout: "global/scout", reviewer: "global/reviewer" },
            advisorEnabled: true,
            notifyBusyWorkerChanges: false,
        });

        agentConfig.setModel("scout", "project/scout", project);
        expect(JSON.parse(fs.readFileSync(projectConfigPath, "utf8"))).toEqual({
            models: { worker: "project/worker", scout: "project/scout" },
            advisorEnabled: false,
            notifyBusyWorkerChanges: true,
        });
        expect(agentConfig.load(project)).toEqual({
            models: {
                scout: "project/scout",
                reviewer: "global/reviewer",
                worker: "project/worker",
            },
            advisorEnabled: false,
            notifyBusyWorkerChanges: true,
        });
    });

    it("applies overrides without mutating built-in definitions", () => {
        const result = applyAgentConfig([BUILTIN_ADVISOR, BUILTIN_SCOUT, BUILTIN_WORKER], {
            advisorEnabled: true,
            models: { advisor: "openai/o3", scout: "openai/gpt-4.1", worker: "anthropic/sonnet" },
        });

        expect(result.map((agent) => agent.model)).toEqual([
            "openai/o3",
            "openai/gpt-4.1",
            "anthropic/sonnet",
        ]);
        expect(BUILTIN_ADVISOR.model).toBeUndefined();
        expect(BUILTIN_SCOUT.model).toBeUndefined();
        expect(BUILTIN_WORKER.model).toBeUndefined();
        expect(applyAgentConfig([BUILTIN_ADVISOR], {})).toEqual([]);
    });

    it("persists notification preference, advisor availability, model overrides, and workspace capacity", () => {
        agentConfig.setAdvisorEnabled(true, project);
        expect(JSON.parse(fs.readFileSync(globalPath, "utf8"))).toEqual({
            advisorEnabled: true,
        });

        agentConfig.setNotifyBusyWorkerChanges(false, project);
        expect(JSON.parse(fs.readFileSync(globalPath, "utf8"))).toEqual({
            advisorEnabled: true,
            notifyBusyWorkerChanges: false,
        });
        expect(agentConfig.load(project).notifyBusyWorkerChanges).toBe(false);
        expect(agentConfig.load(project).advisorEnabled).toBe(true);

        agentConfig.setModel("scout", "openai/gpt-4.1", project);
        expect(JSON.parse(fs.readFileSync(globalPath, "utf8"))).toEqual({
            models: { scout: "openai/gpt-4.1" },
            advisorEnabled: true,
            notifyBusyWorkerChanges: false,
        });

        agentConfig.setMaxWorkspacesPerRepo(7, project);
        expect(JSON.parse(fs.readFileSync(globalPath, "utf8"))).toEqual({
            models: { scout: "openai/gpt-4.1" },
            advisorEnabled: true,
            notifyBusyWorkerChanges: false,
            maxWorkspacesPerRepo: 7,
        });

        agentConfig.setModel("scout", undefined, project);
        expect(agentConfig.load(project)).toEqual({
            advisorEnabled: true,
            notifyBusyWorkerChanges: false,
            maxWorkspacesPerRepo: 7,
        });
    });
});
