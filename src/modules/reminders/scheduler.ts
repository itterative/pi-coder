import { MEMORY_READ_REMINDER, ROTATION_REMINDERS } from "./catalog";
import type { ReminderDefinition, ReminderId } from "./types";

/** What the model chose for this turn, or `undefined` when it was not asked or gave no readable answer. */
export type ReminderModelChoice = "none" | ReminderId;

export interface SchedulerOptions {
    /** Emit a rotation reminder after this many user turns; `0` disables the trigger. */
    everyTurns: number;
    /** Emit a rotation reminder after this much new context; `0` disables the trigger. */
    thresholdTokens: number;
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
}

/** A read-only view of the scheduler, for debug entries and tests. */
export interface SchedulerSnapshot {
    userTurns: number;
    rotationIndex: number;
    lastEmitTurn: number;
    thresholdBaseline: number;
    sessionArmed: boolean;
}

/**
 * The deterministic half of the reminder schedule: the memory reminder for a changed memory list, and a
 * rotation through the catalog on a turn cadence or a context-growth threshold.
 *
 * One call per user turn. The model policy is layered on top by passing its answer in; a deliberate `none`
 * is respected for that turn, while an unavailable model leaves the deterministic triggers in charge so
 * reminders never silently stop.
 */
export class ReminderScheduler {
    private userTurns = 0;
    private rotationIndex = 0;
    private lastEmitTurn = 0;
    private thresholdBaseline = 0;
    private sessionArmed = false;

    constructor(private readonly options: SchedulerOptions) {}

    /**
     * Decide a mid-run emission: only the context threshold applies, because there is no new user turn to
     * count and the session reminder is tied to the memory list changing. The emission bookkeeping is the
     * same, so the next user turn starts a full cadence after it rather than repeating it.
     */
    decideMidRun(input: { maxContextTokens: number }): ReminderDefinition | undefined {
        if (!this.thresholdDue(input.maxContextTokens)) {
            return undefined;
        }

        return this.emit(this.nextRotation(), input.maxContextTokens);
    }

    /**
     * A new session, branch, or post-compaction point: re-arm the memory reminder and restart the cadence.
     *
     * The thresholds are moments of change, not a continuous clock, so a branch that just changed its
     * context gets the memory reminder and a fresh cooldown rather than inheriting the previous point's.
     */
    reset(): void {
        this.userTurns = 0;
        this.rotationIndex = 0;
        this.lastEmitTurn = 0;
        this.thresholdBaseline = 0;
        this.sessionArmed = true;
    }

    decide(input: DecideInput): ReminderDefinition | undefined {
        this.userTurns += 1;

        if (this.sessionArmed) {
            this.sessionArmed = false;
            return this.emit(MEMORY_READ_REMINDER, input.maxContextTokens);
        }

        if (input.modelChoice !== undefined) {
            if (input.modelChoice === "none") {
                return undefined;
            }

            const chosen = ROTATION_REMINDERS.find((reminder) => reminder.id === input.modelChoice);
            if (chosen !== undefined) {
                // Leave the rotation pointer after the model's pick, so a deterministic fallback next turn
                // does not immediately repeat it.
                this.rotationIndex =
                    (ROTATION_REMINDERS.indexOf(chosen) + 1) % ROTATION_REMINDERS.length;
                return this.emit(chosen, input.maxContextTokens);
            }
        }

        if (!this.triggersDue(input.maxContextTokens)) {
            return undefined;
        }

        return this.emit(this.nextRotation(), input.maxContextTokens);
    }

    snapshot(): SchedulerSnapshot {
        return {
            userTurns: this.userTurns,
            rotationIndex: this.rotationIndex,
            lastEmitTurn: this.lastEmitTurn,
            thresholdBaseline: this.thresholdBaseline,
            sessionArmed: this.sessionArmed,
        };
    }

    private thresholdDue(maxContextTokens: number): boolean {
        return (
            this.options.thresholdTokens > 0 &&
            maxContextTokens - this.thresholdBaseline >= this.options.thresholdTokens
        );
    }

    private triggersDue(maxContextTokens: number): boolean {
        const rotationDue =
            this.options.everyTurns > 0 &&
            this.userTurns - this.lastEmitTurn >= this.options.everyTurns;

        return this.thresholdDue(maxContextTokens) || rotationDue;
    }

    private nextRotation(): ReminderDefinition {
        const reminder = ROTATION_REMINDERS[this.rotationIndex];
        this.rotationIndex = (this.rotationIndex + 1) % ROTATION_REMINDERS.length;
        return reminder;
    }

    private emit(reminder: ReminderDefinition, maxContextTokens: number): ReminderDefinition {
        this.lastEmitTurn = this.userTurns;
        this.thresholdBaseline = maxContextTokens;
        return reminder;
    }
}
