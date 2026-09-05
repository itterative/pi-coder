import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Pi-coder compaction settings.
 *
 * Mirrors `src/tools/agent/config.ts`: project file wins over the global file, both optional, and both
 * locations env-overridable so a suite or a shell can point at a temporary file. Absence of a field is
 * never an error: compaction runs unattended in a delegated child, where a bad config read must degrade
 * to defaults rather than block a run.
 */
export interface CompactionConfig {
    /** When false, pi-coder does not intercept compaction and pi's default path runs untouched. */
    enabled: boolean;
    /** Include assistant thinking in the serialized fallback. It is the heaviest block and rarely carries decisions the visible text does not. */
    keepThinking: boolean;
    /** Ceiling for the serialized fallback request, in estimated tokens. Oldest messages are dropped first. */
    serializedMaxTokens: number;
    /** Characters kept per assistant text block in the serialized fallback. */
    serializedAssistantChars: number;
    /** Characters kept per user message in the serialized fallback. Kept generous: user text is the ground truth for goals and constraints. */
    serializedUserChars: number;
    /** Characters kept per successful tool result. */
    serializedToolResultChars: number;
    /** Characters kept per failed tool result, which is what feeds the summary's Blocked section. */
    serializedErrorResultChars: number;
    /** Characters kept per hidden or system custom message. Zero omits them entirely. */
    serializedNoteChars: number;
    /**
     * Resends a summarization request this many extra times, and only for a cause a wait can clear
     * (`transient`): 5xx, transport, a stream that ended early. Quota, rejected credentials, and rate limits are
     * never resent, and overflow moves straight to the next rung.
     *
     * Defaults lower than core's agent-retry settings (3 retries from 2000ms, so 2s/4s/8s) on purpose: this
     * stall happens inside a turn the user is waiting on, and a compaction that cannot recover hands over
     * anyway. Two retries from 1000ms costs at most 3s per stage.
     */
    retryMaxRetries: number;
    /** First backoff, doubling per attempt. */
    retryBaseDelayMs: number;
    /** Reserved for the planned side-model strategy; unused by the current cascade. */
    model?: string;
    /** Write the per-stage compaction trace under `.state/`. `isAgentTraceEnabled()` gates it as well. */
    traceEnabled: boolean;
    /** Trace file location; a relative path resolves against the working directory. */
    tracePath?: string;
    /** Rotate the trace into a single `.1` generation once it grows past this many bytes. */
    traceMaxBytes: number;
    /**
     * Rotated copies of the trace kept, the live file excluded, so `10` retains `file` plus `file.1` ... `file.10`.
     * Kept because the cap is what makes history short rather than large: on a filesystem that already compresses
     * these lines, an extra nine generations costs a few hundred KB.
     */
    traceGenerations: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
    enabled: true,
    keepThinking: false,
    serializedMaxTokens: 12_000,
    serializedAssistantChars: 1_200,
    serializedUserChars: 2_000,
    serializedToolResultChars: 400,
    serializedErrorResultChars: 1_000,
    serializedNoteChars: 200,
    retryMaxRetries: 2,
    retryBaseDelayMs: 1_000,
    traceEnabled: true,
    traceMaxBytes: 1_048_576,
    traceGenerations: 10,
};

export interface CompactionConfigLocations {
    global: string;
    project?: string;
}

function globalConfigPath(): string {
    return (
        process.env.COMPACTION_CONFIG_PATH_GLOBAL ??
        path.join(os.homedir(), ".pi", "compaction-config.json")
    );
}

