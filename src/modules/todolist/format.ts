import type { TodoList, TodoStatus } from "./parser";

export interface TodoProgress {
    completed: number;
    total: number;
    current?: string;
}

const MAX_PROGRESS_TITLE_LENGTH = 72;
const MAX_WIDGET_ITEMS = 8;
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

export function summarizeTodoList(todo: TodoList): TodoProgress | undefined {
    if (todo.items.length === 0) return undefined;

    const current = todo.items.find((item) => item.status === "in_progress")
        ?? todo.items.find((item) => item.status === "pending")
        ?? todo.items.find((item) => item.status === "blocked");
    const completed = todo.items.filter((item) => item.status === "completed").length;
    return {
        completed,
        total: todo.items.length,
        ...(current ? { current: truncateText(current.title, MAX_PROGRESS_TITLE_LENGTH) } : {}),
    };
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
    for (const item of todo.items.slice(0, MAX_WIDGET_ITEMS)) {
        lines.push(
            `${STATUS_MARKERS[item.status]} ${truncateText(item.title, MAX_WIDGET_TITLE_LENGTH)}`,
        );
    }
    if (todo.items.length > MAX_WIDGET_ITEMS) {
        lines.push(`… ${todo.items.length - MAX_WIDGET_ITEMS} more TODO item(s)`);
    }
    return lines;
}

export { MAX_WIDGET_ITEMS, MAX_WIDGET_TITLE_LENGTH };
