import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTodoListExtension from "../../../../modules/todolist";
import type { TodoProgress } from "../../../../modules/todolist/progress";
import { reportProgress } from "../progress";
import type { ChildExtensionRuntime } from "./index";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * The scratchpad-backed TODO list.
 *
 * Its only child-specific behavior is reporting: a todo change is a progress frame like any other, so
 * the tracker is updated *before* the frame is reported. Reversing those two steps lets the parent see
 * a todo list ahead of the activity that produced it, which is the ordering invariant to preserve here.
 */
export const TODOLIST_UNIT = {
    id: "todolist",
    extension: (runtime: ChildExtensionRuntime): InlineExtension => ({
        name: "pi-coder-todolist-child",
        hidden: true,
        factory: (pi: ExtensionAPI) =>
            registerTodoListExtension(pi, {
                onTodoProgress: (todo: TodoProgress | undefined) => {
                    runtime.tracker.progress.todo = todo ? { ...todo } : undefined;
                    reportProgress(runtime.tracker, runtime.onProgress);
                },
            }),
    }),
} as const;
