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
 * reminder's full text as well as its id. Threshold crossings are simulated too and print with the turn
 * whose run emitted them, because the live module steers them into that running loop. With
 * `reminders: true` the live choice could differ, but this report never consults the endpoint. Memory-index
 * and todo-snapshot entries recorded in the session are picked up as the live module would pick them up.
 *
 * A `compaction` entry is modeled as the live `session_compact` restart: the schedule, the shown map, and
 * the context estimate start over and the compaction reminder is armed, while the activity scan keeps reading
 * the whole branch, which is what `getBranch()` serves the live module. `--recorded` additionally shows what
 * the session itself recorded for each turn - the `pi-coder-reminder:debug` decision and the signals it was
 * made from, and any reminder message actually delivered - and warns when that data is missing. The file is
 * what pi has persisted, so a live session can lag its own turn: recent turns may show no recorded decision
 * even though the live module already made one.
 *
 * A turn here is a prompt that started an agent run, which is what `before_agent_start` and the scheduler
 * count. A message submitted while the run was still streaming is queued by pi as a steer and never reaches
 * the decision: it is listed under the turn it joined, and it does not shift the turn numbering.
 *
 * Usage:
 *   npm run reminder-report -- <session.jsonl> [options]
 *
 *   <session.jsonl>   recorded session file to replay (required)
 *   --turn <n>        print only this user turn (1-based)
 *   --turns <n>       print at most this many user turns
 *   --compact         one line per turn instead of the full state
 *   --recorded        show the decisions and messages the session recorded
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
import {
    COMPACTION_REMINDER,
    MEMORY_READ_REMINDER,
    REMINDER_NOTICE,
} from "../src/modules/reminders/catalog";
import { ReminderScheduler } from "../src/modules/reminders/scheduler";
import {
    REMINDER_CUSTOM_TYPE,
    REMINDER_DEBUG_ENTRY_TYPE,
    availableRotationIds,
    buildReminderSignals,
    reminderLabelsFromEntries,
} from "../src/modules/reminders/session-signals";
import { loadReminderSettings } from "../src/modules/reminders/settings";
import type { ReminderId } from "../src/modules/reminders/types";

const USAGE = `usage: npm run reminder-report -- <session.jsonl> [options]

  <session.jsonl>   recorded session file to replay (required)
  --turn <n>        print only this turn (1-based)
  --turns <n>       print at most this many turns
  --compact         one line per turn instead of the full state
  --recorded        show the decisions and messages the session recorded
  --json            machine-readable turns, in session order
  --help            this message`;

export interface Options {
    file: string | undefined;
    turn: number | undefined;
    turns: number | undefined;
    compact: boolean;
    recorded: boolean;
    json: boolean;
    help: boolean;
}

