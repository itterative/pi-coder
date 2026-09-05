export type AgentContextSource = "parent" | "repository" | "workspace";

/** A bounded piece of runtime information supplied to a delegated agent. */
export interface AgentContextSection {
    id: string;
    title: string;
    content: string;
    source: AgentContextSource;
}

export interface AgentContext {
    sections: AgentContextSection[];
}

/**
 * Narrows and bounds the dynamic context one agent accepts, without changing its role prompt.
 *
 * Both fields are optional in effect: an omitted policy, or one with no `sectionIds`, accepts every
 * supplied section under the renderer's default budget, and a non-positive `maxChars` falls back to
 * that same default. Only a policy that lists IDs narrows anything.
 */
export interface AgentContextPolicy {
    sectionIds: readonly string[];
    maxChars: number;
}
