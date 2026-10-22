import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    consultReminderSelection,
    decisionConfig,
    reminderEnabled,
    type DecisionModelConfig,
    type ReminderConsult,
    type ReminderSignals,
    type ReminderStateLabels,
} from "../decision";
import {
    ACTIVE_ROTATION_REMINDERS,
    COMPACTION_REMINDER,
    MEMORY_READ_REMINDER,
    REMINDER_NOTICE,
} from "./catalog";
import { ContextGrowthTracker } from "./context-growth";
import { ReminderScheduler, type ReminderModelChoice, type SchedulerSnapshot } from "./scheduler";
import {
    REMINDER_CUSTOM_TYPE,
    REMINDER_DEBUG_ENTRY_TYPE,
    REMINDER_STATE_TYPE,
    availableRotationIds,
    buildReminderSignals,
    reminderLabelsFromEntries,
    reminderResumeState,
} from "./session-signals";
import { loadReminderSettings } from "./settings";
import { todoChoiceFrom, todoQueryFrom, type TodoQuery } from "./todo-query";
import type { ReminderDefinition, ReminderId } from "./types";

export interface ReminderRegistrationOptions {
    /**
     * `full` is a parent session: the session reminder, the rotating catalog, and the model policy when
     * `reminders` is enabled in the decision-model config. `memory` is a delegated child: only the memory
     * reminder, which is what children received before the rotation existed.
     */
    scope?: "full" | "memory";
}

function formatReminder(text: string): string {
    return `<pi_coder_reminder>\n${REMINDER_NOTICE}\n${text}\n</pi_coder_reminder>`;
}

/**
 * The text one emission carries. Only the compaction reminder differs from its catalog entry: the session's
 * own JSONL path is known at emission time and makes its "check the transcript" line actionable.
 */
function reminderTextFor(reminder: ReminderDefinition, ctx: ExtensionContext): string {
    if (reminder.id !== COMPACTION_REMINDER.id) {
        return reminder.text;
    }

    const sessionFile = ctx.sessionManager.getSessionFile?.();
    return sessionFile === undefined
        ? reminder.text
        : `${reminder.text}\nSession JSONL: \`${sessionFile}\`.`;
}

/** Everything the debug entry records about one selection decision, however it was reached. */
interface DecisionEntryInput {
    trigger: "session" | "turn" | "mid-run";
    reminder: ReminderDefinition | undefined;
    scope: "full" | "memory";
    /** The state a model decision was made from; absent for the session reminder and mid-run steers. */
    state?: ReminderSignals;
    available?: ReadonlySet<ReminderId>;
    options?: readonly ReminderDefinition[];
    modelChoice?: ReminderModelChoice;
    scores?: Record<string, number>;
    consult?: ReminderConsult;
    labels?: ReminderStateLabels;
    /** The TODO item the extra query read as the current work, when it moved off the list. */
    todoMove?: { id: string; probability: number };
    /** Every TODO query candidate's returned probability, for calibration. */
    todoScores?: Record<string, number>;
    contextTokens: number;
    scheduler: SchedulerSnapshot;
}

/**
 * The `pi-coder-reminder:debug` entry: the state a selection was made from and what it decided.
 *
 * Recorded whether or not a reminder was chosen - "nothing was shown" is exactly the case the state is
 * needed to explain - and the pre-decision scheduler snapshot is kept so the threshold and rotation the
 * decision saw are recoverable rather than inferred.
 */
function decisionEntry(input: DecisionEntryInput): Record<string, unknown> {
    const options = input.options ?? [];

    return {
        trigger: input.trigger,
        reminder: input.reminder?.id ?? null,
        scope: input.scope,
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.available === undefined ? {} : { available: [...input.available] }),
        ...(options.length === 0 ? {} : { options: options.map((option) => option.id) }),
        ...(input.modelChoice === undefined ? {} : { modelChoice: input.modelChoice }),
        ...(input.scores === undefined ? {} : { scores: input.scores }),
        ...(input.consult === undefined
            ? {}
            : {
                  consult: {
                      status: input.consult.status,
                      latencyMs: input.consult.latencyMs,
                      ...(input.consult.usage === undefined ? {} : { usage: input.consult.usage }),
                  },
              }),
        ...(input.labels === undefined ? {} : { labels: { ...input.labels } }),
        ...(input.todoMove === undefined ? {} : { todoMove: { ...input.todoMove } }),
        ...(input.todoScores === undefined ? {} : { todoScores: { ...input.todoScores } }),
        contextTokens: input.contextTokens,
        scheduler: input.scheduler,
    };
}

