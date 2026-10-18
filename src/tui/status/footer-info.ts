import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
    ContextUsage,
    ExtensionContext,
    SessionEntry,
    Theme,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Cumulative token totals, cost, and the latest cache-hit share for the active session. */
export interface SessionUsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    /** Latest cache-read share of the prompt, when any cached tokens were reported. */
    cacheHitRate?: number;
}

/**
 * The session surface usage totals are read from. Narrower than `ReadonlySessionManager` so tests can
 * supply exactly the members the cache consults; the real manager is structurally assignable.
 */
export interface FooterSessionSource {
    getSessionId(): string;
    getLeafId(): string | null;
    getEntries(): SessionEntry[];
}

/** Inputs assembled from the live extension context and footer data provider on every render. */
export interface FooterInfoInput {
    cwd: string;
    home?: string;
    branch: string | null;
    model?: ExtensionContext["model"];
    contextUsage?: ContextUsage;
    totals?: SessionUsageTotals;
    extensionStatuses: ReadonlyMap<string, string>;
}

const SEGMENT_SEPARATOR = " · ";
const MIN_PADDING = 2;

/** Format token counts for compact footer display. Mirrors pi's built-in formatter. */
export function formatTokens(count: number): string {
    if (count < 1000) {
        return count.toString();
    }
    if (count < 10000) {
        return `${(count / 1000).toFixed(1)}k`;
    }
    if (count < 1000000) {
        return `${Math.round(count / 1000)}k`;
    }
    if (count < 10000000) {
        return `${(count / 1000000).toFixed(1)}M`;
    }
    return `${Math.round(count / 1000000)}M`;
}

/** Shorten a cwd under the home directory the way pi's built-in footer does. */
export function formatCwd(cwd: string, home: string | undefined): string {
    if (!home) {
        return cwd;
    }

    const resolvedCwd = resolve(cwd);
    const resolvedHome = resolve(home);
    const relativeToHome = relative(resolvedHome, resolvedCwd);
    const isInsideHome =
        relativeToHome === "" ||
        (relativeToHome !== ".." &&
            !relativeToHome.startsWith(`..${sep}`) &&
            !isAbsolute(relativeToHome));
    if (!isInsideHome) {
        return cwd;
    }

    return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Split the non-status footer content into named pieces. The caller assigns sides and drop
 * priorities when assembling the line.
 */
export interface FooterInfoSegments {
    cwd: string;
    statuses: string;
    usage: string;
    context: string;
    model: string;
}

export function footerInfoSegments(theme: Theme, input: FooterInfoInput): FooterInfoSegments {
    const cwd = formatCwd(input.cwd, input.home);
    const pwd = input.branch ? `${cwd} (${input.branch})` : cwd;

    return {
        cwd: theme.fg("dim", pwd),
        statuses: formatExtensionStatuses(input.extensionStatuses),
        usage: formatUsage(theme, input.totals),
        context: formatContextUsage(theme, input),
        model: theme.fg("dim", input.model?.id || "no-model"),
    };
}

/** One piece of the footer line. Segments keep their array order within each side. */
export interface FooterLineSegment {
    text: string;
    side: "left" | "right";
    /**
     * Higher values drop first when that side has to shed segments. Right segments only drop when
     * the right cluster alone cannot fit the line.
     */
    dropPriority: number;
    /**
     * When set, a cluster that cannot fit shortens this segment to the leftover width before dropping
     * it, so transient content yields characters instead of disappearing.
     */
    shrinkToFit?: boolean;
    /** Ellipsis for a layout trim, styled when the segment itself is styled. */
    ellipsis?: string;
}

/**
 * Lay out an optionally right-aligned footer line. The right cluster reserves its width first; the
 * left cluster fits into what remains by dropping whole segments (highest dropPriority first) down to
 * one, then truncating that one. Right segments shed only when the right cluster alone is wider than
 * the line, so the right side always outranks the left.
 */
export function layoutFooterLine(segments: readonly FooterLineSegment[], width: number): string {
    const right = fitCluster(nonEmpty(segments, "right"), width);
    const rightWidth = clusterWidth(right);
    const availableForLeft = width - rightWidth - (right.length > 0 ? MIN_PADDING : 0);
    const left =
        availableForLeft > 0 ? fitCluster(nonEmpty(segments, "left"), availableForLeft) : [];

    return compose(left, right, width);
}

function nonEmpty(
    segments: readonly FooterLineSegment[],
    side: FooterLineSegment["side"],
): FooterLineSegment[] {
    return segments.filter((segment) => segment.side === side && segment.text.length > 0);
}

/** Below this many columns a shortened segment is dropped instead of squeezed into a stub. */
const MIN_SHRINK_WIDTH = 16;

/** Drop whole segments until the cluster fits, then truncate a lone oversized segment. */
function fitCluster(segments: readonly FooterLineSegment[], width: number): FooterLineSegment[] {
    const parts = [...segments];
    while (parts.length > 1 && clusterWidth(parts) > width) {
        const index = highestDropPriority(parts);
        if (index === -1) break;

        const segment = parts[index];
        const shrunk = segment?.shrinkToFit ? shrinkToFit(parts, index, width) : undefined;
        if (shrunk) {
            parts.splice(index, 1, shrunk);
            break;
        }

        parts.splice(index, 1);
    }

    const [only] = parts;
    if (!only) return [];

    if (clusterWidth(parts) > width) {
        return [{ ...only, text: truncateToWidth(only.text, width, only.ellipsis ?? "…") }];
    }

    return parts;
}

/** A shrinkable segment truncated into what its siblings and their separators leave over. */
function shrinkToFit(
    parts: readonly FooterLineSegment[],
    index: number,
    width: number,
): FooterLineSegment | undefined {
    const segment = parts[index];
    if (!segment) return undefined;

    const others = parts.filter((_, position) => position !== index);
    const budget = width - clusterWidth(others) - others.length * visibleWidth(SEGMENT_SEPARATOR);
    if (budget < MIN_SHRINK_WIDTH) return undefined;

    return { ...segment, text: truncateToWidth(segment.text, budget, segment.ellipsis ?? "…") };
}

function highestDropPriority(segments: readonly FooterLineSegment[]): number {
    return segments.reduce(
        (best, segment, index) =>
            segment.dropPriority > (segments[best]?.dropPriority ?? Number.NEGATIVE_INFINITY)
                ? index
                : best,
        -1,
    );
}

function clusterWidth(segments: readonly FooterLineSegment[]): number {
    const separatorWidth = Math.max(0, segments.length - 1) * visibleWidth(SEGMENT_SEPARATOR);
    return segments.reduce((total, segment) => total + visibleWidth(segment.text), separatorWidth);
}

function compose(
    leftParts: readonly FooterLineSegment[],
    rightParts: readonly FooterLineSegment[],
    width: number,
): string {
    const left = leftParts.map((part) => part.text).join(SEGMENT_SEPARATOR);
    const right = rightParts.map((part) => part.text).join(SEGMENT_SEPARATOR);
    if (!left && !right) return "";

    if (!left) {
        const rightWidth = visibleWidth(right);
        if (rightWidth >= width) return truncateToWidth(right, width, "…");
        return " ".repeat(width - rightWidth) + right;
    }

    if (!right) {
        return visibleWidth(left) > width ? truncateToWidth(left, width, "…") : left;
    }

    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const gap = Math.max(MIN_PADDING, width - leftWidth - rightWidth);
    return left + " ".repeat(gap) + right;
}

function formatUsage(theme: Theme, totals: SessionUsageTotals | undefined): string {
    if (!totals) return "";

    const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
    const parts: string[] = [];
    if (total) parts.push(`${formatTokens(total)} tok`);
    if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
    if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.cacheHitRate !== undefined) {
        parts.push(`CH${totals.cacheHitRate.toFixed(1)}%`);
    }
    if (parts.length === 0) return "";

    return theme.fg("dim", parts.join(SEGMENT_SEPARATOR));
}

