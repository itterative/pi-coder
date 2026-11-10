import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    consultReminderSelection,
    consultReminderState,
    decisionConfig,
    reminderEnabled,
    PHASE_MOVE_CONFIDENCE,
    TRANSCRIPT_WINDOW_CHARS,
    type DecisionModelConfig,
    type ReminderConsult,
    type ReminderPhase,
    type ReminderSignals,
    type ReminderStateConsult,
    type ReminderStateLabels,
    type SessionWindow,
} from "../decision";
import { emitDecisionState } from "../decision/events";
import { SerialQueue } from "../../common/async";
import {
    ACTIVE_ROTATION_REMINDERS,
    COMPACTION_REMINDER,
    MEMORY_AUDIT_REMINDER,
    MEMORY_READ_REMINDER,
    REMINDER_NOTICE,
} from "./catalog";
import { ContextGrowthTracker } from "./context-growth";
import { ContextUsageReminders, foldContextNote, type FoldContextNote } from "./context-usage";
import { createMemoryAuditTrigger } from "./memory-audit";
import { ReminderScheduler, type ReminderModelChoice, type SchedulerSnapshot } from "./scheduler";
import {
    REMINDER_CUSTOM_TYPE,
    REMINDER_DEBUG_ENTRY_TYPE,
    REMINDER_STATE_TYPE,
    availableRotationIds,
    buildReminderSignals,
    reminderLabelsFromEntries,
    reminderResumeState,
    reminderSessionLabels,
    reminderStateMarker,
} from "./session-signals";
import { loadReminderSettings } from "./settings";
import { todoChoiceFrom, todoQueryFrom, type TodoQuery } from "./todo-query";
import type { ReminderDefinition, ReminderId } from "./types";

export interface ReminderRegistrationOptions {
    /**
     * `full` is a parent session: the session reminder, the rotating catalog, and the model policy when
     * `reminders` is enabled in the decision-model config. `memory` is a delegated child: the session reminder
     * and the automatic memory audit's findings, but nothing from the rotation - which is what children received
     * before the rotation existed.
     */
    scope?: "full" | "memory";
}

export interface ReminderExtensionHandle {
    /**
     * Resolves when every queued judgement has settled.
     *
     * The rotation judgement is deferred, so pi's own await points do not cover it: a caller that needs the
     * settled state - the mid-run gate, a test driving the hooks - waits here rather than on any hook.
     */
    idle(): Promise<void>;
}

function formatReminder(text: string): string {
    return `<pi_coder_reminder>\n${REMINDER_NOTICE}\n${text}\n</pi_coder_reminder>`;
}

/**
 * The text one emission carries. Only the compaction reminder differs from its catalog entry: the session's
 * own JSONL path is known at emission time and makes its "check the transcript" line actionable, and the
 * measured (or estimated) post-fold context is what counters the stale number the model is still assuming.
 */
function reminderTextFor(
    reminder: ReminderDefinition,
    ctx: ExtensionContext,
    foldNote?: FoldContextNote,
): string {
    if (reminder.id !== COMPACTION_REMINDER.id) {
        return reminder.text;
    }

    const parts = [reminder.text];
    if (foldNote !== undefined) {
        parts.push(foldNote.text);
    }

    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (sessionFile !== undefined) {
        parts.push(`Session JSONL: \`${sessionFile}\`.`);
    }

    return parts.join("\n\n");
}

