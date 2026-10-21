/**
 * `/stats` command: usage, activity, and cost statistics across pi's parent sessions and
 * pi-coder's delegated-child sessions.
 *
 * The scan is the slow part, so it runs behind a cancellable loader with event-loop yields, and the
 * report view can switch ranges without re-reading anything.
 */

import path from "node:path";

import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { PI_CODER_AGENT_SESSIONS_DIR } from "../../common/constants";
import { aggregateStats } from "./aggregate";
import { TranscriptCache } from "./cache";
import { parseRangeArgs, presetRange } from "./range";
import { buildReportLines, identityReportTheme } from "./render";
import { scanSessions } from "./scan";
import { scanWithLoader, showStatsReport } from "./view";

interface RangeCompletion {
    value: string;
    description: string;
}

const RANGE_COMPLETIONS: RangeCompletion[] = [
    { value: "7d", description: "Last 7 days" },
    { value: "30d", description: "Last 30 days" },
    { value: "90d", description: "Last 90 days" },
    { value: "all", description: "All history" },
];

/**
 * Parent session root: the current transcript's session root, so `--session-dir` and custom agent
 * directories keep resolving to the same place pi writes sessions. Falls back to pi's default when
 * the session is ephemeral.
 */
function parentSessionsRoot(ctx: ExtensionCommandContext): string {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
        return path.join(getAgentDir(), "sessions");
    }

    return path.dirname(path.dirname(sessionFile));
}

async function handleStats(
    args: string,
    ctx: ExtensionCommandContext,
    cache: TranscriptCache,
): Promise<void> {
    const today = new Date();
    const parsed = parseRangeArgs(args, today);
    if (!parsed.ok) {
        ctx.ui.notify(`pi-coder stats: ${parsed.message}`, "warning");
        return;
    }

    const options = {
        parentRoot: parentSessionsRoot(ctx),
        childRoot: PI_CODER_AGENT_SESSIONS_DIR,
        cache,
    };
    const scan = ctx.hasUI ? await scanWithLoader(ctx, options) : await scanSessions(options);
    if (!scan) {
        return;
    }

    if (scan.sessions.length === 0) {
        ctx.ui.notify("pi-coder stats: no sessions found yet. Start using pi!", "warning");
        return;
    }

    if (!ctx.hasUI) {
        const stats = aggregateStats(scan, parsed.range, today);
        const allStats = aggregateStats(scan, presetRange("all", today), today);
        ctx.ui.notify(
            buildReportLines(stats, allStats, identityReportTheme, today).join("\n"),
            "info",
        );
        return;
    }

    await showStatsReport(ctx, scan, parsed.range, today);
}

export default function registerStatsCommand(pi: ExtensionAPI): void {
    // One cache per extension instance: each repeat `/stats` re-reads only transcripts that
    // changed since the previous scan, and a restarted pi starts clean.
    const cache = new TranscriptCache();

    pi.registerCommand("stats", {
        description: "Show pi usage statistics (range: 7d, 30d, all, or YYYY-MM-DD dates)",
        getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
            return RANGE_COMPLETIONS.filter((item) => item.value.startsWith(prefix)).map(
                (item) => ({
                    value: item.value,
                    label: item.value,
                    description: item.description,
                }),
            );
        },
        handler: (args, ctx) => handleStats(args, ctx, cache),
    });
}