function formatContextUsage(theme: Theme, input: FooterInfoInput): string {
    const contextWindow = input.contextUsage?.contextWindow ?? input.model?.contextWindow ?? 0;
    const percent = input.contextUsage?.percent;
    const display =
        percent == null
            ? `?/${formatTokens(contextWindow)}`
            : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;

    if (percent == null) {
        return theme.fg("dim", display);
    }
    if (percent > 90) {
        return theme.fg("error", display);
    }
    if (percent > 70) {
        return theme.fg("warning", display);
    }

    return theme.fg("dim", display);
}

/**
 * Usage totals scan the whole session, and the footer renders on every frame. Entries are append-only and
 * every append moves the leaf, so the results only change with the session, leaf, or entry count.
 */
export class UsageTotalsCache {
    private key: string | undefined;
    private totals: SessionUsageTotals | undefined;

    get(session: FooterSessionSource): SessionUsageTotals {
        const key = `${session.getSessionId()}\u0000${session.getLeafId() ?? ""}\u0000${entryCount(session)}`;
        if (this.totals && this.key === key) {
            return this.totals;
        }

        this.totals = collectUsageTotals(session.getEntries());
        this.key = key;
        return this.totals;
    }
}

function collectUsageTotals(entries: readonly SessionEntry[]): SessionUsageTotals {
    const totals: SessionUsageTotals = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
    };

    for (const entry of entries) {
        if (entry.type === "usage") {
            addUsage(totals, entry.usage);
            continue;
        }

        if (entry.type === "message" && entry.message.role === "assistant") {
            addUsage(totals, entry.message.usage);

            const promptTokens =
                entry.message.usage.input +
                entry.message.usage.cacheRead +
                entry.message.usage.cacheWrite;
            totals.cacheHitRate =
                promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
            continue;
        }

        if (
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.usage
        ) {
            addUsage(totals, entry.message.usage);
            continue;
        }

        if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
            addUsage(totals, entry.usage);
        }
    }

    return totals;
}

function addUsage(totals: SessionUsageTotals, usage: Usage): void {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
}

/**
 * Read the session entry count without copying the session. The extension context exposes the write-capable
 * `SessionManager`, which has `getEntryCount()`; the declared `ReadonlySessionManager` view does not, so it
 * is feature-detected and falls back to the length of the copy.
 */
function entryCount(session: FooterSessionSource): number {
    const counter = (session as FooterSessionSource & { getEntryCount?: () => number })
        .getEntryCount;
    if (typeof counter === "function") {
        return counter.call(session);
    }

    return session.getEntries().length;
}

function formatExtensionStatuses(statuses: ReadonlyMap<string, string>): string {
    if (statuses.size === 0) {
        return "";
    }

    return [...statuses.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, text]) => sanitizeStatusText(text))
        .join(SEGMENT_SEPARATOR);
}

function sanitizeStatusText(text: string): string {
    // Replace newlines, tabs, and carriage returns with spaces, then collapse runs of spaces.
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}
