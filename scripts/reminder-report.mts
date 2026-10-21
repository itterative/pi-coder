#!/usr/bin/env node
/**
 * Replay a recorded session and print the reminder state the decision model would judge at each user turn.
 *
 * The signals are rebuilt from the branch prefix exactly as `before_agent_start` sees it: the live request
 * stands in for the user message that is not persisted yet, the recent window comes from the branch, and the
 * activity, prior-reminder, TODO, memory, and label fields are recomputed per turn. Nothing is sent anywhere:
 * this shows the input side only, so the questions' wording and the question-count tradeoff can be inspected
 * before a consult is ever made.
 *
 * The deterministic schedule is simulated alongside the state, respecting `PI_CODER_REMINDER_*`, so the
 * report also shows what each turn would have received with the model off; each turn prints the picked
 * reminder's full text as well as its id. Threshold crossings between user turns are simulated too and print
 * as mid-run emissions above the next turn, because the live module steers them into the running loop. With
 * `reminders: true` the live choice could differ, but this report never consults the endpoint. Memory-index and todo-snapshot entries recorded in the session are
 * picked up as the live module would pick them up.
 *
 * Usage:
 *   npm run reminder-report -- <session.jsonl> [options]
 *
 *   <session.jsonl>   recorded session file to replay (required)
 *   --turn <n>        print only this user turn (1-based)
 *   --turns <n>       print at most this many user turns
 *   --compact         one line per turn instead of the full state
 *   --json            machine-readable turns, in session order
 *   --help            this message
 *
 * A missing file is an error; `SessionManager.open` silently starts an empty session otherwise, which would
 * print a header and nothing else.
 *
 * This file is `.mts` because the root package is not `"type": "module"`: under `node --import tsx` a `.ts`
 * script here is CommonJS, and the pi package is ESM-only. `src/package.json` marks the source tree ESM for
 * the same reason, so the relative imports into `src/` resolve as imports rather than requires.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "@earendil-works/pi-ai";

import { buildReminderState } from "../src/modules/decision/reminder";
import { decisionSessionContext } from "../src/modules/decision/session-context";
import { REMINDER_NOTICE } from "../src/modules/reminders/catalog";
import { ReminderScheduler } from "../src/modules/reminders/scheduler";
import {
    availableRotationIds,
    buildReminderSignals,
    reminderLabelsFromEntries,
} from "../src/modules/reminders/session-signals";
import { loadReminderSettings } from "../src/modules/reminders/settings";
import type { ReminderId } from "../src/modules/reminders/types";

const USAGE = `usage: npm run reminder-report -- <session.jsonl> [options]

  <session.jsonl>   recorded session file to replay (required)
  --turn <n>        print only this user turn (1-based)
  --turns <n>       print at most this many user turns
  --compact         one line per turn instead of the full state
  --json            machine-readable turns, in session order
  --help            this message`;

export interface Options {
    file: string | undefined;
    turn: number | undefined;
    turns: number | undefined;
    compact: boolean;
    json: boolean;
    help: boolean;
}

export function parseArgs(argv: string[]): Options {
    const options: Options = {
        file: undefined,
        turn: undefined,
        turns: undefined,
        compact: false,
        json: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = (): string | undefined => {
            index += 1;
            return argv[index];
        };
        const numberArg = (): number | undefined => {
            const value = Number(next());
            return Number.isInteger(value) && value > 0 ? value : undefined;
        };

        if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else if (arg === "--compact") {
            options.compact = true;
        } else if (arg === "--json") {
            options.json = true;
        } else if (arg === "--turn") {
            options.turn = numberArg();
        } else if (arg === "--turns") {
            options.turns = numberArg();
        } else if (arg !== undefined && !arg.startsWith("-")) {
            options.file = arg;
        }
    }

    return options;
}

/** A threshold reminder the live module would have delivered inside the run, before the next user turn. */
export interface ReplayEmission {
    /** The assistant entry whose context crossing fired it. */
    afterEntryId: string;
    schedule: ReminderId;
    reminderText: string;
}

