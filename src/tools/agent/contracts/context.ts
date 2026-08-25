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

/** Selects and bounds dynamic context without changing an agent's role prompt. */
export interface AgentContextPolicy {
    sectionIds: readonly string[];
    maxChars: number;
}
