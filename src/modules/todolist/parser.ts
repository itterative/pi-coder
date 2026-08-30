import { FrontmatterParseError, parseFrontmatter } from "../../common/frontmatter";

export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface TodoItem {
    id: string;
    title: string;
    status: TodoStatus;
}

export interface TodoList {
    path: string;
    version: 1;
    items: TodoItem[];
    body: string;
}

const TODO_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const TODO_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "blocked"]);
const MAX_TODO_ITEMS = 50;
const MAX_TODO_TITLE_LENGTH = 500;
const MAX_TODO_DOCUMENT_LENGTH = 256_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidTodo(filePath: string, reason: string): never {
    throw new FrontmatterParseError(filePath, `invalid TODO frontmatter: ${reason}`);
}

function validateTopLevel(frontmatter: Record<string, unknown>, filePath: string): unknown[] {
    const unknownFields = Object.keys(frontmatter).filter(
        (key) => key !== "version" && key !== "todos",
    );
    if (unknownFields.length > 0) {
        invalidTodo(filePath, `unknown field(s): ${unknownFields.join(", ")}`);
    }

    if (frontmatter.version !== 1) {
        invalidTodo(filePath, "`version` must be the integer 1");
    }

    const todos = frontmatter.todos;
    if (!Array.isArray(todos)) {
        invalidTodo(filePath, "`todos` must be a YAML sequence");
    }
    if (todos.length > MAX_TODO_ITEMS) {
        invalidTodo(filePath, `a maximum of ${MAX_TODO_ITEMS} TODO entries is allowed`);
    }

    return todos;
}

function parseItem(value: unknown, index: number, filePath: string): TodoItem {
    if (!isRecord(value)) {
        invalidTodo(filePath, `TODO entry ${index + 1} must be a mapping`);
    }

    const unknownFields = Object.keys(value).filter(
        (key) => !["id", "title", "status"].includes(key),
    );
    if (unknownFields.length > 0) {
        invalidTodo(
            filePath,
            `TODO entry ${index + 1} has unknown field(s): ${unknownFields.join(", ")}`,
        );
    }

    const id = value.id;
    if (typeof id !== "string" || !TODO_ID.test(id)) {
        invalidTodo(filePath, `TODO entry ${index + 1} has an invalid \`id\` value`);
    }

    const title = value.title;
    if (typeof title !== "string" || title.trim().length === 0) {
        invalidTodo(filePath, `TODO entry ${index + 1} must have a non-empty string \`title\``);
    }
    if (title.trim().length > MAX_TODO_TITLE_LENGTH) {
        invalidTodo(
            filePath,
            `TODO entry ${index + 1} title exceeds ${MAX_TODO_TITLE_LENGTH} characters`,
        );
    }

    const status = value.status;
    if (typeof status !== "string" || !TODO_STATUSES.has(status as TodoStatus)) {
        invalidTodo(filePath, `TODO entry ${index + 1} has an invalid status`);
    }

    return {
        id,
        title: title.trim(),
        status: status as TodoStatus,
    };
}

/** Parse and validate one structured TODO.md document. */
export function parseTodoList(content: string, filePath = "TODO.md"): TodoList {
    if (content.length > MAX_TODO_DOCUMENT_LENGTH) {
        throw new FrontmatterParseError(
            filePath,
            `TODO document exceeds ${MAX_TODO_DOCUMENT_LENGTH} characters`,
        );
    }

    const parsed = parseFrontmatter(content, filePath);
    const todos = validateTopLevel(parsed.frontmatter, filePath);
    const ids = new Set<string>();
    const items: TodoItem[] = [];

    for (const [index, value] of todos.entries()) {
        const item = parseItem(value, index, filePath);
        if (ids.has(item.id)) {
            invalidTodo(filePath, `TODO entry ID \`${item.id}\` is duplicated`);
        }
        ids.add(item.id);
        items.push(item);
    }

    return {
        path: filePath,
        version: 1,
        items,
        body: parsed.body,
    };
}

export { FrontmatterParseError } from "../../common/frontmatter";