export function parseArgs(argv: string[]): Options {
    const options: Options = {
        file: undefined,
        turn: undefined,
        turns: undefined,
        compact: false,
        recorded: false,
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
        } else if (arg === "--recorded") {
            options.recorded = true;
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

/** A threshold reminder the live module delivered inside a turn's run, between its assistant messages. */
export interface ReplayEmission {
    /** The assistant entry whose context crossing fired it. */
    afterEntryId: string;
    schedule: ReminderId;
    reminderText: string;
}

/** A selection decision the session recorded, from a `pi-coder-reminder:debug` entry. */
export interface RecordedDecision {
    trigger: string;
    /** The emitted id, or null when the decision showed nothing. */
    reminder: string | null;
    modelChoice?: string;
    scores?: Record<string, number>;
    options?: string[];
    available?: string[];
    contextTokens?: number;
    labels?: JsonObject;
    consult?: JsonObject;
    scheduler?: JsonObject;
    /** The signals the decision was made from; absent for the session reminder and mid-run steers. */
    state?: JsonObject;
}

/** A reminder message the session actually delivered, with the marker it was stamped with. */
export interface RecordedDelivery {
    id?: string;
    turn?: number;
    /** False when the entry has no id/turn marker, as in sessions recorded before the stamp existed. */
    hasDetails: boolean;
    /** The message exactly as delivered, wrapper and notice included. */
    text: string;
}

/** What one session recorded for one user turn. */
export interface RecordedTurn {
    /** The turn's own decision entry, when one was recorded. */
    decision?: RecordedDecision;
    /** Mid-run decisions recorded during the turn's run. */
    midRun: RecordedDecision[];
    /** Reminder messages delivered for this turn, whether at its start or as a steer during its run. */
    delivered: RecordedDelivery[];
}

/** A compaction entry seen on the branch, and the report turn that follows it. */
export interface CompactionMark {
    entryId: string;
    turn: number;
}

/** A user message submitted while a run was streaming, delivered into that run as a steer. */
export interface ReplaySteer {
    entryId: string;
    request: string;
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
    /** Mid-run emissions during this turn's run, which the live module steers into that loop. */
    midRun?: ReplayEmission[];
    /** Messages steered into this turn's run; they never reach the scheduler's turn decision. */
    steers?: ReplaySteer[];
    contextTokens: number;
    /** The classifier state `buildReminderState` would send. */
    state: JsonObject;
    /** What the session recorded for this turn; empty when it recorded nothing. */
    recorded: RecordedTurn;
}

export interface ReplayResult {
    cwd: string;
    /** Turns that started a run, matching the scheduler's own count; steered messages are not turns. */
    userTurns: number;
    turns: ReplayTurn[];
    /** Compaction entries on the branch, each with the turn that follows it. */
    compactions: CompactionMark[];
    /** Coverage notes about the recorded data: no debug entries, or messages without details. */
    recordedNotes: string[];
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
 * Whether a user message joined a running turn as a steer instead of starting one.
 *
 * `before_agent_start` fires only for prompts submitted while the agent is idle, so a steered message never
 * reaches the scheduler and never counts as a turn. The branch shows it delivered among the run's tool
 * results: walking back over extension entries, the first message is a tool result or a tool-calling
 * assistant while the run is open, and a fold is a boundary where the next message starts a run.
 */
function isSteeredMessage(entries: readonly SessionEntry[], index: number): boolean {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const entry = entries[cursor];
        if (entry === undefined || entry.type === "compaction" || entry.type === "branch_summary") {
            return false;
        }

        if (entry.type !== "message") {
            continue;
        }

        if (entry.message.role === "toolResult") {
            return true;
        }

        if (entry.message.role === "assistant") {
            return hasToolCall(entry.message.content);
        }

        return false;
    }

    return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Read a recorded decision structurally; an entry without a trigger is unreadable and dropped. */
function readDecision(data: unknown): RecordedDecision | undefined {
    if (!isRecord(data) || typeof data.trigger !== "string") {
        return undefined;
    }

    const decision: RecordedDecision = {
        trigger: data.trigger,
        reminder: typeof data.reminder === "string" ? data.reminder : null,
    };
    if (typeof data.modelChoice === "string") {
        decision.modelChoice = data.modelChoice;
    }
    if (isRecord(data.scores)) {
        decision.scores = Object.fromEntries(
            Object.entries(data.scores).filter(
                (entry): entry is [string, number] => typeof entry[1] === "number",
            ),
        );
    }
    if (isStringArray(data.options)) {
        decision.options = [...data.options];
    }
    if (isStringArray(data.available)) {
        decision.available = [...data.available];
    }
    if (typeof data.contextTokens === "number") {
        decision.contextTokens = data.contextTokens;
    }
    if (isRecord(data.labels)) {
        decision.labels = data.labels as JsonObject;
    }
    if (isRecord(data.consult)) {
        decision.consult = data.consult as JsonObject;
    }
    if (isRecord(data.scheduler)) {
        decision.scheduler = data.scheduler as JsonObject;
    }
    if (isRecord(data.state)) {
        decision.state = data.state as JsonObject;
    }

    return decision;
}

/** Read a delivered reminder message and the id/turn stamp it carries, if any. */
function readDelivery(entry: Extract<SessionEntry, { type: "custom_message" }>): RecordedDelivery {
    const details = isRecord(entry.details) ? entry.details : undefined;
    const id = typeof details?.id === "string" ? details.id : undefined;
    const turn =
        typeof details?.turn === "number" && Number.isFinite(details.turn)
            ? details.turn
            : undefined;

    return {
        ...(id === undefined ? {} : { id }),
        ...(turn === undefined ? {} : { turn }),
        hasDetails: id !== undefined && turn !== undefined,
        text: textOf(entry.content),
    };
}

/**
 * Simulate the session turn by turn, keeping the scheduler's own state so the shown-reminder map and the
 * rotation pointer are what the live module would have had.
 *
 * A compaction entry is the live `session_compact` restart: the scheduler, the shown map, and the context
 * estimate reset there, while signals keep scanning the whole branch, exactly as `getBranch()` serves them
 * live. The branch is still kept so the report can mark the fold and section the turns around it.
 */
export function replay(entries: readonly SessionEntry[], cwd: string): ReplayResult {
    const settings = loadReminderSettings();
    const scheduler = new ReminderScheduler({
        everyTurns: settings.everyTurns,
        thresholdTokens: settings.thresholdTokens,
        maxMidRunPerTurn: settings.midRunMax,
    });
    // The replay starts where the session did: a session start, which arms the memory reminder.
    scheduler.reset(MEMORY_READ_REMINDER);

    const shown = new Map<ReminderId, number>();
    const turns: ReplayTurn[] = [];
    const pendingDeliveries: RecordedDelivery[] = [];
    const compactions: CompactionMark[] = [];
    const recordedNotes: string[] = [];
    let contextTokens = 0;
    let foldEntryId: string | undefined;
    let pendingDecision: RecordedDecision | undefined;
    let currentRecorded: RecordedTurn | undefined;
    let recordedDecisions = 0;
    let unmarkedDeliveries = 0;

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined) {
            continue;
        }

        if (entry.type === "compaction") {
            // The fold is a full reset: the rotation restarts, the compaction reminder is armed, and the
            // context estimate starts over, while the branch scan below keeps its pre-fold facts.
            scheduler.reset(COMPACTION_REMINDER);
            shown.clear();
            contextTokens = 0;
            foldEntryId = String(entry.id);
            continue;
        }

        if (entry.type === "custom") {
            if (entry.customType === REMINDER_DEBUG_ENTRY_TYPE) {
                const decision = readDecision(entry.data);
                if (decision !== undefined) {
                    recordedDecisions += 1;
                    if (decision.trigger === "mid-run") {
                        currentRecorded?.midRun.push(decision);
                    } else {
                        pendingDecision = decision;
                    }
                }
            }
            continue;
        }

        if (entry.type === "custom_message") {
            if (entry.customType === REMINDER_CUSTOM_TYPE) {
                const delivery = readDelivery(entry);
                if (!delivery.hasDetails) {
                    unmarkedDeliveries += 1;
                }

                if (currentRecorded === undefined) {
                    pendingDeliveries.push(delivery);
                } else {
                    currentRecorded.delivered.push(delivery);
                }
            }
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
                    currentTurn: scheduler.snapshot().userTurns,
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
                    const runTurn = turns.at(-1);
                    if (runTurn !== undefined) {
                        runTurn.midRun ??= [];
                        runTurn.midRun.push({
                            afterEntryId: String(entry.id),
                            schedule: midRun.id,
                            reminderText: midRun.text,
                        });
                    }
                }
            }
            continue;
        }

        if (message.role !== "user") {
            continue;
        }

        const request = textOf(message.content);

        // A steered message joins the run it interrupted; only a prompt that started a run is a turn. The
        // branch is the sole evidence without a debug entry, so `pendingDecision` overrides it when present.
        const runTurn = turns.at(-1);
        if (
            runTurn !== undefined &&
            pendingDecision === undefined &&
            isSteeredMessage(entries, index)
        ) {
            runTurn.steers ??= [];
            runTurn.steers.push({ entryId: String(entry.id), request });
            continue;
        }

        const prefix = entries.slice(0, index);
        const turn = turns.length + 1;

        // The module's own counter restarts at a fold; the report keeps numbering turns globally.
        const currentTurn = scheduler.snapshot().userTurns + 1;

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

        const recorded: RecordedTurn = { midRun: [], delivered: [] };
        if (pendingDecision !== undefined) {
            recorded.decision = pendingDecision;
            pendingDecision = undefined;
        }
        recorded.delivered.push(...pendingDeliveries.splice(0));
        currentRecorded = recorded;

        const reminder = scheduler.decide({
            maxContextTokens: contextTokens,
            available: availableRotationIds(signals),
        });
        if (reminder !== undefined && reminder.id !== "memory-read") {
            shown.set(reminder.id, scheduler.snapshot().userTurns);
        }

        if (foldEntryId !== undefined) {
            compactions.push({ entryId: foldEntryId, turn });
            foldEntryId = undefined;
        }

        turns.push({
            turn,
            entryId: String(entry.id),
            request,
            schedule: reminder?.id ?? "none",
            ...(reminder === undefined ? {} : { reminderText: reminder.text }),
            contextTokens,
            state,
            recorded,
        });
    }

    // A fold the branch ends on still belongs in the header, with the turn that would follow it.
    if (foldEntryId !== undefined) {
        compactions.push({ entryId: foldEntryId, turn: turns.length + 1 });
    }

    if (recordedDecisions === 0) {
        recordedNotes.push(
            "no pi-coder-reminder:debug entries: decisions were not recorded (debug off, or the session predates the debug record)",
        );
    }
    if (unmarkedDeliveries > 0) {
        recordedNotes.push(
            `${String(unmarkedDeliveries)} delivered reminder message(s) carry no id/turn details; they predate the stamp`,
        );
    }

    return { cwd, userTurns: turns.length, turns, compactions, recordedNotes };
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

