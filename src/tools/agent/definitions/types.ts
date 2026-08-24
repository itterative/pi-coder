import { createHash } from "node:crypto";

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