/** Map the decision model's answer onto the scheduler's vocabulary; `undefined` leaves the fallback in charge. */
export function modelChoiceOf(consult: ReminderConsult): ReminderModelChoice | undefined {
    const decision = consult.decision;
    if (decision === undefined) {
        return undefined;
    }

    if (decision.kind === "none") {
        return "none";
    }

    return ACTIVE_ROTATION_REMINDERS.find((reminder) => reminder.id === decision.id)?.id;
}

/** Consult the decision model once its config has opted into `reminders`; never throws. */
async function consultModelFor(
    ctx: ExtensionContext,
    config: DecisionModelConfig,
    request: string,
    signals: ReminderSignals,
    options: readonly ReminderDefinition[],
    todoQuery?: TodoQuery,
): Promise<ReminderConsult> {
    return consultReminderSelection({
        ctx,
        config,
        options,
        request,
        signals,
        ...(todoQuery === undefined ? {} : { extraQuestions: todoQuery.questions }),
    });
}

function sameLabels(left: ReminderStateLabels, right: ReminderStateLabels): boolean {
    return (
        left.phase === right.phase &&
        left.finishing === right.finishing &&
        left.unvalidated === right.unvalidated
    );
}

/**
 * Emit pi-coder reminders as hidden context: at most one at the start of a user turn, plus threshold-driven
 * mid-run steers.
 *
 * The memory reminder is tied to the memory list changing at a session start; a tree navigation only
 * resumes the schedule, and a compaction arms its own reminder for the fold. The rest rotate on a turn
 * cadence or a context-growth threshold. The two delivery paths are deliberately
 * separate from the one-per-turn rule: a long autonomous run may receive a mid-run steer, but only while the
 * streaming assistant message has called a tool, so a reminder never follows a run that is about to end.
 *
 * The activity gate narrows the rotation: `memory-hygiene` is unavailable until mutating work happened, and
 * a model pick the gate disallows is dropped rather than replaced. When the decision model is configured
 * with `reminders: true`, it answers first: a chosen reminder or a deliberate `none` decides the turn, and
 * an unavailable or unreadable answer leaves the deterministic schedule in charge.
 */