/** One compact field for a recorded decision: its pick, marked `?` when the session recorded none. */
function recordedPick(recorded: RecordedTurn): string {
    if (recorded.decision === undefined) {
        return "?";
    }

    return recorded.decision.reminder ?? "none";
}

function renderCompact(turn: ReplayTurn, options: Options): string {
    const activity = turn.state.session as JsonObject | undefined;
    const tools = activity?.tools;
    const toolText =
        typeof tools === "object" && tools !== null && !Array.isArray(tools)
            ? Object.entries(tools)
                  .map(([name, count]) => `${name}:${String(count)}`)
                  .join(",")
            : "";
    const decision = turn.recorded.decision;
    const delivered = turn.recorded.delivered.flatMap((delivery) => [delivery.id ?? "unmarked"]);

    return [
        `turn ${turn.turn}`,
        `schedule=${turn.schedule}`,
        options.recorded ? `recorded=${recordedPick(turn.recorded)}` : undefined,
        options.recorded && decision?.modelChoice !== undefined
            ? `model=${decision.modelChoice}`
            : undefined,
        options.recorded && delivered.length > 0 ? `delivered=${delivered.join(",")}` : undefined,
        turn.reminderText === undefined
            ? undefined
            : `shows=${JSON.stringify(collapse(turn.reminderText, 64))}`,
        turn.midRun === undefined ? undefined : `midrun=${turn.midRun.length}`,
        turn.steers === undefined ? undefined : `steers=${turn.steers.length}`,
        `phase=${String(activity?.phase ?? "-")}`,
        `tokens=${turn.contextTokens}`,
        toolText === "" ? undefined : `tools=${toolText}`,
        `request=${JSON.stringify(collapse(turn.request, 80))}`,
    ]
        .filter((part): part is string => part !== undefined)
        .join("  ");
}

