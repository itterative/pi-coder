/**
 * Usage helpers shared by the scanner, aggregator, and renderer.
 *
 * Reported usage arrives in several shapes (assistant messages, tool results, `usage` entries,
 * compaction summaries), so the additive helpers accept the raw unknown values JSON parsing produced.
 */

import type { ModelUsage, UsageTotals } from "./types";

export function emptyUsageTotals(): UsageTotals {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
    target.input += source.input;
    target.output += source.output;
    target.cacheRead += source.cacheRead;
    target.cacheWrite += source.cacheWrite;
    target.cost += source.cost;
}

export function ensureModelUsage(usage: ModelUsage, model: string): UsageTotals {
    const existing = usage[model];
    if (existing) {
        return existing;
    }

    const created = emptyUsageTotals();
    usage[model] = created;
    return created;
}

/** Add one raw reported usage block, tolerating missing fields and both cost shapes. */
export function addReportedUsage(target: UsageTotals, reported: Record<string, unknown>): void {
    target.input += numberOrZero(reported.input);
    target.output += numberOrZero(reported.output);
    target.cacheRead += numberOrZero(reported.cacheRead);
    target.cacheWrite += numberOrZero(reported.cacheWrite);
    target.cost += costTotal(reported.cost);
}

export function freshTokens(usage: UsageTotals | undefined): number {
    if (!usage) {
        return 0;
    }

    return usage.input + usage.output;
}

export function cachedTokens(usage: UsageTotals | undefined): number {
    if (!usage) {
        return 0;
    }

    return usage.cacheRead + usage.cacheWrite;
}

function numberOrZero(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function costTotal(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "object" && value !== null) {
        return numberOrZero((value as Record<string, unknown>).total);
    }

    return 0;
}
