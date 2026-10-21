/**
 * The reminders module's settings, read from the environment in the same style as the memory module's
 * `PI_MEMORY_*` switches.
 *
 * `PI_CODER_REMINDER=false` disables every reminder, including the session one. `PI_CODER_REMINDER_EVERY_TURNS`
 * (default 5) and `PI_CODER_REMINDER_THRESHOLD` (default 30000, the token growth that triggers a reminder)
 * may be set to `0` to disable that trigger on its own. `PI_CODER_REMINDER_DEBUG=true` records each emission
 * as a session entry. `PI_MEMORY_REMINDER_THRESHOLD` keeps working as an alias for the threshold.
 */
export interface ReminderSettings {
    enabled: boolean;
    everyTurns: number;
    thresholdTokens: number;
    debug: boolean;
}

export const DEFAULT_REMINDER_TURNS = 5;
export const DEFAULT_REMINDER_THRESHOLD = 30000;

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
        debug: env.PI_CODER_REMINDER_DEBUG === "true",
    };
}
