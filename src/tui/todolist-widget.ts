import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { TodoList } from "../modules/todolist/parser";
import { formatTodoList } from "../modules/todolist/format";

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
