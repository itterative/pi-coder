import { createHash } from "node:crypto";

import { getUserMemoryDirectory } from "../../../common/constants";
import type { AgentContextPolicy } from "../contracts/context";

export type AgentSource = "builtin" | "user" | "project";

/** Capabilities available to delegated agents. */
export const AGENT_CAPABILITIES = [
    "read",
    "search",
    "memories",
    "scratchpad",
    "todolist",
    "safe-bash",
    "command-runner",
    "edit",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/** Capabilities granted to every delegated agent for baseline inspection. */
export const BASELINE_AGENT_CAPABILITIES = ["read", "search"] as const;

/**
 * The command-and-mutation ladder, from least to most capable.
 *
 * These rungs are not three more capabilities: `safe-bash`, `command-runner`, and `edit` are one
 * axis at different strengths, which is why a `command-runner` can also do everything `safe-bash`
 * can. Anything asking "may this child be gated, mutate, or run serially?" should compare a rung
 * instead of combining booleans, so the number of scenarios stays equal to the number of rungs
 * rather than growing with every flag pair.
 *
 * The ladder orders *gate strength*, not tool presence: `mutate` is the top rung of the gate, but a
 * definition may hold `edit` without any Bash capability at all, so whether the `bash` tool exists
 * comes from `safe-bash` (`agentCanUseBash`) rather than from a rung comparison.
 */
export const AGENT_AUTHORITY_LADDER = ["read", "inspect", "command", "mutate"] as const;
export type AgentAuthority = (typeof AGENT_AUTHORITY_LADDER)[number];

/** Tools granted by the baseline read and search capabilities. */
export const READ_ONLY_AGENT_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface AgentDefinition {
    name: string;
    description: string;
    /** Explicit tool and execution capabilities for this agent. */
    capabilities: AgentCapability[];
    /** Additional paths that are readable by the child, beyond its cwd. */
    additionalPaths?: string[];
    /** Exact shell command patterns eligible for direct safe-Bash inspection. */
    safeBashCommands?: string[];
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
        ...(definition.additionalPaths !== undefined
            ? { additionalPaths: [...definition.additionalPaths] }
            : {}),
        ...(definition.safeBashCommands !== undefined
            ? { safeBashCommands: [...definition.safeBashCommands] }
            : {}),
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
        typeof candidate.name !== "string" ||
        !candidate.name ||
        typeof candidate.description !== "string" ||
        typeof candidate.systemPrompt !== "string" ||
        !Array.isArray(candidate.capabilities) ||
        candidate.capabilities.some(
            (capability) => !AGENT_CAPABILITIES.includes(capability as AgentCapability),
        ) ||
        (candidate.additionalPaths !== undefined &&
            (!Array.isArray(candidate.additionalPaths) ||
                candidate.additionalPaths.some(
                    (additionalPath) =>
                        typeof additionalPath !== "string" || additionalPath.trim() === "",
                ))) ||
        (candidate.safeBashCommands !== undefined &&
            (!Array.isArray(candidate.safeBashCommands) ||
                candidate.safeBashCommands.some(
                    (command) => typeof command !== "string" || command.trim() === "",
                ))) ||
        (candidate.model !== undefined && typeof candidate.model !== "string") ||
        !["builtin", "user", "project"].includes(candidate.source as string) ||
        (candidate.filePath !== undefined && typeof candidate.filePath !== "string") ||
        (candidate.allowUserInteraction !== undefined &&
            typeof candidate.allowUserInteraction !== "boolean")
    )
        return undefined;
    const contextPolicy = candidate.contextPolicy;
    if (
        contextPolicy !== undefined &&
        (!contextPolicy ||
            !Array.isArray(contextPolicy.sectionIds) ||
            contextPolicy.sectionIds.some((sectionId) => typeof sectionId !== "string") ||
            typeof contextPolicy.maxChars !== "number" ||
            !Number.isFinite(contextPolicy.maxChars))
    )
        return undefined;
    return snapshotAgentDefinition(candidate as AgentDefinition);
}

/**
 * Where a definition sits on the ladder, read from its effective capability set.
 *
 * Ordered checks rather than rank arithmetic, because the highest rung is the only one whose lower
 * rungs must also be available, and that precedence is the whole meaning of the ladder.
 */
export function agentAuthority(definition: AgentDefinition): AgentAuthority {
    const capabilities = new Set(agentCapabilities(definition));
    if (capabilities.has("edit")) {
        return "mutate";
    }
    if (capabilities.has("command-runner")) {
        return "command";
    }
    if (capabilities.has("safe-bash")) {
        return "inspect";
    }
    return "read";
}

/** Whether an authority may do everything `minimum` allows. */
export function hasAgentAuthority(authority: AgentAuthority, minimum: AgentAuthority): boolean {
    return AGENT_AUTHORITY_LADDER.indexOf(authority) >= AGENT_AUTHORITY_LADDER.indexOf(minimum);
}

/**
 * The effective capability set, including the always-available baseline and the implications below.
 *
 * This is the declaration layer's answer to "what did the author ask for", and the implications are
 * part of that contract: they show up in the parent-facing catalog and are hashed into the persisted
 * definition fingerprint. The child-side mapping from capability to tools, read roots, and extensions
 * lives in `child/capabilities`, and deliberately does not restate these implications.
 */
export function agentCapabilities(definition: AgentDefinition): AgentCapability[] {
    const declared = new Set<AgentCapability>([
        ...BASELINE_AGENT_CAPABILITIES,
        ...definition.capabilities,
    ]);
    if (declared.has("command-runner")) declared.add("safe-bash");
    if (declared.has("todolist")) declared.add("scratchpad");
    return AGENT_CAPABILITIES.filter((capability) => declared.has(capability));
}

export function hasAgentCapability(
    definition: AgentDefinition,
    capability: AgentCapability,
): boolean {
    return agentCapabilities(definition).includes(capability);
}

/** Whether the definition can use direct edit/write tools: the top rung of the ladder. */
export function agentCanEdit(definition: AgentDefinition): boolean {
    return agentAuthority(definition) === "mutate";
}

/** Whether the definition can run Bash through the normal permission gate. */
export function agentCanRunCommands(definition: AgentDefinition): boolean {
    return hasAgentAuthority(agentAuthority(definition), "command");
}

/** Whether the definition may call Bash at all, gated either way: the `safe-bash` capability. */
export function agentCanUseBash(definition: AgentDefinition): boolean {
    return hasAgentCapability(definition, "safe-bash");
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
    return (
        fingerprintAgentDefinition(definition) === fingerprint ||
        fingerprintLegacyAgentDefinition(definition) === fingerprint
    );
}

function hashDefinition(definition: AgentDefinition, includeContextPolicy: boolean): string {
    const normalized = JSON.stringify({
        name: definition.name,
        description: definition.description,
        capabilities: [...definition.capabilities].sort(),
        ...(includeContextPolicy
            ? { additionalPaths: [...(definition.additionalPaths ?? [])].sort() }
            : {}),
        ...(includeContextPolicy
            ? { safeBashCommands: [...(definition.safeBashCommands ?? [])].sort() }
            : {}),
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
