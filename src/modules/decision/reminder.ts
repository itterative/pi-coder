import type {
    ClassifierAnswer,
    ClassifierApi,
    ClassifierContext,
    ClassifierModel,
    ClassifierQuestion,
    ClassifierResult,
    JsonObject,
    Usage,
} from "@earendil-works/pi-ai";

import { resolveClassifier, type ClassifierRegistry } from "./model";
import type { DecisionModelConfig, DecisionRecentMessage, ReminderQuestionForm } from "./types";

/**
 * The reminder subject: one choice question that decides whether an agent turn gets a reminder, and which
 * one.
 *
 * It grants no authority and resolves no permission prompt — the answer is a hidden piece of context shown
 * to the agent. The candidates and their wording come from the caller (`src/modules/reminders`), so this file
 * knows only that reminders have an id and a line of guidance, exactly as the suggestion subject knows only
 * that two roles exist. The evaluator keeps its own cache and cooldown because a failed reminder request must
 * not pause a permission verdict.
 */

/**
 * Default probability a reminder's own answer must reach to be shown.
 *
 * The threshold is a ranking gate, not a calibrated probability. Measured on real session replays with
 * `vllm-d3-flash`: read-only states peak around 0.14-0.21 for every reminder, clear `validation` states reach
 * 0.57-0.65, and borderline states sit at 0.43-0.44. At 0.45 the read-only control abstains, the clear
 * cases fire, and a long turn does not get a reminder on every user turn. A single-choice question with a
 * `none` option abstained on almost every real state; asking each reminder separately and thresholding the
 * winner is what makes the model choose again.
 */
export const DEFAULT_REMINDER_MIN_PROBABILITY = 0.45;

/**
 * The question form the per-reminder questions use by default.
 *
 * `"score"` is the measured default: on real states the bool form kept `todo` at 0.12-0.29 and never fired
 * it, while the score form ranked `todo` first whenever work was underway (0.94-1.21) and yielded to
 * `validation` when that was the real need.
 */
export const DEFAULT_REMINDER_FORM: ReminderQuestionForm = "score";

/**
 * Default score a reminder's own answer must reach when the form is `"score"`.
 *
 * The scale is `[0, criteria.length - 1]`, so 1.0 is the second of four levels. Measured `todo` scores on
 * real states were 0.94-1.21 while work was underway and 0.44 on a closed list, so 1.0 fires the former and
 * not the latter; the `todo` availability gate suppresses the no-list states the model also scored high.
 */
export const DEFAULT_REMINDER_MIN_SCORE = 1;

/** The helpfulness levels of the score form, in order; the answer is a continuous point in this range. */
export const REMINDER_HELPFULNESS_CRITERIA = ["no help", "mild", "useful", "important"] as const;

/** The two ends of one reminder's own question. */
export const REMINDER_WORTH_SHOWING_CRITERIA = {
    true: "Yes: it targets something the agent is likely to overlook right now",
    false: "No: it would be noise, or the agent already has this in context",
} as const;

/**
 * One reminder's question. The guidance is the criterion, and every option is judged on its own so the
 * answer is a probability rather than a pick among alternatives.
 */
export function reminderQuestionInstruction(option: ReminderOption): string {
    return (
        "Would showing this single reminder to the agent before its next step help, or is it easy to " +
        `overlook right now? When this reminder helps: ${option.guidance}`
    );
}

/**
 * One reminder's score-form question: the same guidance, asked as a helpfulness level rather than a yes/no.
 *
 * The wording is the one measured in the score-form comparison, not a rewrite of the bool instruction.
 */
export function reminderScoreInstruction(option: ReminderOption): string {
    return `How helpful would showing this reminder be right now: ${option.guidance}`;
}

