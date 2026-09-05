import fs from "node:fs";
import path from "node:path";
import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

import { pager, type PagerItem } from "../../../tui/pager";
import type { AgentTraceData } from "../contracts/trace";

export type { AgentTraceData, AgentTraceValue } from "../contracts/trace";

export const AGENT_TRACE_ENV = "PI_CODER_AGENT_TRACE";
const TRACE_VERSION = 1;
const DEFAULT_MAX_RUNS = 20;
const DEFAULT_MAX_EVENTS = 400;

export interface AgentTraceEvent {
    sequence: number;
    timestamp: string;
    type: string;
    data?: AgentTraceData;
}

export interface AgentTraceSnapshot {
    version: number;
    runId: string;
    agent: string;
    startedAt: string;
    updatedAt: string;
    terminalStatus?: string;
    droppedEvents: number;
    events: AgentTraceEvent[];
}

interface MutableTrace extends AgentTraceSnapshot {
    nextSequence: number;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function isAgentTraceEnabled(value = process.env[AGENT_TRACE_ENV]): boolean {
    // return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
    // TODO: enabled temporarily while developing the extension
    return true;
}

export class AgentTraceStore {
    private readonly traces = new Map<string, MutableTrace>();

    constructor(
        private readonly maxRuns = DEFAULT_MAX_RUNS,
        private readonly maxEvents = DEFAULT_MAX_EVENTS,
    ) {}

    start(runId: string, agent: string, data?: AgentTraceData): void {
        const timestamp = new Date().toISOString();
        this.traces.set(runId, {
            version: TRACE_VERSION,
            runId,
            agent,
            startedAt: timestamp,
            updatedAt: timestamp,
            droppedEvents: 0,
            events: [],
            nextSequence: 1,
        });
        this.record(runId, "run.created", data);
        this.prune();
    }

    record(runId: string, type: string, data?: AgentTraceData): void {
        const trace = this.traces.get(runId);
        if (!trace) return;
        const timestamp = new Date().toISOString();
        trace.updatedAt = timestamp;
        if (trace.events.length >= this.maxEvents) {
            trace.events.shift();
            trace.droppedEvents++;
        }
        trace.events.push({
            sequence: trace.nextSequence++,
            timestamp,
            type,
            ...(data && Object.keys(data).length ? { data } : {}),
        });
    }

    finish(runId: string, status: string, data?: AgentTraceData): void {
        this.record(runId, "run.terminal", { status, ...data });
        const trace = this.traces.get(runId);
        if (trace) trace.terminalStatus = status;
        this.prune();
    }

    list(): AgentTraceSnapshot[] {
        return [...this.traces.values()]
            .slice()
            .reverse()
            .map((trace) => this.snapshot(trace));
    }

    get(runId: string): AgentTraceSnapshot | undefined {
        const trace = this.traces.get(runId);
        return trace ? this.snapshot(trace) : undefined;
    }

    clear(): number {
        const count = this.traces.size;
        this.traces.clear();
        return count;
    }

    private snapshot(trace: MutableTrace): AgentTraceSnapshot {
        return {
            version: trace.version,
            runId: trace.runId,
            agent: trace.agent,
            startedAt: trace.startedAt,
            updatedAt: trace.updatedAt,
            terminalStatus: trace.terminalStatus,
            droppedEvents: trace.droppedEvents,
            events: trace.events.map((event) => ({
                ...event,
                ...(event.data ? { data: { ...event.data } } : {}),
            })),
        };
    }

