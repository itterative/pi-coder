import type {
    ClassifierAnswer,
    ClassifierApi,
    ClassifierChoiceAnswer,
    ClassifierContext,
    ClassifierModel,
    ClassifierQuestion,
    ClassifierResult,
    JsonObject,
    Usage,
} from "@earendil-works/pi-ai";

import { resolveClassifier, type ClassifierRegistry } from "./model";
import type { SessionWindow } from "./session-context";
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

/**
 * The state labels the model may assign while the session proceeds.
 *
 * The set is the mid-run state probe's `--states doc` (`session-midturn.py`, `reminders/stage-gating.md`),
 * adopted here so the live state and the probe's measurements speak the same language. Two folds came with
 * it: `planning` splits between `discussing` (deciding or asking) and `documenting` (writing the plan), and
 * `debugging` folds into `validating`, whose criteria already cover diagnosing a failure.
 */
export const REMINDER_PHASES = [
    "discussing",
    "exploring",
    "implementing",
    "validating",
    "documenting",
    "reporting",
] as const;

export type ReminderPhase = (typeof REMINDER_PHASES)[number];

/** Question ids for the state the model builds alongside the reminder choice. */
export const REMINDER_PHASE_QUESTION = "next_state";

/**
 * The state question, verbatim from the probe's `--tier` instruction.
 *
 * The anchor travels in the state (`current_state`), and the probe's wording tells the model so; it is not
 * paraphrased here, because the variant was measured as this text.
 */
export const REMINDER_PHASE_INSTRUCTION =
    "The session is currently in the state shown in current_state. Below is the recent conversation between " +
    "the user and the agent, with tool calls in short form. Which state does the session move to next? " +
    "Choose the current state if it continues in it.";

/**
 * The criteria, verbatim from the probe's `--states doc` set.
 *
 * The sentences carry their subject ("The assistant is …") because that is what the measured variants asked;
 * the live phase vocabulary is the same list, so the labels and the probe's answers line up one for one.
 */
export const REMINDER_PHASE_CRITERIA: Record<ReminderPhase, string> = {
    discussing:
        "The assistant is answering questions, debating options, or deciding, without changing files",
    exploring: "The assistant is reading or searching code or docs to understand before acting",
    implementing: "The assistant is changing the deliverable's code, tests, or configuration",
    validating: "The assistant is running tests, typechecks, or lint, or diagnosing a failure",
    documenting: "The assistant is writing or updating a plan, design doc, README, memory, or TODO",
    reporting: "The assistant is summarizing what was done and handing it back to the user",
};

/** Whether a string names one of the phase labels. */
export function isReminderPhase(value: string): value is ReminderPhase {
    return (REMINDER_PHASES as readonly string[]).includes(value);
}

/**
 * How confident a phase answer must be to move the phase off the one already accepted.
 *
 * The accept rule is the mid-run state probe's (`session-midturn.py`): hold the state in hand unless the
 * proposal is confident. Without it the tracked phase only ever moved when the model decided to move it, and
 * the consult's own state field carries the previous phase back in, so an answer that disagreed quietly came
 * back as the same phase on the next turn (one session held `validating` for a thousand entries of code and
 * test work while the branch read `implementing`).
 */
export const PHASE_MOVE_CONFIDENCE = 0.5;

/**
 * The phase one answer accepts: the first answer is taken as-is, a repeat keeps the phase in hand, and a
 * different phase has to be confident enough to move it.
 */
export function acceptedReminderPhase(
    answer: ClassifierChoiceAnswer,
    held: ReminderPhase | undefined,
    threshold = PHASE_MOVE_CONFIDENCE,
): ReminderPhase | undefined {
    if (!isReminderPhase(answer.choice)) {
        return undefined;
    }

    if (held === undefined || answer.choice === held || answer.confidence >= threshold) {
        return answer.choice;
    }

    return held;
}

/**
 * The state labels the model may assign while the session proceeds.
 *
 * The phase is the one the questions ask. `finishing` and `unvalidated` are read from a persisted entry when an
 * older session recorded them, but no question sets them any more: nothing gates on them (the pool gate is the
 * phase and the TODO), and `unvalidated` has a deterministic inference the labels only ever overrode.
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
    /** Prose documents written or edited in the branch, memory files and TODO.md excluded. */
    doc_writes?: number;
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
     * The phase already accepted, when one is. The accept rule holds it unless this answer is confident enough
     * to move it, so it is the answer being tested against, not only the state the model reads as
     * `current_state`.
     */
    heldPhase?: ReminderPhase;
    /**
     * The fitted conversation the state ask is judged by, when this is a state ask.
     *
     * The state question is the only one that reads the transcript, and the transcript is fitted by the caller
     * ({@link windowTranscript}) from the same branch walk the pool's window comes from. Absent for a pool ask,
     * which judges from signals instead.
     */
    transcript?: string;
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

