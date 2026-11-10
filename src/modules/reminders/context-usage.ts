/**
 * Ground-truth context usage, as reminders.
 *
 * A model cannot see how much of its window is in use, so it guesses - and the guess is worst right after a fold,
 * when the number it remembers describes a transcript that no longer exists. That guess is what makes it economize,
 * skip reads, or shorten work on a task that has room. These reminders put the measured count in front of it and
 * say plainly not to budget from the imagined one.
 *
 * Three reminders share that job, all change points rather than rotation entries. A fact that can be shown is not
 * something to ask the selection model whether it is relevant, and that model is the same guess-prone reader:
 *
 * - `context-half` / `context-tight` fire once each when a measured reading crosses half or three quarters of the
 *   window. They are event-driven rather than periodic, because a percentage is a real boundary and a cadence is
 *   not; a fold or a model change starts a new epoch, and the delivered ones are rebuilt from the branch on a
 *   reload.
 * - `context-after-fold` is the fallback for a fold whose own reminder could not state a number: it waits for the
 *   first measured reading and delivers that. Used when the fold estimate is refused (the model changed) or the
 *   fold row carries nothing to estimate from.
 *
 * ## What counts as measured
 *
 * `ctx.getContextUsage()` alone is not evidence. It answers with a number even when the counted reply it is
 * anchored on predates a model or thinking-level change - only a fold makes it refuse - so the number can describe
 * a different model's tokenizer or a preamble that no longer exists. The same rule compaction uses
 * (`changesCountBasis`) decides: a provider-counted reply must exist after the newest such row. Anything else is
 * skipped rather than shown, because a wrong number is exactly the failure this reminder exists to prevent.
 *
 * ## The fold estimate
 *
 * Before anything has replied after a fold there is no count, and the fold reminder cannot wait for one: it rides
 * the first turn after the fold, which is when the stale assumption is strongest. For that narrow window the size
 * is estimated from the current system prompt and tool definitions plus the retained rows and the summary, reusing
 * compaction's own estimators rather than a new one. It is labeled "about" and only used while the model is
 * unchanged: a model change makes every chars/4 ratio suspect, and that is what the one-shot above is for. Once a
 * measured reading exists it always wins, and the estimate is never shown beside it.
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { activeToolDefinitions, changesCountBasis } from "../compaction/native-request";
import { estimateTextTokens } from "../compaction/text";
import { estimateEntryTokens, totalTokensOf } from "../compaction/usage";
import {
    CONTEXT_AFTER_FOLD_REMINDER,
    CONTEXT_HALF_REMINDER,
    CONTEXT_TIGHT_REMINDER,
} from "./catalog";
import { REMINDER_CUSTOM_TYPE } from "./session-signals";
import type { ReminderDefinition, ReminderId } from "./types";

/** One measured reading of the live context. */
export interface ContextReading {
    tokens: number;
    contextWindow: number;
    /** `tokens / contextWindow` as a percentage, the same scale `ctx.getContextUsage()` uses. */
    percent: number;
}

/** What the compaction reminder says about the context the fold left behind. */
export interface FoldContextNote {
    /** The paragraph to append to the fold reminder. */
    text: string;
    /** Whether the paragraph stated a number; when it did not, the one-shot is armed. */
    stated: boolean;
}

/** The line stating that the pre-fold count no longer describes the context. */
const PRE_FOLD_LINE =
    "The token count from before the fold no longer applies - do not budget the work from it.";

/** The thresholds, lowest first. A reading that crosses several at once reports only the highest. */
const CONTEXT_THRESHOLDS = [
    { percent: 50, reminder: CONTEXT_HALF_REMINDER },
    { percent: 75, reminder: CONTEXT_TIGHT_REMINDER },
] as const;

/**
 * The context count to trust right now, or `undefined` when there is none.
 *
 * A counted reply after the newest basis-changing row is what makes the number describe the body the next
 * request carries. `changesCountBasis` covers folds, model changes, and thinking-level changes - the three rows
 * that rewrite the head - and a session with none of them falls back to its own chars/4 estimate, which is not a
 * measurement and is therefore declined here too.
 */
export function readMeasuredContext(ctx: ExtensionContext): ContextReading | undefined {
    const usage = ctx.getContextUsage();
    if (usage === undefined || usage.tokens === null || usage.contextWindow <= 0) {
        return undefined;
    }

    const branch = ctx.sessionManager.getBranch();
    const boundary = branch.findLastIndex(changesCountBasis);
    if (!branch.slice(boundary + 1).some(isCountedReply)) {
        return undefined;
    }

    return {
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        percent: usage.percent ?? (usage.tokens / usage.contextWindow) * 100,
    };
}

