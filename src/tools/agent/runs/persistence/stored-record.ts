import path from "node:path";
import {
    isAgentTerminalStatus,
    type ChildProgress,
    type ParentQuestion,
    type PersistedAgentRun,
} from "../../contracts/runs";
import { WorkerMutationReport } from "../../contracts/mutations";
import { ZERO_USAGE } from ".././usage";
import { parseAgentDefinitionSnapshot } from "../../definitions/types";
import { type AgentRunSnapshotMarker } from "../../storage/run-markers";
import { type AgentRunSnapshotRow } from "../../storage/run-snapshots";
import { safeExistingChildFile } from "./session-paths";

const RUN_ID = /^[a-z][a-z0-9_-]{0,63}-\d+$/;

const RESTORABLE_STATUSES = new Set<PersistedAgentRun["status"]>([
    "starting",
    "running",
    "waiting_for_parent",
    "interrupted",
    "completed",
    "failed",
    "aborted",
    "canceled",
    "removed",
]);

/**
 * Durable numeric fields only ever hold quantities that cannot go below zero: usage counters, costs,
 * timestamps, and counts. A negative value is corruption, so it fails the check and the caller falls
 * back to its default rather than restoring a nonsensical number.
 */
function nonNegativeNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cloneUsage(value: unknown): PersistedAgentRun["usageSnapshot"] {
    if (!value || typeof value !== "object") return { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
    const usage = value as Partial<PersistedAgentRun["usageSnapshot"]>;
    const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : ZERO_USAGE.cost;
    return {
        input: nonNegativeNumber(usage.input) ? usage.input : 0,
        output: nonNegativeNumber(usage.output) ? usage.output : 0,
        cacheRead: nonNegativeNumber(usage.cacheRead) ? usage.cacheRead : 0,
        cacheWrite: nonNegativeNumber(usage.cacheWrite) ? usage.cacheWrite : 0,
        ...(nonNegativeNumber(usage.cacheWrite1h) ? { cacheWrite1h: usage.cacheWrite1h } : {}),
        ...(nonNegativeNumber(usage.reasoning) ? { reasoning: usage.reasoning } : {}),
        totalTokens: nonNegativeNumber(usage.totalTokens) ? usage.totalTokens : 0,
        cost: {
            input: nonNegativeNumber(cost.input) ? cost.input : 0,
            output: nonNegativeNumber(cost.output) ? cost.output : 0,
            cacheRead: nonNegativeNumber(cost.cacheRead) ? cost.cacheRead : 0,
            cacheWrite: nonNegativeNumber(cost.cacheWrite) ? cost.cacheWrite : 0,
            total: nonNegativeNumber(cost.total) ? cost.total : 0,
        },
    };
}

function boundedString(value: unknown, max: number): string | undefined {
    if (typeof value !== "string") return undefined;
    return value.slice(0, max);
}

function boundedToolCounts(value: unknown): Record<string, number> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const counts: Record<string, number> = {};
    for (const [name, count] of Object.entries(value as Record<string, unknown>)) {
        if (
            name.length > 80 ||
            typeof count !== "number" ||
            !Number.isSafeInteger(count) ||
            count < 0
        )
            continue;
        counts[name] = count;
    }
    return Object.keys(counts).length ? counts : undefined;
}

/**
 * Cap a stored string list, keeping the leading entries and truncating each item.
 */
function boundedStringList(value: unknown, maxItems: number, maxLength: number): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter((item): item is string => typeof item === "string")
        .slice(0, maxItems)
        .map((item) => item.slice(0, maxLength));
}

/**
 * Accept a stored count only as a non-negative safe integer.
 *
 * `finite` already rejects negatives, so the integer check carries the whole remaining contract; the
 * snapshot shape test pins both.
 */
function boundedCount(value: unknown): number | undefined {
    if (!nonNegativeNumber(value) || !Number.isSafeInteger(value)) {
        return undefined;
    }
    return value;
}

