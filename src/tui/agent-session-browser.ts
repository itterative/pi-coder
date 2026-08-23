import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    matchesKey,
    truncateToWidth,
    Text,
} from "@earendil-works/pi-tui";
import type { ListItem, ListViewRenderItemOptions, ListViewState } from "./list-view";
import { ListViewComponent } from "./list-view";
import type { AgentSessionBrowserItem } from "../tools/agent/sessions";
import { BORDER_STYLES } from "./border-box";
import { AgentSessionDetailComponent } from "./agent-session-detail";

interface AgentSessionBrowserState extends ListViewState<AgentSessionBrowserItem> {
    tab: "current" | "past";
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
    task: "No persisted child sessions were found for this cwd.",
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

function tabText(tab: "current" | "past", theme: Theme): string {
    return tab === "current"
        ? `${theme.fg("accent", theme.bold("● Current"))}    ${theme.fg("dim", "○ Past")}`
        : `${theme.fg("dim", "○ Current")}    ${theme.fg("accent", theme.bold("● Past"))}`;
}

function itemText(
    item: AgentSessionBrowserItem,
    theme: Theme,
): string {
    if (item.kind === "empty") return theme.fg("muted", item.task);

    const mode = item.mutating ? "worker" : item.agent;
    const status = item.status.replaceAll("_", " ");
    const headline = `${item.title || "Untitled run"} · ${mode} · ${status} · ${dateText(item.updatedAt)}`;
    const task = `Task: ${oneLine(item.task)}`;
    const returned = returnedText(item);
    const activity = item.activity ? ` · ${oneLine(item.activity, 120)}` : "";
    const preview = returned ? `\n${theme.fg("muted", `Result: ${returned}`)}` : "";
    return theme.fg("accent", headline) + `\n${task}${activity}${preview}`;
}

export class AgentSessionBrowserComponent extends ListViewComponent<
    AgentSessionBrowserItem,
    void,
    AgentSessionBrowserState
> {
    private readonly current: AgentSessionBrowserItem[];
    private detail: AgentSessionDetailComponent | null = null;
    private readonly past: AgentSessionBrowserItem[];

    constructor(options: AgentSessionBrowserOptions) {
        const current = options.current;
        const past = options.past;
        let activeTab: AgentSessionBrowserState["tab"] = "current";
        let tabHeader: Text | undefined;
        let tabTheme: Theme | undefined;
        const refreshTabHeader = () => {
            if (tabHeader && tabTheme) tabHeader.setText(tabText(activeTab, tabTheme));
        };
        super(
            {
                title: "Delegated agent sessions",
                borderColor: "borderMuted",
                borderCharacters: BORDER_STYLES.rounded,
                helpText: "↑/↓ navigate · Tab/←/→ switch tab · Enter open · Esc close",
                headerContent: (container, theme) => {
                    tabTheme = theme;
                    tabHeader = new Text(tabText(activeTab, theme), 1, 0);
                    container.addChild(tabHeader);
                    container.addChild(new Text(
                        theme.fg("muted", "Current shows this parent session; Past shows durable child results for this cwd."),
                        1,
                        0,
                    ));
                },
                renderItem: (item: ListItem<AgentSessionBrowserItem>, options: ListViewRenderItemOptions<AgentSessionBrowserItem, AgentSessionBrowserState>) => {
                    const content = itemText(item.value, options.theme);
                    return options.isCursor ? content : options.theme.fg("text", content);
                },
                onKey: (key, state) => {
                    if (matchesKey(key, "tab") || matchesKey(key, "left") || matchesKey(key, "right")) {
                        const nextTab = matchesKey(key, "left")
                            ? "current"
                            : matchesKey(key, "right")
                                ? "past"
                                : state.tab === "current" ? "past" : "current";
                        activeTab = nextTab;
                        refreshTabHeader();
                        state.tab = nextTab;
                        state.items = asListItems(
                            state.tab === "current" ? current : past,
                            state.tab === "current" ? EMPTY_CURRENT : EMPTY_PAST,
                        );
                        state.cursor = 0;
                        state.scrollOffset = 0;
                        return true;
                    }
                    if (matchesKey(key, "enter")) {
                        const selected = state.items[state.cursor ?? 0]?.value;
                        if (selected?.kind !== "empty" && this.theme) {
                            this.detail = new AgentSessionDetailComponent({ item: selected });
                            this.detail.initialize(this.theme);
                            this.detail.setDoneCallback(() => {
                                this.detail = null;
                                this.invalidate();
                            });
                        }
                        return true;
                    }
                    return false;
                },
                footerContent: (container, theme, state) => {
                    const count = state.tab === "current" ? current.length : past.length;
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
            },
        );
        this.current = current;
        this.past = past;
    }

    override render(width: number): string[] {
        if (this.detail) return this.detail.render(width);
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
