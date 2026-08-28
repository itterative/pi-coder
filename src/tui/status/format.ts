import type { TodoList, TodoStatus } from "../../modules/todolist/parser";
import { summarizeTodoList, type TodoProgress } from "../../modules/todolist/progress";

const MAX_WIDGET_ITEMS = 4;
const MAX_WIDGET_TITLE_LENGTH = 96;

const STATUS_MARKERS: Record<TodoStatus, string> = {
    pending: "○",
    in_progress: "◐",
    completed: "✓",
    blocked: "!",
};

function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatTodoProgress(progress: TodoProgress | undefined): string {
    if (!progress || progress.total <= 0) return "";
    return progress.current
        ? `TODO ${progress.completed}/${progress.total} · ${progress.current}`
        : `TODO ${progress.completed}/${progress.total}`;
}

export function formatTodoList(todo: TodoList): string[] {
    const progress = summarizeTodoList(todo);
    if (!progress) return [];

    const lines = [formatTodoProgress(progress)];
    let start = 0;
    if (todo.items.length > MAX_WIDGET_ITEMS) {
        start = todo.items.findIndex((item) => item.status === "in_progress");
        if (start < 0) start = todo.items.findIndex((item) => item.status === "pending");
        if (start < 0) start = 0;
    }

    const remainingItems = todo.items.length - start;
    const hasMoreLine = remainingItems > MAX_WIDGET_ITEMS;
    const visibleCount = hasMoreLine ? MAX_WIDGET_ITEMS - 1 : remainingItems;
    const visibleItems = todo.items.slice(start, start + visibleCount);
    for (const item of visibleItems) {
        lines.push(
            `  ${STATUS_MARKERS[item.status]} ${truncateText(item.title, MAX_WIDGET_TITLE_LENGTH)}`,
        );
    }

    if (hasMoreLine) {
        lines.push(`  … ${remainingItems - visibleCount} more TODO item(s)`);
    }
    return lines;
}

export { MAX_WIDGET_ITEMS, MAX_WIDGET_TITLE_LENGTH, summarizeTodoList, type TodoProgress };