/** The question for one reminder in the configured form; the piggybacked labels stay bool/choice. */
function reminderQuestion(option: ReminderOption, form: ReminderQuestionForm): ClassifierQuestion {
    if (form === "score") {
        return {
            type: "score",
            instructions: reminderScoreInstruction(option),
            criteria: [...REMINDER_HELPFULNESS_CRITERIA],
        };
    }

    return {
        type: "bool",
        instructions: reminderQuestionInstruction(option),
        criteria: REMINDER_WORTH_SHOWING_CRITERIA,
    };
}

/** The phase labels the model may assign while the session proceeds. */
export const REMINDER_PHASES = [
    "exploring",
    "planning",
    "implementing",
    "debugging",
    "verifying",
    "wrapping_up",
] as const;

export type ReminderPhase = (typeof REMINDER_PHASES)[number];

/** Question ids for the state the model builds alongside the reminder choice. */
export const REMINDER_PHASE_QUESTION = "phase";
export const REMINDER_FINISHING_QUESTION = "finishing";
export const REMINDER_UNVALIDATED_QUESTION = "unvalidated";

export const REMINDER_PHASE_INSTRUCTION =
    "What is the agent currently doing, given the recent activity? Keep the previous phase when the work has " +
    "not moved on.";

export const REMINDER_PHASE_CRITERIA: Record<ReminderPhase, string> = {
    exploring: "Reading and searching to understand the codebase or the request",
    planning: "Designing an approach, writing a plan, or asking the user before changing files",
    implementing: "Editing or writing files to build the requested change",
    debugging: "Diagnosing a failure; retrying or narrowing down a problem",
    verifying: "Running tests, typechecks, or checks to confirm a change works",
    wrapping_up: "Finishing up: summarizing, updating memories or the TODO list, reporting back",
};

export const REMINDER_FINISHING_INSTRUCTION =
    "Is the task this turn serves about to be wrapped up - the work is done and only reporting, memory, or " +
    "cleanup remains?";

export const REMINDER_FINISHING_CRITERIA = {
    true: "Yes: the requested work appears complete or is being concluded",
    false: "No: the task is still in progress",
};

export const REMINDER_UNVALIDATED_INSTRUCTION =
    "Have files changed during this task without a test or typecheck run since the last change?";

export const REMINDER_UNVALIDATED_CRITERIA = {
    true: "Yes: changes were made and validation has not run since",
    false: "No: validation ran after the last change, or nothing changed",
};

/** Whether a string names one of the phase labels. */
export function isReminderPhase(value: string): value is ReminderPhase {
    return (REMINDER_PHASES as readonly string[]).includes(value);
}

/**
 * Labels the model maintains as the session proceeds.
 *
 * They are piggybacked on the reminder request - the endpoint answers every question in one round trip - and
 * persisted by the caller so the next turn's state carries them. They are not authority: an unreadable label
 * is dropped and the caller's deterministic inference stands.
 */
export interface ReminderStateLabels {
    phase?: ReminderPhase;
    finishing?: boolean;
    unvalidated?: boolean;
}

/** One selectable reminder: the id the answer names, and the line the model judges it by. */
export interface ReminderOption {
    id: string;
    /** When showing this reminder helps, as the model reads it. */
    guidance: string;
}

/**
 * What the agent has been doing, derived from the session branch.
 *
 * The four-item recent window cannot carry this: a turn that edits three files and delegates to a worker can
 * look like one line of prose, and the reminder choice depends on exactly those facts.
 */
export interface ReminderSessionActivity {
    /** User turns since the last reset (session start, tree navigation, compaction). */
    user_turns?: number;
    context_tokens?: number;
    /** Tool-name call counts for the branch. */
    tools?: Record<string, number>;
    /** Tool names in call order, most recent last. */
    recent_tools?: string[];
    /** Paths written or edited in the branch, memory files and TODO.md excluded. */
    files_modified?: string[];
    /** Whether a bash command in the branch ran a known test runner. */
    tests_run?: boolean;
    /** Whether the most recent test run's tool result reported an error. */
    last_test_failed?: boolean;
    memory_writes?: number;
    todo_writes?: number;
    /** The phase label last assigned to the session. */
    phase?: ReminderPhase;
    finishing?: boolean;
    unvalidated?: boolean;
}

