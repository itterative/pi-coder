import type { TodoList } from "./parser";

export interface TodoProgress {
    completed: number;
    total: number;
    current?: string;
}

const MAX_PROGRESS_TITLE_LENGTH = 72;

function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function summarizeTodoList(todo: TodoList): TodoProgress | undefined {
    if (todo.items.length === 0) return undefined;

    const current =
        todo.items.find((item) => item.status === "in_progress") ??
        todo.items.find((item) => item.status === "pending") ??
        todo.items.find((item) => item.status === "blocked");
    const completed = todo.items.filter((item) => item.status === "completed").length;
    return {
        completed,
        total: todo.items.length,
        ...(current ? { current: truncateText(current.title, MAX_PROGRESS_TITLE_LENGTH) } : {}),
    };
}