/** One user turn as the report presents it. */
export interface ReplayTurn {
    turn: number;
    entryId: string;
    request: string;
    /** The deterministic schedule's pick for this turn, or `none`. */
    schedule: ReminderId | "none";
    /** The exact text the pick would emit, absent for `none`. */
    reminderText?: string;
    /** Mid-run emissions since the previous user turn, which the live module steers into the run. */
    midRun?: ReplayEmission[];
    contextTokens: number;
    /** The classifier state `buildReminderState` would send. */
    state: JsonObject;
}

export interface ReplayResult {
    cwd: string;
    userTurns: number;
    turns: ReplayTurn[];
}

interface MessageView {
    role: string;
    content: unknown;
    usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
}

function messageView(entry: SessionEntry): MessageView | undefined {
    if (entry.type !== "message") {
        return undefined;
    }

    return entry.message as MessageView;
}

function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter((part): part is { type: "text"; text: string } => {
            return (
                typeof part === "object" &&
                part !== null &&
                (part as { type?: unknown }).type === "text" &&
                typeof (part as { text?: unknown }).text === "string"
            );
        })
        .map((part) => part.text)
        .join("\n")
        .trim();
}

/** The context size the session was at, estimated from the newest assistant usage before this turn. */
function contextTokensOf(usage: MessageView["usage"]): number {
    if (usage === undefined) {
        return 0;
    }

    return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** Whether the assistant message called a tool, the condition the live mid-run steer requires. */
function hasToolCall(content: unknown): boolean {
    if (!Array.isArray(content)) {
        return false;
    }

    return content.some((part) => {
        return (
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "toolCall"
        );
    });
}

/**
 * Simulate the session turn by turn, keeping the scheduler's own state so the shown-reminder map and the
 * rotation pointer are what the live module would have had.
 */
export function replay(entries: readonly SessionEntry[], cwd: string): ReplayResult {
    const settings = loadReminderSettings();
    const scheduler = new ReminderScheduler({
        everyTurns: settings.everyTurns,
        thresholdTokens: settings.thresholdTokens,
        maxMidRunPerTurn: settings.midRunMax,
    });
    scheduler.reset();

    const shown = new Map<ReminderId, number>();
    const turns: ReplayTurn[] = [];
    const pendingMidRun: ReplayEmission[] = [];
    let contextTokens = 0;

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined) {
            continue;
        }

        const message = messageView(entry);
        if (message === undefined) {
            continue;
        }

        if (message.role === "assistant") {
            contextTokens = contextTokensOf(message.usage);

            // The live module steers only once the streaming message has called a tool, and narrows the
            // rotation by the activity gate. Both read the committed prefix, not the message itself, so the
            // current assistant message never counts toward its own availability.
            if (hasToolCall(message.content)) {
                const prefix = entries.slice(0, index);
                const signals = buildReminderSignals({
                    entries: prefix,
                    cwd,
                    currentTurn: turns.length + 1,
                    contextTokens,
                    shown,
                    labels: reminderLabelsFromEntries(prefix),
                });
                const midRun = scheduler.decideMidRun({
                    maxContextTokens: contextTokens,
                    available: availableRotationIds(signals),
                });
                if (midRun !== undefined) {
                    shown.set(midRun.id, scheduler.snapshot().userTurns);
                    pendingMidRun.push({
                        afterEntryId: String(entry.id),
                        schedule: midRun.id,
                        reminderText: midRun.text,
                    });
                }
            }
            continue;
        }

        if (message.role !== "user") {
            continue;
        }

        const request = textOf(message.content);
        const prefix = entries.slice(0, index);
        const currentTurn = turns.length + 1;

        const signals = buildReminderSignals({
            entries: prefix,
            cwd,
            currentTurn,
            contextTokens,
            shown,
            labels: reminderLabelsFromEntries(prefix),
        });
        const state = buildReminderState({
            request,
            recent: decisionSessionContext(prefix).recent,
            options: [],
            signals,
        });

        const reminder = scheduler.decide({
            maxContextTokens: contextTokens,
            available: availableRotationIds(signals),
        });
        if (reminder !== undefined && reminder.id !== "memory-read") {
            shown.set(reminder.id, scheduler.snapshot().userTurns);
        }

        turns.push({
            turn: currentTurn,
            entryId: String(entry.id),
            request,
            schedule: reminder?.id ?? "none",
            ...(reminder === undefined ? {} : { reminderText: reminder.text }),
            ...(pendingMidRun.length === 0 ? {} : { midRun: pendingMidRun.splice(0) }),
            contextTokens,
            state,
        });
    }

    return { cwd, userTurns: turns.length, turns };
}