/** One line summarizing a recorded decision, model answers included. */
function describeDecision(decision: RecordedDecision): string {
    const parts = [`trigger=${decision.trigger}`, `pick=${decision.reminder ?? "none"}`];

    if (decision.modelChoice !== undefined) {
        parts.push(`model=${decision.modelChoice}`);
    }
    if (decision.scores !== undefined) {
        parts.push(`scores=${JSON.stringify(decision.scores)}`);
    }
    if (decision.consult !== undefined) {
        parts.push(`consult=${describeConsult(decision.consult)}`);
    }
    if (decision.options !== undefined) {
        parts.push(`options=[${decision.options.join(",")}]`);
    }
    if (decision.available !== undefined) {
        parts.push(`available=[${decision.available.join(",")}]`);
    }
    if (decision.labels !== undefined) {
        parts.push(`labels=${JSON.stringify(decision.labels)}`);
    }

    return parts.join(" ");
}

function describeConsult(consult: JsonObject): string {
    const status = typeof consult.status === "string" ? consult.status : "unknown";
    const latency = typeof consult.latencyMs === "number" ? `${String(consult.latencyMs)}ms` : "";

    return latency === "" ? status : `${status}/${latency}`;
}

/** The module turn a recorded turn decision belongs to; absent for mid-run decisions and old entries. */
function recordedDecisionTurn(decision: RecordedDecision | undefined): number | undefined {
    if (decision === undefined || decision.trigger === "mid-run") {
        return undefined;
    }

    const turns = decision.scheduler?.userTurns;
    return typeof turns === "number" && Number.isFinite(turns) ? turns + 1 : undefined;
}

