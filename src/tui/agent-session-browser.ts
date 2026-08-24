import type { EventBus, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    matchesKey,
    truncateToWidth,
    Spacer,
    Text,
} from "@earendil-works/pi-tui";
import type { ListItem, ListViewRenderItemOptions, ListViewState } from "./list-view";
import { ListViewComponent } from "./list-view";
import type {
    AgentSessionBrowserItem,
    AgentWorkspaceBrowserItem,
    WorkspaceDispositionAction,
} from "../tools/agent/presentation/browser-models";
import {
    AGENT_EVENT_CHANNEL,
    isAgentEvent,
} from "../tools/agent/observability/events";
import { BORDER_STYLES } from "./border-box";
import { withOverlayStack } from "./overlay-stack";
import { AgentSessionDetailComponent } from "./agent-session-detail";
import {
    AgentWorkspaceDetailComponent,
    agentWorkspaceItemText,
    type AgentWorkspaceAction,
} from "./agent-workspace-browser";

export type { AgentWorkspaceAction } from "./agent-workspace-browser";

type AgentBrowserItem = AgentSessionBrowserItem | AgentWorkspaceBrowserItem;
type AgentBrowserTab = "current" | "past" | "workspaces";

interface AgentSessionBrowserState extends ListViewState<AgentBrowserItem> {
    tab: AgentBrowserTab;
}

export interface AgentSessionBrowserData {
    current: AgentSessionBrowserItem[];
    past: AgentSessionBrowserItem[];
    workspaces?: AgentWorkspaceBrowserItem[];
}

export interface AgentSessionBrowserOptions extends AgentSessionBrowserData {
    cwd?: string;
    eventBus?: EventBus;
    onRefresh?: () => Promise<AgentSessionBrowserData>;
    fixedHeight?: () => number;
    onResume?: (item: AgentSessionBrowserItem) => void | Promise<void>;
    onCancel?: (item: AgentSessionBrowserItem) => void | Promise<void>;
    onWorkspaceAction?: (workspace: AgentWorkspaceBrowserItem, action: WorkspaceDispositionAction) => AgentWorkspaceBrowserItem | null | undefined | Promise<AgentWorkspaceBrowserItem | null | undefined>;
    onWorkspaceInspect?: (workspace: AgentWorkspaceBrowserItem) => string | Promise<string>;
    onInvalidate?: () => void;
}

const EMPTY_CURRENT: AgentSessionBrowserItem = {
    kind: "empty",
    id: "empty-current",
    title: "",
    agent: "",
    status: "",
    task: "No delegated agents are active in this parent session.",
    updatedAt: 0,
};

const EMPTY_PAST: AgentSessionBrowserItem = {
    kind: "empty",
    id: "empty-past",
    title: "",
    agent: "",
    status: "",
    task: "No persisted child sessions were found for this cwd.",
    updatedAt: 0,
};

const EMPTY_WORKSPACES: AgentBrowserItem = {
    kind: "empty",
    id: "empty-workspaces",
    title: "",
    agent: "",
    status: "",
    task: "No isolated workspaces have been created for this cwd.",
    updatedAt: 0,
};

function asSessionListItems(items: AgentSessionBrowserItem[], empty: AgentSessionBrowserItem): ListItem<AgentBrowserItem>[] {
    return (items.length ? items : [empty]).map((value) => ({
        value,
        label: value.kind === "empty" ? value.task : `${value.title} · ${value.agent}`,
        disabled: value.kind === "empty",
    }));
}

function asWorkspaceListItems(workspaces: AgentWorkspaceBrowserItem[]): ListItem<AgentBrowserItem>[] {
    return (workspaces.length ? workspaces : [EMPTY_WORKSPACES]).map((value) => ({
        value,
        label: isWorkspace(value) ? value.slug : value.task,
        disabled: !isWorkspace(value),
    }));
}

function isWorkspace(item: AgentBrowserItem): item is AgentWorkspaceBrowserItem {
    return item.kind === "workspace";
}

function isSession(item: AgentBrowserItem): item is AgentSessionBrowserItem {
    return !isWorkspace(item);
}

function dateText(timestamp: number | undefined): string {
    return timestamp === undefined ? "unknown time" : new Date(timestamp).toLocaleString();
}

