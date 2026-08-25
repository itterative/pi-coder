import { createHash } from "node:crypto";

export type AgentSource = "builtin" | "user" | "project";

/** User-configurable capabilities for read-only delegated agents. */
export const AGENT_CAPABILITIES = ["safe-bash"] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/** Tools granted to every delegated agent for baseline codebase inspection. */
export const READ_ONLY_AGENT_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface AgentDefinition {
    name: string;
    description: string;
    /** Explicit privileges beyond the baseline codebase-read tools. */
    capabilities: AgentCapability[];
    model?: string;
    systemPrompt: string;
    source: AgentSource;
    filePath?: string;
    /** Built-ins only: grants mutation tools through the worker permission gate. */
    mutating?: boolean;
}

/** Maps the capability policy to the concrete SDK tools supplied to a child. */
export function agentTools(definition: AgentDefinition): string[] {
    const tools: string[] = [...READ_ONLY_AGENT_TOOLS];
    if (definition.mutating) return [...tools, "edit", "write", "bash"];
    if (definition.capabilities.includes("safe-bash")) tools.push("bash");
    return tools;
}

/** Stable capability/prompt identity used to validate durable child sessions. */
export function fingerprintAgentDefinition(definition: AgentDefinition): string {
    const normalized = JSON.stringify({
        name: definition.name,
        description: definition.description,
        capabilities: [...definition.capabilities].sort(),
        model: definition.model ?? null,
        systemPrompt: definition.systemPrompt,
        source: definition.source,
        filePath: definition.filePath ?? null,
        mutating: definition.mutating === true,
    });
    return createHash("sha256").update(normalized).digest("hex");
}
