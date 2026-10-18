import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Shared pi event channel for decision-model activity changes. */
export const DECISION_STATUS_EVENT = "pi-coder:decision-status";

/** How many decision-model consults are in flight; the status footer animates while it is nonzero. */
export interface DecisionStatusEvent {
    checking: number;
}

export function emitDecisionStatus(events: EventBus | undefined, checking: number): void {
    events?.emit(DECISION_STATUS_EVENT, { checking } satisfies DecisionStatusEvent);
}

export function isDecisionStatusEvent(value: unknown): value is DecisionStatusEvent {
    if (!value || typeof value !== "object") return false;
    const event = value as Partial<DecisionStatusEvent>;
    return typeof event.checking === "number";
}
