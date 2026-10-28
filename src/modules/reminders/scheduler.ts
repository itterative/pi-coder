import { ACTIVE_ROTATION_REMINDERS } from "./catalog";
import type { ReminderDefinition, ReminderId } from "./types";

/** What the model chose for this turn, or `undefined` when it was not asked or gave no readable answer. */
export type ReminderModelChoice = "none" | ReminderId;

export interface SchedulerOptions {
    /** Emit a rotation reminder after this many user turns; `0` disables the trigger. */
    everyTurns: number;
    /** Emit a rotation reminder after this much new context; `0` disables the trigger. */
    thresholdTokens: number;
    /**
     * Most mid-run reminders one user turn may receive (default 1); `0` disables mid-run emissions. A long
     * autonomous turn crosses the context threshold repeatedly, and without a cap each crossing steered
     * another reminder into the same run.
     */
    maxMidRunPerTurn?: number;
}

export interface DecideInput {
    /** The context-growth estimate for the current run. */
    maxContextTokens: number;
    /**
     * The model's answer for this turn. `"none"` is a deliberate choice to show nothing and suppresses the
     * deterministic fallback; `undefined` means the model was disabled, unavailable, or unreadable, and the
     * fallback still runs.
     */
    modelChoice?: ReminderModelChoice;
    /**
     * The rotation ids the module allows this turn, from the activity gate. When absent every active
     * reminder is allowed. A model pick outside the set is vetoed with no fallback, so a gated id never
     * reaches the agent; the deterministic rotation skips to the next allowed id.
     */
    available?: ReadonlySet<ReminderId>;
}

/** A read-only view of the scheduler, for debug entries and tests. */
export interface SchedulerSnapshot {
    userTurns: number;
    rotationIndex: number;
    lastEmitTurn: number;
    /** The context the threshold is measured from, or `undefined` before the run that will establish it. */
    thresholdBaseline: number | undefined;
    sessionArmed: boolean;
    midRunThisTurn: number;
}

/**
 * The deterministic half of the reminder schedule: the reminder a restart arms (a changed memory list, or a
 * folded transcript), and a rotation through the catalog on a turn cadence or a context-growth threshold.
 *
 * The boundary and the decision are separate: `beginTurn` runs the moment a user turn starts, `decide`
 * advances the turn itself unless the caller already did. The model policy is layered on top by passing its
 * answer in, on a turn and on a mid-run point alike; a deliberate `none` is respected for the point it answered,
 * while an unavailable model leaves the deterministic triggers in charge so reminders never silently stop.
 */
export class ReminderScheduler {
    private userTurns = 0;
    private rotationIndex = 0;
    private lastEmitTurn = 0;
    /** The context the threshold is measured from; `undefined` until an emission or a run's first usage sets it. */
    private thresholdBaseline: number | undefined;
    private armed: ReminderDefinition | undefined;
    private midRunThisTurn = 0;
    private readonly maxMidRunPerTurn: number;

    constructor(private readonly options: SchedulerOptions) {
        this.maxMidRunPerTurn = options.maxMidRunPerTurn ?? 1;
    }

    /**
     * Decide a mid-run emission: only the context threshold applies, because there is no new user turn to
     * count and the session reminder is tied to a change point. The emission bookkeeping is the
     * same, so the next user turn starts a full cadence after it rather than repeating it.
     *
     * The model's answer decides this point the way it decides a turn: a named id is emitted, `none` declines
     * it, and an id the gate withholds shows nothing rather than a reminder the model did not ask for. Without
     * the consult the rotation always has an answer, so a threshold crossing could never be refused - the
     * pointer is a schedule, not a judgement.
     */
    decideMidRun(input: {
        maxContextTokens: number;
        available?: ReadonlySet<ReminderId>;
        /** The model's answer for this point; `undefined` leaves the deterministic rotation in charge. */
        modelChoice?: ReminderModelChoice;
    }): ReminderDefinition | undefined {
        if (!this.thresholdDue(input.maxContextTokens)) {
            return undefined;
        }

        if (this.midRunThisTurn >= this.maxMidRunPerTurn) {
            return undefined;
        }

        if (input.modelChoice !== undefined) {
            if (input.modelChoice === "none") {
                return this.decline(input.maxContextTokens);
            }

            const chosen = ACTIVE_ROTATION_REMINDERS.find(
                (reminder) => reminder.id === input.modelChoice,
            );
            if (chosen !== undefined) {
                // Leave the rotation pointer after the model's pick, so a deterministic fallback on the next
                // crossing does not immediately repeat it.
                this.rotationIndex =
                    (ACTIVE_ROTATION_REMINDERS.indexOf(chosen) + 1) %
                    ACTIVE_ROTATION_REMINDERS.length;

                // The gate is the module's own invariant, so it overrides the model too, exactly as it does on
                // a turn.
                if (input.available !== undefined && !input.available.has(chosen.id)) {
                    return this.decline(input.maxContextTokens);
                }

                this.midRunThisTurn += 1;
                return this.emit(chosen, input.maxContextTokens);
            }
        }

        const reminder = this.nextAvailableRotation(input.available);
        if (reminder === undefined) {
            return undefined;
        }

        this.midRunThisTurn += 1;
        return this.emit(reminder, input.maxContextTokens);
    }