function projectConfigPath(cwd: string): string | undefined {
    const override = process.env.COMPACTION_CONFIG_PATH;
    if (override) {
        return override;
    }
    let current = path.resolve(cwd);
    for (let index = 0; index < 20; index += 1) {
        const candidate = path.join(current, ".pi", "compaction-config.json");
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return undefined;
}

export function compactionConfigLocations(cwd: string): CompactionConfigLocations {
    return { global: globalConfigPath(), project: projectConfigPath(cwd) };
}

function booleanField(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function positiveNumberField(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return Math.floor(value);
}

/** A `0` in the config means "omit", which `positiveNumberField` would drop, so it gets its own reader. */
function nonNegativeNumberField(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return undefined;
    }
    return Math.floor(value);
}

/** A trimmed string from the file, or undefined for absent, blank, and non-string values. */
function stringField(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function readConfigFile(filePath: string | undefined): Partial<CompactionConfig> {
    if (!filePath || !fs.existsSync(filePath)) {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== "object") {
        return {};
    }
    const record = parsed as Record<string, unknown>;
    const model = stringField(record.model);
    const tracePath = stringField(record.tracePath);
    return {
        enabled: booleanField(record.enabled),
        keepThinking: booleanField(record.keepThinking),
        serializedMaxTokens: positiveNumberField(record.serializedMaxTokens),
        serializedAssistantChars: positiveNumberField(record.serializedAssistantChars),
        serializedUserChars: positiveNumberField(record.serializedUserChars),
        serializedToolResultChars: nonNegativeNumberField(record.serializedToolResultChars),
        serializedErrorResultChars: nonNegativeNumberField(record.serializedErrorResultChars),
        serializedNoteChars: nonNegativeNumberField(record.serializedNoteChars),
        // `0` is a real value here ("never resend"), so it needs the reader that keeps zero.
        retryMaxRetries: nonNegativeNumberField(record.retryMaxRetries),
        retryBaseDelayMs: positiveNumberField(record.retryBaseDelayMs),
        traceEnabled: booleanField(record.traceEnabled),
        traceMaxBytes: positiveNumberField(record.traceMaxBytes),
        traceGenerations: nonNegativeNumberField(record.traceGenerations),
        ...(model ? { model } : {}),
        ...(tracePath ? { tracePath } : {}),
    };
}

/** Resolve defaults, then the global file, then the project file. */
export function loadCompactionConfig(cwd: string): CompactionConfig {
    const locations = compactionConfigLocations(cwd);
    const global = readConfigFile(locations.global);
    const project = readConfigFile(locations.project);
    const defaults = DEFAULT_COMPACTION_CONFIG;
    const model = project.model ?? global.model;
    const tracePath = project.tracePath ?? global.tracePath;
    return {
        enabled: project.enabled ?? global.enabled ?? defaults.enabled,
        keepThinking: project.keepThinking ?? global.keepThinking ?? defaults.keepThinking,
        serializedMaxTokens:
            project.serializedMaxTokens ??
            global.serializedMaxTokens ??
            defaults.serializedMaxTokens,
        serializedAssistantChars:
            project.serializedAssistantChars ??
            global.serializedAssistantChars ??
            defaults.serializedAssistantChars,
        serializedUserChars:
            project.serializedUserChars ??
            global.serializedUserChars ??
            defaults.serializedUserChars,
        serializedToolResultChars:
            project.serializedToolResultChars ??
            global.serializedToolResultChars ??
            defaults.serializedToolResultChars,
        serializedErrorResultChars:
            project.serializedErrorResultChars ??
            global.serializedErrorResultChars ??
            defaults.serializedErrorResultChars,
        serializedNoteChars:
            project.serializedNoteChars ??
            global.serializedNoteChars ??
            defaults.serializedNoteChars,
        retryMaxRetries:
            project.retryMaxRetries ?? global.retryMaxRetries ?? defaults.retryMaxRetries,
        retryBaseDelayMs:
            project.retryBaseDelayMs ?? global.retryBaseDelayMs ?? defaults.retryBaseDelayMs,
        traceEnabled: project.traceEnabled ?? global.traceEnabled ?? defaults.traceEnabled,
        traceMaxBytes: project.traceMaxBytes ?? global.traceMaxBytes ?? defaults.traceMaxBytes,
        traceGenerations:
            project.traceGenerations ?? global.traceGenerations ?? defaults.traceGenerations,
        ...(model ? { model } : {}),
        ...(tracePath ? { tracePath } : {}),
    };
}
