import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type {
    AgentWorkspaceAction,
    AgentWorkspaceBrowserItem,
    WorkspaceDispositionAction,
} from "../../tools/agent/presentation/browser-models";
import { BORDER_STYLES } from "../border-box";
import {
    ListViewComponent,
    type ListItem,
    type ListViewRenderItemOptions,
    type ListViewState,
} from "../list-view";
import { PagerComponent } from "../pager";
import { withOverlayStack } from "../overlay-stack";
import {
    agentWorkspaceItemText,
    asWorkspaceListItems,
    workspaceDetailHelpText,
    workspaceDetailText,
    type WorkspaceListItem,
} from "./formatting";
import type { AgentWorkspaceActionCallbacks, AgentWorkspaceBrowserOptions } from "./types";

export type { AgentWorkspaceAction } from "../../tools/agent/presentation/browser-models";

type WorkspaceBrowserState = ListViewState<WorkspaceListItem>;

function itemText(workspace: WorkspaceListItem, theme: Theme): string {
    return workspace.kind === "workspace"
        ? agentWorkspaceItemText(workspace, theme)
        : theme.fg("muted", workspace.task);
}

function disposeChild(component: Component | null): void {
    (component as (Component & { dispose?: () => void }) | null)?.dispose?.();
}

/** Workspace metadata and actions, composed around the reusable pager. */
export class AgentWorkspaceDetailComponent implements Component {
    private readonly pager: PagerComponent<AgentWorkspaceBrowserItem>;
    private currentWorkspace: AgentWorkspaceBrowserItem;
    private showingDiff = false;
    private diffText = "";
    private errorText = "";
    private confirmationOpen = false;
    private busy = false;
    private contentWidth = 80;
    private done: (() => void) | null = null;

    constructor(
        workspace: AgentWorkspaceBrowserItem,
        fixedHeight?: () => number,
        private readonly callbacks: AgentWorkspaceActionCallbacks = {},
    ) {
        this.currentWorkspace = workspace;
        this.pager = new PagerComponent({
            title: `Workspace · ${workspace.slug}`,
            items: [{ value: workspace, label: "" }],
            scrollOffset: 0,
            maxVisibleLines: 16,
            fixedHeight,
            compactFooter: true,
            helpText: workspaceDetailHelpText(workspace),
            onKey: (key) => this.handleKey(key),
            renderItem: (item, renderOptions) =>
                this.renderContent(item.value, renderOptions.theme),
        });
    }

    get workspace(): AgentWorkspaceBrowserItem {
        return this.currentWorkspace;
    }

    initialize(theme: Theme): void {
        this.pager.initialize(theme);
    }

    setDoneCallback(done: () => void): void {
        this.done = done;
        this.pager.setDoneCallback(done);
    }

    close(): void {
        this.done?.();
    }

    updateWorkspace(workspace: AgentWorkspaceBrowserItem): void {
        this.currentWorkspace = workspace;
        this.pager.state.items[0] = { value: workspace, label: "" };
        this.pager.updateTitle(`Workspace · ${workspace.slug}`);
        this.pager.updateHelpText(workspaceDetailHelpText(workspace));
        this.confirmationOpen = false;
        this.invalidate();
    }

    render(width: number): string[] {
        this.contentWidth = Math.max(1, width - 8);
        const height = this.pager.options.fixedHeight?.();
        if (height !== undefined) this.pager.state.maxVisibleLines = Math.max(1, height - 7);
        return this.pager.render(width);
    }

    handleInput(key: string): void {
        this.pager.handleInput(key);
    }

    invalidate(): void {
        this.pager.invalidate();
    }

    dispose(): void {
        disposeChild(this.pager);
    }

    private renderContent(workspace: AgentWorkspaceBrowserItem, theme: Theme): string {
        if (this.showingDiff) return this.diffText;
        return [
            ...(this.errorText ? [theme.fg("error", `Action failed: ${this.errorText}`), ""] : []),
            workspaceDetailText(workspace, theme, this.contentWidth),
            ...(this.busy ? ["", theme.fg("muted", "Working…")] : []),
        ].join("\n");
    }

    private handleKey(key: string): boolean {
        if (this.busy || this.confirmationOpen) {
            return true;
        }
        if (this.showingDiff) {
            if (matchesKey(key, "escape") || key === "q") {
                this.showingDiff = false;
                this.diffText = "";
                this.invalidate();
                return true;
            }
            return false;
        }
        const action = this.currentWorkspace.actions.find((item) => item.key === key)?.action;
        if (!action) return false;
        if (action === "inspect") {
            this.runAction(action);
            return true;
        }
        if (!this.callbacks.onConfirmAction) {
            return true;
        }
        this.confirmationOpen = true;
        void this.confirmAction(action);
        return true;
    }

    private async confirmAction(action: WorkspaceDispositionAction): Promise<void> {
        try {
            const confirmed = await this.callbacks.onConfirmAction?.(action);
            if (confirmed) {
                this.runAction(action);
            }
        } catch (error) {
            this.errorText = error instanceof Error ? error.message : String(error);
        } finally {
            this.confirmationOpen = false;
            this.invalidate();
            this.callbacks.onInvalidate?.();
        }
    }

    private runAction(action: AgentWorkspaceAction): void {
        this.busy = true;
        this.errorText = "";
        this.invalidate();
        void (async () => {
            try {
                if (action === "inspect") {
                    const diff = this.callbacks.onInspect?.();
                    this.diffText =
                        typeof diff === "string"
                            ? diff
                            : ((await diff) ?? "No saved worker result is available.");
                    this.showingDiff = true;
                } else {
                    const replacement = await this.callbacks.onAction?.(action);
                    if (replacement === null) {
                        this.close();
                        return;
                    }
                    if (replacement) this.updateWorkspace(replacement);
                }
            } catch (error) {
                this.errorText = error instanceof Error ? error.message : String(error);
            } finally {
                this.busy = false;
                this.invalidate();
                this.callbacks.onInvalidate?.();
            }
        })();
    }
}

