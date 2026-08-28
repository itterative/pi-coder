import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import type { TodoList } from "../../modules/todolist/parser";
import { TODO_STATUS_EVENT, type TodoStatusEvent, isTodoStatusEvent } from "../../modules/todolist/events";
import type { AgentRunSummary } from "../../tools/agent/contracts/runs";
import {
    AGENT_STATUS_EVENT,
    type AgentStatusEvent,
    isAgentStatusEvent,
} from "../../tools/agent/observability/events";
import { AgentActivityWidget } from "../agents/activity-widget";
import { TodoListWidget } from "../todolist-widget";

export const STATUS_WIDGET_ID = "pi-coder-status";

interface StatusWidgetState {
    events: EventBus;
    context?: ExtensionContext;
    runs: AgentRunSummary[];
    hiddenCount: number;
    todo?: TodoList;
    registered: boolean;
    component?: PiCoderStatusWidget;
}

const widgetStates = new WeakMap<object, StatusWidgetState>();

export class PiCoderStatusWidget implements Component {
    private readonly activity: AgentActivityWidget;
    private todoWidget: TodoListWidget | undefined;
    private hasAgentContent: boolean;

    constructor(
        private readonly tui: TUI,
        runs: AgentRunSummary[] = [],
        hiddenCount = 0,
        todo: TodoList | undefined,
        events?: EventBus,
    ) {
        this.activity = new AgentActivityWidget(tui, runs, hiddenCount, events);
        this.hasAgentContent = runs.length > 0 || hiddenCount > 0;
        this.todoWidget = todo ? new TodoListWidget(tui, todo) : undefined;
    }

    setAgents(runs: AgentRunSummary[], hiddenCount = 0): void {
        this.hasAgentContent = runs.length > 0 || hiddenCount > 0;
        this.activity.setRuns(runs, hiddenCount);
    }

    setTodo(todo: TodoList | undefined): void {
        if (todo) {
            if (this.todoWidget) {
                this.todoWidget.setTodo(todo);
                return;
            }
            this.todoWidget = new TodoListWidget(this.tui, todo);
            this.tui.requestRender();
            return;
        }

        this.todoWidget?.dispose();
        this.todoWidget = undefined;
        this.tui.requestRender();
    }

    render(width: number): string[] {
        const lines = this.hasAgentContent ? this.activity.render(width) : [];
        if (this.todoWidget) lines.push(...this.todoWidget.render(width));
        return lines;
    }

    invalidate(): void {
        // Child components read the current state during each render.
    }

    dispose(): void {
        this.activity.dispose();
        this.todoWidget?.dispose();
    }
}

function stateFor(events: EventBus): StatusWidgetState {
    const existing = widgetStates.get(events);
    if (existing) return existing;

    const state: StatusWidgetState = {
        events,
        runs: [],
        hiddenCount: 0,
        registered: false,
    };
    widgetStates.set(events, state);
    return state;
}

function clearState(state: StatusWidgetState, ctx?: ExtensionContext): void {
    if (state.registered && ctx?.mode === "tui" && ctx.hasUI) {
        ctx.ui.setWidget(STATUS_WIDGET_ID, undefined);
    } else {
        state.component?.dispose();
    }

    state.runs = [];
    state.hiddenCount = 0;
    state.todo = undefined;
    state.registered = false;
    state.component = undefined;
}

function ensureWidget(state: StatusWidgetState): void {
    const ctx = state.context;
    if (!state.runs.length && !state.todo) {
        if (state.registered && ctx?.mode === "tui" && ctx.hasUI) {
            ctx.ui.setWidget(STATUS_WIDGET_ID, undefined);
        } else {
            state.component?.dispose();
        }
        state.registered = false;
        state.component = undefined;
        return;
    }
    if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
    if (state.component || state.registered) return;

    const events = state.events;
    state.registered = true;
    ctx.ui.setWidget(
        STATUS_WIDGET_ID,
        (tui) => {
            const component = new PiCoderStatusWidget(
                tui,
                state.runs,
                state.hiddenCount,
                state.todo,
                events,
            );
            state.component = component;
            return component;
        },
        { placement: "aboveEditor" },
    );
}

function applyAgentEvent(state: StatusWidgetState, event: AgentStatusEvent): void {
    state.runs = event.runs;
    state.hiddenCount = event.hiddenCount;
    state.component?.setAgents(state.runs, state.hiddenCount);
    ensureWidget(state);
}

function applyTodoEvent(state: StatusWidgetState, event: TodoStatusEvent): void {
    state.todo = event.todo;
    state.component?.setTodo(state.todo);
    ensureWidget(state);
}

/** Register the single parent status widget and its domain-event listeners. */
export function registerStatusWidget(pi: ExtensionAPI): void {
    const events = pi.events;
    if (!events) return;

    const state = stateFor(events);
    events.on(AGENT_STATUS_EVENT, (data) => {
        if (isAgentStatusEvent(data)) applyAgentEvent(state, data);
    });
    events.on(TODO_STATUS_EVENT, (data) => {
        if (isTodoStatusEvent(data)) applyTodoEvent(state, data);
    });

    pi.on("session_start", (_event, ctx) => {
        clearState(state, ctx);
        state.context = ctx;
    });
    pi.on("session_tree", (_event, ctx) => {
        clearState(state, ctx);
        state.context = ctx;
    });
    pi.on("session_shutdown", (_event, ctx) => {
        clearState(state, ctx);
        state.context = undefined;
    });
}