    private prune(): void {
        if (this.traces.size <= this.maxRuns) return;
        for (const [runId, trace] of this.traces) {
            if (!trace.terminalStatus) continue;
            this.traces.delete(runId);
            if (this.traces.size <= this.maxRuns) break;
        }
    }
}

function eventLine(event: AgentTraceEvent): string {
    const time = event.timestamp.slice(11, 23);
    const data = event.data ? ` ${JSON.stringify(event.data)}` : "";
    return `${String(event.sequence).padStart(3, "0")} ${time} ${event.type}${data}`;
}

async function showLines(
    title: string,
    lines: string[],
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!ctx.hasUI) {
        ctx.ui.notify(`${title}\n${lines.join("\n")}`, "info");
        return;
    }
    let scrollOffset = 0;
    const maxVisibleLines = 20;
    const maxScrollOffset = Math.max(0, lines.length - maxVisibleLines);
    const items: Array<PagerItem<string>> = lines.map((line) => ({ label: line, value: line }));
    await pager(
        {
            title,
            items,
            scrollOffset,
            maxVisibleLines,
            helpText: "↑/↓ scroll | Esc close",
            renderItem: (item) => item.label,
            onKey: (key, state) => {
                if (matchesKey(key, "up") || key === "k") {
                    scrollOffset = Math.max(0, scrollOffset - 1);
                    state.scrollOffset = scrollOffset;
                    return true;
                }
                if (matchesKey(key, "down") || key === "j") {
                    scrollOffset = Math.min(maxScrollOffset, scrollOffset + 1);
                    state.scrollOffset = scrollOffset;
                    return true;
                }
                return false;
            },
        },
        ctx,
    );
}

function saveTrace(trace: AgentTraceSnapshot): string {
    const dir = path.join(getAgentDir(), "traces");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const safeRunId = trace.runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(dir, `${timestamp}-${safeRunId}.json`);
    fs.writeFileSync(
        filePath,
        `${JSON.stringify(
            {
                savedAt: new Date().toISOString(),
                trace,
            },
            null,
            2,
        )}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    return filePath;
}

export function registerAgentTraceCommand(pi: ExtensionAPI, store: AgentTraceStore): void {
    pi.registerCommand("agent-trace", {
        description: "Inspect bounded sanitized traces for delegated agents",
        getArgumentCompletions: (prefix) => {
            const values = store.list().flatMap((trace) => [trace.runId, `${trace.runId} save`]);
            values.push("clear");
            return values
                .filter((value) => value.startsWith(prefix))
                .map((value) => ({ value, label: value }));
        },
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) {
                const traces = store.list();
                if (!traces.length) {
                    ctx.ui.notify("No delegated-agent traces have been recorded.", "info");
                    return;
                }
                await showLines(
                    "Delegated agent traces",
                    traces.map((trace) => {
                        const status = trace.terminalStatus ?? "active";
                        const dropped = trace.droppedEvents
                            ? `, ${trace.droppedEvents} dropped`
                            : "";
                        return `${trace.runId}: ${status}, ${trace.events.length} events${dropped}`;
                    }),
                    ctx,
                );
                return;
            }

            if (parts[0] === "clear" && parts.length === 1) {
                const count = store.clear();
                ctx.ui.notify(
                    `Cleared ${count} delegated-agent trace${count === 1 ? "" : "s"}.`,
                    "info",
                );
                return;
            }

            const trace = store.get(parts[0]!);
            if (!trace) {
                ctx.ui.notify(`Unknown or expired delegated-agent trace: ${parts[0]}`, "warning");
                return;
            }
            if (parts[1] === "save" && parts.length === 2) {
                try {
                    const filePath = saveTrace(trace);
                    ctx.ui.notify(`Saved sanitized delegated-agent trace to ${filePath}`, "info");
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Failed to save delegated-agent trace: ${message}`, "error");
                }
                return;
            }
            if (parts.length > 1) {
                ctx.ui.notify("Usage: /agent-trace [run-id [save]|clear]", "warning");
                return;
            }

            const header = [
                `${trace.runId}: ${trace.terminalStatus ?? "active"}`,
                `started ${trace.startedAt}; updated ${trace.updatedAt}`,
                `${trace.events.length} events; ${trace.droppedEvents} dropped`,
                "",
            ];
            await showLines(
                `Delegated agent trace: ${trace.runId}`,
                [...header, ...trace.events.map(eventLine)],
                ctx,
            );
        },
    });
}
