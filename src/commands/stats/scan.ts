/**
 * Async scanner for pi's parent sessions and pi-coder's delegated-child sessions.
 *
 * The scan is deliberately tolerant: a malformed line, a vanished file, or an unknown entry type is
 * skipped rather than failing the command. Raw JSONL is read instead of `SessionManager`, because
 * usage on abandoned branches was still real spend and belongs in the totals.
 *
 * Repeats of `/stats` in one process reuse an in-memory parse cache (see `cache.ts`), but discovery
 * is always complete: the cache never excludes a file, it only skips re-reading an unchanged one.
 * Every disk read yields the event loop once so the loader keeps animating during long scans.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { FileStamp, TranscriptCache } from "./cache";
import { toLocalDateString } from "./range";
import type {
    DailyActivity,
    FileScan,
    ScanOptions,
    ScanResult,
    SessionRecord,
    StatsSource,
} from "./types";
import { addReportedUsage, addUsageTotals, emptyUsageTotals, ensureModelUsage } from "./usage";

/** Maximum directory depth below a sessions root; parents nest two levels, children three. */
const MAX_WALK_DEPTH = 4;

/** Yield between file reads; `0` still returns to the event loop, keeping the loader responsive. */
const YIELD_MS = 0;

interface SessionFile {
    path: string;
    source: StatsSource;
}

/** One transcript's parse plus where it came from, so the caller can skip a yield for cache hits. */
interface LoadedScan {
    scan: FileScan;
    fromCache: boolean;
}

/** Scan a root and aggregate every reachable JSONL transcript. */
export async function scanSessions(options: ScanOptions): Promise<ScanResult> {
    const discovered = [
        ...(await collectSessionFiles(options.parentRoot, "parent")),
        ...(await collectSessionFiles(options.childRoot, "child")),
    ];

    options.cache?.retain(new Set(discovered.map((file) => file.path)));

    const days = new Map<string, DailyActivity>();
    const sessions: SessionRecord[] = [];
    const total = discovered.length;
    let scanned = 0;
    options.onProgress?.({ scanned, total });

    for (const file of discovered) {
        options.signal?.throwIfAborted();
        const loaded = await mergeFile(file, days, sessions, options.cache);
        scanned++;
        options.onProgress?.({ scanned, total });
        // Only disk reads need the yield: a warm cache hit is stat-bound and would otherwise pay
        // one timer tick per file for no animation benefit.
        if (loaded && !loaded.fromCache) {
            await yieldToEventLoop(YIELD_MS, options.signal);
        }
    }

    return {
        dailyActivity: [...days.values()].sort((left, right) =>
            left.date.localeCompare(right.date),
        ),
        sessions: sessions.toSorted(
            (left, right) => left.startTimestampMs - right.startTimestampMs,
        ),
        totalFiles: total,
    };
}

/**
 * Yield with a referenced timer. The shared `sleep` helper unrefs its timer, which lets a scan run
 * exit early in non-interactive runs where no other handle keeps the event loop alive. Aborting is
 * picked up at the next file boundary.
 */
function yieldToEventLoop(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(signal.reason ?? new Error("Session scan aborted"));
    }

    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

async function collectSessionFiles(root: string, source: StatsSource): Promise<SessionFile[]> {
    const files: SessionFile[] = [];
    await walk(root, 0, source, files);
    return files;
}

async function walk(
    directory: string,
    depth: number,
    source: StatsSource,
    files: SessionFile[],
): Promise<void> {
    let entries: Dirent[];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (depth < MAX_WALK_DEPTH) {
                await walk(fullPath, depth + 1, source, files);
            }
            continue;
        }

        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            files.push({ path: fullPath, source });
        }
    }
}

