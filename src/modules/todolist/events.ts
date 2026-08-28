import type { EventBus } from "@earendil-works/pi-coding-agent";

import type { TodoList } from "./parser";

export const TODO_STATUS_EVENT = "pi-coder:todo-status";

export interface TodoStatusEvent {
    todo?: TodoList;
}

export function emitTodoStatus(events: EventBus | undefined, todo: TodoList | undefined): void {
    events?.emit(TODO_STATUS_EVENT, { todo } satisfies TodoStatusEvent);
}

export function isTodoStatusEvent(value: unknown): value is TodoStatusEvent {
    return Boolean(value && typeof value === "object" && "todo" in value);
}
