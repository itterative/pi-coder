import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentDefinition } from "./definitions/types";

export const BUILTIN_AGENT_NAMES = ["scout", "reviewer", "worker"] as const;
export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];
export type BuiltinAgentModels = Partial<Record<BuiltinAgentName, string>>;

export interface AgentConfig {
    /** Models override the parent model for individual built-in agents. */
    models?: BuiltinAgentModels;
}

function globalConfigPath(): string {
    return process.env.AGENT_CONFIG_PATH_GLOBAL ?? path.join(os.homedir(), ".pi", "agent-config.json");
}

function projectConfigPath(cwd: string): string | undefined {
    let current = path.resolve(cwd);
    for (let index = 0; index < 20; index++) {
        const candidate = path.join(current, ".pi", "agent-config.json");
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return process.env.AGENT_CONFIG_PATH;
}

function parseConfig(filePath: string | undefined): AgentConfig | null {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!value || typeof value !== "object") return null;
        const modelsValue = (value as { models?: unknown }).models;
        if (!modelsValue || typeof modelsValue !== "object") return {};
        const models: BuiltinAgentModels = {};
        for (const name of BUILTIN_AGENT_NAMES) {
            const model = (modelsValue as Record<string, unknown>)[name];
            if (typeof model === "string" && model.trim()) models[name] = model.trim();
        }
        return { models };
    } catch {
        return null;
    }
}

function mergeConfigs(global: AgentConfig | null, project: AgentConfig | null): AgentConfig {
    const models: BuiltinAgentModels = {
        ...(global?.models ?? {}),
        ...(project?.models ?? {}),
    };
    return Object.keys(models).length ? { models } : {};
}

function locations(cwd: string): { global: string; project?: string } {
    return {
        global: globalConfigPath(),
        project: projectConfigPath(cwd),
    };
}

let _config: AgentConfig | null = null;

function loadConfig(cwd: string): AgentConfig {
    const paths = locations(cwd);
    const config = mergeConfigs(parseConfig(paths.global), parseConfig(paths.project));
    _config = config;
    return config;
}

function configPath(cwd: string): string {
    const paths = locations(cwd);
    return paths.project ?? paths.global;
}

export function configuredBuiltinModel(
    config: AgentConfig,
    name: BuiltinAgentName,
): string | undefined {
    return config.models?.[name];
}

/** Apply persisted built-in model overrides without mutating shared definitions. */
export function applyAgentConfig(
    agents: AgentDefinition[],
    config: AgentConfig,
): AgentDefinition[] {
    return agents.map((agent) => {
        if (!BUILTIN_AGENT_NAMES.includes(agent.name as BuiltinAgentName)) return agent;
        const model = configuredBuiltinModel(config, agent.name as BuiltinAgentName);
        return model ? { ...agent, model } : agent;
    });
}

const agentConfig = {
    get current(): AgentConfig | null {
        return _config;
    },

    get(cwd: string): AgentConfig {
        return loadConfig(cwd);
    },

    load(cwd: string): AgentConfig {
        return loadConfig(cwd);
    },

    save(config: AgentConfig, cwd = process.cwd()): AgentConfig {
        const filePath = configPath(cwd);
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
        fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        _config = config;
        return config;
    },

    setModel(name: BuiltinAgentName, model: string | undefined, cwd = process.cwd()): AgentConfig {
        const next: BuiltinAgentModels = { ...loadConfig(cwd).models };
        if (model) next[name] = model;
        else delete next[name];
        return this.save(Object.keys(next).length ? { models: next } : {}, cwd);
    },
};

export default agentConfig;