/** The one state question: which state the session moves to next. */
export function reminderStateQuestions(): Record<string, ClassifierQuestion> {
    return {
        [REMINDER_PHASE_QUESTION]: {
            type: "choice",
            instructions: REMINDER_PHASE_INSTRUCTION,
            criteria: REMINDER_PHASE_CRITERIA,
        },
    };
}

/**
 * The state ask: the anchor and the fitted transcript, and the one question judged from them.
 *
 * Verbatim the probe's variant - `{current_state, conversation}` and a single choice question - because the
 * payload shape is what the measurement was about: the same window sent as structured `recent_messages` with
 * the anchor only in a gate read `exploring` at 0.17 confidence, this shape read `validating` at 0.82.
 *
 * `state` is not the pool's state: the pool judges from signals, and it has its own builder
 * ({@link buildReminderState}).
 */
export function reminderStateRequest(
    currentState: ReminderPhase | undefined,
    conversation: string,
): ClassifierContext {
    return {
        state: { current_state: currentState ?? "none", conversation },
        questions: reminderStateQuestions(),
    };
}

/**
 * The tier-2 request: one question per offered reminder, plus the caller's own questions.
 *
 * Every reminder is asked on its own rather than as a single choice because the choice form with a `none`
 * option collapsed to `none` on nearly every real state. Which form its own question takes is `form`: a
 * probability bool, or a helpfulness score (the default, which separates the reminders where the bool
 * flattens them). The endpoint answers every question in the same round trip, as the file-access subject does
 * with kind/purpose/loss. The state question is not one of them: it has its own state, its own transcript and
 * its own window, and it is asked as its own call, so this state stays the signals the pool is judged by.
 */