/** Workspace list composed around the reusable list view. */
export class AgentWorkspaceBrowserComponent implements Component {
    private readonly list: ListViewComponent<WorkspaceListItem, void, WorkspaceBrowserState>;
    private detail: AgentWorkspaceDetailComponent | null = null;
    private theme: Theme | null = null;
    private done: (() => void) | null = null;

    constructor(private readonly options: AgentWorkspaceBrowserOptions) {
        this.list = new ListViewComponent<WorkspaceListItem, void, WorkspaceBrowserState>(
            {
                title: "Agent workspaces",
                borderColor: "borderMuted",
                borderCharacters: BORDER_STYLES.rounded,
                fixedHeight: options.fixedHeight,
                trailingSpacer: false,
                itemSpacing: 1,
                helpText: "↑/↓ navigate · Enter inspect · Esc close",
                headerContent: (container, theme) => {
                    const available = options.workspaces.filter(
                        (workspace) => workspace.status === "available",
                    ).length;
                    const reviewRequired = options.workspaces.filter(
                        (workspace) => workspace.status === "review_required",
                    ).length;
                    const leased = options.workspaces.filter(
                        (workspace) => workspace.leased,
                    ).length;
                    container.addChild(new Text(theme.fg("muted", `Cwd: ${options.cwd}`), 5, 0));
                    container.addChild(
                        new Text(
                            theme.fg(
                                "muted",
                                `${available} available · ${reviewRequired} review required · ${leased} leased`,
                            ),
                            5,
                            0,
                        ),
                    );
                },
                renderItem: (
                    item: ListItem<WorkspaceListItem>,
                    renderOptions: ListViewRenderItemOptions<
                        WorkspaceListItem,
                        WorkspaceBrowserState
                    >,
                ) => {
                    const content = itemText(item.value, renderOptions.theme);
                    return renderOptions.isCursor
                        ? content
                        : renderOptions.theme.fg("text", content);
                },
                itemPrefix: (index, isCursor, theme) => {
                    if (this.list.state.items[index]?.disabled)
                        return { first: "  ", continuation: "  " };
                    return isCursor
                        ? { first: theme.fg("accent", "→ "), continuation: "  " }
                        : { first: "  ", continuation: "  " };
                },
                onKey: (key) => {
                    if (matchesKey(key, "escape") || key === "q") {
                        this.done?.();
                        return true;
                    }
                    if (!matchesKey(key, "enter")) return false;
                    this.openDetail();
                    return true;
                },
                footerContent: (container, theme) => {
                    container.addChild(new Spacer(1));
                    container.addChild(
                        new Text(
                            theme.fg(
                                "dim",
                                "Review-required workspaces are not selected automatically.",
                            ),
                            1,
                            0,
                        ),
                    );
                },
            },
            {
                items: asWorkspaceListItems(options.workspaces),
                cursor: 0,
                scrollOffset: 0,
                maxVisibleLines: 12,
            },
        );
    }

    initialize(theme: Theme): void {
        this.theme = theme;
        this.list.initialize(theme);
    }

    setDoneCallback(done: () => void): void {
        this.done = done;
    }

    render(width: number): string[] {
        if (this.detail)
            return this.detail.render(width).map((line) => truncateToWidth(line, width, ""));
        const height = this.options.fixedHeight?.();
        if (height !== undefined) this.list.state.maxVisibleLines = Math.max(1, height - 12);
        return this.list.render(width).map((line) => truncateToWidth(line, width, ""));
    }

    handleInput(key: string): void {
        if (this.detail) {
            this.detail.handleInput(key);
            return;
        }
        this.list.handleInput(key);
    }

    invalidate(): void {
        this.list.invalidate();
        this.detail?.invalidate();
    }

    dispose(): void {
        disposeChild(this.detail);
        this.detail = null;
        disposeChild(this.list);
    }

    private openDetail(): void {
        const selected = this.list.state.items[this.list.state.cursor ?? 0]?.value;
        if (!selected || selected.kind !== "workspace" || !this.theme) return;
        const detail = new AgentWorkspaceDetailComponent(selected, this.options.fixedHeight);
        this.detail = detail;
        detail.initialize(this.theme);
        detail.setDoneCallback(() => {
            if (this.detail !== detail) return;
            this.detail = null;
            detail.dispose();
            this.invalidate();
        });
    }
}

export async function showAgentWorkspaceBrowser(
    options: AgentWorkspaceBrowserOptions,
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    await withOverlayStack((overlay) =>
        ctx.ui.custom<void>(
            (tui, theme, _keybindings, done) => {
                overlay.bind(tui);
                const fixedHeight = () =>
                    Math.max(
                        2,
                        Math.min(
                            Math.floor(tui.terminal.rows * 0.82),
                            Math.max(2, tui.terminal.rows - 2),
                        ),
                    );
                const component = new AgentWorkspaceBrowserComponent({ ...options, fixedHeight });
                component.setDoneCallback(done);
                component.initialize(theme);
                return component;
            },
            {
                overlay: true,
                overlayOptions: {
                    width: "84%",
                    minWidth: 64,
                    maxHeight: "82%",
                    anchor: "center",
                    margin: 1,
                },
                onHandle: overlay.setHandle,
            },
        ),
    );
}