/** The measured line every one of these reminders opens with. */
export function formatContextLine(reading: ContextReading): string {
    return numbersLine(reading.tokens, reading.contextWindow, "Measured context", false);
}

/**
 * The context paragraph appended to the compaction reminder.
 *
 * A measured reading wins whenever there is one - a resume, or a fold early enough that a reply has already
 * landed. The estimate covers the manual-fold case where nothing has replied yet, and is refused when the model
 * changed, which leaves only the sentence about the pre-fold count; the caller arms the measured one-shot then.
 */
export function foldContextNote(ctx: ExtensionContext, pi: ExtensionAPI): FoldContextNote {
    const measured = readMeasuredContext(ctx);
    if (measured !== undefined) {
        return {
            text: `${numbersLine(measured.tokens, measured.contextWindow, "Measured context after the fold", false)}\n${PRE_FOLD_LINE}`,
            stated: true,
        };
    }

    const estimate = estimateAfterFold(ctx, pi);
    if (estimate !== undefined) {
        return {
            text: `${numbersLine(estimate.tokens, estimate.contextWindow, "Estimated context after the fold", true)}\n${PRE_FOLD_LINE}`,
            stated: true,
        };
    }

    return { text: PRE_FOLD_LINE, stated: false };
}

/**
 * The post-fold body size, estimated from the pieces a provider would receive.
 *
 * The fixed prefix is the *current* system prompt and tool set, not the fold's persisted copy: the memory appendix
 * and the tool loadout can change between the fold and this turn, and a request carries today's. The retained rows
 * and the summary come from the branch slice at `firstKeptEntryId`, which is the window pi rebuilds; an older fold
 * row inside it stays a row, as it does in the projection.
 *
 * Refused when the model moved - a persisted `provider`/`model` that no longer matches, or a later model or
 * thinking-level row - because a chars/4 estimate is exactly as good as the tokenizer it was calibrated on.
 */
function estimateAfterFold(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
): { tokens: number; contextWindow: number } | undefined {
    const branch = ctx.sessionManager.getBranch();
    const foldIndex = branch.findLastIndex((entry) => entry.type === "compaction");
    const fold = branch[foldIndex];
    const model = ctx.model;
    if (fold?.type !== "compaction" || model === undefined) {
        return undefined;
    }

    if (branch.slice(foldIndex + 1).some(changesCountBasis)) {
        return undefined;
    }

    const details = fold.details;
    if (isRecord(details)) {
        const provider = details["provider"];
        const id = details["model"];
        const moved =
            typeof provider === "string" &&
            typeof id === "string" &&
            (provider !== model.provider || id !== model.id);
        if (moved) {
            return undefined;
        }
    }

    const keptIndex =
        fold.firstKeptEntryId === null
            ? -1
            : branch.findIndex((entry) => entry.id === fold.firstKeptEntryId);
    const from = keptIndex < 0 ? foldIndex : keptIndex;
    const prefix =
        estimateTextTokens(ctx.getSystemPrompt()) +
        estimateTextTokens(JSON.stringify(activeToolDefinitions(pi)) ?? "");
    const tokens = prefix + estimateEntryTokens(branch.slice(from));
    const contextWindow = model.contextWindow;

    if (tokens <= 0 || contextWindow <= 0) {
        return undefined;
    }

    return { tokens, contextWindow };
}

/**
 * The thresholds one context epoch has already delivered.
 *
 * Rebuilt from the branch rather than persisted, for the same reason the rotation's `shown` map is: a delivered
 * reminder is already recorded, and the branch is the only state a reload can see. The slice starts after the
 * newest basis change, so a fold or a model change resets the thresholds without touching a file.
 */
export class ContextThresholdTracker {
    private fired = new Set<ReminderId>();

    /** A new context epoch: whatever it has delivered is what the branch holds after its newest basis row. */
    reset(branch: readonly SessionEntry[]): void {
        this.fired = deliveredThresholds(branch);
    }

    /** The highest threshold this reading newly crosses, marking every threshold it crossed as delivered. */
    next(percent: number): ReminderDefinition | undefined {
        if (!Number.isFinite(percent)) {
            return undefined;
        }

        const crossed = CONTEXT_THRESHOLDS.filter(
            (threshold) => percent >= threshold.percent && !this.fired.has(threshold.reminder.id),
        );
        if (crossed.length === 0) {
            return undefined;
        }

        this.markThrough(percent);

        return crossed.at(-1)?.reminder;
    }

    /** Whether every threshold this epoch has is already delivered, so no reading can fire one. */
    idle(): boolean {
        return CONTEXT_THRESHOLDS.every((threshold) => this.fired.has(threshold.reminder.id));
    }

