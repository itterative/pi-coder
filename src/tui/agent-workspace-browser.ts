import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    matchesKey,
    Spacer,
    Text,
    truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
    AgentWorkspace,
    AgentWorkspaceGitState,
} from "../tools/agent/workspaces";
import { PagerComponent } from "./pager";
import type { ListItem, ListViewRenderItemOptions, ListViewState } from "./list-view";
import { ListViewComponent } from "./list-view";
import { BORDER_STYLES } from "./border-box";
import { wrapPreservingSpaces } from "../common/text";

interface EmptyWorkspaceItem {
    kind: "empty";
    message: string;
}

type WorkspaceBrowserItem = AgentWorkspace | EmptyWorkspaceItem;

interface AgentWorkspaceBrowserState extends ListViewState<WorkspaceBrowserItem> {}

export interface AgentWorkspaceBrowserOptions {
    cwd: string;
    workspaces: AgentWorkspace[];
    gitStates?: ReadonlyMap<string, AgentWorkspaceGitState>;
    fixedHeight?: () => number;
}

function isWorkspace(item: WorkspaceBrowserItem): item is AgentWorkspace {
    return !("kind" in item);
}

function asListItems(workspaces: AgentWorkspace[]): ListItem<WorkspaceBrowserItem>[] {
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

function statusText(workspace: AgentWorkspace): string {
    return workspace.status.replaceAll("_", " ");
}

function leaseText(workspace: AgentWorkspace): string {
    if (!workspace.leaseRunId) return "none";
    const kind = workspace.leaseKind ?? "unknown";
    return `${kind} · ${workspace.leaseRunId}`;
}

function setupText(workspace: AgentWorkspace): string {
    return workspace.setupState.replaceAll("_", " ");
}

function gitStateText(gitState: AgentWorkspaceGitState | undefined): string {
    if (!gitState) return "unknown";
    if (gitState.kind === "unavailable") return `unavailable · ${gitState.error ?? "not a Git worktree"}`;
    if (!gitState.dirty) return "clean";
    const files = gitState.changedFiles ?? 0;
    return `dirty · ${files} changed file${files === 1 ? "" : "s"}`;
}

export function agentWorkspaceItemText(
    workspace: AgentWorkspace,
    theme: Theme,
    gitState?: AgentWorkspaceGitState,
): string {
    const statusColor = workspace.status === "review_required" ? "warning" : "success";
    const leaseColor = workspace.leaseRunId ? "warning" : "muted";
    const gitColor = gitState?.kind === "available" && gitState.dirty ? "warning" : "muted";
    return theme.fg("accent", workspace.slug)
        + ` · ${theme.fg(statusColor, statusText(workspace))}`
        + `\nSetup: ${setupText(workspace)} · Lease: ${theme.fg(leaseColor, leaseText(workspace))}`
        + ` · Git: ${theme.fg(gitColor, gitStateText(gitState))}`
        + `\nPath: ${workspace.worktreePath}`;
}

function itemText(workspace: WorkspaceBrowserItem, theme: Theme): string {
    return isWorkspace(workspace)
        ? agentWorkspaceItemText(workspace, theme)
        : theme.fg("muted", workspace.message);
}

export function agentWorkspaceDetailText(
    workspace: AgentWorkspace,
    theme: Theme,
    width: number,
    gitState?: AgentWorkspaceGitState,
): string {
    const lines = [
        `Workspace: ${workspace.slug}`,
        `Git: ${gitStateText(gitState)}`,
        ...(gitState?.kind === "available" ? [
            `Git files: ${gitState.changedFiles ?? 0} changed, ${gitState.stagedFiles ?? 0} staged, ${gitState.unstagedFiles ?? 0} unstaged, ${gitState.untrackedFiles ?? 0} untracked`,
            `HEAD: ${gitState.headRevision ?? "unknown"}`,
        ] : []),
        `Status: ${statusText(workspace)}`,
        `Setup: ${setupText(workspace)}`,
        `Lease: ${leaseText(workspace)}`,
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
    lines.push(
        "",
        theme.fg("muted", workspace.status === "review_required"
            ? "This workspace requires explicit review before it can be reused."
            : "This workspace may be selected for an isolated worker."),
    );
    return lines.join("\n");
}

export class AgentWorkspaceDetailComponent extends PagerComponent<AgentWorkspace> {
    private contentWidth = 80;

    constructor(
        workspace: AgentWorkspace,
        fixedHeight?: () => number,
        private readonly gitState?: AgentWorkspaceGitState,
    ) {
        super({
            title: `Workspace · ${workspace.slug}`,
            items: [{ value: workspace, label: "" }],
            scrollOffset: 0,
            maxVisibleLines: 16,
            helpText: "↑/↓ scroll · Esc back",
            fixedHeight,
            compactFooter: true,
            renderItem: (item, renderOptions) => agentWorkspaceDetailText(
                item.value,
                renderOptions.theme,
                this.contentWidth,
                this.gitState,
            ),
        });
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
        const gitStates = options.gitStates ?? new Map<string, AgentWorkspaceGitState>();
        const available = workspaces.filter((workspace) => workspace.status === "available").length;
        const reviewRequired = workspaces.filter((workspace) => workspace.status === "review_required").length;
        const leased = workspaces.filter((workspace) => workspace.leaseRunId).length;

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
                    const content = isWorkspace(item.value)
                        ? agentWorkspaceItemText(item.value, renderOptions.theme, gitStates.get(item.value.id))
                        : itemText(item.value, renderOptions.theme);
                    return renderOptions.isCursor ? content : renderOptions.theme.fg("text", content);
                },
                onKey: (key, state) => {
                    if (!matchesKey(key, "enter")) return false;
                    const selected = state.items[state.cursor ?? 0]?.value;
                    if (!selected || !isWorkspace(selected) || !this.theme) return true;
                    this.detail = new AgentWorkspaceDetailComponent(
                        selected,
                        this.listOptions.fixedHeight,
                        gitStates.get(selected.id),
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
