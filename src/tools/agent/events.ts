import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { AgentRunStatus } from "./runtime";

/** Shared pi event channel for delegated-agent runtime changes. */
export const AGENT_EVENT_CHANNEL = "pi-coder:agent-event";

export type AgentRunEvent =
    | {
        type: "run";
        action: "created" | "restored";
        runId: string;
        agent: string;
        background: boolean;
        status: AgentRunStatus;
        workspaceId?: string;
    }
    | {
        type: "run";
        action: "progress";
        runId: string;
        status: AgentRunStatus;
        workspaceId?: string;
    }
    | {
        type: "run";
        action: "status_changed";
        runId: string;
        status: AgentRunStatus;
        previousStatus: AgentRunStatus;
        workspaceId?: string;
    }
    | {
        type: "run";
        action: "removed";
        runId: string;
        status: AgentRunStatus;
        reason: "collected" | "pruned" | "shutdown" | "terminal" | "canceled" | "restored_terminal";
        workspaceId?: string;
    };

export type AgentWorkspaceEvent = {
    type: "workspace";
    action: "created" | "updated" | "lease_changed" | "result_changed" | "removed";
    workspaceId: string;
    reason?: string;
};

export type AgentRuntimeEvent =
    | {
        type: "runtime";
        action: "restored" | "reconciled" | "reset" | "shutdown";
        released?: number;
    };

export type AgentEvent = (AgentRunEvent | AgentWorkspaceEvent | AgentRuntimeEvent) & {
    cwd: string;
    timestamp: number;
};

export type AgentEventPayload = AgentRunEvent | AgentWorkspaceEvent | AgentRuntimeEvent;

export interface AgentEventSink {
    emit(event: AgentEvent): void;
}

/** Bridges typed pi-coder events onto pi's shared event bus. */
export function createAgentEventSink(events: EventBus | undefined): AgentEventSink {
    return {
        emit(event) {
            events?.emit(AGENT_EVENT_CHANNEL, event);
        },
    };
}

export function emitAgentEvent(
    sink: AgentEventSink | undefined,
    cwd: string,
    event: AgentEventPayload,
): void {
    sink?.emit({
        ...event,
        cwd,
        timestamp: Date.now(),
    });
}