    /**
     * Record a mid-run point the model declined.
     *
     * The point was decided, so it spends the turn's mid-run budget and restarts the cooldown: leaving the
     * threshold overdue would ask the model again on the very next streamed update. `lastEmitTurn` is left
     * alone because nothing was shown, so the turn's own reminder slot is still open.
     */
    private decline(maxContextTokens: number): undefined {
        this.midRunThisTurn += 1;
        if (maxContextTokens > 0) {
            this.thresholdBaseline = maxContextTokens;
        }

        return undefined;
    }

    /**
     * Whether a mid-run threshold crossing is due, without deciding which reminder or emitting. Lets the
     * caller skip the branch scan that builds the availability set on the many stream updates where nothing
     * is due.
     */
    midRunDue(maxContextTokens: number): boolean {
        return this.thresholdDue(maxContextTokens);
    }

    /**
     * A new session or post-compaction point: start a fresh cadence and arm `armed`, if given. Session start
     * arms the memory reminder, a compaction the reminder that covers the rest of what the fold changed, and
     * a restart point that arms nothing only resets the cadence.
     *
     * The thresholds are moments of change, not a continuous clock, so a branch that just changed its
     * context gets the armed reminder and a fresh cooldown rather than inheriting the previous point's. The
     * baseline is left unset: a restart cannot know the context, and the run's first usage (`noteContext`)
     * is what starts the cooldown.
     */
    reset(armed?: ReminderDefinition): void {
        this.userTurns = 0;
        this.rotationIndex = 0;
        this.lastEmitTurn = 0;
        this.thresholdBaseline = undefined;
        this.armed = armed;
        this.midRunThisTurn = 0;
    }

    /**
     * Resume from a branch that already has history: a tree move, reload, resume, or fork.
     *
     * The pointer continues after the last emitted rotation id and the turn cadence keeps its origin, so the
     * branch is not treated as new and an id it already showed is not repeated. `armed` is the caller's
     * choice: a session start arms the memory reminder for the rebuilt appendix, while a navigation arms
     * nothing, because landing on an existing branch is not a change point. The context threshold resumes from
     * the branch's last reminder when the resume state carries one (its stamp, or the first response after it),
     * so a reload does not reset the cooldown; without one it stays unset until the run establishes it.
     */
    seed(
        state: {
            userTurns: number;
            lastEmitTurn: number;
            lastRotationId?: string;
            /** The context the branch's last reminder was shown at, when it recorded one. */
            baselineContext?: number;
        },
        armed?: ReminderDefinition,
    ): void {
        this.userTurns = state.userTurns;
        this.lastEmitTurn = state.lastEmitTurn;
        this.rotationIndex = rotationIndexAfter(state.lastRotationId);
        this.thresholdBaseline =
            state.baselineContext !== undefined && state.baselineContext > 0
                ? state.baselineContext
                : undefined;
        this.midRunThisTurn = 0;
        this.armed = armed;
    }

    /**
     * The context at the start of an agent run, for a schedule whose baseline is not yet established.
     *
     * A turn decision renders before the run's first assistant usage, so the context it emits with is unknown
     * and the baseline it would leave behind is 0. The run's own first usage is the real value, so it starts the
     * cooldown the reset promised instead of letting the whole context count as growth. A baseline an emission
     * already set is not moved: it belongs to that emission, not to this run.
     */
    noteContext(maxContextTokens: number): void {
        if (this.thresholdBaseline === undefined && maxContextTokens > 0) {
            this.thresholdBaseline = maxContextTokens;
        }
    }

    /**
     * The turn boundary's bookkeeping, run the moment a user turn starts.
     *
     * Separate from `decide` because the decision is deferred: the rotation judgement is a model consult, so the
     * boundary advances the cadence and lets the pick follow in the background. Everything downstream of the
     * boundary - the signals' `user_turns`, a mid-run cap, a rotation pointer read - sees the new turn at once.
     */
    beginTurn(): void {
        // A new user turn resets the mid-run budget; the cap is per turn, not per session.
        this.midRunThisTurn = 0;
        this.userTurns += 1;
    }

