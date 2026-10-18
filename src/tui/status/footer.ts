import type {
    EventBus,
    ExtensionAPI,
    ExtensionContext,
    ReadonlyFooterDataProvider,
    Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import type { TodoList } from "../../modules/todolist/parser";
import {
    TODO_STATUS_EVENT,
    type TodoStatusEvent,
    isTodoStatusEvent,
} from "../../modules/todolist/events";
import type { AgentRunSummary } from "../../tools/agent/contracts/runs";
import {
    AGENT_STATUS_EVENT,
    type AgentStatusEvent,
    isAgentStatusEvent,
} from "../../tools/agent/observability/events";
import { Spinner } from "../spinner";
import { formatAgentSummary } from "./agent-activity-format";
import { formatTodoProgress, summarizeTodoList } from "./format";
import {
    UsageTotalsCache,
    footerInfoSegments,
    layoutFooterLine,
    type FooterLineSegment,
} from "./footer-info";

const MAX_TODO_CURRENT_CHARS = 40;

/**
 * The parent status footer: one compact line combining the visible agent runs and TODO progress
 * with cwd/branch, context usage, and the model. Registered for the whole session through
 * `ctx.ui.setFooter()`, replacing the above-editor status widget.
 */
export class PiCoderFooter implements Component {
    private readonly spinner: Spinner;
    private readonly totals = new UsageTotalsCache();
    private runs: AgentRunSummary[];
    private hiddenCount: number;
    private todo: TodoList | undefined;
    private disposed = false;

    constructor(
        private readonly tui: TUI,
        private readonly theme: Theme,
        private readonly footerData: ReadonlyFooterDataProvider,
        private readonly context: ExtensionContext,
        runs: AgentRunSummary[] = [],
        hiddenCount = 0,
        todo: TodoList | undefined = undefined,
        events?: EventBus,
    ) {
        this.spinner = new Spinner(tui, { events });
        this.runs = runs;
        this.hiddenCount = hiddenCount;
        this.todo = todo;
        this.updateSpinner();
    }

    setAgents(runs: AgentRunSummary[], hiddenCount = 0): void {
        this.runs = runs;
        this.hiddenCount = hiddenCount;
        this.updateSpinner();
        this.tui.requestRender();
    }

    setTodo(todo: TodoList | undefined): void {
        this.todo = todo;
        this.tui.requestRender();
    }

    render(width: number): string[] {
        const info = footerInfoSegments(this.theme, {
            cwd: this.context.cwd,
            home: process.env.HOME || process.env.USERPROFILE,
            branch: this.footerData.getGitBranch(),
            model: this.context.model,
            contextUsage: this.context.getContextUsage(),
            totals: this.totals.get(this.context.sessionManager),
            extensionStatuses: this.footerData.getExtensionStatuses(),
        });

        const segments: FooterLineSegment[] = [
            // Left: the agent summary is kept longest, then TODO, then extension statuses.
            {
                text: formatAgentSummary(this.runs, this.hiddenCount, this.spinner.getFrame()),
                side: "left",
                dropPriority: 4,
            },
            {
                text: this.todo
                    ? formatTodoProgress(summarizeTodoList(this.todo), MAX_TODO_CURRENT_CHARS)
                    : "",
                side: "left",
                dropPriority: 5,
            },
            { text: info.statuses, side: "left", dropPriority: 6 },
            // Right: the cluster reserves its width, so these only shed when it cannot fit alone.
            { text: info.usage, side: "right", dropPriority: 2 },
            { text: info.context, side: "right", dropPriority: 0 },
            { text: info.model, side: "right", dropPriority: 3 },
            { text: info.cwd, side: "right", dropPriority: 1 },
        ];

        return [layoutFooterLine(segments, Math.max(1, width))];
    }

    invalidate(): void {
        // Footer state is updated explicitly after each event; themed info lines rebuild every render.
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.spinner.dispose();
    }

    private updateSpinner(): void {
        this.spinner.setActive(this.runs.some((run) => run.status === "running"));
    }
}

interface StatusFooterState {
    events: EventBus;
    context?: ExtensionContext;
    runs: AgentRunSummary[];
    hiddenCount: number;
    todo?: TodoList;
    registered: boolean;
    component?: PiCoderFooter;
}

const footerStates = new WeakMap<object, StatusFooterState>();

function stateFor(events: EventBus): StatusFooterState {
    const existing = footerStates.get(events);
    if (existing) return existing;

    const state: StatusFooterState = {
        events,
        runs: [],
        hiddenCount: 0,
        registered: false,
    };
    footerStates.set(events, state);
    return state;
}

function clearState(state: StatusFooterState, ctx?: ExtensionContext): void {
    if (state.registered && ctx?.mode === "tui" && ctx.hasUI) {
        ctx.ui.setFooter(undefined);
    } else {
        state.component?.dispose();
    }

    state.runs = [];
    state.hiddenCount = 0;
    state.todo = undefined;
    state.registered = false;
    state.component = undefined;
}

function ensureFooter(state: StatusFooterState): void {
    const ctx = state.context;
    if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
    if (state.registered) return;

    state.registered = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
        const component = new PiCoderFooter(
            tui,
            theme,
            footerData,
            ctx,
            state.runs,
            state.hiddenCount,
            state.todo,
            state.events,
        );
        state.component = component;
        return component;
    });
}

function applyAgentEvent(state: StatusFooterState, event: AgentStatusEvent): void {
    state.runs = event.runs;
    state.hiddenCount = event.hiddenCount;
    state.component?.setAgents(state.runs, state.hiddenCount);
}

function applyTodoEvent(state: StatusFooterState, event: TodoStatusEvent): void {
    state.todo = event.todo;
    state.component?.setTodo(state.todo);
}

/** Register the single parent status footer and its domain-event listeners. */
export function registerStatusFooter(pi: ExtensionAPI): void {
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
        ensureFooter(state);
    });
    pi.on("session_tree", (_event, ctx) => {
        clearState(state, ctx);
        state.context = ctx;
        ensureFooter(state);
    });
    pi.on("session_shutdown", (_event, ctx) => {
        clearState(state, ctx);
        state.context = undefined;
    });
}