/** A rotation reminder already shown in this session, relative to the current user turn. */
export interface ReminderShown {
    id: string;
    turns_ago: number;
}

/** Current progress from the runtime TODO.md snapshot. */
export interface ReminderTodoState {
    completed: number;
    total: number;
    current?: string;
}

/** Context the caller gathered beyond the request and the recent window. */
export interface ReminderSignals {
    cwd?: string;
    session?: ReminderSessionActivity;
    reminders_shown?: ReminderShown[];
    todo?: ReminderTodoState;
    /** Indexed project memory names, so memory guidance can be judged against what exists. */
    memories?: string[];
}

export interface ReminderContext {
    /** The request the turn serves. */
    request?: string;
    /** The last few turns, in the decision module's standard shape. */
    recent?: readonly DecisionRecentMessage[];
    /** The reminders the model may choose from. */
    options: readonly ReminderOption[];
    /** Activity, prior reminders, TODO progress, and the memory list. */
    signals?: ReminderSignals;
    /**
     * Extra questions the caller wants answered in the same round trip, keyed by question id.
     *
     * A built-in id wins a collision, so an extra question can never replace a reminder or label question.
     * The answers come back under `ReminderConsult.extras`; the decision module never interprets them.
     */
    extraQuestions?: Readonly<Record<string, ClassifierQuestion>>;
}

/** What the model chose: no reminder, or one of the offered reminders. */
export type ReminderDecision = { kind: "none" } | { kind: "reminder"; id: string };

/**
 * The classifier state: the request, the recent turns, and the caller's signals.
 *
 * The candidate list is absent on purpose - the criteria carry that - and the signal objects are copied
 * rather than spread so a caller cannot mutate the state after it is built.
 */
export function buildReminderState(context: ReminderContext): JsonObject {
    const state: JsonObject = {};

    if (context.request !== undefined && context.request.trim() !== "") {
        state.request = context.request;
    }

    if (context.recent !== undefined && context.recent.length > 0) {
        state.recent_messages = context.recent.map((item) => ({
            role: item.role,
            text: item.text,
        }));
    }

    const signals = context.signals;
    if (signals?.cwd !== undefined && signals.cwd !== "") {
        state.cwd = signals.cwd;
    }

    if (signals?.session !== undefined && Object.keys(signals.session).length > 0) {
        state.session = { ...signals.session };
    }

    if (signals?.reminders_shown !== undefined && signals.reminders_shown.length > 0) {
        state.reminders_shown = signals.reminders_shown.map((shown) => ({ ...shown }));
    }

    if (signals?.todo !== undefined) {
        state.todo = { ...signals.todo };
    }

    if (signals?.memories !== undefined && signals.memories.length > 0) {
        state.memories = [...signals.memories];
    }

    return state;
}

/**
 * One request: one question per offered reminder, plus the state questions it piggybacks.
 *
 * Every reminder is asked on its own rather than as a single choice because the choice form with a `none`
 * option collapsed to `none` on nearly every real state. Which form its own question takes is `form`: a
 * probability bool, or a helpfulness score (the default, which separates the reminders where the bool
 * flattens them). The endpoint answers every question in the same round trip, as the file-access subject does
 * with kind/purpose/loss, so this costs no extra request.
 */