/**
 * Coerce a stored progress object into the shape projection and accounting code expect.
 *
 * Progress is display state, so a corrupt or oversized field is dropped rather than a reason to
 * reject the run: the run stays restorable without its last progress frame. Activity keeps the eight
 * most recent entries, because older ones are already superseded.
 */
function normalizeProgress(value: unknown): ChildProgress {
    const progress =
        value && typeof value === "object" ? (value as Partial<ChildProgress>) : undefined;
    const activity = Array.isArray(progress?.recentActivity)
        ? progress.recentActivity
              .filter((item): item is string => typeof item === "string")
              .slice(-8)
              .map((item) => item.slice(0, 500))
        : [];
    const phase = boundedString(progress?.phase, 120);
    const lastAssistantMessage = boundedString(progress?.lastAssistantMessage, 32_000);
    const lastToolActivity = boundedString(progress?.lastToolActivity, 500);
    const failedToolCalls = boundedCount(progress?.failedToolCalls);
    const toolCounts = boundedToolCounts(progress?.toolCounts);

    return {
        output: boundedString(progress?.output, 32_000) ?? "",
        recentActivity: activity,
        ...(phase ? { phase } : {}),
        ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
        ...(lastToolActivity ? { lastToolActivity } : {}),
        ...(toolCounts ? { toolCounts } : {}),
        ...(failedToolCalls !== undefined ? { failedToolCalls } : {}),
    };
}

/**
 * Keep a stored question only when it still carries its text; the rest is best effort.
 */
function normalizeQuestion(value: unknown): ParentQuestion | undefined {
    const question =
        value && typeof value === "object" ? (value as Partial<ParentQuestion>) : undefined;
    if (typeof question?.question !== "string") {
        return undefined;
    }
    const context = boundedString(question.context, 12_000);
    const recommendation = boundedString(question.recommendation, 4_000);
    const options = Array.isArray(question.options)
        ? boundedStringList(question.options, 20, 1_000)
        : undefined;

    return {
        question: question.question.slice(0, 4_000),
        ...(context ? { context } : {}),
        ...(options ? { options } : {}),
        ...(recommendation ? { recommendation } : {}),
    };
}

/**
 * Rebuild a stored mutation report with capped lists and explicit boolean defaults.
 *
 * `readFiles` is omitted when empty, which is how an unmutating child stores it; the apply path
 * distinguishes an absent list from an empty one only for display.
 */
function normalizeMutationReport(value: unknown): WorkerMutationReport | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const report = value as Partial<WorkerMutationReport>;
    const readFiles = boundedStringList(report.readFiles, 1_000, 4_096);

    return {
        changedFiles: boundedStringList(report.changedFiles, 1_000, 4_096),
        ...(readFiles.length > 0 ? { readFiles } : {}),
        bashApproved: report.bashApproved === true,
        interrupted: report.interrupted === true,
    };
}

