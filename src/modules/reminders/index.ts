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
import { MEMORY_READ_REMINDER, ROTATION_REMINDERS } from "./catalog";
import { ContextGrowthTracker } from "./context-growth";
import { ReminderScheduler, type ReminderModelChoice } from "./scheduler";
import {
    REMINDER_STATE_TYPE,
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

    return ROTATION_REMINDERS.find((reminder) => reminder.id === decision.id)?.id;
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
        options: ROTATION_REMINDERS,
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
 * Emit pi-coder reminders as hidden context, at most one per user turn.
 *
 * The memory reminder is tied to the memory list changing (session start, tree navigation, compaction); the
 * rest rotate on a turn cadence or a context-growth threshold. When the decision model is configured with
 * `reminders: true`, it answers first: a chosen reminder or a deliberate `none` decides the turn, and an
 * unavailable or unreadable answer leaves the deterministic schedule in charge.
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
     * Only the context threshold applies here: the turn cadence counts user turns and the model policy is
     * consulted at `before_agent_start`, so both stay user-turn events.
     */
    const maybeEmitMidRun = (): void => {
        if (!midRunEnabled) {
            return;
        }

        const reminder = scheduler.decideMidRun({ maxContextTokens: growth.maxTokens });
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
        maybeEmitMidRun();
    });

    pi.on("message_update", (event) => {
        if (event.message.role !== "assistant") {
            return;
        }

        const streamed = event.assistantMessageEvent;
        if (streamed.type === "text_delta" || streamed.type === "thinking_delta") {
            growth.addStreamedChars(streamed.delta.length);
        }

        maybeEmitMidRun();
    });

    pi.on("before_agent_start", async (event, ctx) => {
        if (!settings.enabled) {
            return;
        }

        // The session reminder is already decided, and a rotation with both triggers at zero is off, so
        // neither turn is worth a classifier request.
        const snapshot = scheduler.snapshot();
        const consultModel = scope === "full" && rotationEnabled && !snapshot.sessionArmed;
        let modelChoice: ReminderModelChoice | undefined;
        if (consultModel) {
            const config = decisionConfig.load(ctx.cwd ?? process.cwd());
            if (reminderEnabled(config)) {
                const signals = buildReminderSignals({
                    entries: ctx.sessionManager.getBranch(),
                    cwd: ctx.cwd ?? process.cwd(),
                    currentTurn: snapshot.userTurns + 1,
                    contextTokens: growth.maxTokens,
                    shown,
                    labels,
                });
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

        const reminder = scheduler.decide({ maxContextTokens: growth.maxTokens, modelChoice });
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
