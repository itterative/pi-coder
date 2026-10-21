/**
 * Dialog surfaces for `/stats`: a cancellable progress loader and the scrollable report view.
 *
 * The report extends the shared pager so scrolling, framing, and the help footer stay identical to
 * pi-coder's other read-only views; only range cycling is command-specific.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, matchesKey } from "@earendil-works/pi-tui";

import { PagerComponent, type PagerState } from "../../tui/pager";
import { aggregateStats } from "./aggregate";
import { nextPresetRange, presetRange } from "./range";
import { buildReportLines } from "./render";
import { scanSessions } from "./scan";
import type { PiStats, ScanOptions, ScanProgress, ScanResult, StatsRange } from "./types";

const VIEW_MAX_VISIBLE_LINES = 24;

const HELP_TEXT = "↑/↓ scroll · r cycle range · Esc close";

/** Run the scan behind a cancellable loader. Resolves null when the user cancels. */
export async function scanWithLoader(
    ctx: ExtensionCommandContext,
    options: ScanOptions,
): Promise<ScanResult | null> {
    return await ctx.ui.custom<ScanResult | null>((tui, theme, _keybindings, done) => {
        const loader = new CancellableLoader(
            tui,
            (text) => theme.fg("accent", text),
            (text) => theme.fg("dim", text),
            "Scanning session files…",
        );

        let settled = false;
        const finish = (result: ScanResult | null): void => {
            if (settled) {
                return;
            }
            settled = true;
            done(result);
        };

        loader.onAbort = () => finish(null);

        scanSessions({
            ...options,
            signal: loader.signal,
            onProgress: (progress) => loader.setMessage(progressMessage(progress)),
        })
            .then(finish)
            .catch((error: unknown) => {
                if (!loader.aborted) {
                    ctx.ui.notify(`pi-coder stats: ${errorMessage(error)}`, "error");
                }
                finish(null);
            });

        return loader;
    });
}

function progressMessage(progress: ScanProgress): string {
    return `Scanning session files… ${progress.scanned}/${progress.total}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The scrollable report; `r` cycles the preset ranges without re-reading any files. */
export class StatsReportView extends PagerComponent<string> {
    private range: StatsRange;
    private readonly scan: ScanResult;
    private readonly today: Date;
    private readonly reportTheme: Theme;
    private readonly allStats: PiStats;
    private totalLines = 0;

    constructor(scan: ScanResult, initialRange: StatsRange, today: Date, theme: Theme) {
        super({
            title: `pi usage · ${initialRange.label}`,
            items: [],
            scrollOffset: 0,
            maxVisibleLines: VIEW_MAX_VISIBLE_LINES,
            helpText: HELP_TEXT,
            onKey: (key, state) => this.handleKey(key, state),
            onCacheBuilt: (totalLines) => {
                this.totalLines = totalLines;
            },
        });

        this.scan = scan;
        this.range = initialRange;
        this.today = today;
        this.reportTheme = theme;
        this.allStats = aggregateStats(scan, presetRange("all", today), today);
        this.rebuild();
    }

    private rebuild(): void {
        const stats = aggregateStats(this.scan, this.range, this.today);
        const lines = buildReportLines(stats, this.allStats, this.reportTheme, this.today);
        this.state.items = lines.map((line) => ({ value: line, label: line }));
        this.state.scrollOffset = 0;
        this.updateTitle(`pi usage · ${this.range.label}`);
        this.updateHelpText(HELP_TEXT);
    }

    private handleKey(key: string, state: PagerState<string>): boolean | { done: boolean } {
        if (key === "r" || key === "R") {
            this.range = nextPresetRange(this.range, this.today);
            this.rebuild();
            this.invalidate();
            return true;
        }

        if (matchesKey(key, "up") || key === "k") {
            return this.scroll(state, -1);
        }
        if (matchesKey(key, "down") || key === "j") {
            return this.scroll(state, 1);
        }
        if (matchesKey(key, "pageUp")) {
            return this.scroll(state, -state.maxVisibleLines);
        }
        if (matchesKey(key, "pageDown")) {
            return this.scroll(state, state.maxVisibleLines);
        }

        return false;
    }

    private scroll(state: PagerState<string>, delta: number): boolean {
        const maxOffset = Math.max(0, this.totalLines - state.maxVisibleLines);
        state.scrollOffset = Math.max(0, Math.min(maxOffset, state.scrollOffset + delta));
        return true;
    }
}

/** Open the report dialog and resolve when it closes. */
export async function showStatsReport(
    ctx: ExtensionCommandContext,
    scan: ScanResult,
    range: StatsRange,
    today: Date,
): Promise<void> {
    await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
        const view = new StatsReportView(scan, range, today, theme);
        view.setDoneCallback(() => done());
        view.initialize(theme);
        return view;
    });
}