/** Merge one transcript into the shared aggregates; null when its file vanished or is unreadable. */
async function mergeFile(
    file: SessionFile,
    days: Map<string, DailyActivity>,
    sessions: SessionRecord[],
    cache: TranscriptCache | undefined,
): Promise<LoadedScan | null> {
    const loaded = await loadFile(file, cache);
    if (!loaded) {
        return null;
    }

    for (const day of loaded.scan.days.values()) {
        mergeDay(days, day);
    }

    // The session record bumps its start day's session/hour counters. Merging the per-file days
    // first leaves `FileScan` untouched, so a cached parse stays reusable by the next scan.
    const record = sessionRecord(file, loaded.scan);
    if (record) {
        sessions.push(record);
        countSessionStart(days, record.startDate, new Date(record.startTimestampMs).getHours());
    }

    return loaded;
}

/**
 * Load one transcript, reusing the cached parse when the file's stamp is unchanged.
 *
 * The stamp is taken before the read and confirmed after it: an entry is only cached when the file
 * was untouched for the whole read, so a concurrent append (pi writing the active session) can
 * never be stored under a stale key. A file that changes mid-read is still parsed, just not cached.
 */
async function loadFile(
    file: SessionFile,
    cache: TranscriptCache | undefined,
): Promise<LoadedScan | null> {
    const before = await statFile(file.path);
    if (!before) {
        return null;
    }

    const cached = cache?.get(file.path, file.source, before);
    if (cached) {
        return { scan: cached, fromCache: true };
    }

    let content: string;
    try {
        content = await fs.readFile(file.path, "utf8");
    } catch {
        return null;
    }

    const scan = scanFile(content, file.source);
    const after = cache ? await statFile(file.path) : null;
    if (cache && after && matchesStamp(before, after)) {
        cache.set(file.path, file.source, before, scan);
    }

    return { scan, fromCache: false };
}

async function statFile(filePath: string): Promise<FileStamp | null> {
    try {
        return await fs.stat(filePath);
    } catch {
        return null;
    }
}

function matchesStamp(left: FileStamp, right: FileStamp): boolean {
    return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function scanFile(content: string, source: StatsSource): FileScan {
    const state: FileScan = {
        days: new Map(),
        model: null,
        sessionId: null,
        firstMessageMs: null,
        lastMessageMs: null,
        messages: 0,
        toolCalls: 0,
    };

    for (const line of content.split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }

        const entry = asRecord(parsed);
        if (entry) {
            scanEntry(entry, source, state);
        }
    }

    return state;
}

function scanEntry(entry: Record<string, unknown>, source: StatsSource, state: FileScan): void {
    const type = asString(entry.type);

    if (type === "session") {
        state.sessionId = asString(entry.id) ?? state.sessionId;
        return;
    }

    if (type === "model_change") {
        state.model = asString(entry.modelId) ?? state.model;
        return;
    }

    if (type === "message") {
        const message = asRecord(entry.message);
        if (message) {
            scanMessage(message, entry, source, state);
        }
        return;
    }

    if (type === "usage") {
        state.model = asString(entry.model) ?? state.model;
        addEntryUsage(entry, source, state);
        return;
    }

    if (type === "compaction" || type === "branch_summary") {
        addEntryUsage(entry, source, state);
    }
}

function scanMessage(
    message: Record<string, unknown>,
    entry: Record<string, unknown>,
    source: StatsSource,
    state: FileScan,
): void {
    const role = asString(message.role);
    if (role !== "user" && role !== "assistant" && role !== "toolResult") {
        return;
    }

    const timestampMs = entryTimeMs(entry);
    if (timestampMs === null) {
        return;
    }

    trackMessage(state, timestampMs);
    const day = ensureDay(state, timestampMs);

    if (role === "user") {
        day.messages++;
        state.messages++;
        return;
    }

    if (role === "assistant") {
        day.messages++;
        state.messages++;

        const model = asString(message.model);
        if (model) {
            state.model = model;
        }

        const usage = asRecord(message.usage);
        if (usage) {
            addReportedUsage(
                ensureModelUsage(day.usageByModel, model ?? state.model ?? "unknown"),
                usage,
            );
            addReportedUsage(day.usageBySource[source], usage);
        }
        countToolCalls(message, day, state);
        return;
    }

    const usage = asRecord(message.usage);
    if (usage) {
        addReportedUsage(ensureModelUsage(day.usageByModel, state.model ?? "unknown"), usage);
        addReportedUsage(day.usageBySource[source], usage);
    }
}

