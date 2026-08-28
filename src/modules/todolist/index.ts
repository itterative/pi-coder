import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
    isToolCallEventType,
    type EditToolInput,
    type ExtensionAPI,
    type ExtensionContext,
    type ToolCallEventResult,
    type WriteToolInput,
} from "@earendil-works/pi-coding-agent";

import { getScratchpadPath } from "../scratchpad";
import { registerTodoBashGuard } from "./bash-guard";
import {
    FrontmatterParseError,
    parseTodoList,
    type TodoItem,
    type TodoList,
    type TodoStatus,
} from "./parser";
import { summarizeTodoList, type TodoProgress } from "./format";
import { clearTodoWidget, updateTodoWidget } from "../../tui/todolist-widget";

const EMPTY_TODO_DOCUMENT = "---\nversion: 1\ntodos: []\n---\n";

const TODO_SYSTEM_TAG = "<todolist_system>";
const TODO_SYSTEM_END_TAG = "</todolist_system>";

type TodoEdit = Pick<EditToolInput["edits"][number], "oldText" | "newText">;

export interface TodoListExtensionOptions {
    onTodoProgress?: (progress: TodoProgress | undefined) => void;
}

function normalizeToLf(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function appendTodoPrompt(systemPrompt: string, pathname: string): string {
    if (systemPrompt.includes(TODO_SYSTEM_TAG)) return systemPrompt;

    const block = [
        TODO_SYSTEM_TAG,
        "## Temporary TODO list",
        "",
        `Your private runtime TODO list is at \`${pathname}\`.`,
        "Read TODO.md before beginning substantive work. Keep its YAML frontmatter valid and update TODO statuses as work starts, completes, or becomes blocked.",
        "When mutation tools are available, use the write or edit tool to change TODO.md and preserve the freeform Markdown body after the frontmatter.",
        "The TODO list is temporary and runtime-local; it is not a project TODO file and is not durable across sessions.",
        "Use this exact frontmatter shape: `version: 1` and a `todos` YAML sequence; each entry has a unique lowercase `id`, a non-empty `title`, and a `status`.",
        "For example:",
        "```yaml",
        "---",
        "version: 1",
        "todos:",
        "  - id: inspect",
        "    title: Inspect the implementation",
        "    status: in_progress",
        "---",
        "```",
        "The Markdown body after the closing `---` is freeform and must be preserved.",
        "TODO.md is initialized for every runtime; deleting an existing TODO.md is treated as clearing it to `todos: []`, so use an empty list when no active tasks remain.",
        "Allowed statuses are `pending`, `in_progress`, `completed`, and `blocked`.",
        TODO_SYSTEM_END_TAG,
    ].join("\n");
    const projectContextEnd = "</project_context>";
    const index = systemPrompt.indexOf(projectContextEnd);
    if (index === -1) return `${systemPrompt}\n\n${block}`;

    return systemPrompt.slice(0, index + projectContextEnd.length)
        + "\n\n"
        + block
        + "\n"
        + systemPrompt.slice(index + projectContextEnd.length);
}

function resolveToolPath(rawPath: string, cwd: string): string {
    let filePath = rawPath.trim();
    if (filePath.startsWith("@")) filePath = filePath.slice(1);
    if (filePath === "~") filePath = process.env.HOME ?? filePath;
    else if (filePath.startsWith("~/")) {
        filePath = path.join(process.env.HOME ?? "~", filePath.slice(2));
    }
    return path.resolve(cwd, filePath);
}

async function isManagedTodoPath(
    rawPath: string,
    cwd: string,
    scratchpadPath: string,
): Promise<boolean> {
    const expectedPath = path.resolve(scratchpadPath, "TODO.md");
    if (resolveToolPath(rawPath, cwd) !== expectedPath) return false;

    try {
        if ((await lstat(expectedPath)).isSymbolicLink()) return false;
        const [rootPath, todoPath] = await Promise.all([
            realpath(scratchpadPath),
            realpath(expectedPath),
        ]);
        return todoPath === path.join(rootPath, "TODO.md");
    } catch {
        // A missing TODO.md is valid for a write, but symlinked or otherwise
        // unresolved paths are not accepted as the managed target.
        try {
            const rootPath = await realpath(scratchpadPath);
            const parentPath = await realpath(path.dirname(expectedPath));
            let targetIsSymlink = false;
            try {
                targetIsSymlink = (await lstat(expectedPath)).isSymbolicLink();
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
            }
            return parentPath === rootPath && !targetIsSymlink;
        } catch {
            return false;
        }
    }
}

function countOccurrences(content: string, text: string): number {
    let count = 0;
    let offset = 0;
    while (true) {
        const index = content.indexOf(text, offset);
        if (index === -1) return count;
        count++;
        offset = index + text.length;
    }
}

function applyTodoEdits(content: string, edits: TodoEdit[], filePath: string): string {
    const normalizedContent = normalizeToLf(content);
    const matches = edits.map((edit, index) => {
        const oldText = normalizeToLf(edit.oldText);
        const newText = normalizeToLf(edit.newText);
        if (!oldText) throw new Error(`edits[${index}].oldText must not be empty`);
        const matchIndex = normalizedContent.indexOf(oldText);
        if (matchIndex === -1) {
            throw new Error(`could not find edits[${index}] in ${filePath}`);
        }
        const occurrences = countOccurrences(normalizedContent, oldText);
        if (occurrences !== 1) {
            throw new Error(`edits[${index}] must match exactly once in ${filePath}`);
        }
        return { index, matchIndex, matchLength: oldText.length, newText };
    });

    matches.sort((left, right) => left.matchIndex - right.matchIndex);
    for (let index = 1; index < matches.length; index++) {
        const previous = matches[index - 1];
        const current = matches[index];
        if (previous.matchIndex + previous.matchLength > current.matchIndex) {
            throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap in ${filePath}`);
        }
    }

    let result = normalizedContent;
    for (const match of [...matches].reverse()) {
        result = result.slice(0, match.matchIndex)
            + match.newText
            + result.slice(match.matchIndex + match.matchLength);
    }
    return result;
}

function validationFailure(error: unknown): ToolCallEventResult {
    const reason = error instanceof Error ? error.message : String(error);
    return { block: true, reason };
}

async function initializeTodoFile(ctx: ExtensionContext): Promise<void> {
    const scratchpadPath = getScratchpadPath(ctx.sessionManager);
    if (!scratchpadPath) return;

    try {
        await writeFile(path.join(scratchpadPath, "TODO.md"), EMPTY_TODO_DOCUMENT, {
            encoding: "utf8",
            flag: "wx",
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
    }
}

/** Register TODO prompt, validation, UI refresh, and Bash handling for one runtime. */
export default function registerTodoListExtension(
    pi: ExtensionAPI,
    options: TodoListExtensionOptions = {},
): void {
    registerTodoBashGuard(pi);

    const refresh = async (ctx: ExtensionContext): Promise<void> => {
        const scratchpadPath = getScratchpadPath(ctx.sessionManager);
        if (!scratchpadPath) {
            options.onTodoProgress?.(undefined);
            clearTodoWidget(ctx);
            return;
        }

        const todoPath = path.join(scratchpadPath, "TODO.md");
        let content: string;
        try {
            content = await readFile(todoPath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                options.onTodoProgress?.(undefined);
                clearTodoWidget(ctx);
            }
            return;
        }

        try {
            const todo = parseTodoList(content, todoPath);
            const progress = summarizeTodoList(todo);
            options.onTodoProgress?.(progress);
            if (progress) {
                updateTodoWidget(ctx, todo);
            } else {
                clearTodoWidget(ctx);
            }
        } catch {
            // Preserve the last valid progress/widget while the validation
            // hook reports the malformed update to the agent.
        }
    };

    pi.on("session_start", async (_event, ctx) => {
        await initializeTodoFile(ctx);
        await refresh(ctx);
    });
    pi.on("session_tree", (_event, ctx) => {
        options.onTodoProgress?.(undefined);
        clearTodoWidget(ctx);
    });
    pi.on("session_shutdown", (_event, ctx) => {
        options.onTodoProgress?.(undefined);
        clearTodoWidget(ctx);
    });

    pi.on("before_agent_start", (event, ctx) => {
        const scratchpadPath = getScratchpadPath(ctx.sessionManager);
        if (!scratchpadPath) return;

        return {
            systemPrompt: appendTodoPrompt(event.systemPrompt, path.join(scratchpadPath, "TODO.md")),
        };
    });

    pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
        if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) {
            return { block: false };
        }

        const scratchpadPath = getScratchpadPath(ctx.sessionManager);
        if (!scratchpadPath) return { block: false };
        const input = event.input as WriteToolInput | EditToolInput;
        const todoPath = path.join(scratchpadPath, "TODO.md");
        if (resolveToolPath(input.path, ctx.cwd) !== path.resolve(todoPath)) {
            return { block: false };
        }
        if (!await isManagedTodoPath(input.path, ctx.cwd, scratchpadPath)) {
            return {
                block: true,
                reason: "TODO.md path is not the runtime's canonical scratchpad file.",
            };
        }

        try {
            let content: string;
            if (isToolCallEventType("write", event)) {
                content = (event.input as WriteToolInput).content;
            } else {
                content = await readFile(todoPath, "utf8");
                content = applyTodoEdits(
                    content,
                    (event.input as EditToolInput).edits,
                    todoPath,
                );
            }
            parseTodoList(content, todoPath);
            return { block: false };
        } catch (error) {
            return validationFailure(error);
        }
    });

    pi.on("tool_result", async (event, ctx) => {
        if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") return;
        await refresh(ctx);
    });
}

export {
    appendTodoPrompt,
    applyTodoEdits,
    isManagedTodoPath,
};
export {
    parseTodoList,
    type TodoItem,
    type TodoList,
    type TodoStatus,
} from "./parser";
export {
    formatTodoList,
    formatTodoProgress,
    summarizeTodoList,
    type TodoProgress,
} from "./format";
export { FrontmatterParseError } from "./parser";