export function reminderRequest(
    state: JsonObject,
    options: readonly ReminderOption[],
    extraQuestions?: Readonly<Record<string, ClassifierQuestion>>,
    form: ReminderQuestionForm = DEFAULT_REMINDER_FORM,
): ClassifierContext {
    const questions: Record<string, ClassifierQuestion> = {};

    for (const option of options) {
        questions[option.id] = reminderQuestion(option, form);
    }

    questions[REMINDER_PHASE_QUESTION] = {
        type: "choice",
        instructions: REMINDER_PHASE_INSTRUCTION,
        criteria: REMINDER_PHASE_CRITERIA,
    };
    questions[REMINDER_FINISHING_QUESTION] = {
        type: "bool",
        instructions: REMINDER_FINISHING_INSTRUCTION,
        criteria: REMINDER_FINISHING_CRITERIA,
    };
    questions[REMINDER_UNVALIDATED_QUESTION] = {
        type: "bool",
        instructions: REMINDER_UNVALIDATED_INSTRUCTION,
        criteria: REMINDER_UNVALIDATED_CRITERIA,
    };

    // The caller's own questions ride along in the same round trip, after the built-ins so a collision
    // cannot replace a question the decision itself reads.
    if (extraQuestions !== undefined) {
        for (const [id, question] of Object.entries(extraQuestions)) {
            if (questions[id] === undefined) {
                questions[id] = question;
            }
        }
    }

    return { state, questions };
}

/**
 * The numeric answer one reminder question returned, or `undefined` when it was not answered readably.
 *
 * Reads whichever form was asked: a bool's `probability` or a score's `score`. Keeping this in one place is
 * what lets the decision and the calibration log stay form-agnostic.
 */
function reminderAnswerValue(answer: ClassifierAnswer | undefined): number | undefined {
    if (answer === undefined) {
        return undefined;
    }

    if (answer.type === "bool") {
        return answer.probability;
    }

    return answer.type === "score" ? answer.score : undefined;
}

/** The per-reminder values the model returned, keyed by id; used for calibration and the debug log. */
export function reminderScoresFrom(
    answers: Record<string, ClassifierAnswer>,
    options: readonly ReminderOption[],
): Record<string, number> {
    const scores: Record<string, number> = {};

    for (const option of options) {
        const value = reminderAnswerValue(answers[option.id]);
        if (value !== undefined) {
            scores[option.id] = value;
        }
    }

    return scores;
}

/**
 * Read the per-reminder values and pick the strongest above the threshold.
 *
 * `undefined` means no option's answer was readable, so the caller should fall back to its deterministic
 * schedule; `{ kind: "none" }` is a deliberate decision to show nothing this turn and never falls back. The
 * threshold is the configured form's own gate, so `minValue` means a probability for `"bool"` and a
 * helpfulness level for `"score"`; the default is the bool gate because that is what most direct callers ask.
 */
export function reminderDecisionFrom(
    answers: Record<string, ClassifierAnswer>,
    options: readonly ReminderOption[],
    minValue: number = DEFAULT_REMINDER_MIN_PROBABILITY,
): ReminderDecision | undefined {
    let best: { id: string; value: number } | undefined;

    for (const option of options) {
        const value = reminderAnswerValue(answers[option.id]);
        if (value === undefined) {
            continue;
        }

        if (best === undefined || value > best.value) {
            best = { id: option.id, value };
        }
    }

    if (best === undefined) {
        return undefined;
    }

    return best.value >= minValue ? { kind: "reminder", id: best.id } : { kind: "none" };
}

/**
 * Read the state labels the request piggybacked.
 *
 * An unreadable label is omitted rather than guessed; the caller merges what came back over its persisted
 * labels and fills the rest with its deterministic inference.
 */
export function reminderStateFrom(answers: Record<string, ClassifierAnswer>): ReminderStateLabels {
    const labels: ReminderStateLabels = {};

    const phase = answers[REMINDER_PHASE_QUESTION];
    if (phase?.type === "choice" && isReminderPhase(phase.choice)) {
        labels.phase = phase.choice;
    }

    const finishing = answers[REMINDER_FINISHING_QUESTION];
    if (finishing?.type === "bool") {
        labels.finishing = finishing.probability >= 0.5;
    }

    const unvalidated = answers[REMINDER_UNVALIDATED_QUESTION];
    if (unvalidated?.type === "bool") {
        labels.unvalidated = unvalidated.probability >= 0.5;
    }

    return labels;
}

