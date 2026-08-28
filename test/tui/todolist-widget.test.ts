import { describe, expect, it } from "vitest";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { snapshotText, renderText } from "../helpers";
import { TodoListWidget } from "../../src/tui/status";
import {
    PiCoderStatusWidget,
    registerStatusWidget,
    STATUS_WIDGET_ID,
} from "../../src/tui/status";
import { emitTodoStatus } from "../../src/modules/todolist/events";
import { emitAgentStatus } from "../../src/tools/agent/observability/events";

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

const largeTodo = {
    path: "/tmp/TODO.md",
    version: 1 as const,
    items: Array.from({ length: 20 }, (_, index) => {
        let status: "completed" | "in_progress" | "pending" = "pending";
        if (index === 6) {
            status = "in_progress";
        } else if (index < 6) {
            status = "completed";
        }
        return {
            id: `todo-${index + 1}`,
            title: `Task ${index + 1}`,
            status,
        };
    }),
    body: "",
};

function registerStatusForContext(ctx: ExtensionContext, events: ReturnType<typeof createEventBus>): (name: string, nextContext?: ExtensionContext) => void {
    const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
    registerStatusWidget({
        events,
        on(name: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
            const registered = handlers.get(name) ?? [];
            registered.push(handler);
            handlers.set(name, registered);
        },
    } as any);
    return (name, nextContext = ctx) => {
        for (const handler of handlers.get(name) ?? []) handler({}, nextContext);
    };
}

describe("TODO widget", () => {
    it("renders bounded progress and status-marked titles", async () => {
        const widget = new TodoListWidget({ requestRender() {} } as any, todo);

        await expect(snapshotText(renderText(widget, 42))).toMatchFileSnapshot(
            "./__snapshots__/todolist-widget.render.txt",
        );
        widget.dispose();
    });

    it("scrolls a large list to the first in-progress item", async () => {
        const widget = new TodoListWidget({ requestRender() {} } as any, largeTodo);

        await expect(snapshotText(renderText(widget, 60))).toMatchFileSnapshot(
            "./__snapshots__/todolist-widget.large.txt",
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
        const events = createEventBus();
        const trigger = registerStatusForContext(ctx, events);
        trigger("session_start");

        emitTodoStatus(events, todo);
        expect(registrations).toHaveLength(1);
        expect(registrations[0]?.key).toBe(STATUS_WIDGET_ID);
        const factory = registrations[0]?.content as (tui: unknown) => PiCoderStatusWidget;
        const component = factory({ requestRender() {} });
        const updated = { ...todo, items: todo.items.slice(0, 2) };
        emitTodoStatus(events, updated);
        expect(registrations).toHaveLength(1);
        expect(renderText(component, 80)).toContain("TODO 1/2 · Implement the feature with careful validation");
        emitTodoStatus(events, undefined);
        expect(registrations.at(-1)?.content).toBeUndefined();
        component.dispose();
    });

    it("combines agent activity and TODO progress in one widget", async () => {
        const registrations: Array<{ key: string; content: unknown; options?: { placement?: string } }> = [];
        const ctx = {
            mode: "tui",
            hasUI: true,
            ui: {
                setWidget(key: string, content: unknown, options?: { placement?: string }) {
                    registrations.push({ key, content, options });
                },
            },
        } as unknown as ExtensionContext;
        const events = createEventBus();
        const trigger = registerStatusForContext(ctx, events);
        trigger("session_start");
        const run = {
            runId: "worker-1",
            title: "Implement the feature",
            agent: "worker",
            status: "running",
            task: "Implement the feature",
            startedAt: Date.now(),
            phase: "Thinking",
            toolCounts: {},
        } as any;

        emitAgentStatus(events, [run], 0);
        emitTodoStatus(events, todo);

        expect(registrations).toHaveLength(1);
        expect(registrations[0]?.key).toBe(STATUS_WIDGET_ID);
        expect(registrations[0]?.options?.placement).toBe("aboveEditor");
        const widget = (registrations[0]?.content as (tui: unknown) => PiCoderStatusWidget)({
            requestRender() {},
        });
        const rendered = renderText(widget, 100);
        await expect(snapshotText(rendered)).toMatchFileSnapshot(
            "./__snapshots__/status-widget.combined.txt",
        );
        expect(rendered).toContain("worker-1");
        expect(rendered.indexOf("worker-1")).toBeLessThan(rendered.indexOf("TODO 1/4"));
        expect(rendered).toContain("\n\n");
        expect(rendered).toContain("TODO 1/4");

        emitAgentStatus(events, [], 0);
        expect(renderText(widget, 100)).toContain("TODO 1/4");
        emitTodoStatus(events, undefined);
        expect(registrations.at(-1)?.content).toBeUndefined();
        widget.dispose();
    });

    it("cleans event-bus state when clearing from a non-TUI lifecycle", () => {
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
        const events = createEventBus();
        const trigger = registerStatusForContext(ctx, events);
        trigger("session_start");

        emitTodoStatus(events, todo);
        const component = (registrations[0]?.content as (tui: unknown) => PiCoderStatusWidget)({
            requestRender() {},
        });
        trigger("session_shutdown", { ...ctx, mode: "print", hasUI: false } as ExtensionContext);
        trigger("session_start");
        emitTodoStatus(events, todo);

        expect(registrations).toHaveLength(2);
        expect(registrations[1]?.key).toBe(STATUS_WIDGET_ID);
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
