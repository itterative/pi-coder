import path from "node:path";
import type { EventBus, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { BuiltinAgentName } from "../../tools/agent/config";
import type {
    AgentSessionBrowserItem,
    AgentWorkspaceBrowserItem,
} from "../../tools/agent/presentation/browser-models";
import { AGENT_EVENT_CHANNEL, isAgentEvent } from "../../tools/agent/observability/events";
import { BORDER_STYLES } from "../border-box";
import { ListViewComponent, type ListItem, type ListViewRenderItemOptions, type ListViewState } from "../list-view";
import { SelectComponent } from "../select";
import { withOverlayStack } from "../overlay-stack";
import { AgentSessionDetailComponent } from "./session-detail";
import { AgentWorkspaceDetailComponent } from "./workspace";
import {
    asSessionListItems,
    asSettingsListItems,
    asWorkspaceListItems,
    agentWorkspaceItemText,
    type WorkspaceListItem,
    dateText,
    oneLine,
    returnedText,
} from "./formatting";
import { RefreshCoordinator, type RefreshTarget } from "./refresh";
import type {
    AgentModelOption,
    AgentSetting,
    AgentSessionBrowserData,
    AgentSessionBrowserOptions,
} from "./types";

export type { AgentModelOption, AgentSetting, AgentSessionBrowserData, AgentSessionBrowserOptions } from "./types";
export type { AgentWorkspaceAction } from "./workspace";

type BrowserItem = AgentSessionBrowserItem | WorkspaceListItem | AgentSetting;
type BrowserTab = "agents" | "workspaces" | "settings";
type BrowserScope = "session" | "historical";
interface BrowserState extends ListViewState<BrowserItem> {
    tab: BrowserTab;
    agentScope: BrowserScope;
}

function isWorkspace(item: BrowserItem): item is AgentWorkspaceBrowserItem {
    return "kind" in item && item.kind === "workspace";
}

function isSetting(item: BrowserItem): item is AgentSetting {
    return !("kind" in item);
}

function isSession(item: BrowserItem): item is AgentSessionBrowserItem {
    return !isWorkspace(item) && !isSetting(item);
}

function sameSession(left: AgentSessionBrowserItem, right: AgentSessionBrowserItem): boolean {
    if (left.sessionFile !== undefined && right.sessionFile !== undefined) {
        return path.resolve(left.sessionFile) === path.resolve(right.sessionFile);
    }
    return left.id === right.id;
}

function tabText(tab: BrowserTab, theme: Theme, includeWorkspaces: boolean, includeSettings: boolean): string {
    const agents = tab === "agents"
        ? theme.fg("accent", theme.bold("● Agents"))
        : theme.fg("dim", "○ Agents");
    const tabs = [agents];
    if (includeWorkspaces) {
        tabs.push(tab === "workspaces"
            ? theme.fg("accent", theme.bold("● Workspaces"))
            : theme.fg("dim", "○ Workspaces"));
    }
    if (includeSettings) {
        tabs.push(tab === "settings"
            ? theme.fg("accent", theme.bold("● Settings"))
            : theme.fg("dim", "○ Settings"));
    }
    return tabs.join("    ");
}

function itemText(item: BrowserItem, theme: Theme): string {
    if (isWorkspace(item)) return agentWorkspaceItemText(item, theme);
    if (isSetting(item)) {
        let value: string;
        if (item.enabled === undefined) {
            value = item.model ?? "Parent model (uses the current pi model)";
        } else {
            value = item.enabled ? "On" : "Off";
        }
        if (item.enabled !== undefined) {
            const styledValue = theme.fg(item.enabled ? "accent" : "muted", value);
            return `${theme.fg("accent", item.label)} · ${styledValue}\n${theme.fg("muted", item.description)}`;
        }
        return theme.fg("accent", item.label)
            + `\n${theme.fg("muted", item.description)}\nValue: ${value}`;
    }
    if (item.kind === "empty") return theme.fg("muted", item.task);

    const mode = item.agent === "workspace-setup"
        ? "workspace setup"
        : item.mutating ? "worker" : item.agent;
    const status = item.status.replaceAll("_", " ");
    const continuation = item.readOnlyReason ? ` · ${item.readOnlyReason}` : "";
    const scope = item.kind === "current" ? "active" : "historical";
    const headline = `${item.title || "Untitled run"} · ${mode} · ${scope} · ${status}${continuation} · ${dateText(item.updatedAt)}`;
    const task = `Task: ${oneLine(item.task)}`;
    const returned = returnedText(item);
    const activity = item.activity ? ` · ${oneLine(item.activity, 120)}` : "";
    const preview = item.kind === "current" && returned
        ? `\n${theme.fg("muted", `Result: ${returned}`)}`
        : "";
    return theme.fg("accent", headline) + `\n${task}${activity}${preview}`;
}

function disposeChild(component: Component | null): void {
    (component as (Component & { dispose?: () => void }) | null)?.dispose?.();
}

/** Agents overlay host. It routes between composed list/detail children. */
export class AgentSessionBrowserComponent implements Component, RefreshTarget<AgentSessionBrowserData> {
    private readonly current: AgentSessionBrowserItem[];
    private readonly sessionPast: AgentSessionBrowserItem[];
    private readonly past: AgentSessionBrowserItem[];
    private readonly workspaces: AgentWorkspaceBrowserItem[];
    private readonly settings: AgentSetting[];
    private readonly models?: AgentModelOption[];
    private readonly tabs: BrowserTab[];
    private readonly onInvalidate?: () => void;
    private readonly fixedHeight?: () => number;
    private readonly refresh: RefreshCoordinator<AgentSessionBrowserData> | null;
    private readonly unsubscribeEvents?: () => void;
    private readonly list: ListViewComponent<BrowserItem, void, BrowserState>;
    private activeTab: BrowserTab = "agents";
    private agentScope: BrowserScope = "session";
    private sessionDetail: AgentSessionDetailComponent | null = null;
    private workspaceDetail: AgentWorkspaceDetailComponent | null = null;
    private modelSelector: SelectComponent<AgentModelOption> | null = null;
    private tabHeader: Text | null = null;
    private theme: Theme | null = null;
    private done: (() => void) | null = null;
    private disposed = false;

    constructor(options: AgentSessionBrowserOptions) {
        this.current = [...options.current];
        this.sessionPast = [...(options.sessionPast ?? options.past)];
        this.past = [...options.past];
        this.workspaces = [...(options.workspaces ?? [])];
        this.settings = [...(options.settings ?? [])];
        this.models = options.models?.slice();
        this.onInvalidate = options.onInvalidate;
        this.fixedHeight = options.fixedHeight;
        this.tabs = ["agents"];
        if (options.workspaces !== undefined) this.tabs.push("workspaces");
        if (options.settings !== undefined) this.tabs.push("settings");
        this.list = this.createList(options);
        this.refresh = options.onRefresh
            ? new RefreshCoordinator(options.onRefresh, this, (error) => console.error("Agent browser refresh failed:", error))
            : null;
        if (options.eventBus && options.cwd && options.onRefresh) {
            this.unsubscribeEvents = options.eventBus.on(AGENT_EVENT_CHANNEL, (data) => {
                if (!isAgentEvent(data)) return;
                const relevant = data.cwd === options.cwd
                    || (data.type === "run" && data.parentCwd === options.cwd);
                if (relevant) this.refresh?.schedule();
            });
        }
    }

    initialize(theme: Theme): void {
        this.theme = theme;
        this.list.initialize(theme);
    }

    setDoneCallback(done: () => void): void {
        this.done = done;
    }

    render(width: number): string[] {
        const child = this.activeChild();
        if (child) return child.render(width);
        const height = this.fixedHeight?.();
        if (height !== undefined) this.list.state.maxVisibleLines = Math.max(1, height - 11);
        return this.list.render(width).map((line) => truncateToWidth(line, width, ""));
    }

    handleInput(key: string): void {
        const child = this.activeChild();
        if (child) {
            child.handleInput(key);
            return;
        }
        this.list.handleInput(key);
    }

    invalidate(): void {
        this.list.invalidate();
        this.activeChild()?.invalidate();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.refresh?.dispose();
        this.unsubscribeEvents?.();
        disposeChild(this.sessionDetail);
        disposeChild(this.workspaceDetail);
        disposeChild(this.modelSelector);
        this.sessionDetail = null;
        this.workspaceDetail = null;
        this.modelSelector = null;
    }

    isDisposed(): boolean {
        return this.disposed;
    }

    apply(data: AgentSessionBrowserData): void {
        this.replace(this.current, data.current);
        this.replace(this.sessionPast, data.sessionPast ?? data.past);
        this.replace(this.past, data.past);
        this.replace(this.workspaces, data.workspaces ?? []);
        if (data.settings) this.replace(this.settings, data.settings);

        this.updateOpenDetails();
        this.rebuildItems();
        this.invalidate();
        this.onInvalidate?.();
    }

    private createList(options: AgentSessionBrowserOptions): ListViewComponent<BrowserItem, void, BrowserState> {
        const includeWorkspaces = options.workspaces !== undefined;
        const includeSettings = options.settings !== undefined;
        return new ListViewComponent<BrowserItem, void, BrowserState>(
            {
                title: includeWorkspaces ? "Agents" : "Delegated agent sessions",
                borderColor: "borderMuted",
                borderCharacters: BORDER_STYLES.rounded,
                fixedHeight: options.fixedHeight,
                trailingSpacer: false,
                itemSpacing: 1,
                helpText: `↑/↓ navigate · Tab/←/→ switch tab · Enter open${options.onResume || options.onCancel ? " · r resume · c cancel" : ""} · Esc close`,
                headerContent: (container, theme) => {
                    this.tabHeader = new Text(tabText(this.activeTab, theme, includeWorkspaces, includeSettings), 5, 0);
                    container.addChild(this.tabHeader);
                },
                renderItem: (item: ListItem<BrowserItem>, renderOptions: ListViewRenderItemOptions<BrowserItem, BrowserState>) => {
                    const content = itemText(item.value, renderOptions.theme);
                    return renderOptions.isCursor ? content : renderOptions.theme.fg("text", content);
                },
                itemPrefix: (index, isCursor, theme) => {
                    if (this.list.state.items[index]?.disabled) return { first: "  ", continuation: "  " };
                    return isCursor ? { first: theme.fg("accent", "→ "), continuation: "  " } : { first: "  ", continuation: "  " };
                },
                onKey: (key, state) => this.handleListKey(key, state, options),
                footerContent: (container, theme, state) => {
                    const count = state.tab === "agents"
                        ? this.agentItems().length
                        : state.tab === "workspaces" ? this.workspaces.length : this.settings.length;
                    let label = "session";
                    if (state.tab === "workspaces") label = "workspace";
                    if (state.tab === "settings") label = "setting";
                    let scopeHint = "";
                    if (state.tab === "agents") {
                        scopeHint = this.agentScope === "session"
                            ? " · this session · h: show historical"
                            : " · historical · h: show this session";
                    }
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(
                        theme.fg("dim", `${count} ${label}${count === 1 ? "" : "s"}${scopeHint}`),
                        1,
                        0,
                    ));
                },
            },
            {
                items: this.itemsForTab("agents"),
                cursor: 0,
                scrollOffset: 0,
                maxVisibleLines: 12,
                tab: "agents",
                agentScope: "session",
            },
        );
    }

    private handleListKey(key: string, state: BrowserState, options: AgentSessionBrowserOptions): boolean {
        const selected = state.items[state.cursor ?? 0]?.value;
        if (state.tab === "agents" && key === "h") {
            this.agentScope = this.agentScope === "session" ? "historical" : "session";
            state.agentScope = this.agentScope;
            this.rebuildItems();
            this.invalidate();
            return true;
        }
        if (key === "r" && selected && isSession(selected) && selected.kind === "current" && selected.status === "interrupted") {
            this.closeListAndQueue(options.onResume, selected);
            return true;
        }
        if (key === "c" && selected && isSession(selected) && selected.kind === "current" && this.isCancelable(selected.status)) {
            this.closeListAndQueue(options.onCancel, selected);
            return true;
        }
        if (matchesKey(key, "tab") || matchesKey(key, "left") || matchesKey(key, "right")) {
            this.switchTab(key, state);
            return true;
        }
        if (matchesKey(key, "enter")) {
            this.openSelected(selected, options);
            return true;
        }
        if (matchesKey(key, "escape") || key === "q") {
            this.done?.();
            return true;
        }
        return false;
    }

    private openSelected(selected: BrowserItem | undefined, options: AgentSessionBrowserOptions): void {
        if (!selected || !this.theme) return;
        if (isWorkspace(selected)) {
            this.openWorkspace(selected, options);
            return;
        }
        if (isSetting(selected)) {
            this.openSetting(selected, options);
            return;
        }
        if (selected.kind === "empty") return;
        const detail = new AgentSessionDetailComponent({ item: selected, fixedHeight: options.fixedHeight });
        this.sessionDetail = detail;
        detail.initialize(this.theme);
        detail.setDoneCallback(() => this.closeSessionDetail(detail));
    }

    private openWorkspace(workspace: AgentWorkspaceBrowserItem, options: AgentSessionBrowserOptions): void {
        let detail: AgentWorkspaceDetailComponent;
        detail = new AgentWorkspaceDetailComponent(workspace, options.fixedHeight, {
            onInspect: () => options.onWorkspaceInspect?.(detail.workspace) ?? "No saved worker result is available.",
            onAction: async (action) => {
                const replacement = await options.onWorkspaceAction?.(detail.workspace, action);
                this.updateWorkspace(workspace, replacement);
                return replacement;
            },
            onInvalidate: options.onInvalidate,
        });
        this.workspaceDetail = detail;
        detail.initialize(this.theme!);
        detail.setDoneCallback(() => this.closeWorkspaceDetail(detail));
    }

    private openSetting(setting: AgentSetting, options: AgentSessionBrowserOptions): void {
        if (setting.id === "notifyBusyWorkerChanges" || setting.id === "advisorEnabled") {
            this.toggleSetting(setting, options);
            return;
        }
        const modelItems = (this.models ?? [{ label: "Parent model", description: "Use the current pi model" }])
            .map((model) => ({ value: model, label: model.label }));
        if (modelItems.length === 0) return;
        const selector = new SelectComponent<AgentModelOption>({
            title: setting.label,
            items: modelItems,
            enableSearch: true,
            headerSpacing: false,
            headerContent: (container, theme) => {
                container.addChild(new Text(
                    theme.fg("muted", "  Choose the AI model that should handle this agent's tasks."),
                    1,
                    0,
                ));
            },
            initialCursor: Math.max(0, modelItems.findIndex((item) => item.value.id === setting.model)),
            maxVisible: 12,
            helpText: "Type to search · ↑/↓ navigate · Enter select · Esc back",
            renderItem: (item, renderOptions) => item.value.description
                ? `${item.value.label}\n${renderOptions.theme.fg("muted", item.value.description)}`
                : item.value.label,
        });
        this.modelSelector = selector;
        selector.setDoneCallback((model) => {
            this.modelSelector = null;
            if (!model) {
                this.invalidate();
                return;
            }
            const current = this.settings.find((candidate) => candidate.id === setting.id);
            if (!current || current.id === "notifyBusyWorkerChanges" || current.id === "advisorEnabled") {
                this.invalidate();
                return;
            }
            const previous = current.model;
            current.model = model.id;
            this.rebuildItems();
            this.invalidate();
            this.saveWithRollback(
                () => options.onModelChange?.(current.id as BuiltinAgentName, model.id),
                () => { current.model = previous; },
                options,
            );
        });
        selector.initialize(this.theme!);
    }

    private toggleSetting(setting: AgentSetting, options: AgentSessionBrowserOptions): void {
        const previous = setting.enabled !== false;
        const enabled = !previous;
        setting.enabled = enabled;
        this.rebuildItems();
        this.invalidate();
        const toggleId = setting.id as "advisorEnabled" | "notifyBusyWorkerChanges";
        this.saveWithRollback(
            () => options.onToggleChange?.(toggleId, enabled),
            () => { setting.enabled = previous; },
            options,
        );
    }

    private saveWithRollback(
        update: () => void | Promise<void>,
        restore: () => void,
        options: AgentSessionBrowserOptions,
    ): void {
        const rollback = (error: unknown) => {
            restore();
            this.rebuildItems();
            options.onModelChangeError?.(error);
            this.invalidate();
        };
        try {
            const result = update();
            if (result) void result.catch(rollback);
        } catch (error) {
            rollback(error);
        }
    }

    private closeListAndQueue(callback: AgentSessionBrowserOptions["onResume"] | AgentSessionBrowserOptions["onCancel"], item: AgentSessionBrowserItem): void {
        this.done?.();
        queueMicrotask(() => void callback?.(item));
    }

    private switchTab(key: string, state: BrowserState): void {
        const currentIndex = this.tabs.indexOf(state.tab);
        let nextIndex = (currentIndex + 1) % this.tabs.length;
        if (matchesKey(key, "left")) {
            nextIndex = Math.max(0, currentIndex - 1);
        } else if (matchesKey(key, "right")) {
            nextIndex = Math.min(this.tabs.length - 1, currentIndex + 1);
        }
        this.activeTab = this.tabs[nextIndex]!;
        state.tab = this.activeTab;
        state.items = this.itemsForTab(this.activeTab);
        state.cursor = 0;
        state.scrollOffset = 0;
        this.tabHeader?.setText(tabText(this.activeTab, this.theme!, this.tabs.includes("workspaces"), this.tabs.includes("settings")));
    }

    private updateWorkspace(workspace: AgentWorkspaceBrowserItem, replacement: AgentWorkspaceBrowserItem | null | undefined): void {
        const index = this.workspaces.findIndex((item) => item.id === workspace.id);
        if (index < 0) return;
        if (replacement === null) this.workspaces.splice(index, 1);
        else if (replacement) this.workspaces[index] = replacement;
        if (this.activeTab === "workspaces") this.rebuildItems();
        this.invalidate();
    }

    private updateOpenDetails(): void {
        if (this.workspaceDetail) {
            const replacement = this.workspaces.find((item) => item.id === this.workspaceDetail?.workspace.id);
            if (replacement) this.workspaceDetail.updateWorkspace(replacement);
            else this.workspaceDetail.close();
        }
        if (this.sessionDetail) {
            const selected = this.sessionDetail.sessionItem;
            const replacement = this.agentItems().find((item) => sameSession(item, selected));
            if (replacement) this.sessionDetail.updateItem(replacement);
        }
    }

    private closeSessionDetail(detail: AgentSessionDetailComponent): void {
        if (this.sessionDetail !== detail) return;
        this.sessionDetail = null;
        detail.dispose();
        this.invalidate();
    }

    private closeWorkspaceDetail(detail: AgentWorkspaceDetailComponent): void {
        if (this.workspaceDetail !== detail) return;
        this.workspaceDetail = null;
        detail.dispose();
        this.invalidate();
    }

    private activeChild(): (AgentSessionDetailComponent | AgentWorkspaceDetailComponent | SelectComponent<AgentModelOption>) | null {
        return this.sessionDetail ?? this.workspaceDetail ?? this.modelSelector;
    }

    private agentItems(): AgentSessionBrowserItem[] {
        const source = this.agentScope === "session" ? this.sessionPast : this.past;
        const seen = new Set<string>();
        return [...this.current, ...source].filter((item) => {
            const key = item.sessionFile ? path.resolve(item.sessionFile) : item.id;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    private itemsForTab(tab: BrowserTab): ListItem<BrowserItem>[] {
        if (tab === "agents") return asSessionListItems(this.agentItems()).map((item) => item as ListItem<BrowserItem>);
        if (tab === "workspaces") return asWorkspaceListItems(this.workspaces).map((item) => item as ListItem<BrowserItem>);
        return asSettingsListItems(this.settings).map((item) => item as ListItem<BrowserItem>);
    }

    private rebuildItems(): void {
        const selectedId = this.list.state.items[this.list.state.cursor ?? 0]?.value.id;
        this.list.state.items = this.itemsForTab(this.activeTab);
        const selectedIndex = selectedId === undefined
            ? -1
            : this.list.state.items.findIndex((item) => item.value.id === selectedId);
        this.list.state.cursor = selectedIndex >= 0
            ? selectedIndex
            : Math.min(this.list.state.cursor ?? 0, Math.max(0, this.list.state.items.length - 1));
        this.list.state.scrollOffset = 0;
    }

    private replace<T>(target: T[], values: T[]): void {
        target.splice(0, target.length, ...values);
    }

    private isCancelable(status: string): boolean {
        return status === "starting"
            || status === "running"
            || status === "waiting_for_permission"
            || status === "interrupted"
            || status === "waiting_for_parent";
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
        component.setDoneCallback(() => {
            component.dispose();
            done();
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
