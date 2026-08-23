import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    matchesKey,
    truncateToWidth,
    Text,
} from "@earendil-works/pi-tui";
import type { ListItem, ListViewRenderItemOptions, ListViewState } from "./list-view";
import { ListViewComponent } from "./list-view";
import type { AgentSessionBrowserItem } from "../tools/agent/sessions";

interface AgentSessionBrowserState extends ListViewState<AgentSessionBrowserItem> {
    tab: "current" | "past";
    detail: boolean;
}

export interface AgentSessionBrowserOptions {
    current: AgentSessionBrowserItem[];
    past: AgentSessionBrowserItem[];
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
    task: "No persisted child transcripts were found for this cwd.",
    updatedAt: 0,
};

function asListItems(items: AgentSessionBrowserItem[], empty: AgentSessionBrowserItem): ListItem<AgentSessionBrowserItem>[] {
    return (items.length ? items : [empty]).map((value) => ({
        value,
        label: value.kind === "empty" ? value.task : `${value.title} · ${value.agent}`,
        disabled: value.kind === "empty",
    }));
}

function dateText(timestamp: number | undefined): string {
    return timestamp === undefined ? "unknown time" : new Date(timestamp).toLocaleString();
}

function shortPath(file: string | undefined): string {
    if (!file) return "no durable transcript";
    const parts = file.split(/[\\/]/);
    return parts.slice(-2).join("/");
}

function itemText(
    item: AgentSessionBrowserItem,
    theme: Theme,
    detail: boolean,
): string {
    if (item.kind === "empty") return theme.fg("muted", item.task);

    const mode = item.mutating ? "worker" : item.agent;
    const status = item.status.replaceAll("_", " ");
    const headline = `${item.title} · ${mode} · ${status} · ${dateText(item.updatedAt)}`;
    const task = `Task: ${item.task.replace(/\s+/g, " ").trim()}`;
    if (!detail) {
        const activity = item.activity ? ` · ${item.activity}` : "";
        return theme.fg("accent", headline) + `\n${task}${activity}`;
    }

    const lines = [
        theme.fg("accent", headline),
        `Run ID: ${item.id}`,
        task,
        `Started: ${dateText(item.startedAt)}`,
        `Updated: ${dateText(item.updatedAt)}`,
        `Transcript: ${shortPath(item.sessionFile)}`,
    ];
    if (item.parentSessionId) lines.push(`Parent session: ${item.parentSessionId}`);
    if (item.messageCount !== undefined) lines.push(`Messages: ${item.messageCount}`);
    if (item.usage) {
        lines.push(`Usage: ${item.usage.input} input, ${item.usage.output} output, $${item.usage.cost.total.toFixed(4)}`);
    }
    if (item.changedFiles?.length) lines.push(`Changed files: ${item.changedFiles.join(", ")}`);
    if (item.firstMessage && item.firstMessage !== item.task) {
        lines.push(`First message: ${item.firstMessage.replace(/\s+/g, " ").trim()}`);
    }
    if (item.responsePreview) lines.push(`Latest response: ${item.responsePreview}`);
    if (item.allMessagesText) {
        lines.push("", theme.fg("muted", `Transcript preview:\n${item.allMessagesText}`));
    }
    lines.push("", theme.fg("muted", "This browser is read-only; it does not switch or replay child sessions."));
    return lines.join("\n");
}

export class AgentSessionBrowserComponent extends ListViewComponent<
    AgentSessionBrowserItem,
    void,
    AgentSessionBrowserState
> {
    private readonly current: AgentSessionBrowserItem[];
    private readonly past: AgentSessionBrowserItem[];

    constructor(options: AgentSessionBrowserOptions) {
        const current = options.current;
        const past = options.past;
        super(
            {
                title: "Delegated agent sessions",
                helpText: "↑/↓ navigate · Tab/←/→ switch tab · Enter details · Esc close",
                headerContent: (container, theme) => {
                    container.addChild(new Text(
                        theme.fg("muted", "Current shows this parent session; Past shows durable child transcripts for this cwd."),
                        1,
                        0,
                    ));
                },
                renderItem: (item: ListItem<AgentSessionBrowserItem>, options: ListViewRenderItemOptions<AgentSessionBrowserItem, AgentSessionBrowserState>) => {
                    const content = itemText(item.value, options.theme, options.isCursor && options.state.detail);
                    return options.isCursor ? content : options.theme.fg("text", content);
                },
                onKey: (key, state) => {
                    if (matchesKey(key, "tab") || matchesKey(key, "left") || matchesKey(key, "right")) {
                        state.tab = state.tab === "current" ? "past" : "current";
                        state.items = asListItems(
                            state.tab === "current" ? current : past,
                            state.tab === "current" ? EMPTY_CURRENT : EMPTY_PAST,
                        );
                        state.cursor = 0;
                        state.scrollOffset = 0;
                        state.detail = false;
                        return true;
                    }
                    if (matchesKey(key, "enter")) {
                        const selected = state.items[state.cursor ?? 0]?.value;
                        if (selected?.kind !== "empty") state.detail = !state.detail;
                        return true;
                    }
                    if (matchesKey(key, "escape") && state.detail) {
                        state.detail = false;
                        return true;
                    }
                    return false;
                },
                footerContent: (container, theme, state) => {
                    const isCurrent = state.tab === "current";
                    const tabText = `${isCurrent ? "[Current]" : " Current "}    ${isCurrent ? " Past " : "[Past]"}`;
                    const count = isCurrent ? current.length : past.length;
                    container.addChild(new Text(theme.fg("accent", tabText), 1, 0));
                    container.addChild(new Text(
                        theme.fg("dim", `${count} session${count === 1 ? "" : "s"}`),
                        1,
                        0,
                    ));
                },
            },
            {
                items: asListItems(current, EMPTY_CURRENT),
                cursor: 0,
                scrollOffset: 0,
                maxVisibleLines: 12,
                tab: "current",
                detail: false,
            },
        );
        this.current = current;
        this.past = past;
    }

    override render(width: number): string[] {
        return super.render(width).map((line) => truncateToWidth(line, width, ""));
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

    await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
        const component = new AgentSessionBrowserComponent(options);
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
