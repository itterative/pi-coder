import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    CONFIG_DIR_NAME,
    getAgentDir,
    parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export const READ_ONLY_AGENT_TOOLS = ["read", "grep", "find", "ls"] as const;
const READ_ONLY_TOOL_SET = new Set<string>(READ_ONLY_AGENT_TOOLS);
const RESERVED_AGENT_NAMES = new Set(["scout", "worker"]);
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export type AgentSource = "builtin" | "user" | "project";

export interface AgentDefinition {
    name: string;
    description: string;
    tools: string[];
    model?: string;
    systemPrompt: string;
    source: AgentSource;
    filePath?: string;
    /** Built-ins only: grants mutation tools through the worker permission gate. */
    mutating?: boolean;
}

export interface AgentDiagnostic {
    level: "info" | "warning";
    message: string;
    paths: string[];
}

export interface AgentDiscoveryResult {
    agents: AgentDefinition[];
    diagnostics: AgentDiagnostic[];
}

/** Stable capability/prompt identity used to validate durable child sessions. */
export function fingerprintAgentDefinition(definition: AgentDefinition): string {
    const normalized = JSON.stringify({
        name: definition.name,
        description: definition.description,
        tools: [...definition.tools],
        model: definition.model ?? null,
        systemPrompt: definition.systemPrompt,
        source: definition.source,
        filePath: definition.filePath ?? null,
        mutating: definition.mutating === true,
    });
    return createHash("sha256").update(normalized).digest("hex");
}

type AgentFrontmatter = {
    name?: unknown;
    description?: unknown;
    tools?: unknown;
    model?: unknown;
};

export const BUILTIN_SCOUT: AgentDefinition = {
    name: "scout",
    description: "Read-only codebase reconnaissance",
    tools: [...READ_ONLY_AGENT_TOOLS],
    systemPrompt: `You are the built-in pi-coder scout, a read-only subagent working for a parent coding agent.

Explore the codebase thoroughly and return concise, evidence-based findings. Cite relevant file paths and symbols. You may read, search, find, and list files, but you cannot run commands or modify files.`,
    source: "builtin",
};

export const BUILTIN_WORKER: AgentDefinition = {
    name: "worker",
    description: "Permission-gated implementation work in the current checkout",
    tools: [...READ_ONLY_AGENT_TOOLS, "edit", "write", "bash"],
    systemPrompt: `You are the built-in pi-coder worker, a mutation-capable subagent working in the parent's current checkout.

Inspect relevant code before changing it. Every edit, write, and bash call requires explicit end-user approval; call mutation tools one at a time rather than batching them. Keep changes narrow, avoid destructive git operations, and account for concurrent parent activity in the same checkout. When complete, report what you changed, list affected files, state validation performed, and disclose any uncertainty.`,
    source: "builtin",
    mutating: true,
};

function sortedMarkdownFiles(dir: string): string[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
            .map((entry) => path.join(dir, entry.name))
            .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    } catch {
        return [];
    }
}

function parseTools(value: unknown): string[] {
    const raw = Array.isArray(value)
        ? value.filter((tool): tool is string => typeof tool === "string")
        : typeof value === "string"
            ? value.split(",")
            : [...READ_ONLY_AGENT_TOOLS];
    return [...new Set(raw.map((tool) => tool.trim()).filter(Boolean))];
}

function loadScope(
    dir: string,
    source: "user" | "project",
    diagnostics: AgentDiagnostic[],
): AgentDefinition[] {
    const selected = new Map<string, AgentDefinition>();

    for (const filePath of sortedMarkdownFiles(dir)) {
        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf8");
        } catch (error) {
            diagnostics.push({
                level: "warning",
                message: `Could not read ${source} agent definition: ${errorMessage(error)}`,
                paths: [filePath],
            });
            continue;
        }

        let parsed: ReturnType<typeof parseFrontmatter<AgentFrontmatter>>;
        try {
            parsed = parseFrontmatter<AgentFrontmatter>(content);
        } catch (error) {
            diagnostics.push({
                level: "warning",
                message: `Invalid ${source} agent frontmatter: ${errorMessage(error)}`,
                paths: [filePath],
            });
            continue;
        }

        const { name, description, tools, model } = parsed.frontmatter;
        if (typeof name !== "string" || !AGENT_NAME.test(name)) {
            diagnostics.push({
                level: "warning",
                message: "Agent name must match /^[a-z][a-z0-9_-]{0,63}$/.",
                paths: [filePath],
            });
            continue;
        }
        if (typeof description !== "string" || !description.trim()) {
            diagnostics.push({
                level: "warning",
                message: "Agent description must be a non-empty string.",
                paths: [filePath],
            });
            continue;
        }
        if (RESERVED_AGENT_NAMES.has(name)) {
            diagnostics.push({
                level: "warning",
                message: `Agent name "${name}" is reserved; the markdown definition was ignored.`,
                paths: [filePath],
            });
            continue;
        }
        if (model !== undefined && typeof model !== "string") {
            diagnostics.push({
                level: "warning",
                message: "Agent model must be a provider/model string.",
                paths: [filePath],
            });
            continue;
        }

        const requestedTools = parseTools(tools);
        const allowedTools = requestedTools.filter((tool) => READ_ONLY_TOOL_SET.has(tool));
        const ignoredTools = requestedTools.filter((tool) => !READ_ONLY_TOOL_SET.has(tool));
        if (ignoredTools.length) {
            diagnostics.push({
                level: "warning",
                message: `Unsupported tools were removed from agent "${name}": ${ignoredTools.join(", ")}.`,
                paths: [filePath],
            });
        }

        const existing = selected.get(name);
        if (existing) {
            diagnostics.push({
                level: "warning",
                message: `Duplicate ${source} agent "${name}" ignored; the first sorted definition wins.`,
                paths: [existing.filePath!, filePath],
            });
            continue;
        }

        selected.set(name, {
            name,
            description: description.trim(),
            tools: allowedTools,
            model: typeof model === "string" && model.trim() ? model.trim() : undefined,
            systemPrompt: parsed.body.trim(),
            source,
            filePath,
        });
    }

    return [...selected.values()];
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
    let current = path.resolve(cwd);
    while (true) {
        const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
        try {
            if (fs.statSync(candidate).isDirectory()) return candidate;
        } catch {
            // Continue toward the filesystem root.
        }
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

export function discoverAgentsInDirectories(
    userDir: string,
    projectDir?: string,
): AgentDiscoveryResult {
    const diagnostics: AgentDiagnostic[] = [];
    const userAgents = loadScope(userDir, "user", diagnostics);
    const projectAgents = projectDir ? loadScope(projectDir, "project", diagnostics) : [];

    const merged = new Map<string, AgentDefinition>();
    merged.set(BUILTIN_SCOUT.name, BUILTIN_SCOUT);
    merged.set(BUILTIN_WORKER.name, BUILTIN_WORKER);
    for (const agent of userAgents) merged.set(agent.name, agent);
    for (const agent of projectAgents) {
        const existing = merged.get(agent.name);
        if (existing?.source === "user") {
            diagnostics.push({
                level: "info",
                message: `Project agent "${agent.name}" overrides the user agent.`,
                paths: [existing.filePath!, agent.filePath!],
            });
        }
        merged.set(agent.name, agent);
    }

    return {
        agents: [...merged.values()],
        diagnostics,
    };
}

export function discoverAgents(cwd: string, projectTrusted: boolean): AgentDiscoveryResult {
    const projectDir = projectTrusted ? nearestProjectAgentsDir(cwd) : undefined;
    return discoverAgentsInDirectories(path.join(getAgentDir(), "agents"), projectDir);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