/** Attribute a `usage`, `compaction`, or `branch_summary` entry to the day it was written. */
function addEntryUsage(entry: Record<string, unknown>, source: StatsSource, state: FileScan): void {
    const usage = asRecord(entry.usage);
    if (!usage) {
        return;
    }

    const timestampMs = entryTimeMs(entry);
    if (timestampMs === null) {
        return;
    }

    const day = ensureDay(state, timestampMs);
    addReportedUsage(ensureModelUsage(day.usageByModel, state.model ?? "unknown"), usage);
    addReportedUsage(day.usageBySource[source], usage);
}

function countToolCalls(
    message: Record<string, unknown>,
    day: DailyActivity,
    state: FileScan,
): void {
    if (!Array.isArray(message.content)) {
        return;
    }

    for (const block of message.content) {
        const record = asRecord(block);
        if (record && record.type === "toolCall") {
            day.toolCalls++;
            state.toolCalls++;
        }
    }
}

function trackMessage(state: FileScan, timestampMs: number): void {
    if (state.firstMessageMs === null || timestampMs < state.firstMessageMs) {
        state.firstMessageMs = timestampMs;
    }
    if (state.lastMessageMs === null || timestampMs > state.lastMessageMs) {
        state.lastMessageMs = timestampMs;
    }
}

function ensureDay(state: FileScan, timestampMs: number): DailyActivity {
    const date = toLocalDateString(new Date(timestampMs));
    const existing = state.days.get(date);
    if (existing) {
        return existing;
    }

    const created = createDay(date);
    state.days.set(date, created);
    return created;
}

function createDay(date: string): DailyActivity {
    return {
        date,
        messages: 0,
        sessions: 0,
        toolCalls: 0,
        hours: Array.from({ length: 24 }, () => 0),
        usageByModel: {},
        usageBySource: { parent: emptyUsageTotals(), child: emptyUsageTotals() },
    };
}

function mergeDay(days: Map<string, DailyActivity>, day: DailyActivity): void {
    const target = days.get(day.date) ?? createDay(day.date);
    days.set(day.date, target);

    target.messages += day.messages;
    target.sessions += day.sessions;
    target.toolCalls += day.toolCalls;
    for (let hour = 0; hour < target.hours.length; hour++) {
        target.hours[hour]! += day.hours[hour]!;
    }
    for (const [model, usage] of Object.entries(day.usageByModel)) {
        addUsageTotals(ensureModelUsage(target.usageByModel, model), usage);
    }
    addUsageTotals(target.usageBySource.parent, day.usageBySource.parent);
    addUsageTotals(target.usageBySource.child, day.usageBySource.child);
}

function sessionRecord(file: SessionFile, scan: FileScan): SessionRecord | null {
    if (scan.firstMessageMs === null || scan.lastMessageMs === null || scan.messages === 0) {
        return null;
    }

    return {
        sessionId: scan.sessionId ?? path.basename(file.path, ".jsonl"),
        source: file.source,
        startTimestampMs: scan.firstMessageMs,
        startDate: toLocalDateString(new Date(scan.firstMessageMs)),
        durationMs: scan.lastMessageMs - scan.firstMessageMs,
        messages: scan.messages,
        toolCalls: scan.toolCalls,
    };
}

/** Bump the shared start day's session/hour counters after `mergeFile` merged the per-file days. */
function countSessionStart(
    days: Map<string, DailyActivity>,
    startDate: string,
    startHour: number,
): void {
    const day = days.get(startDate);
    if (!day) {
        return;
    }

    day.sessions++;
    day.hours[startHour]!++;
}

function entryTimeMs(entry: Record<string, unknown>): number | null {
    const timestamp = asString(entry.timestamp);
    if (!timestamp) {
        return null;
    }

    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}
