import { parseTodoList, type TodoList, type TodoStatus } from "../../../modules/todolist/parser";
import { summarizeTodoList } from "../../../modules/todolist/progress";

const STATUS_MARKERS: Record<TodoStatus, string> = {
    pending: "○",
    in_progress: "◐",
    completed: "✓",
    blocked: "!",
};

export interface TodoTranscriptViews {
    collapsed: string;
    body: string;
}

function formatTodoListAll(todo: TodoList): string[] {
    const progress = summarizeTodoList(todo);
    if (!progress) return [];

    return [
        `TODO ${progress.completed}/${progress.total}${progress.current ? ` · ${progress.current}` : ""}`,
        ...todo.items.map((item) => `  ${STATUS_MARKERS[item.status]} ${item.title}`),
    ];
}

export function formatTodoTranscript(content: string): TodoTranscriptViews | undefined {
    let todo: TodoList;
    try {
        todo = parseTodoList(content);
    } catch {
        return undefined;
    }

    const collapsed = formatTodoListAll(todo);
    if (collapsed.length === 0) return undefined;

    return {
        collapsed: collapsed.join("\n"),
        body: todo.body.trim(),
    };
}
