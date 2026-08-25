import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { PagerComponent } from "./pager";
import type { AgentSessionBrowserItem } from "../tools/agent/presentation/browser-models";
import { compactNumber } from "./agent-session-format";
import { wrapPreservingSpaces } from "../common/text";
import type { AgentTranscriptView } from "../tools/agent/presentation/transcript";

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

function detailTitle(item: AgentSessionBrowserItem): string {
    const mode = item.agent === "workspace-setup"
        ? "workspace setup"
        : item.mutating ? "worker" : item.agent;
    return `[${mode}] ${item.title || "Untitled run"} · ${item.status.replaceAll("_", " ")}`;
}

function isLiveExecution(item: AgentSessionBrowserItem): boolean {
    return item.kind === "current" && (
        item.status === "starting"
        || item.status === "running"
        || item.status === "waiting_for_permission"
    );
}

function detailText(
    item: AgentSessionBrowserItem,
    theme: Theme,
    width: number,
    transcriptView: AgentTranscriptView,
): string {
    if (item.kind === "empty") {
        return item.task;
    }

    const transcript = transcriptView === "collapsed"
        ? item.transcriptCollapsed ?? item.transcript ?? item.allMessagesText ?? item.responsePreview
        : item.transcript ?? item.allMessagesText ?? item.responsePreview;
    const lines = [
        `Run ID: ${item.id}`,
        `Task: ${oneLine(item.task)}`,
        `Started: ${dateText(item.startedAt)}`,
        `Updated: ${dateText(item.updatedAt)}`,
    ];
    if (item.messageCount !== undefined) {
        lines.push(`Messages: ${item.messageCount}`);
    }
    if (item.usage) {
        lines.push(`Usage: ${usageText(item.usage)}`);
    }
    if (item.readFiles?.length) {
        lines.push(`Read files (${item.readFiles.length}):`);
        lines.push(...item.readFiles.map((file) => `  - ${file}`));
    }
    if (item.changedFiles?.length) {
        lines.push(`Changed files (${item.changedFiles.length}):`);
        lines.push(...item.changedFiles.map((file) => `  - ${file}`));
    }
    lines.push("", theme.fg("accent", `Transcript (${transcriptView}):`));

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
    private followLiveExecution: boolean;
    private item: AgentSessionBrowserItem;
    private transcriptView: AgentTranscriptView = "collapsed";
    private totalLines = 0;

    constructor(options: AgentSessionDetailOptions) {
        super({
            title: detailTitle(options.item),
            items: [{ value: options.item, label: "" }],
            scrollOffset: 0,
            maxVisibleLines: 16,
            helpText: "↑/↓ scroll · End follow · Tab toggle view · Esc back",
            fixedHeight: options.fixedHeight,
            compactFooter: true,
            onKey: (key, state) => {
                if (matchesKey(key, "tab")) {
                    this.transcriptView = this.transcriptView === "collapsed" ? "detailed" : "collapsed";
                    this.invalidate();
                    return true;
                }

                const page = state.maxVisibleLines;
                const delta = matchesKey(key, "pageUp") ? -page
                    : matchesKey(key, "pageDown") ? page
                        : matchesKey(key, "up") ? -1
                            : matchesKey(key, "down") ? 1
                                : 0;
                const maximumOffset = Math.max(0, this.totalLines - state.maxVisibleLines);
                if (matchesKey(key, "end")) {
                    this.followLiveExecution = true;
                    state.scrollOffset = maximumOffset;
                    return true;
                }
                if (delta === 0) {
                    return false;
                }
                if (delta < 0) {
                    this.followLiveExecution = false;
                }
                state.scrollOffset = Math.max(0, Math.min(maximumOffset, state.scrollOffset + delta));
                if (state.scrollOffset === maximumOffset) {
                    this.followLiveExecution = true;
                }
                return true;
            },
            renderItem: (item, renderOptions) => detailText(
                item.value,
                renderOptions.theme,
                this.contentWidth,
                this.transcriptView,
            ),
        });
        this.item = options.item;
        this.followLiveExecution = isLiveExecution(options.item);
    }

    get sessionItem(): AgentSessionBrowserItem {
        return this.item;
    }

    updateItem(item: AgentSessionBrowserItem): void {
        this.item = item;
        this.state.items[0] = { value: item, label: "" };
        this.setTitle(detailTitle(item));
        this.invalidate();
    }

    protected override onCacheBuilt(totalLines: number): void {
        this.totalLines = totalLines;
        const maximumOffset = Math.max(0, totalLines - this.state.maxVisibleLines);
        if (this.followLiveExecution) {
            this.state.scrollOffset = maximumOffset;
            return;
        }
        this.state.scrollOffset = Math.min(this.state.scrollOffset, maximumOffset);
    }

    override render(width: number): string[] {
        this.contentWidth = Math.max(1, width - 8);
        const height = this.options.fixedHeight?.();
        if (height !== undefined) {
            this.state.maxVisibleLines = Math.max(1, height - 7);
        }
        return super.render(width);
    }
}
