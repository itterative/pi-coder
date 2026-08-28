import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { snapshotText, renderText } from "../helpers";
import {
    clearTodoWidget,
    TODO_WIDGET_ID,
    TodoListWidget,
    updateTodoWidget,
} from "../../src/tui/todolist-widget";

const todo = {
    path: "/tmp/TODO.md",
    version: 1 as const,
    items: [
        { id: "inspect", title: "Inspect the implementation", status: "completed" as const },
        { id: "implement", title: "Implement the feature with careful validation", status: "in_progress" as const },
        { id: "verify", title: "Verify the result", status: "pending" as const },
        { id: "release", title: "Release the change", status: "blocked" as const },
    ],
    body: "",
};

describe("TODO widget", () => {
    it("renders bounded progress and status-marked titles", () => {
        const widget = new TodoListWidget({ requestRender() {} } as any, todo);

        expect(snapshotText(renderText(widget, 42))).toMatchFileSnapshot(
            "./__snapshots__/todolist-widget.render.txt",
        );
        widget.dispose();
    });

    it("registers, updates, and clears the parent widget without replacing it", () => {
        const registrations: Array<{ key: string; content: unknown }> = [];
        const ctx = {
            mode: "tui",
            hasUI: true,
            ui: {
                setWidget(key: string, content: unknown) {
                    registrations.push({ key, content });
                },
            },
        } as unknown as ExtensionContext;

        updateTodoWidget(ctx, todo);
        expect(registrations).toHaveLength(1);
        expect(registrations[0]?.key).toBe(TODO_WIDGET_ID);
        const factory = registrations[0]?.content as (tui: unknown) => TodoListWidget;
        const component = factory({ requestRender() {} });
        const updated = { ...todo, items: todo.items.slice(0, 2) };
        updateTodoWidget(ctx, updated);
        expect(registrations).toHaveLength(1);
        expect(renderText(component, 80)).toContain("TODO 1/2 · Implement the feature with careful validation");
        clearTodoWidget(ctx);
        expect(registrations.at(-1)?.content).toBeUndefined();
        component.dispose();
    });

    it("updates its displayed list without replacing the component", () => {
        const widget = new TodoListWidget({ requestRender() {} } as any, todo);
        const updated = {
            ...todo,
            items: todo.items.slice(0, 2),
        };

        widget.setTodo(updated);

        expect(renderText(widget, 80)).toContain("TODO 1/2 · Implement the feature with careful validation");
        widget.dispose();
    });
});