export default function registerRemindersExtension(
    pi: ExtensionAPI,
    options: ReminderRegistrationOptions = {},
): void {
    const scope = options.scope ?? "full";
    const settings = loadReminderSettings();
    const rotationEnabled = settings.everyTurns > 0 || settings.thresholdTokens > 0;
    const scheduler = new ReminderScheduler(
        scope === "full"
            ? {
                  everyTurns: settings.everyTurns,
                  thresholdTokens: settings.thresholdTokens,
                  maxMidRunPerTurn: settings.midRunMax,
              }
            : { everyTurns: 0, thresholdTokens: 0, maxMidRunPerTurn: 0 },
    );
    const growth = new ContextGrowthTracker();
    /** When each rotation reminder was shown, keyed by the user turn it was emitted on. */
    const shown = new Map<ReminderId, number>();
    /** The model-maintained labels, re-read from the branch at every change point. */
    let labels: ReminderStateLabels = {};

    /**
     * Whether the assistant message being streamed has produced a tool call yet.
     *
     * A steer is delivered after the current assistant turn and its tool calls; a message with no tool call
     * may be the run's last, so queuing a reminder there would leave it as a stray message after the final
     * answer. Reset at each assistant `message_start`.
     */
    let currentMessageHasToolCalls = false;
    /** The activity gate for the message being streamed, computed lazily once per assistant message. */
    let midRunAvailable: ReadonlySet<ReminderId> | undefined;
    /** The signals the mid-run gate was computed from, kept for the debug entry. */
    let midRunSignals: ReminderSignals | undefined;
    let midRunAvailableReady = false;

    const rotationSignals = (ctx: ExtensionContext, currentTurn: number): ReminderSignals =>
        buildReminderSignals({
            entries: ctx.sessionManager.getBranch(),
            cwd: ctx.cwd ?? process.cwd(),
            currentTurn,
            contextTokens: growth.maxTokens,
            shown,
            labels,
        });

    /**
     * A restart point: session start, tree navigation, or compaction.
     *
     * `resume` reads the history back off the branch, so a reload, resume, fork, or tree move continues the
     * rotation and the shown history instead of treating the branch as new. A session start arms the memory
     * reminder because the appendix is rebuilt for a new session; a tree move only seeds, since landing on an
     * existing branch mid-conversation is not a starting point and "before starting work" would mislead.
     * Compaction deliberately resets: the fold is a context reset, so the rotation starts over and the fold's
     * own reminder is armed in place of the memory one. The labels are branch-derived either way.
     */
    const restart = (
        ctx: ExtensionContext,
        options: { resume?: boolean; armed?: ReminderDefinition } = {},
    ) => {
        growth.reset();
        const branch = ctx.sessionManager.getBranch();
        labels = reminderLabelsFromEntries(branch);

        const state = options.resume === true ? reminderResumeState(branch) : undefined;
        if (state === undefined) {
            scheduler.reset(options.armed);
            shown.clear();
            return;
        }

        scheduler.seed(state, options.armed);
        shown.clear();
        for (const [id, turn] of state.shown) {
            shown.set(id, turn);
        }
    };

    pi.on("session_start", (_event, ctx) =>
        restart(ctx, { resume: true, armed: MEMORY_READ_REMINDER }),
    );
    pi.on("session_tree", (_event, ctx) => restart(ctx, { resume: true }));
    pi.on("session_compact", (_event, ctx) => restart(ctx, { armed: COMPACTION_REMINDER }));
    pi.on("agent_start", () => {
        growth.reset();
    });

    const midRunEnabled =
        scope === "full" &&
        settings.enabled &&
        settings.thresholdTokens > 0 &&
        settings.midRunMax > 0;

    /**
     * Deliver a reminder inside the running agent loop rather than at the next user turn.
     *
     * `steer` queues the message for the point after the current assistant turn, before the run's next
     * inference, so a long autonomous stretch sees the nudge without waiting for the user to speak again.
     * Only a message that has already produced a tool call can steer: a tool call means the run continues
     * to another inference, so the reminder is never left over after a final text-only answer. Only the
     * context threshold applies here (the turn cadence counts user turns and the model policy is consulted
     * at `before_agent_start`).
     */
    const maybeEmitMidRun = (ctx: ExtensionContext): void => {
        if (!midRunEnabled || !currentMessageHasToolCalls) {
            return;
        }

        if (!scheduler.midRunDue(growth.maxTokens)) {
            return;
        }

        if (!midRunAvailableReady) {
            midRunSignals = rotationSignals(ctx, scheduler.snapshot().userTurns);
            midRunAvailable = availableRotationIds(midRunSignals);
            midRunAvailableReady = true;
        }

        const before = scheduler.snapshot();
        const reminder = scheduler.decideMidRun({
            maxContextTokens: growth.maxTokens,
            available: midRunAvailable,
        });
        if (reminder === undefined) {
            return;
        }

        const turn = scheduler.snapshot().userTurns;
        shown.set(reminder.id, turn);

        if (settings.debug) {
            pi.appendEntry(
                REMINDER_DEBUG_ENTRY_TYPE,
                decisionEntry({
                    trigger: "mid-run",
                    reminder,
                    scope,
                    state: midRunSignals,
                    available: midRunAvailable,
                    contextTokens: growth.maxTokens,
                    scheduler: before,
                }),
            );
        }

        pi.sendMessage(
            {
                customType: REMINDER_CUSTOM_TYPE,
                content: formatReminder(reminder.text),
                display: false,
                // The entry records what was shown and when, so a restart on this branch can resume.
                details: { id: reminder.id, turn },
            },
            { deliverAs: "steer" },
        );
    };

    pi.on("message_start", (event, ctx) => {
        if (event.message.role !== "assistant") {
            return;
        }

        growth.startAssistantMessage(ctx.getContextUsage()?.tokens ?? 0);
        currentMessageHasToolCalls = false;
        midRunAvailable = undefined;
        midRunSignals = undefined;
        midRunAvailableReady = false;
    });

    pi.on("message_update", (event, ctx) => {
        if (event.message.role !== "assistant") {
            return;
        }

        const streamed = event.assistantMessageEvent;
        if (streamed.type === "text_delta" || streamed.type === "thinking_delta") {
            growth.addStreamedChars(streamed.delta.length);
        }

        if (
            streamed.type === "toolcall_start" ||
            streamed.type === "toolcall_delta" ||
            streamed.type === "toolcall_end"
        ) {
            currentMessageHasToolCalls = true;
        }

        maybeEmitMidRun(ctx);
    });

    pi.on("before_agent_start", async (event, ctx) => {
        if (!settings.enabled) {
            return;
        }

        // The session reminder is already decided, and a rotation with both triggers at zero is off, so
        // neither turn is worth a classifier request or a branch scan.
        const snapshot = scheduler.snapshot();
        const rotationTurn = scope === "full" && rotationEnabled && !snapshot.sessionArmed;
        let modelChoice: ReminderModelChoice | undefined;
        let available: ReadonlySet<ReminderId> | undefined;
        let scores: Record<string, number> | undefined;
        let signals: ReminderSignals | undefined;
        let options: ReminderDefinition[] = [];
        let consult: ReminderConsult | undefined;
        let todoMove: { id: string; probability: number } | undefined;
        let todoScores: Record<string, number> | undefined;
        if (rotationTurn) {
            signals = rotationSignals(ctx, snapshot.userTurns + 1);
            available = availableRotationIds(signals);

            // The gate decides what may be offered, so the model is asked only about ids that can actually
            // be shown; a gated id cannot be chosen and then vetoed.
            options = ACTIVE_ROTATION_REMINDERS.filter((reminder) => available?.has(reminder.id));

            const config = decisionConfig.load(ctx.cwd ?? process.cwd());
            if (reminderEnabled(config)) {
                // The TODO query asks about the items the list has not marked in progress; the item list
                // lives in the question criteria only, so the decision state keeps its summary shape.
                const todoQuery = todoQueryFrom(ctx.sessionManager.getBranch());

                consult = await consultModelFor(
                    ctx,
                    config,
                    event.prompt,
                    signals,
                    options,
                    todoQuery,
                );
                modelChoice = modelChoiceOf(consult);
                scores = consult.scores;

                const todo = todoChoiceFrom(todoQuery, consult.extras, modelChoice);
                modelChoice = todo.choice;
                todoMove = todo.move;
                todoScores = todo.scores;

                // The labels build state along the way: they ride on the same request and are sent back in
                // the next turn's state. Only a real change is recorded, so the session does not grow an
                // entry per turn while the phase is stable.
                if (consult.state !== undefined) {
                    const updated = { ...labels, ...consult.state };
                    if (!sameLabels(updated, labels)) {
                        labels = updated;
                        pi.appendEntry(REMINDER_STATE_TYPE, labels);
                    }
                }
            }
        }

        const reminder = scheduler.decide({
            maxContextTokens: growth.maxTokens,
            modelChoice,
            available,
        });

        /** The turn the reminder is emitted on, stamped on the message so a later restart can resume. */
        const emitTurn = scheduler.snapshot().userTurns;
        if (reminder !== undefined && !snapshot.sessionArmed) {
            shown.set(reminder.id, emitTurn);
        }

        // Record the decision whether or not a reminder was chosen: "nothing was shown" is exactly the case
        // the state is needed to explain, and the session reminder is recorded too so turn one is no gap.
        if (settings.debug && (rotationTurn || reminder !== undefined)) {
            pi.appendEntry(
                REMINDER_DEBUG_ENTRY_TYPE,
                decisionEntry({
                    trigger: rotationTurn ? "turn" : "session",
                    reminder,
                    scope,
                    state: signals,
                    available,
                    options,
                    modelChoice,
                    scores,
                    consult,
                    labels,
                    ...(todoMove === undefined ? {} : { todoMove }),
                    ...(todoScores === undefined ? {} : { todoScores }),
                    contextTokens: growth.maxTokens,
                    scheduler: snapshot,
                }),
            );
        }

        if (reminder === undefined) {
            return;
        }

        return {
            message: {
                customType: REMINDER_CUSTOM_TYPE,
                content: formatReminder(reminderTextFor(reminder, ctx)),
                display: false,
                details: { id: reminder.id, turn: emitTurn },
            },
        };
    });
}