/** Everything the debug entry records about one selection decision, however it was reached. */
interface DecisionEntryInput {
    trigger: "session" | "turn" | "checkpoint" | "mid-run";
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
    /** The raw confidence of the tier-1 state answer, so a held phase can be told from a confident one. */
    stateConfidence?: number;
    /** The phase tier 1 answered, before the accept rule moved or held it; absent when it named none. */
    statePhase?: ReminderPhase;
    /** Tier 1's own latency, so the cheap half of the cascade stays measurable. */
    stateLatencyMs?: number;
    /** Whether the selection consult re-asked the state on the window transcript: the cascade's escalation. */
    escalated?: boolean;
    /**
     * Whether the decision was reached after the turn's user message was already sent.
     *
     * The rotation judgement is deferred, so its entry lands inside the run it belongs to rather than before the
     * prompt: the report attributes a deferred turn by its own `scheduler.userTurns`, not the next turn's.
     */
    deferred?: boolean;
    /**
     * The turn was not decided: the schedule was not due, or the model's own floor blocked its emission.
     *
     * Recorded because the absence is otherwise indistinguishable from a decline, and this is the field that
     * explained a live run where the same reminder came back on three consecutive turns.
     */
    skipped?: boolean;
    /** The window the consult was judged by, carried back on the consult rather than rebuilt here. */
    window?: SessionWindow;
    /**
     * The state transcript, exactly as the state ask sent it, when the state was judged (a checkpoint, or a turn
     * whose short answer escalated).
     *
     * The state ask sends one rendered conversation rather than the pool's window, so this is the only record of
     * what it was judged by; the transcript's own fit is not reproducible from the branch afterwards.
     */
    stateTranscript?: string;
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
 * decision saw are recoverable rather than inferred. The window a consult judged is kept beside the signals:
 * the branch read that produces it happens once, so nothing else can recover which window was sent - and the
 * state ask's own transcript is kept for the same reason, since it is a fit of that same read.
 */
function decisionEntry(input: DecisionEntryInput): Record<string, unknown> {
    const options = input.options ?? [];

    return {
        trigger: input.trigger,
        reminder: input.reminder?.id ?? null,
        scope: input.scope,
        ...(input.skipped === true ? { skipped: true } : {}),
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
        ...(input.stateConfidence === undefined ? {} : { stateConfidence: input.stateConfidence }),
        ...(input.statePhase === undefined ? {} : { statePhase: input.statePhase }),
        ...(input.stateLatencyMs === undefined ? {} : { stateLatencyMs: input.stateLatencyMs }),
        ...(input.escalated === undefined ? {} : { escalated: input.escalated }),
        ...(input.deferred === undefined ? {} : { deferred: input.deferred }),
        ...(input.stateTranscript === undefined ? {} : { stateTranscript: input.stateTranscript }),
        ...(input.window === undefined
            ? {}
            : {
                  window: {
                      items: input.window.items.map((item) => ({ ...item })),
                      omitted: input.window.omitted,
                  },
              }),
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
async function consultModelFor(options: {
    ctx: ExtensionContext;
    config: DecisionModelConfig;
    /**
     * The live prompt, when the branch does not carry it yet. A mid-run consult omits it: inside a run the
     * branch's last user message is the turn's request, so the state needs no extra item.
     */
    request?: string;
    signals: ReminderSignals;
    reminders: readonly ReminderDefinition[];
    /** The bus to count the consult on, so the footer badge animates while it runs. */
    events?: EventBus;
    /** The phase already accepted, which the accept rule holds unless the answer moves it confidently. */
    heldPhase?: ReminderPhase;
    todoQuery?: TodoQuery;
}): Promise<ReminderConsult> {
    return consultReminderSelection({
        ctx: options.ctx,
        config: options.config,
        options: options.reminders,
        ...(options.request === undefined ? {} : { request: options.request }),
        signals: options.signals,
        ...(options.events === undefined ? {} : { events: options.events }),
        ...(options.heldPhase === undefined ? {} : { heldPhase: options.heldPhase }),
        ...(options.todoQuery === undefined ? {} : { extraQuestions: options.todoQuery.questions }),
        stateMarker: reminderStateMarker,
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
 * cadence or a context-growth threshold. The two delivery paths share one rotation slot per user turn: a
 * deferred turn decision yields to a mid-run point that took the slot first, and a mid-run point yields to a
 * rotation reminder the turn already decided. Only a step that ran a tool can steer - a steer polled after a
 * text-only turn is itself the reason a new turn happens - so the deferred path holds its payload for such a
 * step. The armed reminders are change points outside that slot and may share a turn with a mid-run steer.
 *
 * The activity gate narrows the rotation: `memory-hygiene` is unavailable until mutating work happened, and
 * a model pick the gate disallows is dropped rather than replaced. When the decision model is configured
 * with `reminders: true`, it answers first - on a user turn and on a mid-run threshold crossing alike - and
 * a chosen reminder or a deliberate `none` decides that point, while an unavailable or unreadable answer
 * leaves the deterministic schedule in charge.
 *
 * The rotation judgement is deferred. Its consult is a model call, and pi builds the user message only after
 * `before_agent_start` handlers resolve, so waiting there withholds the user's own message until the model has
 * answered; instead the boundary advances the turn and queues the judgement, and the reminder it picks is held
 * until a step that ran a tool (so the run has already committed to another inference), steered into that run,
 * or carried by the next user message when the run settles first. The armed reminders are unaffected because
 * they never consult: the memory and compaction reminders are decided at the boundary and still ride the
 * message they belong to.
 */
export default function registerRemindersExtension(
    pi: ExtensionAPI,
    options: ReminderRegistrationOptions = {},
): ReminderExtensionHandle {
    const scope = options.scope ?? "full";
    const settings = loadReminderSettings();
    const rotationEnabled = settings.everyTurns > 0 || settings.thresholdTokens > 0;
    const scheduler = new ReminderScheduler(
        scope === "full"
            ? {
                  everyTurns: settings.everyTurns,
                  thresholdTokens: settings.thresholdTokens,
                  maxMidRunPerTurn: settings.midRunMax,
                  modelEveryTurns: settings.modelTurns,
              }
            : { everyTurns: 0, thresholdTokens: 0, maxMidRunPerTurn: 0, modelEveryTurns: 0 },
    );
    const growth = new ContextGrowthTracker();
    /**
     * The measured context reminders: the 50%/75% thresholds and the post-fold fallback.
     *
     * All of them are change points outside the rotation. They carry a fact, not advice, so the selection model
     * is not asked to weigh them - the reader whose assumption is wrong is the one that would answer. The switch
     * is separate from `enabled` so the numbers can be turned off without losing the rest of the module.
     */
    const context = new ContextUsageReminders();
    const contextEnabled = settings.enabled && settings.context;
    /**
     * The automatic memory audit, run at a step boundary whenever a memory file changed.
     *
     * Registered for both scopes: a delegated child writes memories too, and a memory that fails to parse is
     * just as invisible from its prompt as from the parent's. `pendingSteers` is per registration, so the two
     * scopes never contend for a queue.
     */
    const memoryAudit = createMemoryAuditTrigger({
        enabled: settings.enabled && settings.memoryAudit,
    });
    /** When each rotation reminder was shown, keyed by the user turn it was emitted on. */
    const shown = new Map<ReminderId, number>();
    /** The model-maintained labels, re-read from the branch at every change point. */
    let labels: ReminderStateLabels = {};

    /**
     * The serialized judgement queue.
     *
     * The turn judgement, the checkpoint judgement, and the next turn's judgement all consult the model and all
     * write the same labels, so they run one at a time in the order they were requested instead of racing: a
     * checkpoint never lands before the turn judgement that preceded it, and anything waiting on the queue reads
     * a settled state.
     */
    const judgements = new SerialQueue();

    /** Wait for the judgements requested so far, which is how a reader of the state settles it. */
    const idle = (): Promise<void> => judgements.idle();

    /**
     * The change-point counter that in-flight judgements check before they write.
     *
     * A consult outlives the event that started it, so a reload, tree move, or fold can land while one is in the
     * air; a task stamped with an older epoch drops its answer instead of recording it into a session it no
     * longer belongs to.
     */
    let epoch = 0;

    /** Whether an agent run is in flight, which is what decides how a deferred reminder is delivered. */
    let runActive = false;

    /**
     * A reminder waiting for a delivery point.
     *
     * `text` is the reminder body without the wrapper, because held reminders are combined into one message and
     * the wrapper's "automated" notice must appear once in it. The stamp is the threshold baseline the emission
     * leaves in force, not the context at emission: a change-point reminder that rendered before the run's usage
     * updated nothing (the branch seed or the run's first usage is still the anchor), while a rotation pick or a
     * mid-run steer has just set it to its own context. Recording the baseline is what lets a later resume
     * continue the cooldown consistently.
     */
    interface HeldReminder {
        id: ReminderId;
        text: string;
        turn: number;
        contextTokens: number;
    }

    /** Hold one reminder for the next delivery point. */
    const heldReminder = (
        ctx: ExtensionContext,
        reminder: ReminderDefinition,
        turn: number,
    ): HeldReminder => {
        const foldNote =
            contextEnabled && reminder.id === COMPACTION_REMINDER.id
                ? foldContextNote(ctx, pi)
                : undefined;
        if (foldNote !== undefined && !foldNote.stated) {
            // The fold reminder could not state a number, so the first measured reading will carry it instead.
            context.awaitAfterFold();
        }

        return {
            id: reminder.id,
            text: reminderTextFor(reminder, ctx, foldNote),
            turn,
            contextTokens: scheduler.snapshot().thresholdBaseline ?? 0,
        };
    };

    /**
     * The message a delivery point sends, for one held reminder or several.
     *
     * Everything a delivery point holds travels as **one** message. pi delivers a queued steer before the next
     * inference, but two sends at one boundary cost a delivery each: the second arrived on the next user prompt,
     * which put a memory audit finding a whole turn late. Combining also keeps the wrapper and its "automated"
     * notice to a single occurrence, which is what the notice is for. Held entries are deduped by id, newest
     * wins: a reminder re-decided while held supersedes the copy already waiting.
     */
    const heldMessage = (held: readonly HeldReminder[]) => {
        const unique = [...new Map(held.map((entry) => [entry.id, entry])).values()];
        const newest = unique[unique.length - 1]!;

        return {
            customType: REMINDER_CUSTOM_TYPE,
            content: formatReminder(unique.map((entry) => entry.text).join("\n\n")),
            display: false,
            details: {
                id: newest.id,
                // The resume path needs every rotation id a combined message carried, not just the newest.
                ...(unique.length > 1 ? { ids: unique.map((entry) => entry.id) } : {}),
                turn: Math.max(...unique.map((entry) => entry.turn)),
                contextTokens: newest.contextTokens,
            },
        };
    };

    const sendHeld = (held: readonly HeldReminder[], deliverAs: "steer" | "nextTurn"): void => {
        if (held.length === 0) {
            return;
        }

        pi.sendMessage(heldMessage(held), { deliverAs });
    };

    /**
     * A rotation reminder the turn judged but has not delivered yet.
     *
     * A deferred judgement resolves before pi knows whether the run continues. `steer` queues the message for
     * the next inference and pi polls that queue after *every* turn, including one with no tool call - where the
     * steer is then the only reason another inference happens at all, so the reminder would land after the
     * run's final answer and wake a turn of its own. Holding it until a step that ran a tool proves the run is
     * going to ask again; a run that settles first hands it to the next prompt instead.
     */
    const pendingSteers: HeldReminder[] = [];

    /**
     * The user turn whose rotation reminder was already decided.
     *
     * The deferred turn and the mid-run gate are one slot per user turn: the deferred decide already yields
     * when a mid-run point took the slot, and this is the other direction, so a step later in the same turn
     * does not show a second rotation reminder. Armed reminders do not set it - they belong to the catalog's
     * change points, not to the rotation.
     */
    let rotationReminderTurn: number | undefined;

    /** Deliver the reminders held for a continuing run at the step boundary that proved it continues. */
    const flushPendingSteers = (): void => {
        sendHeld(pendingSteers.splice(0), "steer");
    };

    /** The activity gate for the step being judged, computed lazily once per assistant message. */
    let midRunAvailable: ReadonlySet<ReminderId> | undefined;
    /** The signals the mid-run gate was computed from, kept for the debug entry and the selection consult. */
    let midRunSignals: ReminderSignals | undefined;
    let midRunAvailableReady = false;
    /**
     * Whether a mid-run decision is already asking the model.
     *
     * `turn_end` is awaited by pi and a step is one boundary, so this only guards against a re-entrant dispatch;
     * it is not the cadence.
     */
    let midRunInFlight = false;

    /**
     * The tier-1 stream the cascade's escalations can be read from.
     *
     * The state is judged on the short transcript; when its phase answer came back unsure - or did not come
     * back at all - the reported state may be the held one rather than what the short transcript suggested, so
     * the same question is asked again on the window transcript.
     */
    const comesBackUnsure = (state: ReminderStateConsult | undefined): boolean =>
        state !== undefined &&
        (state.phaseConfidence === undefined || state.phaseConfidence < PHASE_MOVE_CONFIDENCE);

    /**
     * One rotation turn, as the cascade: tier 1 judges the state, the state scopes the pool, tier 2 asks the
     * pool's questions.
     *
     * The order is the point. The pool is the judged state's (`availableRotationIds`), so it cannot be built
     * before the state is answered; the state ask is the cheap half, so it is asked on the short transcript and
     * re-asked on the window transcript only when that answer was unsure. The two asks are separate requests
     * with separate states - the state ask never carries the pool's signals, and the pool ask never carries the
     * transcript - because each shape is the one it was measured with. Everything the caller records or feeds
     * the scheduler comes back in one object, because the alternative is a dozen locals mutated across four
     * nested blocks.
     */
    const judgeTurn = async (
        ctx: ExtensionContext,
        request: string,
        currentTurn: number,
        /** The epoch the boundary stamped: a judgement whose session was replaced writes nothing. */
        at: number,
    ): Promise<{
        signals: ReminderSignals;
        available: ReadonlySet<ReminderId>;
        options: ReminderDefinition[];
        modelChoice: ReminderModelChoice | undefined;
        scores: Record<string, number> | undefined;
        consult: ReminderConsult | undefined;
        escalated: boolean;
        stateConfidence: number | undefined;
        statePhase: ReminderPhase | undefined;
        stateLatencyMs: number | undefined;
        /** The accepted state's transcript, so the debug entry records what was judged rather than a re-fit. */
        stateTranscript: string | undefined;
        todoMove: { id: string; probability: number } | undefined;
        todoScores: Record<string, number> | undefined;
        /**
         * The turn was not judged, because the schedule is not due or the model's own floor blocks it.
         *
         * The caller must then call no `decide`: the model being in charge means an absent answer is not a
         * fallback to the deterministic rotation.
         */
        skipped: boolean;
    }> => {
        const config = decisionConfig.load(ctx.cwd ?? process.cwd());
        const consulting = reminderEnabled(config);
        let signals = rotationSignals(ctx, currentTurn);
        let state = labels;
        const askState = (windowChars?: number): Promise<ReminderStateConsult> =>
            consultReminderState({
                ctx,
                config,
                request,
                ...(windowChars === undefined ? {} : { windowChars }),
                ...(labels.phase === undefined ? {} : { heldPhase: labels.phase }),
                ...(pi.events === undefined ? {} : { events: pi.events }),
                stateMarker: reminderStateMarker,
            });

        let short: ReminderStateConsult | undefined;
        let escalated: ReminderStateConsult | undefined;

        if (consulting) {
            short = await askState();
            escalated = comesBackUnsure(short)
                ? await askState(TRANSCRIPT_WINDOW_CHARS)
                : undefined;
            // The accepted state is the state of this turn: the pool below is scoped by it, and the state the
            // selection consult sends carries it, so the turn reports the judged state rather than what the
            // activity alone would have said.
            state = { ...labels, ...(answeredState(escalated) ?? answeredState(short) ?? {}) };
            signals = rotationSignals(ctx, currentTurn, state);
        }

        const available = availableRotationIds(signals);

        // The gate decides what may be offered, so the model is asked only about ids that can actually be
        // shown; a gated id cannot be chosen and then vetoed.
        const options = ACTIVE_ROTATION_REMINDERS.filter((reminder) => available.has(reminder.id));

        if (!consulting) {
            return {
                signals,
                available,
                options,
                modelChoice: undefined,
                scores: undefined,
                consult: undefined,
                escalated: false,
                stateConfidence: undefined,
                statePhase: undefined,
                stateLatencyMs: undefined,
                stateTranscript: undefined,
                todoMove: undefined,
                todoScores: undefined,
                skipped: false,
            };
        }

        // The schedule gates the judgement, and the model's floor gates the emissions it would produce. Both
        // are checked before the consult: an answer that cannot be emitted is the expensive half of the turn,
        // and a non-due turn has nothing to show either way. The state is still recorded - it is what the badge
        // and the mid-run pool read.
        if (!scheduler.turnDue(growth.maxTokens) || !scheduler.modelTurnDue()) {
            if (at === epoch) {
                rememberState(answeredState(escalated) ?? answeredState(short));
            }

            return {
                signals,
                available,
                options,
                modelChoice: undefined,
                scores: undefined,
                consult: undefined,
                escalated: escalated !== undefined,
                stateConfidence: short?.phaseConfidence,
                statePhase: short?.answeredPhase,
                stateLatencyMs: short?.latencyMs,
                stateTranscript: (escalated ?? short)?.transcript,
                todoMove: undefined,
                todoScores: undefined,
                skipped: true,
            };
        }

        const todoQuery = todoQueryFrom(ctx.sessionManager.getBranch());
        const consult = await consultModelFor({
            ctx,
            config,
            request,
            signals,
            reminders: options,
            ...(pi.events === undefined ? {} : { events: pi.events }),
            heldPhase: state.phase,
            todoQuery,
        });
        const modelChoice = modelChoiceOf(consult);
        const todo = todoChoiceFrom(todoQuery, consult.extras, modelChoice);

        // A consult outlives the event that started it, so the record waits for the epoch: a reload or fold
        // mid-consult must not inherit the answer. The escalated answer is recorded already - it was accepted
        // above - so this only re-records the tier-1 answer when nothing escalated.
        if (at === epoch) {
            rememberState(answeredState(escalated) ?? answeredState(short));
        }

        return {
            signals,
            available,
            options,
            modelChoice: todo.choice,
            scores: consult.scores,
            consult,
            escalated: escalated !== undefined,
            stateConfidence: short?.phaseConfidence,
            statePhase: short?.answeredPhase,
            stateLatencyMs: short?.latencyMs,
            stateTranscript: (escalated ?? short)?.transcript,
            todoMove: todo.move,
            todoScores: todo.scores,
            skipped: false,
        };
    };

    /**
     * Merge one turn's accepted state into the module's labels, recording it only when it changed.
     *
     * The entry is what `restart()` re-reads, so an unchanged answer writes nothing and a session does not grow
     * an entry per turn.
     */
    const rememberState = (answered: ReminderStateLabels | undefined): void => {
        if (answered === undefined || Object.keys(answered).length === 0) {
            return;
        }

        const updated = { ...labels, ...answered };
        if (sameLabels(updated, labels)) {
            return;
        }

        labels = updated;
        pi.appendEntry(REMINDER_STATE_TYPE, labels);
    };

    /**
     * The state a consult answered, or `undefined` when nothing readable came back.
     *
     * A failed or disabled ask answers an empty state rather than an absent one, so an escalation that
     * produced nothing has to leave the answer behind it standing instead of erasing it.
     */
    const answeredState = (
        consult: ReminderStateConsult | undefined,
    ): ReminderStateLabels | undefined =>
        consult !== undefined && Object.keys(consult.state).length > 0 ? consult.state : undefined;

    /**
     * Re-judge the state after one assistant response.
     *
     * pi's `turn_end` is one response plus the tools it called, not a user turn, so this is the probe's
     * checkpoint cadence: the state is judged as the work happens, which is what lets the badge move inside a
     * long run instead of only when the user speaks. Tier 1 is asked on the short window, and an unsure phase
     * answer sends the same question again on the full window - the probe's `--tier`, minus the selection
     * questions a checkpoint has no reminder decision for. No `decide()` runs here, so the user-turn count, the
     * rotation pointer, and the mid-run budget stay the turn boundary's business; the only things that move are
     * the labels the mid-run gate and the badge read.
     */
    const judgeStateCheckpoint = async (
        ctx: ExtensionContext,
        /** The epoch the hook stamped: a judgement whose session was replaced writes nothing. */
        at: number,
    ): Promise<void> => {
        if (scope !== "full" || !settings.enabled || !rotationEnabled) {
            return;
        }

        const config = decisionConfig.load(ctx.cwd ?? process.cwd());
        if (!reminderEnabled(config)) {
            return;
        }

        const signals = rotationSignals(ctx, scheduler.snapshot().userTurns);
        const askState = (windowChars?: number): Promise<ReminderStateConsult> =>
            consultReminderState({
                ctx,
                config,
                ...(windowChars === undefined ? {} : { windowChars }),
                ...(labels.phase === undefined ? {} : { heldPhase: labels.phase }),
                ...(pi.events === undefined ? {} : { events: pi.events }),
                stateMarker: reminderStateMarker,
            });

        const short = await askState();
        const escalated = comesBackUnsure(short)
            ? await askState(TRANSCRIPT_WINDOW_CHARS)
            : undefined;
        const accepted = escalated ?? short;

        if (at !== epoch) {
            return;
        }

        rememberState(answeredState(escalated) ?? answeredState(short));
        publishState(ctx);

        if (!settings.debug) {
            return;
        }

        pi.appendEntry(
            REMINDER_DEBUG_ENTRY_TYPE,
            decisionEntry({
                trigger: "checkpoint",
                reminder: undefined,
                scope,
                state: signals,
                labels,
                ...(short.phaseConfidence === undefined
                    ? {}
                    : { stateConfidence: short.phaseConfidence }),
                ...(short.answeredPhase === undefined ? {} : { statePhase: short.answeredPhase }),
                stateLatencyMs: short.latencyMs,
                escalated: escalated !== undefined,
                ...((escalated ?? short).transcript === undefined
                    ? {}
                    : { stateTranscript: (escalated ?? short).transcript }),
                ...(accepted.status === "disabled" ? {} : { consult: accepted }),
                contextTokens: growth.maxTokens,
                scheduler: scheduler.snapshot(),
            }),
        );
    };

    /**
     * Judge one rotation turn off the boundary's critical path, then deliver whatever it picked.
     *
     * The queue keeps the consults in order, so this never lands before the judgement it followed; the epoch
     * check keeps an answer that outlived a session switch from writing to a session it no longer belongs to.
     * `decide` runs here rather than at the boundary because the pool it rotates over is the judged state's, so
     * the pick is only knowable once the consult has answered - by which time the user's message is long since
     * with the model.
     */
    const judgeTurnInBackground = (ctx: ExtensionContext, request: string, turn: number): void => {
        const at = epoch;
        void judgements.add(async () => {
            const judged = await judgeTurn(ctx, request, turn, at);
            if (at !== epoch) {
                return;
            }

            const before = scheduler.snapshot();
            // A mid-run emission may have covered this turn while the consult ran; one reminder per turn holds
            // whichever delivery path took the slot. A skipped judgement calls no `decide` at all: with the
            // model in charge, no answer must not fall back to the deterministic rotation.
            const reminder =
                before.lastEmitTurn >= turn || judged.skipped
                    ? undefined
                    : scheduler.decide(
                          {
                              maxContextTokens: growth.maxTokens,
                              modelChoice: judged.modelChoice,
                              available: judged.available,
                          },
                          { turnBegun: true },
                      );

            // The judgement moved the labels, so the badge is republished from the boundary's held state to the
            // judged one. Every turn publishes: the phase is inferred from the branch, so the badge tracks a turn
            // the rotation skipped just as well as one it judged.
            publishState(ctx);

            /** The turn the reminder is emitted on, stamped on the message so a later restart can resume. */
            const emitTurn = scheduler.snapshot().userTurns;
            if (reminder !== undefined) {
                shown.set(reminder.id, emitTurn);
            }

            if (settings.debug) {
                pi.appendEntry(
                    REMINDER_DEBUG_ENTRY_TYPE,
                    decisionEntry({
                        trigger: "turn",
                        deferred: true,
                        ...(judged.skipped ? { skipped: true } : {}),
                        reminder,
                        scope,
                        state: judged.signals,
                        available: judged.available,
                        options: judged.options,
                        modelChoice: judged.modelChoice,
                        scores: judged.scores,
                        consult: judged.consult,
                        labels,
                        ...(judged.stateConfidence === undefined
                            ? {}
                            : { stateConfidence: judged.stateConfidence }),
                        ...(judged.statePhase === undefined
                            ? {}
                            : { statePhase: judged.statePhase }),
                        ...(judged.stateLatencyMs === undefined
                            ? {}
                            : { stateLatencyMs: judged.stateLatencyMs }),
                        escalated: judged.escalated,
                        ...(judged.stateTranscript === undefined
                            ? {}
                            : { stateTranscript: judged.stateTranscript }),
                        ...(judged.consult?.window === undefined
                            ? {}
                            : { window: judged.consult.window }),
                        ...(judged.todoMove === undefined ? {} : { todoMove: judged.todoMove }),
                        ...(judged.todoScores === undefined
                            ? {}
                            : { todoScores: judged.todoScores }),
                        contextTokens: growth.maxTokens,
                        scheduler: before,
                    }),
                );
            }

            if (reminder === undefined) {
                return;
            }

            // The turn's rotation slot is taken whether or not the delivery below can happen yet.
            rotationReminderTurn = emitTurn;

            const payload = heldReminder(ctx, reminder, emitTurn);
            // The request the decision was made for is already in flight, so the reminder cannot ride it. A run
            // in flight does not yet promise another inference either: its current turn may be the last, so a
            // steer queued now would be polled after the final answer and be the only reason for another turn.
            // Hold it for the first step that ran a tool; a settled run hands it to the next prompt, which is
            // the only delivery that still reaches the model.
            if (runActive) {
                pendingSteers.push(payload);
                return;
            }

            sendHeld([payload], "nextTurn");
        });
    };

    const rotationSignals = (
        ctx: ExtensionContext,
        currentTurn: number,
        stateLabels: ReminderStateLabels = labels,
    ): ReminderSignals =>
        buildReminderSignals({
            entries: ctx.sessionManager.getBranch(),
            cwd: ctx.cwd ?? process.cwd(),
            currentTurn,
            contextTokens: growth.maxTokens,
            shown,
            labels: stateLabels,
        });

    /**
     * Publish the judged session labels for the footer's badge.
     *
     * The state is derived from the branch alone - the model's persisted labels with the deterministic
     * inference filling the gaps - so it tracks every turn rather than only the turns that ask the model, and
     * the phase is published in both `auto` and `manual` mode. Publishing per turn costs one message and one
     * footer render, which the turn triggers anyway; a child session's labels must not overwrite the parent's
     * badge, and the readout belongs to this module, so it stays silent for `scope: "memory"` and while
     * reminders are off.
     */
    const publishState = (ctx: ExtensionContext): void => {
        if (scope !== "full" || !settings.enabled || pi.events === undefined) {
            return;
        }

        emitDecisionState(
            pi.events,
            reminderSessionLabels({
                entries: ctx.sessionManager.getBranch(),
                cwd: ctx.cwd ?? process.cwd(),
                labels,
            }),
        );
    };

    /**
     * A restart point: session start, tree navigation, or compaction.
     *
     * `resume` reads the history back off the branch, so a reload, resume, fork, or tree move continues the
     * rotation and the shown history instead of treating the branch as new. A session start arms the memory
     * reminder because the appendix is rebuilt for a new session; a tree move only seeds, since landing on an
     * existing branch mid-conversation is not a starting point and "before starting work" would mislead.
     * Compaction deliberately resets: the fold is a context reset, so the rotation starts over and the fold's
     * own reminder is armed in place of the memory one. A fold whose reminder is still pending - a reload,
     * resume, or tree move immediately after it, before any post-fold turn - arms the fold's reminder too,
     * because the resume cannot tell that branch apart from a fresh one. The labels are branch-derived either
     * way.
     */
    const restart = (
        ctx: ExtensionContext,
        options: { resume?: boolean; armed?: ReminderDefinition } = {},
    ) => {
        // A change point: a judgement still in the air belongs to the session that is being left, so it drops
        // its answer instead of recording it here, and a held reminder has no run left to join.
        epoch += 1;
        growth.reset();
        pendingSteers.length = 0;
        rotationReminderTurn = undefined;
        const branch = ctx.sessionManager.getBranch();
        labels = reminderLabelsFromEntries(branch);
        // A restart is also a context epoch: a fold or a model change starts a new one, and a reload rebuilds
        // what it already delivered from the branch. A due fallback is dropped - see `ContextUsageReminders`.
        context.reset(branch);

        // A restart is a change point: publishing here means a reload, a tree move, or a fold shows the phase
        // at once instead of waiting for the first turn.
        publishState(ctx);

        const state = options.resume === true ? reminderResumeState(branch) : undefined;
        // A resume that finds nothing after a fold is the fold's own reminder still pending, not a fresh
        // start. `state === undefined` already means the post-fold slice holds no user turn and no delivered
        // reminder, so a fold reminder that was shown makes it defined; `branch.some` then separates a pending
        // fold from a genuinely fresh branch. The fold's reminder outranks the caller's arm because the
        // appendix rebuild re-reads the memory list, but the fold's reminder also covers the lossy summary and
        // the TODO state the summary does not carry; recomputing it from the branch restores the arm the
        // `session_compact` handler set when the process that set it is gone.
        const foldReminderPending =
            state === undefined && branch.some((entry) => entry.type === "compaction");
        const armed = foldReminderPending ? COMPACTION_REMINDER : options.armed;

        if (state === undefined) {
            scheduler.reset(armed);
            shown.clear();
            return;
        }

        scheduler.seed(state, armed);
        shown.clear();
        for (const [id, turn] of state.shown) {
            shown.set(id, turn);
        }
    };

    pi.on("session_start", async (_event, ctx) => {
        restart(ctx, { resume: true, armed: MEMORY_READ_REMINDER });
        // What is already on disk is not this run's doing, so it is the baseline and not a finding to report.
        await memoryAudit.reseed(ctx.cwd);
    });
    pi.on("session_tree", async (_event, ctx) => {
        restart(ctx, { resume: true });
        await memoryAudit.reseed(ctx.cwd);
    });
    pi.on("session_compact", async (_event, ctx) => {
        restart(ctx, { armed: COMPACTION_REMINDER });
        await memoryAudit.reseed(ctx.cwd);
    });
    pi.on("agent_start", () => {
        runActive = true;
        growth.reset();
    });
    pi.on("agent_settled", () => {
        runActive = false;

        // No step proved the run would continue, so the held reminders never had a steer destination. Hand
        // them to the next user prompt rather than waking a turn of their own after the final answer.
        sendHeld(pendingSteers.splice(0), "nextTurn");
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
     * context threshold applies here (the turn cadence counts user turns).
     *
     * One decision per step, and a step is a *completed* assistant message whose tool calls have run, not a
     * streamed delta: a delta is neither a point a steer can be delivered at (it lands after the turn, before
     * the next inference) nor a point worth a branch read and a window allocation, and judging there meant the
     * extension blocked the render loop once per crossing in the middle of the text the user is reading.
     * `turn_end` is the same boundary the checkpoint uses, and pi awaits it, so a steer still lands before the
     * run asks its next question.
     */
    const maybeEmitMidRun = async (ctx: ExtensionContext): Promise<void> => {
        if (!midRunEnabled) {
            return;
        }

        // The turn's rotation reminder already holds the slot, delivered or still held for this run.
        if (rotationReminderTurn === scheduler.snapshot().userTurns) {
            return;
        }

        if (!scheduler.midRunDue(growth.maxTokens) || midRunInFlight) {
            return;
        }

        midRunInFlight = true;
        try {
            await emitMidRun(ctx);
        } finally {
            midRunInFlight = false;
        }
    };

    /**
     * The mid-run decision itself: the pool, the model's answer on it, and the steer.
     *
     * The consult is the tier-2 question a step boundary asks, on the state the last checkpoint judged and with
     * no request of its own. It is what makes a mid-run point refusable: the rotation always has an answer, so
     * without it a threshold crossing emits whatever the pointer reached, whether or not it fits. Tier 1 is not
     * re-run - the checkpoints keep the labels current and the pool is built from them - and the TODO query is
     * left out because it reads the turn's new request, which inside a run does not exist.
     */
    const emitMidRun = async (ctx: ExtensionContext): Promise<void> => {
        const at = epoch;

        // The pool this rotates over is the judged state's, so settle the judgements already requested before
        // reading it: a checkpoint's answer lands first, and a deferred turn reminder that was going to take
        // this turn's slot has taken it.
        await idle();

        if (!midRunAvailableReady) {
            midRunSignals = rotationSignals(ctx, scheduler.snapshot().userTurns);
            midRunAvailable = availableRotationIds(midRunSignals);
            midRunAvailableReady = true;

            // A mid-run check is the other point where the branch is scanned anyway, so a long turn's phase
            // reaches the footer inside that turn rather than at its end.
            publishState(ctx);
        }

        const available = midRunAvailable;
        // The gate decides what may be offered, so the model is asked only about ids that can be shown.
        const options = ACTIVE_ROTATION_REMINDERS.filter(
            (reminder) => available?.has(reminder.id) === true,
        );
        const judged = options.length === 0 ? undefined : await consultMidRun(ctx, options);
        // A consult outlives the update that started it; an answer from a session this one replaced is dropped.
        if (at !== epoch) {
            return;
        }

        const before = scheduler.snapshot();
        const reminder = scheduler.decideMidRun({
            maxContextTokens: growth.maxTokens,
            available,
            ...(judged?.modelChoice === undefined ? {} : { modelChoice: judged.modelChoice }),
        });

        // A declined point is recorded too: nothing shown is exactly the case the state and the answer explain.
        if (settings.debug) {
            pi.appendEntry(
                REMINDER_DEBUG_ENTRY_TYPE,
                decisionEntry({
                    trigger: "mid-run",
                    reminder,
                    scope,
                    state: midRunSignals,
                    available,
                    options,
                    ...(judged?.modelChoice === undefined
                        ? {}
                        : { modelChoice: judged.modelChoice }),
                    ...(judged?.consult.scores === undefined
                        ? {}
                        : { scores: judged.consult.scores }),
                    ...(judged === undefined ? {} : { consult: judged.consult }),
                    ...(judged?.consult.window === undefined
                        ? {}
                        : { window: judged.consult.window }),
                    contextTokens: growth.maxTokens,
                    scheduler: before,
                }),
            );
        }

        if (reminder === undefined) {
            return;
        }

        const turn = scheduler.snapshot().userTurns;
        shown.set(reminder.id, turn);

        pi.sendMessage(
            {
                customType: REMINDER_CUSTOM_TYPE,
                content: formatReminder(reminder.text),
                display: false,
                // Records what was shown, when, and the baseline the emission leaves, so a later restart on
                // this branch can resume the rotation, the cadence, and the threshold.
                details: {
                    id: reminder.id,
                    turn,
                    contextTokens: scheduler.snapshot().thresholdBaseline ?? 0,
                },
            },
            { deliverAs: "steer" },
        );
    };

    /**
     * The tier-2 question at a mid-run point, asked the way a turn boundary asks it.
     *
     * The pool is the judged state's, so the answer can only name an id the gate allows; the state is the same
     * one conversation, and the signals ride along for the caller's record rather than as part of it. A disabled
     * or unreadable consult answers no choice, which leaves the deterministic rotation in charge.
     */
    const consultMidRun = async (
        ctx: ExtensionContext,
        options: readonly ReminderDefinition[],
    ): Promise<
        { modelChoice: ReminderModelChoice | undefined; consult: ReminderConsult } | undefined
    > => {
        const config = decisionConfig.load(ctx.cwd ?? process.cwd());
        if (!reminderEnabled(config)) {
            return undefined;
        }

        const signals = midRunSignals;
        if (signals === undefined) {
            return undefined;
        }

        const consult = await consultModelFor({
            ctx,
            config,
            signals,
            reminders: options,
            ...(pi.events === undefined ? {} : { events: pi.events }),
            ...(signals.session?.phase === undefined ? {} : { heldPhase: signals.session.phase }),
        });

        return { modelChoice: modelChoiceOf(consult), consult };
    };

    /**
     * The user-turn boundary: advance the cadence, publish the state, and decide the turn's reminder.
     *
     * An armed reminder - the memory list changed, or the transcript was folded - carries no consult, so it is
     * still decided here and rides the user message it is about. A rotation turn is the model's, and its consult
     * is not worth holding the user's message behind: the turn is advanced and published at once, the judgement
     * is queued, and the reminder it picks joins the run at the first opportunity after that message.
     *
     * Both paths still decide exactly once per turn, and only the deferred one can be pre-empted, by a mid-run
     * emission that took the turn's slot while the consult was still in the air.
     */
    pi.on("before_agent_start", (event, ctx) => {
        if (!settings.enabled) {
            return;
        }

        // The session reminder is already decided, and a rotation with both triggers at zero is off, so
        // neither turn is worth a classifier request or a branch scan.
        const snapshot = scheduler.snapshot();
        const rotationTurn = scope === "full" && rotationEnabled && !snapshot.sessionArmed;

        scheduler.beginTurn();

        if (!rotationTurn) {
            const reminder = scheduler.decide(
                { maxContextTokens: growth.maxTokens },
                { turnBegun: true },
            );

            // Every turn publishes, whether or not it asked the model: the phase is inferred from the branch,
            // so the badge tracks a turn the rotation skipped just as well as one it judged.
            publishState(ctx);

            /** The turn the reminder is emitted on, stamped on the message so a later restart can resume. */
            const emitTurn = scheduler.snapshot().userTurns;
            // Only the rotation is tracked: an armed reminder belongs to the catalog's session lifecycle, not to
            // the rotation the `shown` history feeds.
            if (reminder !== undefined && !snapshot.sessionArmed) {
                shown.set(reminder.id, emitTurn);
            }

            // Record the decision whether or not a reminder was chosen: the session reminder is recorded so
            // turn one is no gap, and a deliberate skip is what the state is needed to explain.
            if (settings.debug && reminder !== undefined) {
                pi.appendEntry(
                    REMINDER_DEBUG_ENTRY_TYPE,
                    decisionEntry({
                        trigger: "session",
                        reminder,
                        scope,
                        labels,
                        contextTokens: growth.maxTokens,
                        scheduler: snapshot,
                    }),
                );
            }

            if (reminder === undefined) {
                return;
            }

            return { message: heldMessage([heldReminder(ctx, reminder, emitTurn)]) };
        }

        // The held state is published before the consult resolves, so a turn whose judgement is slow still moves
        // the badge the moment the user speaks; the judged state republishes when the answer lands.
        publishState(ctx);
        judgeTurnInBackground(ctx, event.prompt, scheduler.snapshot().userTurns);
    });

    pi.on("message_start", (event, ctx) => {
        if (event.message.role !== "assistant") {
            return;
        }

        growth.startAssistantMessage(ctx.getContextUsage()?.tokens ?? 0);
        // A turn decision renders before this usage exists, so the run's first real context is what starts the
        // threshold cooldown; without it the whole context would read as growth on the first tool call.
        scheduler.noteContext(growth.maxTokens);
        midRunAvailable = undefined;
        midRunSignals = undefined;
        midRunAvailableReady = false;
    });

    pi.on("message_update", (event) => {
        if (event.message.role !== "assistant") {
            return;
        }

        const streamed = event.assistantMessageEvent;
        if (streamed.type === "text_delta" || streamed.type === "thinking_delta") {
            // Growth only: the decision itself is taken at `turn_end`, because a delta is not a point a steer
            // can be delivered at and the consult must never run while text is streaming.
            growth.addStreamedChars(streamed.delta.length);
        }
    });

    /**
     * The step boundary: every assistant response that used a tool re-judges the state and offers a mid-run
     * reminder.
     *
     * A response with no tool call changed no activity, and a step - the probe's step is a tool call - so it is
     * skipped and the next response catches up. `turn_end` rather than `message_end` because it fires once per
     * response, after that response's tools have run and their results are in the branch, which is the
     * conversation the state should be read from.
     *
     * The checkpoint judgement is queued rather than awaited: nothing in pi waits on it, and its consumers - the
     * mid-run gate, the next turn's judgement - wait for the queue, so the checkpoint never holds the run's next
     * request behind a consult. The mid-run decision *is* awaited, because a steer that arrives after the next
     * inference has started is a turn too late; its own cheap `midRunDue` check runs before anything waits, so a
     * step with nothing due pays nothing.
     */
    pi.on("turn_end", async (event, ctx) => {
        if (event.toolResults.length === 0) {
            // A step that ran no tool has no next inference to steer into: the run may be over, so a reminder
            // queued here would arrive as a stray message after the final answer.
            return;
        }

        // A memory edit is audited here rather than asked for by a rule: the audit is keyed on the trees'
        // fingerprint, so it costs a stat walk on a step that touched nothing and a parse only when a memory
        // actually changed. A finding joins the held reminders and leaves with them, which means it arrives as
        // a steer in the run that caused it instead of at the end of the task, when the memory is already
        // unindexed. It does not need a delivery of its own: `flushPendingSteers` combines everything held into
        // one message, so a held rotation reminder and a fresh finding share a steer rather than queueing two.
        const auditFindings = await memoryAudit.check(ctx.cwd);
        if (auditFindings !== undefined) {
            pendingSteers.push(
                heldReminder(
                    ctx,
                    {
                        ...MEMORY_AUDIT_REMINDER,
                        text: `${MEMORY_AUDIT_REMINDER.text}\n\n${auditFindings}`,
                    },
                    scheduler.snapshot().userTurns,
                ),
            );
        }

        // The context reminders are event-driven and share this boundary with the audit: the measured reading is
        // only worth taking once a reply exists, which is exactly what a step guarantees, and a steer queued here
        // lands before the next inference. They are facts, so no selection consult gates them, and a step that
        // carried one leaves the rotation its own step - two sends at this boundary would cost two deliveries.
        let contextEmitted = false;
        if (contextEnabled && !context.idle()) {
            const due = context.due(ctx);
            if (due !== undefined) {
                contextEmitted = true;
                pendingSteers.push(
                    heldReminder(
                        ctx,
                        { ...due.reminder, text: due.text },
                        scheduler.snapshot().userTurns,
                    ),
                );
            }
        }

        // A step that ran a tool is the first point the run guarantees another inference, so the reminders held
        // for it have a destination now.
        flushPendingSteers();

        const at = epoch;
        // Queued first, because the mid-run gate reads the labels this checkpoint produces and waits for it.
        void judgements.add(async () => {
            if (at !== epoch) {
                return;
            }

            await judgeStateCheckpoint(ctx, at);
        });

        // Awaited: the steer has to be queued before pi asks its next question.
        // One message per step: a defect report or a context reminder takes the slot the rotation would have used,
        // and the rotation keeps its cadence for the next step.
        if (auditFindings === undefined && !contextEmitted) {
            await maybeEmitMidRun(ctx);
        }
    });

    return { idle };
}