    /**
     * Consume every threshold a reading has reached without reporting one.
     *
     * The after-fold one-shot carries the same number, so letting a threshold fire beside it would repeat it on
     * the next step. Consuming instead costs the tighter text once, right after a fold, where the fold reminders
     * already delivered the same advice.
     */
    markThrough(percent: number): void {
        for (const threshold of CONTEXT_THRESHOLDS) {
            if (percent >= threshold.percent) {
                this.fired.add(threshold.reminder.id);
            }
        }
    }
}

/** What one step boundary decided to say about the context. */
export interface ContextReminderDue {
    reminder: ReminderDefinition;
    /** The reminder body with the measured line already in front of it. */
    text: string;
}

/**
 * The context reminders one registration owns: the threshold tracker and the post-fold fallback.
 *
 * `reset` is the context epoch, run at every restart point and on a fold: the thresholds restart from the branch,
 * and a pending one-shot is dropped because a reload cannot tell whether the fold reminder that armed it stated a
 * number in the process that is gone. That is the one lifecycle gap here, and it costs one number after a reload,
 * not a wrong one.
 */
export class ContextUsageReminders {
    private readonly thresholds = new ContextThresholdTracker();
    private afterFold = false;

    reset(branch: readonly SessionEntry[]): void {
        this.thresholds.reset(branch);
        this.afterFold = false;
    }

    /** The fold reminder could not state a number: deliver the first measured one instead of guessing. */
    awaitAfterFold(): void {
        this.afterFold = true;
    }

    /** Whether a new context epoch is needed before anything can be due; the step then costs no branch read. */
    idle(): boolean {
        return !this.afterFold && this.thresholds.idle();
    }

    /** The reminder due at this step boundary, if any; nothing is returned when no measured reading exists. */
    due(ctx: ExtensionContext): ContextReminderDue | undefined {
        const reading = readMeasuredContext(ctx);
        if (reading === undefined) {
            return undefined;
        }

        const line = formatContextLine(reading);

        if (this.afterFold) {
            this.afterFold = false;
            this.thresholds.markThrough(reading.percent);

            return {
                reminder: CONTEXT_AFTER_FOLD_REMINDER,
                text: `${line}\n\n${CONTEXT_AFTER_FOLD_REMINDER.text}`,
            };
        }

        const reminder = this.thresholds.next(reading.percent);
        if (reminder === undefined) {
            return undefined;
        }

        return { reminder, text: `${line}\n\n${reminder.text}` };
    }
}

/** Whether a row is a reply a provider counted under the head in force now. */
function isCountedReply(entry: SessionEntry): boolean {
    return (
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        totalTokensOf(entry.message.usage, entry.message.stopReason) !== null
    );
}

/** The threshold ids delivered since the branch's newest basis-changing row. */
function deliveredThresholds(branch: readonly SessionEntry[]): Set<ReminderId> {
    const fired = new Set<ReminderId>();
    const from = branch.findLastIndex(changesCountBasis) + 1;

    for (const entry of branch.slice(from)) {
        if (entry.type !== "custom_message" || entry.customType !== REMINDER_CUSTOM_TYPE) {
            continue;
        }

        for (const id of reminderIdsOf(entry.details)) {
            if (id === CONTEXT_HALF_REMINDER.id) {
                fired.add(CONTEXT_HALF_REMINDER.id);
            }
            if (id === CONTEXT_TIGHT_REMINDER.id) {
                fired.add(CONTEXT_TIGHT_REMINDER.id);
            }
        }
    }

    return fired;
}

/**
 * Every reminder id one delivered message carried.
 *
 * A delivery point combines what it holds into one message, so the ids live in `details.ids` beside the newest
 * `details.id`; reading only the latter would miss a threshold combined with a rotation pick.
 */
function reminderIdsOf(details: unknown): string[] {
    if (!isRecord(details)) {
        return [];
    }

    const combined = details["ids"];
    if (Array.isArray(combined)) {
        return combined.filter((value): value is string => typeof value === "string");
    }

    const id = details["id"];

    return typeof id === "string" ? [id] : [];
}

function numbersLine(
    tokens: number,
    contextWindow: number,
    label: string,
    approximate: boolean,
): string {
    const shown = approximate ? roundToThousand(tokens) : Math.round(tokens);
    const percent = Math.round((shown / contextWindow) * 100);
    const free = Math.max(0, contextWindow - shown);
    const qualifier = approximate ? "about " : "";

    return `${label}: ${qualifier}${group(shown)} of ${group(contextWindow)} tokens used (${percent}%), ${group(free)} free.`;
}

/** An estimate is not precise enough to report to the token, so it is rounded to the nearest thousand. */
function roundToThousand(tokens: number): number {
    return Math.max(1_000, Math.round(tokens / 1_000) * 1_000);
}

/** Thousands separators without a locale, so one reminder reads the same on every host. */
function group(value: number): string {
    return Math.round(value)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
