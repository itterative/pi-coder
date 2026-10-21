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
import { ACTIVE_ROTATION_REMINDERS, MEMORY_READ_REMINDER } from "./catalog";
import { ContextGrowthTracker } from "./context-growth";
import { ReminderScheduler, type ReminderModelChoice } from "./scheduler";
import {
    REMINDER_STATE_TYPE,
    availableRotationIds,
    buildReminderSignals,
    reminderLabelsFromEntries,
} from "./session-signals";
import { loadReminderSettings } from "./settings";
import type { ReminderDefinition, ReminderId } from "./types";

const CUSTOM_TYPE = "pi-coder-reminder";
const DEBUG_ENTRY_TYPE = "pi-coder-reminder:debug";

export interface ReminderRegistrationOptions {
    /**
     * `full` is a parent session: the session reminder, the rotating catalog, and the model policy when
     * `reminders` is enabled in the decision-model config. `memory` is a delegated child: only the memory
     * reminder, which is what children received before the rotation existed.
     */
    scope?: "full" | "memory";
}

function formatReminder(reminder: ReminderDefinition): string {
    return `<pi_coder_reminder>\n${reminder.text}\n</pi_coder_reminder>`;
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
): Promise<ReminderConsult> {
    return consultReminderSelection({
        ctx,
        config,
        options: ACTIVE_ROTATION_REMINDERS,
        request,
        signals,
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
 * The memory reminder is tied to the memory list changing (session start, tree navigation, compaction); the
 * rest rotate on a turn cadence or a context-growth threshold. The two delivery paths are deliberately
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
            ? { everyTurns: settings.everyTurns, thresholdTokens: settings.thresholdTokens }
            : { everyTurns: 0, thresholdTokens: 0 },
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

    const restart = (ctx: ExtensionContext) => {
        scheduler.reset();
        growth.reset();
        shown.clear();
        labels = reminderLabelsFromEntries(ctx.sessionManager.getBranch());
    };

    pi.on("session_start", (_event, ctx) => restart(ctx));
    pi.on("session_tree", (_event, ctx) => restart(ctx));
    pi.on("session_compact", (_event, ctx) => restart(ctx));
    pi.on("agent_start", () => {
        growth.reset();
    });

    const midRunEnabled = scope === "full" && settings.enabled && settings.thresholdTokens > 0;

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
            midRunAvailable = availableRotationIds(
                rotationSignals(ctx, scheduler.snapshot().userTurns),
            );
            midRunAvailableReady = true;
        }

        const reminder = scheduler.decideMidRun({
            maxContextTokens: growth.maxTokens,
            available: midRunAvailable,
        });
        if (reminder === undefined) {
            return;
        }

        shown.set(reminder.id, scheduler.snapshot().userTurns);

        if (settings.debug) {
            pi.appendEntry(DEBUG_ENTRY_TYPE, {
                reminder: reminder.id,
                scope,
                midRun: true,
                ...scheduler.snapshot(),
            });
        }

        pi.sendMessage(
            {
                customType: CUSTOM_TYPE,
                content: formatReminder(reminder),
                display: false,
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
        if (rotationTurn) {
            const signals = rotationSignals(ctx, snapshot.userTurns + 1);
            available = availableRotationIds(signals);

            const config = decisionConfig.load(ctx.cwd ?? process.cwd());
            if (reminderEnabled(config)) {
                const consult = await consultModelFor(ctx, config, event.prompt, signals);
                modelChoice = modelChoiceOf(consult);

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
        if (reminder === undefined) {
            return;
        }

        if (reminder.id !== MEMORY_READ_REMINDER.id) {
            shown.set(reminder.id, scheduler.snapshot().userTurns);
        }

        if (settings.debug) {
            pi.appendEntry(DEBUG_ENTRY_TYPE, {
                reminder: reminder.id,
                scope,
                modelChoice: modelChoice ?? null,
                labels: { ...labels },
                ...scheduler.snapshot(),
            });
        }

        return {
            message: {
                customType: CUSTOM_TYPE,
                content: formatReminder(reminder),
                display: false,
            },
        };
    });
}
