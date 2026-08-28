import { createHash } from "node:crypto";

import type { AgentContextPolicy } from "../contracts/context";

export type AgentSource = "builtin" | "user" | "project";

/** Capabilities available to delegated agents. */
export const AGENT_CAPABILITIES = [
    "read",
    "search",
    "memories",
    "scratchpad",
    "safe-bash",
    "command-runner",
    "edit",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/** Capabilities granted to every delegated agent for baseline inspection. */
export const BASELINE_AGENT_CAPABILITIES = ["read", "search"] as const;

/** Tools granted by the baseline read and search capabilities. */
export const READ_ONLY_AGENT_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface AgentDefinition {
    name: string;
    description: string;
    /** Explicit tool and execution capabilities for this agent. */
    capabilities: AgentCapability[];
    model?: string;
    systemPrompt: string;
    contextPolicy?: AgentContextPolicy;
    source: AgentSource;
    filePath?: string;
    /** Whether a foreground child may ask the end user directly. Defaults to true. */
    allowUserInteraction?: boolean;
}

/** Copy the complete runtime contract into durable run metadata. */
export function snapshotAgentDefinition(definition: AgentDefinition): AgentDefinition {
    return {
        name: definition.name,
        description: definition.description,
        capabilities: [...definition.capabilities],
        ...(definition.model !== undefined ? { model: definition.model } : {}),
        systemPrompt: definition.systemPrompt,
        ...(definition.contextPolicy
            ? {
                contextPolicy: {
                    sectionIds: [...definition.contextPolicy.sectionIds],
                    maxChars: definition.contextPolicy.maxChars,
                },
            }
            : {}),
        source: definition.source,
        ...(definition.filePath !== undefined ? { filePath: definition.filePath } : {}),
        ...(definition.allowUserInteraction !== undefined
            ? { allowUserInteraction: definition.allowUserInteraction }
            : {}),
    };
}

/** Parse a durable runtime contract without trusting malformed metadata. */
export function parseAgentDefinitionSnapshot(value: unknown): AgentDefinition | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const candidate = value as Partial<AgentDefinition>;
    if (
        typeof candidate.name !== "string"
        || !candidate.name
        || typeof candidate.description !== "string"
        || typeof candidate.systemPrompt !== "string"
        || !Array.isArray(candidate.capabilities)
        || candidate.capabilities.some((capability) => !AGENT_CAPABILITIES.includes(capability as AgentCapability))
        || (candidate.model !== undefined && typeof candidate.model !== "string")
        || !["builtin", "user", "project"].includes(candidate.source as string)
        || (candidate.filePath !== undefined && typeof candidate.filePath !== "string")
        || (candidate.allowUserInteraction !== undefined && typeof candidate.allowUserInteraction !== "boolean")
    ) return undefined;
    const contextPolicy = candidate.contextPolicy;
    if (contextPolicy !== undefined && (
        !contextPolicy
        || !Array.isArray(contextPolicy.sectionIds)
        || contextPolicy.sectionIds.some((sectionId) => typeof sectionId !== "string")
        || typeof contextPolicy.maxChars !== "number"
        || !Number.isFinite(contextPolicy.maxChars)
    )) return undefined;
    return snapshotAgentDefinition(candidate as AgentDefinition);
}

/** Returns the effective capability set, including the always-available baseline. */
export function agentCapabilities(definition: AgentDefinition): AgentCapability[] {
    const declared = new Set<AgentCapability>([
        ...BASELINE_AGENT_CAPABILITIES,
        ...definition.capabilities,
    ]);
    if (declared.has("command-runner")) declared.add("safe-bash");
    return AGENT_CAPABILITIES.filter((capability) => declared.has(capability));
}

export function hasAgentCapability(
    definition: AgentDefinition,
    capability: AgentCapability,
): boolean {
    return agentCapabilities(definition).includes(capability);
}

/** Whether the definition can use direct edit/write tools. */
export function agentCanEdit(definition: AgentDefinition): boolean {
    return hasAgentCapability(definition, "edit");
}

/** Whether the definition can run Bash through the normal permission gate. */
export function agentCanRunCommands(definition: AgentDefinition): boolean {
    return hasAgentCapability(definition, "command-runner");
}

/** Maps the capability policy to the concrete SDK tools supplied to a child. */
export function agentTools(definition: AgentDefinition): string[] {
    const tools: string[] = [...READ_ONLY_AGENT_TOOLS];
    if (agentCanEdit(definition)) tools.push("edit", "write");
    if (agentCanRunCommands(definition) || hasAgentCapability(definition, "safe-bash")) tools.push("bash");
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
        ...(includeContextPolicy
            ? { allowUserInteraction: definition.allowUserInteraction !== false }
            : {}),
    });
    return createHash("sha256").update(normalized).digest("hex");
}
