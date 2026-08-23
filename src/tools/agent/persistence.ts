import fs from "node:fs";
import path from "node:path";
import {
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { PI_CODER_AGENT_SESSIONS_DIR } from "../../common/constants";
import {
    type AgentRunPersistence,
    type PersistedAgentRun,
    ZERO_USAGE,
} from "./runtime";

export const AGENT_RUN_STATE_ENTRY = "pi-coder:agent-run-state-v1";
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

/** Mirrors pi's cwd encoding for its own per-project session directories. */
export function normalizeCwdForSessionDirectory(cwd: string): string {
    const resolvedCwd = path.resolve(cwd);
    return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Returns the extension-local session directory for one cwd. */
export function getAgentCwdSessionDir(
    cwd: string,
    agentSessionsDir = PI_CODER_AGENT_SESSIONS_DIR,
): string {
    const sessionDir = path.join(
        path.resolve(agentSessionsDir),
        normalizeCwdForSessionDirectory(cwd),
    );
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.resolve(agentSessionsDir), 0o700);
    fs.chmodSync(sessionDir, 0o700);
    return sessionDir;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cloneUsage(value: unknown): PersistedAgentRun["usageSnapshot"] {
    if (!value || typeof value !== "object") return { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
    const usage = value as Partial<PersistedAgentRun["usageSnapshot"]>;
    const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : ZERO_USAGE.cost;
    return {
        input: finite(usage.input) ? usage.input : 0,
        output: finite(usage.output) ? usage.output : 0,
        cacheRead: finite(usage.cacheRead) ? usage.cacheRead : 0,
        cacheWrite: finite(usage.cacheWrite) ? usage.cacheWrite : 0,
        ...(finite(usage.cacheWrite1h) ? { cacheWrite1h: usage.cacheWrite1h } : {}),
        ...(finite(usage.reasoning) ? { reasoning: usage.reasoning } : {}),
        totalTokens: finite(usage.totalTokens) ? usage.totalTokens : 0,
        cost: {
            input: finite(cost.input) ? cost.input : 0,
            output: finite(cost.output) ? cost.output : 0,
            cacheRead: finite(cost.cacheRead) ? cost.cacheRead : 0,
            cacheWrite: finite(cost.cacheWrite) ? cost.cacheWrite : 0,
            total: finite(cost.total) ? cost.total : 0,
        },
    };
}

function boundedString(value: unknown, max: number): string | undefined {
    if (typeof value !== "string") return undefined;
    return value.slice(0, max);
}

function inside(directory: string, candidate: string): boolean {
    const relative = path.relative(directory, candidate);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function safeExistingChildFile(childSessionDir: string, candidate: string): string | undefined {
    try {
        const resolved = path.resolve(candidate);
        const stat = fs.lstatSync(resolved);
        if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
        const real = fs.realpathSync(resolved);
        return inside(childSessionDir, real) ? real : undefined;
    } catch {
        return undefined;
    }
}

function parseRecord(value: unknown, ownerSessionId: string, childSessionDir: string): PersistedAgentRun | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Partial<PersistedAgentRun>;
    if (
        record.version !== 1
        || record.ownerSessionId !== ownerSessionId
        || typeof record.runId !== "string"
        || !RUN_ID.test(record.runId)
        || typeof record.agent !== "string"
        || !record.runId.startsWith(`${record.agent}-`)
        || typeof record.agentSource !== "string"
        || typeof record.definitionFingerprint !== "string"
        || !/^[a-f0-9]{64}$/.test(record.definitionFingerprint)
        || typeof record.status !== "string"
        || !RESTORABLE_STATUSES.has(record.status as PersistedAgentRun["status"])
        || typeof record.background !== "boolean"
        || typeof record.mutating !== "boolean"
        || !finite(record.startedAt)
        || !finite(record.updatedAt)
    ) return undefined;

    const progressValue = record.progress && typeof record.progress === "object" ? record.progress : undefined;
    const activity = Array.isArray(progressValue?.recentActivity)
        ? progressValue.recentActivity.filter((item): item is string => typeof item === "string").slice(-8).map((item) => item.slice(0, 500))
        : [];
    const childSessionFile = boundedString(record.childSessionFile, 4_096);
    const resolvedChildFile = childSessionFile
        ? safeExistingChildFile(childSessionDir, childSessionFile)
        : undefined;
    const questionValue = record.question && typeof record.question === "object" ? record.question : undefined;
    const mutationValue = record.mutationReport && typeof record.mutationReport === "object" ? record.mutationReport : undefined;

    return {
        version: 1,
        ownerSessionId,
        runId: record.runId,
        agent: record.agent.slice(0, 64),
        agentSource: record.agentSource.slice(0, 32),
        agentFilePath: boundedString(record.agentFilePath, 4_096),
        definitionFingerprint: record.definitionFingerprint,
        task: boundedString(record.task, 16_000) ?? "Restored delegated task",
        status: record.status as PersistedAgentRun["status"],
        background: record.background,
        mutating: record.mutating,
        question: typeof questionValue?.question === "string" ? {
            question: questionValue.question.slice(0, 4_000),
            context: boundedString(questionValue.context, 12_000),
            options: Array.isArray(questionValue.options)
                ? questionValue.options.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 1_000))
                : undefined,
            recommendation: boundedString(questionValue.recommendation, 4_000),
        } : undefined,
        progress: {
            output: boundedString(progressValue?.output, 32_000) ?? "",
            recentActivity: activity,
        },
        usageCheckpoint: cloneUsage(record.usageCheckpoint),
        usageSnapshot: cloneUsage(record.usageSnapshot),
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        childSessionFile: resolvedChildFile,
        terminalContent: boundedString(record.terminalContent, 48_000),
        terminalError: boundedString(record.terminalError, 4_000),
        terminalIsError: typeof record.terminalIsError === "boolean" ? record.terminalIsError : undefined,
        mutationReport: mutationValue ? {
            changedFiles: Array.isArray(mutationValue.changedFiles)
                ? mutationValue.changedFiles.filter((item): item is string => typeof item === "string").slice(0, 1_000).map((item) => item.slice(0, 4_096))
                : [],
            bashApproved: mutationValue.bashApproved === true,
            interrupted: mutationValue.interrupted === true,
        } : undefined,
    };
}

export interface LoadedAgentRunPersistence {
    persistence: AgentRunPersistence;
    records: PersistedAgentRun[];
}

export function loadAgentRunPersistence(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    agentSessionsDir = PI_CODER_AGENT_SESSIONS_DIR,
): LoadedAgentRunPersistence | undefined {
    if (!ctx.sessionManager.getSessionFile()) return undefined;
    const ownerSessionId = ctx.sessionManager.getSessionId();
    const cwdSessionDir = getAgentCwdSessionDir(ctx.cwd, agentSessionsDir);
    const childSessionDir = path.join(cwdSessionDir, ownerSessionId);
    fs.mkdirSync(childSessionDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(childSessionDir, 0o700);

    const latest = new Map<string, PersistedAgentRun>();
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== AGENT_RUN_STATE_ENTRY) continue;
        const parsed = parseRecord(entry.data, ownerSessionId, childSessionDir);
        if (parsed) latest.set(parsed.runId, parsed);
    }

    let persistenceWarningShown = false;
    const persistence: AgentRunPersistence = {
        ownerSessionId,
        childSessionDir,
        save(record) {
            try {
                pi.appendEntry(AGENT_RUN_STATE_ENTRY, record);
                return true;
            } catch (error) {
                if (!persistenceWarningShown) {
                    persistenceWarningShown = true;
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`pi-coder agents: could not persist delegated run state: ${message}`, "warning");
                }
                return false;
            }
        },
        deleteChildSession(sessionFile) {
            const resolved = path.resolve(sessionFile);
            if (!inside(childSessionDir, resolved)) return;
            try {
                fs.rmSync(resolved, { force: true });
            } catch {
                // Cleanup is best effort; state tombstones remain authoritative.
            }
        },
    };
    return { persistence, records: [...latest.values()] };
}