/** The module's own turn count for a replayed turn, as carried in the state it would send. */
function moduleTurnOf(state: JsonObject): number | undefined {
    const session = state.session;
    if (!isRecord(session)) {
        return undefined;
    }

    return typeof session.user_turns === "number" ? session.user_turns : undefined;
}

/** The recorded half of a turn: the decision, any delivered message text, and the judged signals. */
function recordedLines(recorded: RecordedTurn, state: JsonObject): string[] {
    const lines: string[] = [];

    if (recorded.decision === undefined) {
        lines.push("recorded decision: none recorded for this turn");
    } else {
        lines.push(`recorded decision: ${describeDecision(recorded.decision)}`);
    }

    const recordedTurn = recordedDecisionTurn(recorded.decision);
    const replayedTurn = moduleTurnOf(state);
    if (recordedTurn !== undefined && replayedTurn !== undefined && recordedTurn !== replayedTurn) {
        lines.push(
            `recorded turn mismatch: the session counted module turn ${String(recordedTurn)}, the replay ${String(replayedTurn)}`,
        );
    }

    for (const decision of recorded.midRun) {
        lines.push(`recorded mid-run: ${describeDecision(decision)}`);
    }

    for (const delivery of recorded.delivered) {
        const id = delivery.id ?? "unmarked";
        const turn = delivery.turn === undefined ? "turn unknown" : `turn ${String(delivery.turn)}`;
        lines.push(`recorded delivered: ${id} (${turn})`);
        lines.push(delivery.text);
    }

    if (recorded.decision?.state !== undefined) {
        lines.push("recorded state (signals the live module judged):");
        lines.push(JSON.stringify(recorded.decision.state, null, 1));
    }

    return lines;
}

function hasRecordedData(recorded: RecordedTurn): boolean {
    return (
        recorded.decision !== undefined ||
        recorded.midRun.length > 0 ||
        recorded.delivered.length > 0
    );
}

export function renderText(
    result: ReplayResult,
    selected: readonly ReplayTurn[],
    options: Options,
): string {
    const lines = [
        `session: cwd=${result.cwd} user-turns=${result.userTurns}`,
        `schedule: deterministic memory-read + rotation, settings from PI_CODER_REMINDER_*`,
        options.recorded
            ? `recorded: showing what the session recorded; the replay is the deterministic simulation`
            : `model: not consulted; a live choice with reminders: true may differ`,
    ];

    if (result.compactions.length > 0) {
        const folds = result.compactions
            .map((mark) => `entry ${mark.entryId} before turn ${String(mark.turn)}`)
            .join(", ");
        lines.push(`compactions: ${folds}`);
    }

    if (options.recorded) {
        lines.push(...result.recordedNotes.map((note) => `recorded warning: ${note}`));
    }

    lines.push("");

    const compactionAt = new Map(
        result.compactions.map((mark) => [mark.turn, mark.entryId] as const),
    );

    for (const turn of selected) {
        const compactionEntryId = compactionAt.get(turn.turn);
        if (compactionEntryId !== undefined && !options.compact) {
            lines.push(
                `----- compaction entry ${compactionEntryId}: rotation restarted, compaction reminder armed -----`,
            );
        }

        lines.push(`===== turn ${turn.turn} (entry ${turn.entryId}) =====`);

        if (options.compact) {
            lines.push(renderCompact(turn, options));
            lines.push("");
            continue;
        }

        if (options.recorded) {
            lines.push(...recordedLines(turn.recorded, turn.state));
            lines.push("");
            lines.push("replay:");
        }

        lines.push(`request: ${JSON.stringify(turn.request.slice(0, 120))}`);
        for (const steer of turn.steers ?? []) {
            lines.push(
                `steer (entry ${steer.entryId}): ${JSON.stringify(collapse(steer.request, 120))}`,
            );
        }
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

        lines.push("");
    }

    return lines.join("\n");
}

export function renderJson(result: ReplayResult, selected: readonly ReplayTurn[]): string {
    return JSON.stringify(
        {
            cwd: result.cwd,
            userTurns: result.userTurns,
            ...(result.compactions.length === 0 ? {} : { compactions: result.compactions }),
            ...(result.recordedNotes.length === 0 ? {} : { recordedNotes: result.recordedNotes }),
            turns: selected.map((turn) => ({
                ...turn,
                // Turns without recorded data keep the shape they had before the mode existed.
                ...(hasRecordedData(turn.recorded) ? {} : { recorded: undefined }),
            })),
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
