import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TodoList } from "../modules/todolist/parser";
import { formatTodoList } from "../modules/todolist/format";

export const TODO_WIDGET_ID = "pi-coder-todolist";

interface TodoWidgetState {
    todo: TodoList;
    component?: TodoListWidget;
}

const widgetStates = new WeakMap<object, TodoWidgetState>();

function widgetOwner(ctx: ExtensionContext, events?: EventBus): object {
    return (events ?? ctx.ui) as object;
}

export class TodoListWidget implements Component {
    constructor(
        private readonly tui: TUI,
        private todo: TodoList,
    ) {}

    setTodo(todo: TodoList): void {
        this.todo = todo;
        this.tui.requestRender();
    }

    render(width: number): string[] {
        const lines = formatTodoList(this.todo);
        if (width <= 2) return lines.map((line) => truncateToWidth(line, Math.max(1, width)));

        const contentWidth = width - 2;
        return lines.map((line) => ` ${truncateToWidth(line, contentWidth)} `);
    }

    invalidate(): void {
        // The widget state is updated explicitly after each relevant pi event.
    }

    dispose(): void {}
}

export function updateTodoWidget(
    ctx: ExtensionContext,
    todo: TodoList,
    events?: EventBus,
): void {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    const owner = widgetOwner(ctx, events);
    const state = widgetStates.get(owner);
    if (state) {
        state.todo = todo;
        state.component?.setTodo(todo);
        return;
    }

    const nextState: TodoWidgetState = { todo };
    widgetStates.set(owner, nextState);
    ctx.ui.setWidget(
        TODO_WIDGET_ID,
        (tui) => {
            const component = new TodoListWidget(tui, nextState.todo);
            nextState.component = component;
            return component;
        },
        { placement: "aboveEditor" },
    );
}

export function clearTodoWidget(ctx: ExtensionContext, events?: EventBus): void {
    if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget(TODO_WIDGET_ID, undefined);
    widgetStates.delete(widgetOwner(ctx, events));
}
