import { createHash } from "node:crypto";

import type { AgentContextPolicy } from "../contracts/context";

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
    contextPolicy?: AgentContextPolicy;
    source: AgentSource;
    filePath?: string;
    /** Built-ins only: grants mutation tools through the worker permission gate. */
    mutating?: boolean;
    /** Whether a foreground child may ask the end user directly. Defaults to true. */
    allowUserInteraction?: boolean;
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
    return hashDefinition(definition, true);
}

/** Fingerprint format used before runtime context policies were introduced. */
export function fingerprintLegacyAgentDefinition(definition: AgentDefinition): string {
    return hashDefinition(definition, false);
}

/** Accept old persisted records when only the context-policy field changed. */
export function isAgentDefinitionFingerprintCompatible(
    definition: AgentDefinition,
    fingerprint: string,
): boolean {
    return fingerprintAgentDefinition(definition) === fingerprint
        || fingerprintLegacyAgentDefinition(definition) === fingerprint;
}

function hashDefinition(definition: AgentDefinition, includeContextPolicy: boolean): string {
    const normalized = JSON.stringify({
        name: definition.name,
        description: definition.description,
        capabilities: [...definition.capabilities].sort(),
        model: definition.model ?? null,
        systemPrompt: definition.systemPrompt,
        ...(includeContextPolicy
            ? {
                contextPolicy: definition.contextPolicy
                    ? {
                        sectionIds: [...definition.contextPolicy.sectionIds],
                        maxChars: definition.contextPolicy.maxChars,
                    }
                    : null,
            }
            : {}),
        source: definition.source,
        filePath: definition.filePath ?? null,
        mutating: definition.mutating === true,
        ...(includeContextPolicy
            ? { allowUserInteraction: definition.allowUserInteraction !== false }
            : {}),
    });
    return createHash("sha256").update(normalized).digest("hex");
}
