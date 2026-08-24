import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Shared pi event channel for delegated-agent and workspace state changes. */
export const AGENT_STATE_CHANGED_EVENT = "pi-coder:agent-state-changed";

export type AgentStateChangeReason =
    | "run_started"
    | "run_progress"
    | "run_terminal"
    | "run_resumed"
    | "run_canceled"
    | "run_collected"
    | "workspace_setup"
    | "workspace_reconciled"
    | "workspace_action"
    | "state_restored";

/**
 * Deliberately carries only invalidation metadata. Consumers should reload
 * current state from the manager/database rather than treating this as a
 * durable state record.
 */
export interface AgentStateChangedEvent {
    cwd: string;
    reason: AgentStateChangeReason;
    runId?: string;
    workspaceId?: string;
}

export function emitAgentStateChanged(
    events: EventBus | undefined,
    event: AgentStateChangedEvent,
): void {
    events?.emit(AGENT_STATE_CHANGED_EVENT, event);
}