/**
 * The caller's extra answers, keyed by question id.
 *
 * Unanswered ids are omitted; `undefined` means nothing was asked or nothing came back, so a caller can skip
 * its own interpretation without checking the request again.
 */
function extraAnswersFrom(
    answers: Record<string, ClassifierAnswer>,
    extraQuestions: Readonly<Record<string, ClassifierQuestion>> | undefined,
): Record<string, ClassifierAnswer> | undefined {
    if (extraQuestions === undefined) {
        return undefined;
    }

    const extras: Record<string, ClassifierAnswer> = {};
    for (const id of Object.keys(extraQuestions)) {
        const answer = answers[id];
        if (answer !== undefined) {
            extras[id] = answer;
        }
    }

    return Object.keys(extras).length === 0 ? undefined : extras;
}

/** How one reminder consult ended, for tests and the caller. */
export type ReminderStatus =
    "answered" | "cached" | "cooldown" | "abstained" | "error" | "timeout" | "disabled";

export interface ReminderConsult {
    /** Present when the model chose no reminder or named one. */
    decision?: ReminderDecision;
    /** Present when at least one piggybacked state label came back readable. */
    state?: ReminderStateLabels;
    /** Every offered reminder's returned probability, for calibration and the debug log. */
    scores?: Record<string, number>;
    /** Answers to the caller's extra questions, keyed by question id; absent when none were asked. */
    extras?: Record<string, ClassifierAnswer>;
    status: ReminderStatus;
    latencyMs: number;
    usage?: Usage;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_COOLDOWN_MS = 30000;
const CACHE_LIMIT = 64;

export interface ReminderEvaluatorOptions {
    registry: ClassifierRegistry;
    config: DecisionModelConfig;
    /** Clock, injectable so cooldown tests can advance time without sleeping. */
    now?: () => number;
}

type Classifier = ClassifierModel<ClassifierApi>;

/**
 * One consult of the reminder question, with its own cache and cooldown.
 *
 * Deliberately separate from `DecisionEvaluator` and `SuggestionEvaluator`: the shared instance's cooldown
 * belongs to authority-bearing verdicts, and a reminder answer that timed out has no business pausing them.
 * The configured classifier is shared, so the reminders module can opt in with `reminders: true` without a
 * second endpoint.
 */
interface CachedReminderAnswer {
    decision: ReminderDecision;
    state?: ReminderStateLabels;
    scores?: Record<string, number>;
    extras?: Record<string, ClassifierAnswer>;
}

export class ReminderEvaluator {
    private readonly now: () => number;
    private readonly cache = new Map<string, CachedReminderAnswer>();
    private cooldownUntil = 0;

    constructor(private readonly options: ReminderEvaluatorOptions) {
        this.now = options.now ?? Date.now;
    }

    async evaluate(context: ReminderContext): Promise<ReminderConsult> {
        const { config } = this.options;
        if (!reminderEnabled(config)) {
            return { status: "disabled", latencyMs: 0 };
        }

        const model = resolveClassifier(this.options.registry, config);
        if (model === undefined) {
            return { status: "disabled", latencyMs: 0 };
        }

        const form = config.reminderForm ?? DEFAULT_REMINDER_FORM;
        const key = reminderCacheKey(model, context, form);
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return consultFrom(cached, "cached", 0);
        }

        if (this.now() < this.cooldownUntil) {
            return { status: "cooldown", latencyMs: 0 };
        }

        const started = this.now();
        const classified = await this.classify(
            model,
            reminderRequest(
                buildReminderState(context),
                context.options,
                context.extraQuestions,
                form,
            ),
        );
        const { result } = classified;
        const latencyMs = this.now() - started;

        if (result.stopReason !== "stop") {
            this.cooldownUntil = this.now() + (config.cooldownMs ?? DEFAULT_COOLDOWN_MS);
            const status = classified.timedOut ? "timeout" : "error";

            return consultFrom({}, status, latencyMs, result.usage);
        }