export function selectTurns(result: ReplayResult, options: Options): ReplayTurn[] {
    let selected = result.turns;

    if (options.turn !== undefined) {
        selected = selected.filter((turn) => turn.turn === options.turn);
    }

    if (options.turns !== undefined) {
        selected = selected.slice(0, options.turns);
    }

    return selected;
}

function collapse(text: string, limit: number): string {
    const collapsed = text.replace(/\s+/gu, " ").trim();
    return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

function renderCompact(turn: ReplayTurn): string {
    const activity = turn.state.session as JsonObject | undefined;
    const tools = activity?.tools;
    const toolText =
        typeof tools === "object" && tools !== null && !Array.isArray(tools)
            ? Object.entries(tools)
                  .map(([name, count]) => `${name}:${String(count)}`)
                  .join(",")
            : "";

    return [
        `turn ${turn.turn}`,
        `schedule=${turn.schedule}`,
        turn.reminderText === undefined
            ? undefined
            : `shows=${JSON.stringify(collapse(turn.reminderText, 64))}`,
        turn.midRun === undefined ? undefined : `midrun=${turn.midRun.length}`,
        `phase=${String(activity?.phase ?? "-")}`,
        `tokens=${turn.contextTokens}`,
        toolText === "" ? undefined : `tools=${toolText}`,
        `request=${JSON.stringify(collapse(turn.request, 80))}`,
    ]
        .filter((part): part is string => part !== undefined)
        .join("  ");
}

export function renderText(
    result: ReplayResult,
    selected: readonly ReplayTurn[],
    options: Options,
): string {
    const lines = [
        `session: cwd=${result.cwd} user-turns=${result.userTurns}`,
        `schedule: deterministic memory-read + rotation, settings from PI_CODER_REMINDER_*`,
        `model: not consulted; a live choice with reminders: true may differ`,
        "",
    ];

    for (const turn of selected) {
        lines.push(`===== turn ${turn.turn} (entry ${turn.entryId}) =====`);

        if (options.compact) {
            lines.push(renderCompact(turn));
        } else {
            lines.push(`request: ${JSON.stringify(turn.request.slice(0, 120))}`);
            for (const emission of turn.midRun ?? []) {
                lines.push(`mid-run: ${emission.schedule} (after entry ${emission.afterEntryId})`);
                lines.push(`  ${collapse(emission.reminderText, 120)}`);
            }
            lines.push(`schedule: ${turn.schedule}  context-tokens: ${turn.contextTokens}`);
            if (turn.reminderText === undefined) {
                lines.push("reminder: none");
            } else {
                lines.push(`reminder: ${turn.schedule}`);
                lines.push("<pi_coder_reminder>");
                lines.push(REMINDER_NOTICE);
                lines.push(turn.reminderText);
                lines.push("</pi_coder_reminder>");
            }
            lines.push("state:");
            lines.push(JSON.stringify(turn.state, null, 1));
        }

        lines.push("");
    }

    return lines.join("\n");
}

export function renderJson(result: ReplayResult, selected: readonly ReplayTurn[]): string {
    return JSON.stringify(
        {
            cwd: result.cwd,
            userTurns: result.userTurns,
            turns: selected,
        },
        null,
        2,
    );
}

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }

    if (options.file === undefined) {
        throw new Error(USAGE);
    }

    const file = path.resolve(options.file);
    if (!fs.existsSync(file)) {
        throw new Error(`session file not found: ${file}`);
    }

    const session = SessionManager.open(file);
    const result = replay(session.getBranch(), session.getCwd());
    const selected = selectTurns(result, options);

    process.stdout.write(
        options.json
            ? `${renderJson(result, selected)}\n`
            : `${renderText(result, selected, options)}\n`,
    );
}

/**
 * Whether this file is the program being run, rather than a module a test imported. The parts are exported so
 * a suite can feed synthetic entries through `replay` without a real session file.
 */
function isDirectRun(): boolean {
    const invoked = process.argv[1];
    if (invoked === undefined) {
        return false;
    }

    try {
        return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isDirectRun()) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