    /**
     * Decide the reminder for a user turn.
     *
     * The turn is advanced here - `userTurns`, and the mid-run budget the new turn resets - because a decision
     * belongs to a turn. `turnBegun` is for the deferred path: the boundary runs `beginTurn` the moment the user
     * speaks so everything downstream sees the new turn, and the decision follows once the model has answered.
     */
    decide(
        input: DecideInput,
        options: { turnBegun?: boolean } = {},
    ): ReminderDefinition | undefined {
        // A new user turn resets the mid-run budget; the cap is per turn, not per session.
        if (options.turnBegun !== true) {
            this.beginTurn();
        }

        if (this.armed !== undefined) {
            const armed = this.armed;
            this.armed = undefined;
            return this.emit(armed, input.maxContextTokens);
        }

        if (input.modelChoice !== undefined) {
            if (input.modelChoice === "none") {
                return undefined;
            }

            const chosen = ACTIVE_ROTATION_REMINDERS.find(
                (reminder) => reminder.id === input.modelChoice,
            );
            if (chosen !== undefined) {
                // Leave the rotation pointer after the model's pick, so a deterministic fallback next turn
                // does not immediately repeat it.
                this.rotationIndex =
                    (ACTIVE_ROTATION_REMINDERS.indexOf(chosen) + 1) %
                    ACTIVE_ROTATION_REMINDERS.length;

                // The gate is the module's own invariant, so it overrides the model too: a gated pick emits
                // nothing rather than falling back to a reminder the model did not ask for.
                if (input.available !== undefined && !input.available.has(chosen.id)) {
                    return undefined;
                }

                return this.emit(chosen, input.maxContextTokens);
            }
        }

        if (!this.triggersDue(input.maxContextTokens)) {
            return undefined;
        }

        const reminder = this.nextAvailableRotation(input.available);
        if (reminder === undefined) {
            return undefined;
        }

        return this.emit(reminder, input.maxContextTokens);
    }

    snapshot(): SchedulerSnapshot {
        return {
            userTurns: this.userTurns,
            rotationIndex: this.rotationIndex,
            lastEmitTurn: this.lastEmitTurn,
            thresholdBaseline: this.thresholdBaseline,
            sessionArmed: this.armed !== undefined,
            midRunThisTurn: this.midRunThisTurn,
        };
    }

    private thresholdDue(maxContextTokens: number): boolean {
        if (this.options.thresholdTokens <= 0 || this.thresholdBaseline === undefined) {
            return false;
        }

        return maxContextTokens - this.thresholdBaseline >= this.options.thresholdTokens;
    }

    private triggersDue(maxContextTokens: number): boolean {
        const rotationDue =
            this.options.everyTurns > 0 &&
            this.userTurns - this.lastEmitTurn >= this.options.everyTurns;

        return this.thresholdDue(maxContextTokens) || rotationDue;
    }

    /**
     * The next rotation entry the gate allows, scanning forward from the pointer so one gated reminder does
     * not stall the whole rotation. The pointer moves only past the id that is actually emitted, and stays
     * put when nothing is allowed, so a gated reminder is retried once the activity changes.
     */
    private nextAvailableRotation(
        available: ReadonlySet<ReminderId> | undefined,
    ): ReminderDefinition | undefined {
        const count = ACTIVE_ROTATION_REMINDERS.length;
        for (let offset = 0; offset < count; offset += 1) {
            const index = (this.rotationIndex + offset) % count;
            const reminder = ACTIVE_ROTATION_REMINDERS[index];
            if (reminder === undefined) {
                continue;
            }

            if (available !== undefined && !available.has(reminder.id)) {
                continue;
            }

            this.rotationIndex = (index + 1) % count;
            return reminder;
        }

        return undefined;
    }

    private emit(reminder: ReminderDefinition, maxContextTokens: number): ReminderDefinition {
        this.lastEmitTurn = this.userTurns;
        // A turn decision renders before the run's first usage, so its context can still be 0 (unknown). An
        // unknown context leaves the baseline alone rather than clearing it: a real change point (a fold, a
        // fresh session) already cleared it in `reset`, while a reload's armed memory reminder renders with an
        // unknown context but is not a change point - it reuses the branch's seed through `seed`. `noteContext`
        // establishes a baseline only when there is none.
        if (maxContextTokens > 0) {
            this.thresholdBaseline = maxContextTokens;
        }
        return reminder;
    }
}

/** The rotation pointer just past `id`, or zero when there is no history to continue from. */
function rotationIndexAfter(id: string | undefined): number {
    if (id === undefined) {
        return 0;
    }

    const index = ACTIVE_ROTATION_REMINDERS.findIndex((reminder) => reminder.id === id);
    return index < 0 ? 0 : (index + 1) % ACTIVE_ROTATION_REMINDERS.length;
}
