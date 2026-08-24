import type { EventBus } from "@earendil-works/pi-coding-agent";

import type { AgentEvent, AgentEventPayload, AgentEventSink } from "../contracts/events";

export type {
    AgentEvent,
    AgentEventPayload,
    AgentEventSink,
    AgentRunEvent,
    AgentRuntimeEvent,
    AgentWorkspaceEvent,
} from "../contracts/events";

/** Shared pi event channel for delegated-agent runtime changes. */
export const AGENT_EVENT_CHANNEL = "pi-coder:agent-event";

/** Bridges typed pi-coder events onto pi's shared event bus. */
export function createAgentEventSink(events: EventBus | undefined): AgentEventSink {
    return {
        emit(event) {
            events?.emit(AGENT_EVENT_CHANNEL, event);
        },
    };
}

export function isAgentEvent(value: unknown): value is AgentEvent {
    if (!value || typeof value !== "object") return false;
    const event = value as Partial<AgentEvent>;
    return typeof event.cwd === "string"
        && typeof event.timestamp === "number"
        && (event.type === "run" || event.type === "workspace" || event.type === "runtime");
}

export function subscribeAgentEvents(
    events: EventBus | undefined,
    handler: (event: AgentEvent) => void,
): () => void {
    if (!events || typeof events.on !== "function") return () => {};
    return events.on(AGENT_EVENT_CHANNEL, (data) => {
        if (isAgentEvent(data)) handler(data);
    });
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
