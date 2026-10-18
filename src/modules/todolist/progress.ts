import type { TodoList } from "./parser";

export interface TodoProgress {
    completed: number;
    total: number;
    current?: string;
    /** The final item, shown once every item is complete so a muted line still names what finished. */
    last?: string;
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
    const last = completed === todo.items.length ? todo.items.at(-1) : undefined;
    return {
        completed,
        total: todo.items.length,
        ...(current ? { current: truncateText(current.title, MAX_PROGRESS_TITLE_LENGTH) } : {}),
        ...(last ? { last: truncateText(last.title, MAX_PROGRESS_TITLE_LENGTH) } : {}),
    };
}
