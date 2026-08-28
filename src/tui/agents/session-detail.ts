import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { AgentSessionBrowserItem } from "../../tools/agent/presentation/browser-models";
import type { AgentTranscriptPart, AgentTranscriptView } from "../../tools/agent/presentation/transcript";
import { markdownTheme } from "../markdown-theme";
import { PagerComponent } from "../pager";
import { dateText, oneLine, usageText } from "./formatting";

export interface AgentSessionDetailOptions {
    item: AgentSessionBrowserItem;
    fixedHeight?: () => number;
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

function renderTranscriptParts(
    parts: AgentTranscriptPart[],
    theme: Theme,
    width: number,
): string[] {
    const lines: string[] = [];
    let previousKind: AgentTranscriptPart["kind"] | undefined;

    for (const part of parts) {
        if (lines.length > 0 && !(previousKind === "plain" && part.kind === "plain")) {
            lines.push("");
        }
        if (part.kind === "plain") {
            lines.push(...part.text.split("\n"));
        } else {
            lines.push(...new Markdown(part.text, 0, 0, markdownTheme(theme)).render(width));
        }
        previousKind = part.kind;
    }

    return lines;
}

function detailText(
    item: AgentSessionBrowserItem,
    theme: Theme,
    width: number,
    transcriptView: AgentTranscriptView,
): string {
    if (item.kind === "empty") return item.task;

    const transcript = transcriptView === "collapsed"
        ? item.transcriptCollapsed ?? item.transcript ?? item.allMessagesText ?? item.responsePreview
        : item.transcript ?? item.allMessagesText ?? item.responsePreview;
    const transcriptParts = transcriptView === "collapsed"
        ? item.transcriptCollapsedParts ?? item.transcriptParts
        : item.transcriptParts;
    const lines = [
        `Run ID: ${item.id}`,
        `Task: ${oneLine(item.task)}`,
        `Started: ${dateText(item.startedAt)}`,
        `Updated: ${dateText(item.updatedAt)}`,
    ];
    if (item.messageCount !== undefined) lines.push(`Messages: ${item.messageCount}`);
    if (item.readOnlyReason) lines.push(`Continuation: ${item.readOnlyReason}`);
    if (item.usage) lines.push(`Usage: ${usageText(item.usage)}`);
    if (item.changedFiles?.length) {
        lines.push(`Changed files (${item.changedFiles.length}):`);
        lines.push(...item.changedFiles.map((file) => `  - ${file}`));
    }
    const loadingTranscript = item.transcript === undefined && item.sessionFile !== undefined;
    lines.push("", theme.fg("accent", "Transcript:"), "");

    if (transcriptParts !== undefined) {
        lines.push(...renderTranscriptParts(transcriptParts, theme, width));
        if (loadingTranscript) {
            lines.push("", theme.fg("muted", "Loading full transcript…"));
        }
    } else if (transcript) {
        lines.push(...new Markdown(transcript, 0, 0, markdownTheme(theme)).render(width));
        if (loadingTranscript) {
            lines.push("", theme.fg("muted", "Loading full transcript…"));
        }
    } else if (loadingTranscript) {
        lines.push(theme.fg("muted", "Loading transcript…"));
    } else {
        lines.push(theme.fg("muted", "Transcript unavailable for this session."));
    }

    return lines.join("\n");
}

function disposeChild(component: Component | null): void {
    (component as (Component & { dispose?: () => void }) | null)?.dispose?.();
}

/** Read-only detail view composed from the generic pager. */
export class AgentSessionDetailComponent implements Component {
    private readonly pager: PagerComponent<AgentSessionBrowserItem>;
    private item: AgentSessionBrowserItem;
    private contentWidth = 80;
    private followLiveExecution: boolean;
    private transcriptView: AgentTranscriptView = "collapsed";
    private totalLines = 0;

    constructor(options: AgentSessionDetailOptions) {
        this.item = options.item;
        this.followLiveExecution = isLiveExecution(options.item);
        this.pager = new PagerComponent({
            title: detailTitle(options.item),
            items: [{ value: options.item, label: "" }],
            scrollOffset: 0,
            maxVisibleLines: 16,
            helpText: "↑/↓ scroll · End follow · Tab toggle view · Esc back",
            fixedHeight: options.fixedHeight,
            compactFooter: true,
            onKey: (key, state) => this.handleKey(key, state.maxVisibleLines, state),
            onCacheBuilt: (totalLines) => this.updateScrollAfterRender(totalLines),
            renderItem: (item, renderOptions) => detailText(
                item.value,
                renderOptions.theme,
                this.contentWidth,
                this.transcriptView,
            ),
        });
    }

    get sessionItem(): AgentSessionBrowserItem {
        return this.item;
    }

    initialize(theme: Theme): void {
        this.pager.initialize(theme);
    }

    setDoneCallback(done: () => void): void {
        this.pager.setDoneCallback(done);
    }

    updateItem(item: AgentSessionBrowserItem): void {
        this.item = item;
        this.pager.state.items[0] = { value: item, label: "" };
        this.pager.updateTitle(detailTitle(item));
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

    private handleKey(
        key: string,
        page: number,
        state: { scrollOffset: number; maxVisibleLines: number },
    ): boolean {
        if (matchesKey(key, "tab")) {
            this.transcriptView = this.transcriptView === "collapsed" ? "detailed" : "collapsed";
            this.invalidate();
            return true;
        }

        let delta = 0;
        if (matchesKey(key, "pageUp")) delta = -page;
        else if (matchesKey(key, "pageDown")) delta = page;
        else if (matchesKey(key, "up")) delta = -1;
        else if (matchesKey(key, "down")) delta = 1;
        const maximumOffset = Math.max(0, this.totalLines - state.maxVisibleLines);
        if (matchesKey(key, "end")) {
            this.followLiveExecution = true;
            state.scrollOffset = maximumOffset;
            return true;
        }
        if (delta === 0) return false;
        if (delta < 0) this.followLiveExecution = false;
        state.scrollOffset = Math.max(0, Math.min(maximumOffset, state.scrollOffset + delta));
        if (state.scrollOffset === maximumOffset) this.followLiveExecution = true;
        return true;
    }

    private updateScrollAfterRender(totalLines: number): void {
        this.totalLines = totalLines;
        const maximumOffset = Math.max(0, totalLines - this.pager.state.maxVisibleLines);
        if (this.followLiveExecution) {
            this.pager.state.scrollOffset = maximumOffset;
            return;
        }
        this.pager.state.scrollOffset = Math.min(this.pager.state.scrollOffset, maximumOffset);
    }
}
