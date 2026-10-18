import { summarizeTodoList, type TodoProgress } from "../../modules/todolist/progress";

function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * The compact TODO segment. `maxCurrent` additionally caps the current item for one-line use;
 * omitted, the progress title keeps the parser's own 72-character bound.
 */
export function formatTodoProgress(
    progress: TodoProgress | undefined,
    maxCurrent?: number,
): string {
    if (!progress || progress.total <= 0) return "";

    const current =
        progress.current && maxCurrent !== undefined
            ? truncateText(progress.current, maxCurrent)
            : progress.current;
    return current
        ? `TODO ${progress.completed}/${progress.total} · ${current}`
        : `TODO ${progress.completed}/${progress.total}`;
}

export { summarizeTodoList, type TodoProgress };
