import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    matchesKey,
    Spacer,
    Text,
    truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
    AgentWorkspaceAction,
    AgentWorkspaceBrowserItem,
    WorkspaceDispositionAction,
} from "../tools/agent/presentation/browser-models";

export type { AgentWorkspaceAction } from "../tools/agent/presentation/browser-models";
import { PagerComponent } from "./pager";
import type { ListItem, ListViewRenderItemOptions, ListViewState } from "./list-view";
import { ListViewComponent } from "./list-view";
import { BORDER_STYLES } from "./border-box";
import { wrapPreservingSpaces } from "../common/text";

interface EmptyWorkspaceItem {
    kind: "empty";
    message: string;
}

type WorkspaceBrowserItem = AgentWorkspaceBrowserItem | EmptyWorkspaceItem;
interface AgentWorkspaceBrowserState extends ListViewState<WorkspaceBrowserItem> {}

export interface AgentWorkspaceBrowserOptions {
    cwd: string;
    workspaces: AgentWorkspaceBrowserItem[];
    fixedHeight?: () => number;
}

function isWorkspace(item: WorkspaceBrowserItem): item is AgentWorkspaceBrowserItem {
    return item.kind === "workspace";
}

function asListItems(workspaces: AgentWorkspaceBrowserItem[]): ListItem<WorkspaceBrowserItem>[] {
    if (workspaces.length === 0) {
        return [{
            value: {
                kind: "empty",
                message: "No isolated workspaces have been created for this cwd.",
            },
            label: "No isolated workspaces have been created for this cwd.",
            disabled: true,
        }];
    }
    return workspaces.map((workspace) => ({
        value: workspace,
        label: workspace.slug,
    }));
}

