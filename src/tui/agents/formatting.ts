import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ListItem } from "../list-view";
import { wrapPreservingSpaces } from "../../common/text";
import type {
    AgentSessionBrowserItem,
    AgentWorkspaceBrowserItem,
} from "../../tools/agent/presentation/browser-models";
import type { AgentSetting } from "./types";

export const EMPTY_AGENTS: AgentSessionBrowserItem = {
    kind: "empty",
    id: "empty-agents",
    title: "",
    agent: "",
    status: "",
    task: "No delegated agents were found.",
    updatedAt: 0,
};

export interface EmptyWorkspaceItem {
    kind: "empty";
    id: string;
    task: string;
}

export type WorkspaceListItem = AgentWorkspaceBrowserItem | EmptyWorkspaceItem;

export const EMPTY_WORKSPACES: EmptyWorkspaceItem = {
    kind: "empty",
    id: "empty-workspaces",
    task: "No isolated workspaces have been created for this cwd.",
};

export function oneLine(text: string, maxChars = 240): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

export function compactNumber(value: number): string {
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

export function dateText(timestamp: number | undefined): string {
    return timestamp === undefined ? "unknown time" : new Date(timestamp).toLocaleString();
}

export function usageText(usage: NonNullable<AgentSessionBrowserItem["usage"]>): string {
    return `${compactNumber(usage.input)} input, ${compactNumber(usage.output)} output, $${usage.cost.total.toFixed(4)}`;
}

export function returnedText(item: AgentSessionBrowserItem): string | undefined {
    if (item.responsePreview) return oneLine(item.responsePreview);
    if (item.allMessagesText) return oneLine(item.allMessagesText.slice(-1_000));
    return undefined;
}

export function asSessionListItems(
    items: AgentSessionBrowserItem[],
): ListItem<AgentSessionBrowserItem>[] {
    return (items.length ? items : [EMPTY_AGENTS]).map((value) => ({
        value,
        label: value.kind === "empty" ? value.task : `${value.title} · ${value.agent}`,
        disabled: value.kind === "empty",
    }));
}

export function asWorkspaceListItems(
    workspaces: AgentWorkspaceBrowserItem[],
): ListItem<WorkspaceListItem>[] {
    return (workspaces.length ? workspaces : [EMPTY_WORKSPACES]).map((value) => ({
        value,
        label: value.kind === "workspace" ? value.slug : value.task,
        disabled: value.kind !== "workspace",
    }));
}

export function asSettingsListItems(
    settings: AgentSetting[],
): ListItem<AgentSetting>[] {
    return settings.map((setting) => ({
        value: setting,
        label: setting.enabled === undefined
            ? `${setting.label}: ${setting.model ?? "Parent model"}`
            : `${setting.label} · ${setting.enabled ? "On" : "Off"}`,
    }));
}

export function agentWorkspaceItemText(workspace: AgentWorkspaceBrowserItem, theme: Theme): string {
    const statusColor = workspace.status === "review_required" ? "warning" : "success";
    const leaseColor = workspace.leased ? "warning" : "muted";
    const gitColor = workspace.git?.kind === "available" && workspace.git.dirty ? "warning" : "muted";
    return theme.fg("accent", workspace.slug)
        + ` · ${theme.fg(statusColor, workspace.statusText)}`
        + `\nSetup: ${workspace.setupText} · Lease: ${theme.fg(leaseColor, workspace.leaseText)}`
        + ` · Git: ${theme.fg(gitColor, workspace.git?.text ?? "unknown")}`
        + `\nPath: ${workspace.worktreePath}`;
}

export function workspaceDetailText(
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
    const actions = workspace.actions.map(({ key, label }) => `${key} ${label}`);
    if (actions.length > 0) {
        lines.push("", theme.fg("accent", "Actions:"), theme.fg("muted", actions.join(" · ")), "");
    }
    lines.push(theme.fg("muted", workspace.notice));
    return lines.join("\n");
}

export function workspaceDetailHelpText(workspace: AgentWorkspaceBrowserItem): string {
    const actions = workspace.actions.map(({ key, label }) => `${key} ${label}`);
    return ["↑/↓ scroll", ...actions, "Esc back"].join(" · ");
}

export function oneLinePreview(text: string, maxChars = 180): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxChars
        ? normalized
        : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function firstLinePreview(text: string, maxChars = 180): string {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    return oneLinePreview(firstLine, maxChars);
}