export function parseRecord(
    value: unknown,
    ownerSessionId: string,
    childSessionDir: string,
): PersistedAgentRun | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Partial<PersistedAgentRun>;
    if (
        record.version !== 1 ||
        record.ownerSessionId !== ownerSessionId ||
        typeof record.runId !== "string" ||
        !RUN_ID.test(record.runId) ||
        typeof record.agent !== "string" ||
        !record.runId.startsWith(`${record.agent}-`) ||
        typeof record.agentSource !== "string" ||
        typeof record.definitionFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.definitionFingerprint) ||
        typeof record.status !== "string" ||
        !RESTORABLE_STATUSES.has(record.status as PersistedAgentRun["status"]) ||
        typeof record.background !== "boolean" ||
        typeof record.mutating !== "boolean" ||
        !nonNegativeNumber(record.startedAt) ||
        !nonNegativeNumber(record.updatedAt)
    )
        return undefined;

    const childSessionFile = boundedString(record.childSessionFile, 4_096);
    const resolvedChildFile = childSessionFile
        ? safeExistingChildFile(childSessionDir, childSessionFile)
        : undefined;
    const definitionSnapshot = parseAgentDefinitionSnapshot(record.definitionSnapshot);

    return {
        version: 1,
        ownerSessionId,
        ownerPid:
            typeof record.ownerPid === "number" && Number.isSafeInteger(record.ownerPid)
                ? record.ownerPid
                : undefined,
        runId: record.runId,
        ...(typeof record.runInstanceId === "string"
            ? { runInstanceId: record.runInstanceId }
            : {}),
        title: boundedString(record.title, 80),
        agent: record.agent.slice(0, 64),
        agentSource: record.agentSource.slice(0, 32),
        agentFilePath: boundedString(record.agentFilePath, 4_096),
        definitionFingerprint: record.definitionFingerprint,
        ...(definitionSnapshot ? { definitionSnapshot } : {}),
        task: boundedString(record.task, 16_000) ?? "Restored delegated task",
        status: record.status as PersistedAgentRun["status"],
        ...(isAgentTerminalStatus(record.terminalStatus)
            ? { terminalStatus: record.terminalStatus }
            : {}),
        background: record.background,
        mutating: record.mutating,
        workspaceId: boundedString(record.workspaceId, 200),
        workspaceResultId: boundedString(record.workspaceResultId, 200),
        question: normalizeQuestion(record.question),
        progress: normalizeProgress(record.progress),
        usageCheckpoint: cloneUsage(record.usageCheckpoint),
        usageSnapshot: cloneUsage(record.usageSnapshot),
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        parentCwd: boundedString(record.parentCwd, 4_096),
        cwd: boundedString(record.cwd, 4_096),
        childSessionFile: resolvedChildFile,
        ...(record.childSessionLeafId === null || typeof record.childSessionLeafId === "string"
            ? { childSessionLeafId: record.childSessionLeafId }
            : {}),
        ...(record.resumable === false ? { resumable: false } : {}),
        ...(typeof record.readOnlyReason === "string"
            ? { readOnlyReason: record.readOnlyReason.slice(0, 500) }
            : {}),
        terminalContent: boundedString(record.terminalContent, 48_000),
        terminalError: boundedString(record.terminalError, 4_000),
        terminalIsError:
            typeof record.terminalIsError === "boolean" ? record.terminalIsError : undefined,
        setupFailed: record.setupFailed === true ? true : undefined,
        mutationReport: normalizeMutationReport(record.mutationReport),
    };
}

export function validateAgentRunSnapshot(
    snapshot: AgentRunSnapshotRow,
    marker: AgentRunSnapshotMarker,
    ownerSessionId: string,
    childSessionDir: string,
): PersistedAgentRun | undefined {
    if (
        snapshot.ownerSessionId !== ownerSessionId ||
        snapshot.payloadVersion !== 2 ||
        snapshot.runInstanceId !== marker.runInstanceId ||
        snapshot.runId !== marker.runId
    ) {
        return undefined;
    }

    const parsed = parseRecord(snapshot.payload, ownerSessionId, childSessionDir);
    if (!parsed || parsed.runInstanceId !== marker.runInstanceId || parsed.runId !== marker.runId) {
        return undefined;
    }

    if (snapshot.childSessionFile !== undefined && parsed.childSessionLeafId === undefined) {
        return undefined;
    }

    if ((parsed.childSessionLeafId ?? null) !== snapshot.childSessionLeafId) {
        return undefined;
    }

    if (
        (snapshot.childSessionFile ? path.resolve(snapshot.childSessionFile) : undefined) !==
        parsed.childSessionFile
    ) {
        return undefined;
    }

    if (snapshot.status !== parsed.status || snapshot.updatedAt !== parsed.updatedAt) {
        return undefined;
    }

    return parsed;
}
