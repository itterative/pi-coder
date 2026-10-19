import type {
    EventBus,
    ExtensionAPI,
    ExtensionContext,
    ReadonlyFooterDataProvider,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import decisionConfig from "../../modules/decision/config";
import {
    DECISION_STATUS_EVENT,
    type DecisionStatusEvent,
    isDecisionStatusEvent,
} from "../../modules/decision/events";
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
import { formatAgentSummary, hasActiveAgentRuns } from "./agent-activity-format";
import { formatTodoProgress, summarizeTodoList } from "./format";
import { TipRotator, type FooterTip } from "./tips";
import {
    UsageTotalsCache,
    footerInfoSegments,
    layoutFooterLine,
    type FooterLineSegment,
} from "./footer-info";

const MAX_TODO_CURRENT_CHARS = 40;
const MAX_RIGHT_TIP_CHARS = 56;

/**
 * The parent status footer: one compact line combining the decision model's auto-mode state, the visible
 * agent runs, and TODO progress on the left, with usage totals, context usage, the model, and the
 * cwd/branch on the right. Registered for the whole session through `ctx.ui.setFooter()`, replacing the
 * above-editor status widget.
 */
export class PiCoderFooter implements Component {
    private readonly spinner: Spinner;
    private readonly tips: TipRotator;
    private readonly totals = new UsageTotalsCache();
    private runs: AgentRunSummary[];
    private hiddenCount: number;
    private todo: TodoList | undefined;
    private tip: FooterTip | undefined;
    private decisionChecking = 0;
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
        this.tips = new TipRotator((tip) => this.setTip(tip), {
            isLineIdle: () => this.isIdle(),
        });
        this.runs = runs;
        this.hiddenCount = hiddenCount;
        this.todo = todo;
        this.updateSpinner();
        this.tips.start();
    }

    setAgents(runs: AgentRunSummary[], hiddenCount = 0): void {
        this.runs = runs;
        this.hiddenCount = hiddenCount;
        this.tips.recheck();
        this.updateSpinner();
        this.tui.requestRender();
    }

    setTodo(todo: TodoList | undefined): void {
        this.todo = todo;
        this.tips.recheck();
        this.tui.requestRender();
    }

    setDecisionChecking(checking: number): void {
        this.decisionChecking = checking;
        this.updateSpinner();
        this.tui.requestRender();
    }

    /** Set the visible help tip; the rotator calls this when a tip's window opens and closes. */
    setTip(tip: FooterTip | undefined): void {
        this.tip = tip;
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

        const agentActive = hasActiveAgentRuns(this.runs);
        // A tip takes whichever slot is free: the TODO's while the line is idle, the usage numbers'
        // while an agent is active.
        const tip = this.visibleTip();
        const leftTip = tip && !agentActive ? this.tipSegment(tip, "left") : undefined;
        const rightTip = tip && agentActive ? this.tipSegment(tip, "right") : undefined;
        const usage: FooterLineSegment = rightTip ?? {
            text: info.usage,
            side: "right",
            dropPriority: 2,
        };

        const segments: FooterLineSegment[] = [
            // Left: the agent summary is kept longest, then auto mode, TODO, and extension statuses.
            { text: this.decisionBadge(), side: "left", dropPriority: 4 },
            {
                text: formatAgentSummary(this.runs, this.hiddenCount, this.spinner.getFrame()),
                side: "left",
                dropPriority: 3,
            },
            leftTip ?? this.todoLineSegment(),
            { text: info.statuses, side: "left", dropPriority: 6 },
            // Right: the cluster reserves its width, so these only shed when it cannot fit alone.
            usage,
            { text: rightTip ? "" : info.context, side: "right", dropPriority: 0 },
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
        this.tips.dispose();
    }

    private updateSpinner(): void {
        const agentRunning = this.runs.some((run) => run.status === "running");
        this.spinner.setActive(agentRunning || this.decisionChecking > 0);
    }

    /**
     * The decision model's badge: `» auto` (accent) while the classifier is enabled, `» manual` (dim)
     * while it is off so the shortcut's state stays visible, and the shared spinner frame in place of the
     * `»` while a check is in flight.
     */
    private decisionBadge(): string {
        if (this.decisionChecking > 0) {
            return this.theme.fg("accent", `${this.spinner.getFrame()} auto`);
        }

        if (decisionConfig.current.enabled === true) {
            return this.theme.fg("accent", "» auto");
        }

        return this.theme.fg("dim", "» manual");
    }

    /**
     * The current help tip as a dim `tip: …` segment. `shrinkToFit` lets the layout trim it into the
     * space that remains instead of dropping it, and the styled ellipsis keeps that trim muted. A tip in
     * the right cluster is capped so it cannot balloon the cluster that reserves width first; a left tip
     * takes whatever the cluster leaves it.
     */
    private tipSegment(tip: FooterTip, side: "left" | "right"): FooterLineSegment {
        const label = `tip: ${tip.text}`;
        const capped = side === "right" ? truncateToWidth(label, MAX_RIGHT_TIP_CHARS, "…") : label;

        return {
            text: this.theme.fg("dim", capped),
            side,
            dropPriority: side === "right" ? 4 : 5,
            shrinkToFit: true,
            ellipsis: this.theme.fg("dim", "…"),
        };
    }

    /**
     * The tip that may render right now: a conditioned tip drops out as soon as its state stops
     * applying, without waiting for the rotator's window to close.
     */
    private visibleTip(): FooterTip | undefined {
        if (this.tip?.when?.() === false) {
            return undefined;
        }

        return this.tip;
    }

    /** True while the line has nothing of its own to show, so a tip may skip its wait and stay up. */
    private isIdle(): boolean {
        if (hasActiveAgentRuns(this.runs)) {
            return false;
        }

        return this.todo === undefined || summarizeTodoList(this.todo) === undefined;
    }

    /**
     * TODO progress as a left segment: muted once every item is complete (the final item still names what
     * finished), and hidden while an agent is active because the footer speaks for the agent instead.
     * `shrinkToFit` keeps the plan on the line beside the mode badge instead of dropping it, with the
     * trimming ellipsis following the segment's own dim state.
     */
    private todoLineSegment(): FooterLineSegment {
        if (!this.todo || hasActiveAgentRuns(this.runs)) {
            return { text: "", side: "left", dropPriority: 5 };
        }

        const progress = summarizeTodoList(this.todo);
        const text = formatTodoProgress(progress, MAX_TODO_CURRENT_CHARS);
        const complete = progress !== undefined && progress.completed === progress.total;

        return {
            text: complete ? this.theme.fg("dim", text) : text,
            side: "left",
            dropPriority: 5,
            shrinkToFit: true,
            ellipsis: complete ? this.theme.fg("dim", "…") : "…",
        };
    }
}

interface StatusFooterState {
    events: EventBus;
    context?: ExtensionContext;
    runs: AgentRunSummary[];
    hiddenCount: number;
    todo?: TodoList;
    decisionChecking: number;
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
        decisionChecking: 0,
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
    state.decisionChecking = 0;
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

function applyDecisionEvent(state: StatusFooterState, event: DecisionStatusEvent): void {
    state.decisionChecking = event.checking;
    state.component?.setDecisionChecking(event.checking);
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
    events.on(DECISION_STATUS_EVENT, (data) => {
        if (isDecisionStatusEvent(data)) applyDecisionEvent(state, data);
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
