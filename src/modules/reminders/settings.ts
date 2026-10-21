/**
 * The reminders module's settings, read from the environment in the same style as the memory module's
 * `PI_MEMORY_*` switches.
 *
 * `PI_CODER_REMINDER=false` disables every reminder, including the session one. `PI_CODER_REMINDER_EVERY_TURNS`
 * (default 5) and `PI_CODER_REMINDER_THRESHOLD` (default 30000, the token growth that triggers a reminder)
 * may be set to `0` to disable that trigger on its own. `PI_CODER_REMINDER_MIDRUN_MAX` (default 1) caps how
 * many threshold-driven mid-run reminders one user turn may receive. `PI_CODER_REMINDER_DEBUG` records each
 * selection decision, with the state it was made from, as a session entry; it is on by default for now (see
 * `reminderDebugEnabled`). `PI_MEMORY_REMINDER_THRESHOLD` keeps working as an alias for the threshold.
 */
export interface ReminderSettings {
    enabled: boolean;
    everyTurns: number;
    thresholdTokens: number;
    midRunMax: number;
    debug: boolean;
}

export const DEFAULT_REMINDER_TURNS = 5;
export const DEFAULT_REMINDER_THRESHOLD = 30000;
export const DEFAULT_REMINDER_MIDRUN_MAX = 1;

function nonNegativeInt(value: string | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }

    return parsed;
}

export function loadReminderSettings(env: NodeJS.ProcessEnv = process.env): ReminderSettings {
    const threshold = env.PI_CODER_REMINDER_THRESHOLD ?? env.PI_MEMORY_REMINDER_THRESHOLD;

    return {
        enabled: env.PI_CODER_REMINDER !== "false",
        everyTurns: nonNegativeInt(env.PI_CODER_REMINDER_EVERY_TURNS, DEFAULT_REMINDER_TURNS),
        thresholdTokens: nonNegativeInt(threshold, DEFAULT_REMINDER_THRESHOLD),
        midRunMax: nonNegativeInt(env.PI_CODER_REMINDER_MIDRUN_MAX, DEFAULT_REMINDER_MIDRUN_MAX),
        debug: reminderDebugEnabled(env.PI_CODER_REMINDER_DEBUG),
    };
}

/**
 * Whether to record each reminder decision as a session entry.
 *
 * `PI_CODER_REMINDER_DEBUG` is the switch, but it is on by default for now: the entry is the only record of
 * the state a selection was made from, and a session that already happened cannot be re-run to capture it.
 * The real implementation is commented out rather than deleted, matching `isAgentTraceEnabled`, so turning
 * this back into an opt-in is a one-line change.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function reminderDebugEnabled(value: string | undefined): boolean {
    // return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
    // TODO: enabled temporarily while tuning reminder selection
    return true;
}