function oneLine(text: string, maxChars = 240): string {
    const normalized = text.replace(/\\s+/g, " ").trim();
    return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function compactNumber(value: number): string {
    const absolute = Math.abs(value);
    const units = [
        { value: 1_000_000_000, suffix: "b" },
        { value: 1_000_000, suffix: "m" },
        { value: 1_000, suffix: "k" },
    ];
    const unit = units.find((candidate) => absolute >= candidate.value);
    if (!unit) return String(value);
    const scaled = value / unit.value;
    const precision = Math.abs(scaled) < 10 ? 1 : 0;
    return `${Number(scaled.toFixed(precision))}${unit.suffix}`;
}

function usageText(usage: NonNullable<AgentSessionBrowserItem["usage"]>): string {
    return `${compactNumber(usage.input)} input, ${compactNumber(usage.output)} output, $${usage.cost.total.toFixed(4)}`;
}

function returnedText(item: AgentSessionBrowserItem): string | undefined {
    if (item.responsePreview) return oneLine(item.responsePreview);
    if (item.allMessagesText) return oneLine(item.allMessagesText.slice(-1_000));
    return undefined;
}

function tabText(tab: AgentBrowserTab, theme: Theme, includeWorkspaces: boolean): string {
    const current = tab === "current"
        ? theme.fg("accent", theme.bold("● Current"))
        : theme.fg("dim", "○ Current");
    const past = tab === "past"
        ? theme.fg("accent", theme.bold("● Past"))
        : theme.fg("dim", "○ Past");
    if (!includeWorkspaces) return `${current}    ${past}`;
    const workspaces = tab === "workspaces"
        ? theme.fg("accent", theme.bold("● Workspaces"))
        : theme.fg("dim", "○ Workspaces");
    return `${current}    ${past}    ${workspaces}`;
}

function itemText(
    item: AgentBrowserItem,
    theme: Theme,
): string {
    if (isWorkspace(item)) return agentWorkspaceItemText(item, theme);
    if (item.kind === "empty") return theme.fg("muted", item.task);

    const mode = item.agent === "workspace-setup"
        ? "workspace setup"
        : item.mutating ? "worker" : item.agent;
    const status = item.status.replaceAll("_", " ");
    const headline = `${item.title || "Untitled run"} · ${mode} · ${status} · ${dateText(item.updatedAt)}`;
    const task = `Task: ${oneLine(item.task)}`;
    const returned = returnedText(item);
    const activity = item.activity ? ` · ${oneLine(item.activity, 120)}` : "";
    const preview = item.kind === "current" && returned
        ? `\n${theme.fg("muted", `Result: ${returned}`)}`
        : "";
    return theme.fg("accent", headline) + `\n${task}${activity}${preview}`;
}

export class AgentSessionBrowserComponent extends ListViewComponent<
    AgentBrowserItem,
    void,
    AgentSessionBrowserState
> {
    private readonly current: AgentSessionBrowserItem[];
    private sessionDetail: AgentSessionDetailComponent | null = null;
    private workspaceDetail: AgentWorkspaceDetailComponent | null = null;
    private readonly past: AgentSessionBrowserItem[];
    private readonly workspaces: AgentWorkspaceBrowserItem[];
    private readonly onRefresh?: () => Promise<AgentSessionBrowserData>;
    private readonly onInvalidate?: () => void;
    private readonly unsubscribeEvents?: () => void;
    private refreshInFlight = false;
    private refreshPending = false;
    private disposed = false;

    private updateWorkspace(workspace: AgentWorkspaceBrowserItem, replacement: AgentWorkspaceBrowserItem | null | undefined): void {
        const index = this.workspaces.findIndex((item) => item.id === workspace.id);
        if (index < 0) return;
        if (replacement === null) {
            this.workspaces.splice(index, 1);
        } else if (replacement) {
            this.workspaces[index] = replacement;
        }
        if (this.state.tab === "workspaces") {
            this.state.items = asWorkspaceListItems(this.workspaces);
            this.state.cursor = Math.min(this.state.cursor ?? 0, Math.max(0, this.state.items.length - 1));
        }
        this.invalidate();
    }

    private rebuildItems(): void {
        const selectedId = this.state.items[this.state.cursor ?? 0]?.value.id;
        this.state.items = this.state.tab === "current"
            ? asSessionListItems(this.current, EMPTY_CURRENT)
            : this.state.tab === "past"
                ? asSessionListItems(this.past, EMPTY_PAST)
                : asWorkspaceListItems(this.workspaces);
        const selectedIndex = selectedId === undefined
            ? -1
            : this.state.items.findIndex((item) => item.value.id === selectedId);
        this.state.cursor = selectedIndex >= 0
            ? selectedIndex
            : Math.min(this.state.cursor ?? 0, Math.max(0, this.state.items.length - 1));
        this.state.scrollOffset = 0;
    }

    private scheduleRefresh(): void {
        if (this.disposed || !this.onRefresh) return;
        if (this.refreshInFlight) {
            this.refreshPending = true;
            return;
        }
        this.refreshInFlight = true;
        void (async () => {
            try {
                do {
                    this.refreshPending = false;
                    const data = await this.onRefresh!();
                    if (this.disposed) return;
                    this.current.splice(0, this.current.length, ...data.current);
                    this.past.splice(0, this.past.length, ...data.past);
                    this.workspaces.splice(0, this.workspaces.length, ...(data.workspaces ?? []));
                    if (this.workspaceDetail) {
                        const replacement = this.workspaces.find((item) => (
                            item.id === this.workspaceDetail?.workspace.id
                        ));
                        if (replacement) {
                            this.workspaceDetail.updateWorkspace(replacement);
                        } else {
                            this.workspaceDetail.close();
                        }
                    }
                    this.rebuildItems();
                    this.invalidate();
                    this.onInvalidate?.();
                } while (this.refreshPending && !this.disposed);
            } catch (error) {
                console.error("Agent browser refresh failed:", error);
            } finally {
                this.refreshInFlight = false;
            }
        })();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribeEvents?.();
    }

    constructor(options: AgentSessionBrowserOptions) {
        const current = options.current;
        const past = options.past;
        const workspaces = options.workspaces ?? [];
        const includeWorkspaces = options.workspaces !== undefined;
        const tabs: AgentBrowserTab[] = includeWorkspaces
            ? ["current", "past", "workspaces"]
            : ["current", "past"];
        let activeTab: AgentSessionBrowserState["tab"] = "current";
        let tabHeader: Text | undefined;
        let tabTheme: Theme | undefined;
        const itemsForTab = (tab: AgentBrowserTab): ListItem<AgentBrowserItem>[] => (
            tab === "current"
                ? asSessionListItems(current, EMPTY_CURRENT)
                : tab === "past"
                    ? asSessionListItems(past, EMPTY_PAST)
                    : asWorkspaceListItems(workspaces)
        );
        const refreshTabHeader = () => {
            if (tabHeader && tabTheme) tabHeader.setText(tabText(activeTab, tabTheme, includeWorkspaces));
        };
        super(
            {
                title: includeWorkspaces ? "Agents" : "Delegated agent sessions",
                borderColor: "borderMuted",
                borderCharacters: BORDER_STYLES.rounded,
                fixedHeight: options.fixedHeight,
                trailingSpacer: false,
                itemSpacing: 1,
                helpText: `↑/↓ navigate · Tab/←/→ switch tab · Enter open${options.onResume || options.onCancel ? " · r resume · c cancel" : ""} · Esc close`,
                headerContent: (container, theme) => {
                    tabTheme = theme;
                    tabHeader = new Text(tabText(activeTab, theme, includeWorkspaces), 5, 0);
                    container.addChild(tabHeader);
                    container.addChild(new Text(
                        theme.fg("muted", includeWorkspaces
                            ? "Current and Past show delegated sessions; Workspaces shows isolated worker checkouts."
                            : "Current shows this parent session; Past shows durable child results for this cwd."),
                        5,
                        0,
                    ));
                },
                renderItem: (item: ListItem<AgentBrowserItem>, options: ListViewRenderItemOptions<AgentBrowserItem, AgentSessionBrowserState>) => {
                    const content = itemText(item.value, options.theme);
                    return options.isCursor ? content : options.theme.fg("text", content);
                },
                onKey: (key, state) => {
                    const selected = state.items[state.cursor ?? 0]?.value;
                    if (key === "r" && selected && isSession(selected) && selected.kind === "current" && selected.status === "interrupted") {
                        this.finish(undefined);
                        queueMicrotask(() => void options.onResume?.(selected));
                        return true;
                    }
                    if (key === "c" && selected && isSession(selected) && selected.kind === "current" && (
                        selected.status === "starting"
                        || selected.status === "running"
                        || selected.status === "waiting_for_permission"
                        || selected.status === "interrupted"
                        || selected.status === "waiting_for_parent"
                    )) {
                        this.finish(undefined);
                        queueMicrotask(() => void options.onCancel?.(selected));
                        return true;
                    }
                    if (matchesKey(key, "tab") || matchesKey(key, "left") || matchesKey(key, "right")) {
                        const currentIndex = tabs.indexOf(state.tab);
                        const nextIndex = matchesKey(key, "left")
                            ? Math.max(0, currentIndex - 1)
                            : matchesKey(key, "right")
                                ? Math.min(tabs.length - 1, currentIndex + 1)
                                : (currentIndex + 1) % tabs.length;
                        const nextTab = tabs[nextIndex];
                        activeTab = nextTab;
                        refreshTabHeader();
                        state.tab = nextTab;
                        state.items = itemsForTab(nextTab);
                        state.cursor = 0;
                        state.scrollOffset = 0;
                        return true;
                    }
                    if (matchesKey(key, "enter")) {
                        const selected = state.items[state.cursor ?? 0]?.value;
                        if (selected && this.theme) {
                            if (isWorkspace(selected)) {
                                let detail: AgentWorkspaceDetailComponent;
                                detail = new AgentWorkspaceDetailComponent(
                                    selected,
                                    this.listOptions.fixedHeight,
                                    {
                                        onInspect: () => options.onWorkspaceInspect?.(detail.workspace)
                                            ?? "No saved worker result is available.",
                                        onAction: async (action) => {
                                            const workspace = detail.workspace;
                                            const replacement = await options.onWorkspaceAction?.(workspace, action);
                                            this.updateWorkspace(workspace, replacement);
                                            return replacement;
                                        },
                                        onInvalidate: options.onInvalidate,
                                    },
                                );
                                this.workspaceDetail = detail;
                                detail.initialize(this.theme);
                                detail.setDoneCallback(() => {
                                    this.workspaceDetail = null;
                                    this.invalidate();
                                });
                            } else if (selected.kind !== "empty") {
                                this.sessionDetail = new AgentSessionDetailComponent({
                                    item: selected,
                                    fixedHeight: this.listOptions.fixedHeight,
                                });
                                this.sessionDetail.initialize(this.theme);
                                this.sessionDetail.setDoneCallback(() => {
                                    this.sessionDetail = null;
                                    this.invalidate();
                                });
                            }
                        }
                        return true;
                    }
                    return false;
                },
                footerContent: (container, theme, state) => {
                    const count = state.tab === "current"
                        ? current.length
                        : state.tab === "past"
                            ? past.length
                            : workspaces.length;
                    const label = state.tab === "workspaces" ? "workspace" : "session";
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(
                        theme.fg("dim", `${count} ${label}${count === 1 ? "" : "s"}`),
                        1,
                        0,
                    ));
                },
            },
            {
                items: itemsForTab("current"),
                cursor: 0,
                scrollOffset: 0,
                maxVisibleLines: 12,
                tab: "current",
            },
        );
        this.current = current;
        this.past = past;
        this.workspaces = workspaces;
        this.onRefresh = options.onRefresh;
        this.onInvalidate = options.onInvalidate;
        if (options.eventBus && options.cwd && options.onRefresh) {
            this.unsubscribeEvents = options.eventBus.on(AGENT_EVENT_CHANNEL, (data) => {
                if (!isAgentEvent(data)) return;
                const isRelevant = data.cwd === options.cwd
                    || (data.type === "run" && data.parentCwd === options.cwd);
                if (!isRelevant) return;
                this.scheduleRefresh();
            });
        }
    }

    override render(width: number): string[] {
        if (this.sessionDetail) return this.sessionDetail.render(width);
        if (this.workspaceDetail) return this.workspaceDetail.render(width);
        const height = this.listOptions.fixedHeight?.();
        if (height !== undefined) this.state.maxVisibleLines = Math.max(1, height - 11);
        return super.render(width).map((line) => truncateToWidth(line, width, ""));
    }

    override handleInput(key: string): void {
        if (this.sessionDetail) {
            this.sessionDetail.handleInput(key);
            return;
        }
        if (this.workspaceDetail) {
            this.workspaceDetail.handleInput(key);
            return;
        }
        super.handleInput(key);
    }

    protected override getItemPrefix(index: number, isCursor: boolean) {
        if (this.state.items[index]?.disabled) return { first: "  ", continuation: "  " };
        return super.getItemPrefix(index, isCursor);
    }

    protected override handleAction(key: string): void {
        if (matchesKey(key, "escape") || key === "q") this.finish(undefined);
    }
}

export async function showAgentSessionBrowser(
    options: AgentSessionBrowserOptions,
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    await withOverlayStack((overlay) => ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        overlay.bind(tui);
        const fixedHeight = () => Math.max(
            2,
            Math.min(
                Math.floor(tui.terminal.rows * 0.82),
                Math.max(2, tui.terminal.rows - 2),
            ),
        );
        const component = new AgentSessionBrowserComponent({
            ...options,
            fixedHeight,
            onInvalidate: () => tui.requestRender(),
        });
        component.setDoneCallback((result) => {
            component.dispose();
            done(result);
        });
        component.initialize(theme);
        return component;
    }, {
        overlay: true,
        overlayOptions: {
            width: "84%",
            minWidth: 64,
            maxHeight: "82%",
            anchor: "center",
            margin: 1,
        },
        onHandle: overlay.setHandle,
    }));
}
