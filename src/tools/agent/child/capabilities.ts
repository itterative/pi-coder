import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    agentAdditionalPaths,
    agentAuthority,
    agentCanUseBash,
    agentTools,
    hasAgentAuthority,
    hasAgentCapability,
} from "../definitions/types";
import type { AgentAuthority, AgentDefinition } from "../definitions/types";
/**
 * What one child may use, resolved from its definition plus the parent's ability to host a prompt.
 *
 * Deriving this once keeps the authorization surface of the child in a single readable place: the
 * session bootstrap, extension set, system prompt, and tool list all consume these values, and none
 * of them should re-derive a rule and drift from the others.
 */
export interface ChildCapabilities {
    /**
     * The one rung this child sits on, and the answer to every "may it be gated, mutate, or run
     * serially?" question. Tool presence is separate: `safeBash` below is the declared capability,
     * because a definition may hold `edit` without any shell access at all.
     */
    authority: AgentAuthority;
    tools: string[];
    additionalPaths: string[];
    safeBashCommands: string[];
    canEdit: boolean;
    canRunCommands: boolean;
    safeBash: boolean;
    hasMemories: boolean;
    hasScratchpad: boolean;
    hasTodolist: boolean;
    /** Whether this child may ask the end user directly, once UI availability is known. */
    canAskUser: boolean;
}

/**
 * `canAskUser` is the only value here that depends on the parent rather than the definition: a
 * background or print-mode parent has no UI to answer with, so asking would strand the child. The
 * definition's own `allowUserInteraction` flag is necessary but not sufficient.
 */
export function deriveChildCapabilities(
    definition: AgentDefinition,
    parentContext: ExtensionContext,
): ChildCapabilities {
    const authority = agentAuthority(definition);
    const allowUserInteraction = definition.allowUserInteraction !== false;
    return {
        authority,
        tools: agentTools(definition),
        additionalPaths: agentAdditionalPaths(definition),
        safeBashCommands: definition.safeBashCommands ?? [],
        canEdit: authority === "mutate",
        canRunCommands: hasAgentAuthority(authority, "command"),
        safeBash: agentCanUseBash(definition),
        hasMemories: hasAgentCapability(definition, "memories"),
        hasScratchpad: hasAgentCapability(definition, "scratchpad"),
        hasTodolist: hasAgentCapability(definition, "todolist"),
        canAskUser:
            allowUserInteraction && parentContext.hasUI === true && parentContext.mode === "tui",
    };
}