function dateText(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

export function agentWorkspaceItemText(
    workspace: AgentWorkspaceBrowserItem,
    theme: Theme,
): string {
    const statusColor = workspace.status === "review_required" ? "warning" : "success";
    const leaseColor = workspace.leased ? "warning" : "muted";
    const gitColor = workspace.git?.kind === "available" && workspace.git.dirty ? "warning" : "muted";
    return theme.fg("accent", workspace.slug)
        + ` · ${theme.fg(statusColor, workspace.statusText)}`
        + `\nSetup: ${workspace.setupText} · Lease: ${theme.fg(leaseColor, workspace.leaseText)}`
        + ` · Git: ${theme.fg(gitColor, workspace.git?.text ?? "unknown")}`
        + `\nPath: ${workspace.worktreePath}`;
}

function itemText(workspace: WorkspaceBrowserItem, theme: Theme): string {
    return isWorkspace(workspace)
        ? agentWorkspaceItemText(workspace, theme)
        : theme.fg("muted", workspace.message);
}

export function agentWorkspaceDetailText(
    workspace: AgentWorkspaceBrowserItem,
    theme: Theme,
    width: number,
): string {
    const lines = [
        `Workspace: ${workspace.slug}`,
        `Git: ${workspace.git?.text ?? "unknown"}`,
        ...(workspace.git?.kind === "available" ? [
            `Git files: ${workspace.git.changedFiles ?? 0} changed, ${workspace.git.stagedFiles ?? 0} staged, ${workspace.git.unstagedFiles ?? 0} unstaged, ${workspace.git.untrackedFiles ?? 0} untracked`,
            `HEAD: ${workspace.git.headRevision ?? "unknown"}`,
        ] : []),
        `Status: ${workspace.statusText}`,
        `Setup: ${workspace.setupText}`,
        `Lease: ${workspace.leaseText}`,
        `Created: ${dateText(workspace.createdAt)}`,
        `Updated: ${dateText(workspace.updatedAt)}`,
        "",
        `ID: ${workspace.id}`,
        `Cwd: ${workspace.cwd}`,
        `Repository: ${workspace.repositoryRoot}`,
        `Worktree: ${workspace.worktreePath}`,
        `Base revision: ${workspace.baseRevision}`,
    ];
    if (workspace.leaseOwnerSessionId) lines.push(`Lease owner: ${workspace.leaseOwnerSessionId}`);
    if (workspace.leaseAcquiredAt !== undefined) lines.push(`Lease acquired: ${dateText(workspace.leaseAcquiredAt)}`);
    if (workspace.setupSummary) {
        lines.push("", theme.fg("accent", "Setup summary:"));
        lines.push(...workspace.setupSummary.split("\n").flatMap((line) => wrapPreservingSpaces(line, width)));
    }
    const actions = workspaceActionHelp(workspace);
    if (actions.length > 0) {
        lines.push(
            "",
            theme.fg("accent", "Actions:"),
            theme.fg("muted", actions.join(" · ")),
            "",
        );
    }
    lines.push(theme.fg("muted", workspace.notice));
    return lines.join("\n");
}

function workspaceActionHelp(workspace: AgentWorkspaceBrowserItem): string[] {
    return workspace.actions.map(({ key, label }) => `${key} ${label}`);
}

function workspaceDetailHelpText(workspace: AgentWorkspaceBrowserItem): string {
    return ["↑/↓ scroll", ...workspaceActionHelp(workspace), "Esc back"].join(" · ");
}

type WorkspaceActionCallbacks = {
    onInspect?: () => string | Promise<string>;
    onAction?: (action: WorkspaceDispositionAction) => AgentWorkspaceBrowserItem | null | undefined | Promise<AgentWorkspaceBrowserItem | null | undefined>;
    onInvalidate?: () => void;
};

export class AgentWorkspaceDetailComponent extends PagerComponent<AgentWorkspaceBrowserItem> {
    private contentWidth = 80;
    private currentWorkspace: AgentWorkspaceBrowserItem;
    private readonly callbacks: WorkspaceActionCallbacks;
    private showingDiff = false;
    private diffText = "";
    private errorText = "";
    private pendingAction: WorkspaceDispositionAction | null = null;
    private busy = false;

    constructor(
        workspace: AgentWorkspaceBrowserItem,
        fixedHeight?: () => number,
        callbacks: WorkspaceActionCallbacks = {},
    ) {
        super({
            title: `Workspace · ${workspace.slug}`,
            items: [{ value: workspace, label: "" }],
            scrollOffset: 0,
            maxVisibleLines: 16,
            fixedHeight,
            compactFooter: true,
            onKey: (key) => this.handleDetailKey(key),
            helpText: workspaceDetailHelpText(workspace),
            renderItem: (item, renderOptions) => this.showingDiff
                ? this.diffText
                : [
                    ...(this.errorText ? [renderOptions.theme.fg("error", `Action failed: ${this.errorText}`), ""] : []),
                    agentWorkspaceDetailText(
                        item.value,
                        renderOptions.theme,
                        this.contentWidth,
                    ),
                    ...(this.busy ? ["", renderOptions.theme.fg("muted", "Working…")] : []),
                    ...(this.pendingAction ? ["", renderOptions.theme.fg("warning", `Confirm ${this.pendingAction}? y/Enter confirm · n/Esc cancel`)] : []),
                ].join("\n"),
        });
        this.currentWorkspace = workspace;
        this.callbacks = callbacks;
    }

    get workspace(): AgentWorkspaceBrowserItem {
        return this.currentWorkspace;
    }

    close(): void {
        this.finish(undefined);
    }

    updateWorkspace(workspace: AgentWorkspaceBrowserItem): void {
        this.currentWorkspace = workspace;
        this.state.items[0]!.value = workspace;
        this.listOptions.helpText = workspaceDetailHelpText(workspace);
        this.pendingAction = null;
        this.invalidate();
    }

    private handleDetailKey(key: string): boolean {
        if (this.busy) return true;
        if (this.showingDiff) {
            if (matchesKey(key, "escape") || key === "q") {
                this.showingDiff = false;
                this.diffText = "";
                this.invalidate();
                return true;
            }
            return false;
        }
        if (this.pendingAction) {
            if (key === "y" || matchesKey(key, "enter")) {
                const action = this.pendingAction;
                this.pendingAction = null;
                this.runAction(action);
                return true;
            }
            if (key === "n" || matchesKey(key, "escape")) {
                this.pendingAction = null;
                this.invalidate();
                return true;
            }
            return true;
        }
        const action = this.currentWorkspace.actions.find((item) => item.key === key)?.action;
        if (!action) return false;
        if (action === "inspect") {
            this.runAction(action);
        } else {
            this.pendingAction = action;
            this.invalidate();
        }
        return true;
    }

    private runAction(action: AgentWorkspaceAction): void {
        this.busy = true;
        this.errorText = "";
        this.invalidate();
        void (async () => {
            try {
                if (action === "inspect") {
                    const diff = this.callbacks.onInspect?.();
                    this.diffText = typeof diff === "string"
                        ? diff
                        : await diff ?? "No saved worker result is available.";
                    this.showingDiff = true;
                } else {
                    const replacement = await this.callbacks.onAction?.(action);
                    if (replacement === null) {
                        this.finish(undefined);
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

    override render(width: number): string[] {
        this.contentWidth = Math.max(1, width - 8);
        const height = this.options.fixedHeight?.();
        if (height !== undefined) this.state.maxVisibleLines = Math.max(1, height - 7);
        return super.render(width);
    }
}

export class AgentWorkspaceBrowserComponent extends ListViewComponent<
    WorkspaceBrowserItem,
    void,
    AgentWorkspaceBrowserState
> {
    private detail: AgentWorkspaceDetailComponent | null = null;

    constructor(options: AgentWorkspaceBrowserOptions) {
        const workspaces = options.workspaces;
        const available = workspaces.filter((workspace) => workspace.status === "available").length;
        const reviewRequired = workspaces.filter((workspace) => workspace.status === "review_required").length;
        const leased = workspaces.filter((workspace) => workspace.leased).length;

        super(
            {
                title: "Agent workspaces",
                borderColor: "borderMuted",
                borderCharacters: BORDER_STYLES.rounded,
                fixedHeight: options.fixedHeight,
                trailingSpacer: false,
                itemSpacing: 1,
                helpText: "↑/↓ navigate · Enter inspect · Esc close",
                headerContent: (container, theme) => {
                    container.addChild(new Text(theme.fg("muted", `Cwd: ${options.cwd}`), 5, 0));
                    container.addChild(new Text(
                        theme.fg("muted", `${available} available · ${reviewRequired} review required · ${leased} leased`),
                        5,
                        0,
                    ));
                },
                renderItem: (
                    item: ListItem<WorkspaceBrowserItem>,
                    renderOptions: ListViewRenderItemOptions<WorkspaceBrowserItem, AgentWorkspaceBrowserState>,
                ) => {
                    const content = itemText(item.value, renderOptions.theme);
                    return renderOptions.isCursor ? content : renderOptions.theme.fg("text", content);
                },
                onKey: (key, state) => {
                    if (!matchesKey(key, "enter")) return false;
                    const selected = state.items[state.cursor ?? 0]?.value;
                    if (!selected || !isWorkspace(selected) || !this.theme) return true;
                    this.detail = new AgentWorkspaceDetailComponent(
                        selected,
                        this.listOptions.fixedHeight,
                    );
                    this.detail.initialize(this.theme);
                    this.detail.setDoneCallback(() => {
                        this.detail = null;
                        this.invalidate();
                    });
                    return true;
                },
                footerContent: (container, theme) => {
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(
                        theme.fg("dim", "Review-required workspaces are not selected automatically."),
                        1,
                        0,
                    ));
                },
            },
            {
                items: asListItems(workspaces),
                cursor: 0,
                scrollOffset: 0,
                maxVisibleLines: 12,
            },
        );
    }

    override render(width: number): string[] {
        if (this.detail) return this.detail.render(width).map((line) => truncateToWidth(line, width, ""));
        const height = this.listOptions.fixedHeight?.();
        if (height !== undefined) this.state.maxVisibleLines = Math.max(1, height - 12);
        return super.render(width).map((line) => truncateToWidth(line, width, ""));
    }

    override handleInput(key: string): void {
        if (this.detail) {
            this.detail.handleInput(key);
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

export async function showAgentWorkspaceBrowser(
    options: AgentWorkspaceBrowserOptions,
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const fixedHeight = () => Math.max(
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
    }, {
        overlay: true,
        overlayOptions: {
            width: "84%",
            minWidth: 64,
            maxHeight: "82%",
            anchor: "center",
            margin: 1,
        },
    });
}