export function reminderChoiceRequest(
    state: JsonObject,
    options: readonly ReminderOption[],
    extraQuestions?: Readonly<Record<string, ClassifierQuestion>>,
    form: ReminderQuestionForm = DEFAULT_REMINDER_FORM,
): ClassifierContext {
    const questions: Record<string, ClassifierQuestion> = {};

    for (const option of options) {
        questions[option.id] = reminderQuestion(option, form);
    }

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
 * Read the state label the request answered.
 *
 * The phase is the only one a question asks now; `finishing` and `unvalidated` come from a persisted entry of
 * an older session, if at all. An unreadable or unasked phase is omitted rather than guessed, and the caller
 * merges what came back over its persisted labels and fills the rest with its deterministic inference.
 */
export function reminderStateFrom(
    answers: Record<string, ClassifierAnswer>,
    heldPhase?: ReminderPhase,
): ReminderStateLabels {
    const labels: ReminderStateLabels = {};

    const phase = answers[REMINDER_PHASE_QUESTION];
    if (phase?.type === "choice") {
        // The accept rule, not the raw answer: a phase that disagrees with the one in hand only moves it when
        // the model is confident, so a quiet disagreement cannot be inherited by the next turn.
        const accepted = acceptedReminderPhase(phase, heldPhase);
        if (accepted !== undefined) {
            labels.phase = accepted;
        }
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
    /** Every offered reminder's returned probability, for calibration and the debug log. */
    scores?: Record<string, number>;
    /** Answers to the caller's extra questions, keyed by question id; absent when none were asked. */
    extras?: Record<string, ClassifierAnswer>;
    status: ReminderStatus;
    latencyMs: number;
    usage?: Usage;
    /**
     * The recent window this consult was judged by, beside the state the caller built.
     *
     * Carried back rather than recomputed: the consult reads the branch once, so a log that re-read the branch
     * afterwards can record a window that was not the one sent. An empty window is recorded as empty, so a
     * reader never has to guess from the state whether there was one. Absent when no consult was attempted.
     */
    window?: SessionWindow;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_COOLDOWN_MS = 30000;
const CACHE_LIMIT = 64;

/** What the tier-1 consult reports: the state it accepted, and how sure the phase answer was. */
export interface ReminderStateConsult {
    /** The state the accept rule produced; empty when nothing readable came back. */
    state: ReminderStateLabels;
    /**
     * The raw confidence of the phase answer, before the accept rule holds or moves the phase.
     *
     * The cascade escalates on it: below the move threshold the state may be the held one rather than what the
     * short window suggested, so the full window is asked and its answer is the one that counts.
     */
    phaseConfidence?: number;
    /**
     * The phase the model answered, before the accept rule.
     *
     * `state.phase` is what the accept rule produced, so it equals the phase in hand whenever a disagreement
     * was not confident enough to move it; this is what the answer itself said, which is the only way to tell a
     * model that keeps proposing another phase from one that keeps confirming this one.
     */
    answeredPhase?: ReminderPhase;
    status: ReminderStatus;
    latencyMs: number;
    usage?: Usage;
    /**
     * The fitted conversation this state was judged by, exactly as it was sent.
     *
     * Recorded because the state ask does not send the pool's window: it sends one rendered transcript, and a
     * reader comparing the request against the probe's has to see those bytes rather than a plan re-derived
     * from the branch afterwards.
     */
    transcript?: string;
}

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
    scores?: Record<string, number>;
    extras?: Record<string, ClassifierAnswer>;
}

/** A cached tier-1 answer: the accepted state, the phase confidence, and the phase the model named. */
interface CachedStateAnswer {
    state: ReminderStateLabels;
    phaseConfidence?: number;
    answeredPhase?: ReminderPhase;
}

export class ReminderEvaluator {
    private readonly now: () => number;
    private readonly cache = new Map<string, CachedReminderAnswer>();
    private readonly stateCache = new Map<string, CachedStateAnswer>();
    private cooldownUntil = 0;

    constructor(private readonly options: ReminderEvaluatorOptions) {
        this.now = options.now ?? Date.now;
    }

    /**
     * Tier 1 of the cascade: judge the state alone, from the anchor and the caller's fitted transcript.
     *
     * Answered before the pool exists, because the pool is built from it. It is the cheap half: one choice
     * question over a short transcript, where the pool ask pays for a question per reminder. When this answer's
     * phase was not confident, the caller asks the same question again on its own, with the window transcript.
     */
    async evaluateState(context: ReminderContext): Promise<ReminderStateConsult> {
        const { config } = this.options;
        if (!reminderEnabled(config)) {
            return { status: "disabled", latencyMs: 0, state: {} };
        }

        const model = resolveClassifier(this.options.registry, config);
        if (model === undefined) {
            return { status: "disabled", latencyMs: 0, state: {} };
        }

        const key = reminderStateCacheKey(model, context);
        const cached = this.stateCache.get(key);
        if (cached !== undefined) {
            return stateConsultFrom(cached, "cached", 0);
        }

        if (this.now() < this.cooldownUntil) {
            return { status: "cooldown", latencyMs: 0, state: {} };
        }

        const started = this.now();
        const classified = await this.classify(
            model,
            reminderStateRequest(context.heldPhase, context.transcript ?? ""),
        );
        const { result } = classified;
        const latencyMs = this.now() - started;

        if (result.stopReason !== "stop") {
            this.cooldownUntil = this.now() + (config.cooldownMs ?? DEFAULT_COOLDOWN_MS);

            return {
                status: classified.timedOut ? "timeout" : "error",
                latencyMs,
                state: {},
                ...(result.usage === undefined ? {} : { usage: result.usage }),
            };
        }

        const phase = result.answers[REMINDER_PHASE_QUESTION];
        const answer: CachedStateAnswer = {
            state: reminderStateFrom(result.answers, context.heldPhase),
            ...(phase?.type === "choice" ? { phaseConfidence: phase.confidence } : {}),
            // The raw answer beside the accepted one: the two differ exactly when the gate held a quiet
            // disagreement, which is the case a frozen phase is diagnosed from.
            ...(phase?.type === "choice" && isReminderPhase(phase.choice)
                ? { answeredPhase: phase.choice }
                : {}),
        };
        this.rememberState(key, answer);

        return stateConsultFrom(answer, "answered", latencyMs, result.usage);
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
        const classified = await this.classify(model, this.choiceRequest(context, form));
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
        const extras = extraAnswersFrom(result.answers, context.extraQuestions);
        if (decision === undefined) {
            // An unreadable answer still keeps whatever came back, so the state keeps building.
            return consultFrom({ scores, extras }, "abstained", latencyMs, result.usage);
        }

        const answer: CachedReminderAnswer = { decision, scores, extras };
        this.remember(key, answer);

        return consultFrom(answer, "answered", latencyMs, result.usage);
    }

    /** The tier-2 request: the pool's questions, whose state is the signals and the planned window. */
    private choiceRequest(context: ReminderContext, form: ReminderQuestionForm): ClassifierContext {
        return reminderChoiceRequest(
            buildReminderState(context),
            context.options,
            context.extraQuestions,
            form,
        );
    }

    private rememberState(key: string, answer: CachedStateAnswer): void {
        if (this.stateCache.size >= CACHE_LIMIT) {
            const oldest = this.stateCache.keys().next().value;
            if (oldest !== undefined) {
                this.stateCache.delete(oldest);
            }
        }

        this.stateCache.set(key, answer);
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

/** A tier-1 consult response from its cached answer. */
function stateConsultFrom(
    parts: CachedStateAnswer,
    status: ReminderStatus,
    latencyMs: number,
    usage?: Usage,
): ReminderStateConsult {
    const consult: ReminderStateConsult = { status, latencyMs, state: { ...parts.state } };

    if (parts.phaseConfidence !== undefined) {
        consult.phaseConfidence = parts.phaseConfidence;
    }
    if (parts.answeredPhase !== undefined) {
        consult.answeredPhase = parts.answeredPhase;
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

/**
 * A state answer keyed by what its own request carries: the anchor, the transcript, and the request line.
 *
 * The pool, the signals and the extra questions are deliberately absent - the state request does not send them,
 * so a change in any of them cannot change its answer.
 */
function reminderStateCacheKey(model: Classifier, context: ReminderContext): string {
    return JSON.stringify([
        model.provider,
        model.id,
        context.heldPhase ?? null,
        context.transcript ?? "",
        context.request ?? "",
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