        const scores = reminderScoresFrom(result.answers, context.options);
        const decision = reminderDecisionFrom(
            result.answers,
            context.options,
            reminderThresholdOf(config, form),
        );
        const state = reminderStateFrom(result.answers);
        const extras = extraAnswersFrom(result.answers, context.extraQuestions);
        if (decision === undefined) {
            // An unreadable answer still keeps whatever labels came back, so the state keeps building.
            return consultFrom({ state, scores, extras }, "abstained", latencyMs, result.usage);
        }

        const answer: CachedReminderAnswer = { decision, state, scores, extras };
        this.remember(key, answer);

        return consultFrom(answer, "answered", latencyMs, result.usage);
    }

    private remember(key: string, answer: CachedReminderAnswer): void {
        if (this.cache.size >= CACHE_LIMIT) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
                this.cache.delete(oldest);
            }
        }

        this.cache.set(key, answer);
    }

    private async classify(
        model: Classifier,
        context: ClassifierContext,
    ): Promise<{ result: ClassifierResult; timedOut: boolean }> {
        const timeoutMs = this.options.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const result = await this.options.registry.classify(model, context, {
                signal: controller.signal,
            });

            return { result, timedOut: controller.signal.aborted };
        } catch (error) {
            return {
                result: errorResult(model, messageOf(error)),
                timedOut: controller.signal.aborted,
            };
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * One consult response from whatever parts came back readable.
 *
 * Empty `state` and `scores` records are dropped here rather than at each call site: an abstained answer may
 * carry no labels at all, and the response should read the same as one whose labels never came back.
 */
function consultFrom(
    parts: {
        decision?: ReminderDecision;
        state?: ReminderStateLabels;
        scores?: Record<string, number>;
        extras?: Record<string, ClassifierAnswer>;
    },
    status: ReminderStatus,
    latencyMs: number,
    usage?: Usage,
): ReminderConsult {
    const consult: ReminderConsult = { status, latencyMs };

    if (parts.decision !== undefined) {
        consult.decision = parts.decision;
    }
    if (parts.state !== undefined && Object.keys(parts.state).length > 0) {
        consult.state = parts.state;
    }
    if (parts.scores !== undefined && Object.keys(parts.scores).length > 0) {
        consult.scores = parts.scores;
    }
    if (parts.extras !== undefined) {
        consult.extras = parts.extras;
    }
    if (usage !== undefined) {
        consult.usage = usage;
    }

    return consult;
}

/** Whether the config lets the model choose reminders at all. */
export function reminderEnabled(config: DecisionModelConfig): boolean {
    return config.enabled === true && config.reminders === true;
}

/** The gate the configured form compares against: a probability for bool, a helpfulness level for score. */
function reminderThresholdOf(config: DecisionModelConfig, form: ReminderQuestionForm): number {
    if (form === "score") {
        return config.reminderMinScore ?? DEFAULT_REMINDER_MIN_SCORE;
    }

    return config.reminderMinProbability ?? DEFAULT_REMINDER_MIN_PROBABILITY;
}

/**
 * A reminder answer keyed by everything that can change it: the model, the question form, the candidates, the
 * request, and the recent window. The request turns over every turn, so the cache mostly helps a repeated
 * consult for the same turn rather than serving an old choice into new context.
 */
function reminderCacheKey(
    model: Classifier,
    context: ReminderContext,
    form: ReminderQuestionForm,
): string {
    return JSON.stringify([
        model.provider,
        model.id,
        form,
        context.options.map((option) => [option.id, option.guidance]),
        context.request ?? "",
        context.recent ?? [],
        context.signals ?? null,
        context.extraQuestions ?? null,
    ]);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The error result shape, so a thrown classify is treated exactly like a provider failure. */
function errorResult(model: Classifier, errorMessage: string): ClassifierResult {
    return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers: {},
        stopReason: "error",
        errorMessage,
        timestamp: 0,
    };
}
