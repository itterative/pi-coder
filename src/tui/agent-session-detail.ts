import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { PagerComponent } from "./pager";
import type { AgentSessionBrowserItem } from "../tools/agent/sessions";
import { compactNumber } from "./agent-session-format";
import { wrapPreservingSpaces } from "../common/text";

export interface AgentSessionDetailOptions {
    item: AgentSessionBrowserItem;
    fixedHeight?: () => number;
}

function dateText(timestamp: number | undefined): string {
    return timestamp === undefined ? "unknown time" : new Date(timestamp).toLocaleString();
}

function oneLine(text: string, maxChars = 240): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function usageText(usage: NonNullable<AgentSessionBrowserItem["usage"]>): string {
    return `${compactNumber(usage.input)} input, ${compactNumber(usage.output)} output, $${usage.cost.total.toFixed(4)}`;
}

function detailText(item: AgentSessionBrowserItem, theme: Theme, width: number): string {
    if (item.kind === "empty") return item.task;

    const transcript = item.transcript ?? item.allMessagesText ?? item.responsePreview;
    const lines = [
        `Run ID: ${item.id}`,
        `Task: ${oneLine(item.task)}`,
        `Started: ${dateText(item.startedAt)}`,
        `Updated: ${dateText(item.updatedAt)}`,
    ];
    if (item.messageCount !== undefined) lines.push(`Messages: ${item.messageCount}`);
    if (item.usage) lines.push(`Usage: ${usageText(item.usage)}`);
    if (item.changedFiles?.length) lines.push(`Changed files: ${item.changedFiles.join(", ")}`);
    lines.push("", theme.fg("accent", "Transcript:"));

    if (transcript) {
        for (const paragraph of transcript.split("\n")) {
            lines.push(...wrapPreservingSpaces(paragraph, width));
        }
    } else {
        lines.push(theme.fg("muted", "Transcript unavailable for this session."));
    }

    return lines.join("\n");
}

/** Read-only detail view for one delegated-agent session. */
export class AgentSessionDetailComponent extends PagerComponent<AgentSessionBrowserItem> {
    private contentWidth = 80;
    private totalLines = 0;

    constructor(options: AgentSessionDetailOptions) {
        const mode = options.item.mutating ? "worker" : options.item.agent;
        const status = options.item.status.replaceAll("_", " ");
        super({
            title: `[${mode}] ${options.item.title || "Untitled run"} · ${status}`,
            items: [{ value: options.item, label: "" }],
            scrollOffset: 0,
            maxVisibleLines: 16,
            helpText: "↑/↓ scroll · Esc back",
            fixedHeight: options.fixedHeight,
            compactFooter: true,
            onKey: (key, state) => {
                const page = state.maxVisibleLines;
                const delta = matchesKey(key, "pageUp") ? -page
                    : matchesKey(key, "pageDown") ? page
                        : matchesKey(key, "up") ? -1
                            : matchesKey(key, "down") ? 1
                                : 0;
                if (delta === 0) return false;
                state.scrollOffset = Math.max(
                    0,
                    Math.min(this.totalLines - state.maxVisibleLines, state.scrollOffset + delta),
                );
                return true;
            },
            renderItem: (item, renderOptions) => {
                const text = detailText(item.value, renderOptions.theme, this.contentWidth);
                this.totalLines = text.split("\n").length;
                return text;
            },
        });
    }

    override render(width: number): string[] {
        this.contentWidth = Math.max(1, width - 8);
        const height = this.options.fixedHeight?.();
        if (height !== undefined) this.state.maxVisibleLines = Math.max(1, height - 7);
        return super.render(width);
    }
}
