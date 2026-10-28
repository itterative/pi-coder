import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
    ClassifierAnswer,
    ClassifierContext,
    ClassifierQuestion,
    ClassifierResult,
    ModelsClassifierOptions,
} from "@earendil-works/pi-ai";

import {
    consultReminderState,
    DEFAULT_REMINDER_FORM,
    DEFAULT_REMINDER_MIN_PROBABILITY,
    DEFAULT_REMINDER_MIN_SCORE,
    ITEM_CHARS,
    REMINDER_HELPFULNESS_CRITERIA,
    REMINDER_PHASE_CRITERIA,
    REMINDER_PHASE_INSTRUCTION,
    REMINDER_PHASE_QUESTION,
    ReminderEvaluator,
    PHASE_MOVE_CONFIDENCE,
    SHORT_WINDOW_CHARS,
    TRANSCRIPT_WINDOW_CHARS,
    consultReminderSelection,
    reminderChoiceRequest,
    reminderDecisionFrom,
    reminderEnabled,
    reminderScoreInstruction,
    reminderStateFrom,
    reminderStateRequest,
    resetDecisionEvaluator,
    type ClassifierRegistry,
    type DecisionModelConfig,
    type ReminderContext,
    type ReminderEvaluatorOptions,
    type ReminderOption,
} from "../../../src/modules/decision";
import { DECISION_PROVIDER_ID } from "../../../src/modules/decision/provider";
import { DECISION_STATUS_EVENT, isDecisionStatusEvent } from "../../../src/modules/decision/events";
import { stubContext, stubSessionManager } from "../../helpers/pi-stub";
import {
    assistantEntry,
    branch,
    cleanupBranches,
    textPart,
    toolCall,
    userEntry,
    type AppendedMessage,
} from "../../helpers/session-branch";

import {
    choiceAnswer,
    classifier,
    classifierModelRegistry,
    reminderResult,
    reminderScoreResult,
    type Classifier,
} from "./classifier";

/**
 * The reminder subject: one choice question over the caller's reminder list, with its own cache and cooldown
 * so a failed reminder request cannot pause a permission verdict.
 */

type Behavior = (
    model: Classifier,
    context: ClassifierContext,
    signal: AbortSignal | undefined,
) => Promise<ClassifierResult>;

const MODEL = classifier(DECISION_PROVIDER_ID, "test-classifier");

const OPTIONS: readonly ReminderOption[] = [
    { id: "sandbox", guidance: "Bash is in use and the confinement gate is easy to overlook." },
    { id: "todo", guidance: "Multi-step work is underway without a current TODO.md." },
];

interface HarnessOptions {
    models?: Classifier[];
    behavior?: Behavior;
    config?: DecisionModelConfig;
    clock?: { t: number };
}

function harness(options: HarnessOptions = {}) {
    const models = options.models ?? [MODEL];
    const behavior =
        options.behavior ??
        (async (model) => reminderScoreResult(model, { sandbox: 2, todo: 0.1 }));
    const classify = vi.fn(
        (model: Classifier, context: ClassifierContext, opts?: ModelsClassifierOptions) =>
            behavior(model, context, opts?.signal),
    );
    const registry: ClassifierRegistry = {
        getModelOfType: (_type, provider, modelId) =>
            models.find((model) => model.provider === provider && model.id === modelId),
        getModelsOfType: (_type, provider) =>
            provider === undefined ? models : models.filter((model) => model.provider === provider),
        classify,
    };
    const clock = options.clock ?? { t: 0 };
    const evaluatorOptions: ReminderEvaluatorOptions = {
        registry,
        config: {
            enabled: true,
            reminders: true,
            provider: DECISION_PROVIDER_ID,
            model: MODEL.id,
            ...options.config,
        },
        now: () => clock.t,
    };

    return { evaluator: new ReminderEvaluator(evaluatorOptions), classify, registry, clock };
}

const context: ReminderContext = { request: "run the tests", options: OPTIONS };

beforeEach(() => {
    // The gate keeps one evaluator per config; without this, a later consult reuses an earlier test's mock.
    resetDecisionEvaluator();
});

/** Narrow the wide `ClassifierQuestion` union to the criteria a choice question carries. */
function choiceCriteria(question: ClassifierQuestion | undefined): Record<string, string> {
    if (question === undefined || question.type !== "choice") {
        throw new Error("expected a choice question");
    }

    return question.criteria;
}

describe("reminder state, request, and answer", () => {
    it("asks one score question per offered reminder by default", () => {
        const request = reminderChoiceRequest({ conversation: "User: run the tests" }, OPTIONS);

        for (const option of OPTIONS) {
            const question = request.questions[option.id];

            expect(question?.type).toBe("score");
            if (question?.type !== "score") {
                throw new Error("expected a score question");
            }
            expect(question.criteria).toEqual([...REMINDER_HELPFULNESS_CRITERIA]);
            expect(question.instructions).toContain(option.guidance);
        }

        // The state question is not part of the pool's request: it has its own state and its own call.
        expect(Object.keys(request.questions)).toEqual(OPTIONS.map((option) => option.id));
        expect(DEFAULT_REMINDER_FORM).toBe("score");
        expect(reminderScoreInstruction(OPTIONS[0] as ReminderOption)).toContain(
            OPTIONS[0]?.guidance ?? "",
        );
    });

    it("asks one probability question per reminder in the bool form", () => {
        const request = reminderChoiceRequest(
            { conversation: "User: run the tests" },
            OPTIONS,
            undefined,
            "bool",
        );

        for (const option of OPTIONS) {
            const question = request.questions[option.id];

            expect(question?.type).toBe("bool");
            expect(question?.instructions).toContain(option.guidance);
        }
    });

    it("asks the state question alone, against the anchor and the transcript", () => {
        const request = reminderStateRequest("validating", "User: run the tests");

        expect(request.state).toEqual({
            current_state: "validating",
            conversation: "User: run the tests",
        });
        expect(Object.keys(request.questions)).toEqual([REMINDER_PHASE_QUESTION]);
        expect(request.questions[REMINDER_PHASE_QUESTION]?.instructions).toBe(
            REMINDER_PHASE_INSTRUCTION,
        );
        expect(choiceCriteria(request.questions[REMINDER_PHASE_QUESTION])).toEqual(
            REMINDER_PHASE_CRITERIA,
        );

        // No state accepted yet: the anchor reads `none`, which is what the probe sent.
        expect(reminderStateRequest(undefined, "").state).toEqual({
            current_state: "none",
            conversation: "",
        });
    });

    it("carries the caller's extra questions, with a built-in id winning a collision", () => {
        const extra: ClassifierQuestion = {
            type: "bool",
            instructions: "Is the work on the second item?",
            criteria: { true: "yes", false: "no" },
        };

        const request = reminderChoiceRequest({}, OPTIONS, { todo_item_second: extra });
        expect(request.questions.todo_item_second).toEqual(extra);

        // An extra question can never replace a reminder question the decision itself reads.
        const collided = reminderChoiceRequest({}, OPTIONS, { todo: extra });
        expect(collided.questions.todo?.instructions).toContain(OPTIONS[1]?.guidance);
    });

    it("reads the answered phase and drops an unreadable one", () => {
        const read = (answers: Record<string, ClassifierAnswer>) => reminderStateFrom(answers);
        expect(read({ [REMINDER_PHASE_QUESTION]: choiceAnswer("implementing", 0.9) })).toEqual({
            phase: "implementing",
        });

        expect(read({})).toEqual({});
        expect(read({ [REMINDER_PHASE_QUESTION]: choiceAnswer("not-a-phase", 0.9) })).toEqual({});
    });

    it("moves the phase only on an agreement or a confident answer", () => {
        const phase = (choice: string, confidence: number) =>
            reminderStateFrom(
                { [REMINDER_PHASE_QUESTION]: choiceAnswer(choice, confidence) },
                "implementing",
            );

        // The accept rule, as the mid-run state probe applies it: the phase in hand is what a quiet
        // disagreement is measured against, and only a confident answer moves it.
        expect(phase("implementing", 0.2)).toEqual({ phase: "implementing" });
        expect(phase("validating", 0.49)).toEqual({ phase: "implementing" });
        expect(phase("validating", PHASE_MOVE_CONFIDENCE)).toEqual({ phase: "validating" });
        expect(phase("validating", 0.9)).toEqual({ phase: "validating" });

        // Nothing accepted yet: the first answer is taken as it comes, however unsure.
        expect(
            reminderStateFrom({ [REMINDER_PHASE_QUESTION]: choiceAnswer("documenting", 0.1) }),
        ).toEqual({
            phase: "documenting",
        });
    });

    it("holds the accepted phase through a state answer whose move is unsure", async () => {
        const behavior = async (model: Classifier) =>
            reminderScoreResult(model, {}, { phase: "validating", phaseConfidence: 0.2 });
        const { evaluator } = harness({ behavior });

        // The state the ask reports is the accepted one, so the caller's merge records nothing and the phase in
        // hand survives an unsure answer instead of being replaced by it.
        const unsure = await evaluator.evaluateState({
            ...context,
            heldPhase: "implementing",
            transcript: "User: run the tests",
        });

        expect(unsure.status).toBe("answered");
        expect(unsure.state.phase).toBe("implementing");
        expect(unsure.answeredPhase).toBe("validating");

        const { evaluator: confidentEvaluator } = harness({
            behavior: async (model) =>
                reminderScoreResult(model, {}, { phase: "validating", phaseConfidence: 0.9 }),
            clock: { t: 0 },
        });
        const moved = await confidentEvaluator.evaluateState({
            ...context,
            heldPhase: "implementing",
            transcript: "User: run the tests",
        });

        // A confident move is the one thing that replaces it.
        expect(moved.state.phase).toBe("validating");
    });

    it("picks the strongest reminder above the threshold, and none below it", () => {
        const answers = (
            probabilities: Record<string, number>,
        ): Record<string, ClassifierAnswer> => {
            const result: Record<string, ClassifierAnswer> = {};
            for (const [id, probability] of Object.entries(probabilities)) {
                result[id] = { type: "bool", probability };
            }

            return result;
        };

        expect(reminderDecisionFrom(answers({ sandbox: 0.9, todo: 0.2 }), OPTIONS)).toEqual({
            kind: "reminder",
            id: "sandbox",
        });
        expect(reminderDecisionFrom(answers({ sandbox: 0.2, todo: 0.8 }), OPTIONS)).toEqual({
            kind: "reminder",
            id: "todo",
        });
        // Exactly at the threshold is enough.
        expect(
            reminderDecisionFrom(answers({ sandbox: DEFAULT_REMINDER_MIN_PROBABILITY }), OPTIONS),
        ).toEqual({ kind: "reminder", id: "sandbox" });
        // Every answer below the threshold is a deliberate none.
        expect(reminderDecisionFrom(answers({ sandbox: 0.1, todo: 0.2 }), OPTIONS)).toEqual({
            kind: "none",
        });
        // No offered id answered at all: unreadable, so the caller falls back to its schedule.
        expect(reminderDecisionFrom(answers({ "not-offered": 0.9 }), OPTIONS)).toBeUndefined();
        expect(reminderDecisionFrom({}, OPTIONS)).toBeUndefined();

        // The score form reads levels instead of probabilities, gated by its own threshold.
        const levels = (scores: Record<string, number>): Record<string, ClassifierAnswer> => {
            const result: Record<string, ClassifierAnswer> = {};
            for (const [id, score] of Object.entries(scores)) {
                result[id] = { type: "score", score, confidence: 0.5 };
            }

            return result;
        };

        expect(
            reminderDecisionFrom(
                levels({ sandbox: 1.4, todo: 0.3 }),
                OPTIONS,
                DEFAULT_REMINDER_MIN_SCORE,
            ),
        ).toEqual({ kind: "reminder", id: "sandbox" });
        expect(
            reminderDecisionFrom(
                levels({ sandbox: 0.4, todo: 0.2 }),
                OPTIONS,
                DEFAULT_REMINDER_MIN_SCORE,
            ),
        ).toEqual({ kind: "none" });
    });

    it("gates the score form above the mild rung the model's own answers sit at", () => {
        const level = (score: number): Record<string, ClassifierAnswer> => ({
            sandbox: { type: "score", score, confidence: 0.5 },
        });

        // The scale is `[no help, mild, useful, important]`, so 1.0 *is* the mild rung - and it is the median of
        // the model's answers, which makes a gate there a coin flip rather than a decision. The shipped gate
        // sits just above it, at the threshold the shape comparisons were run at.
        expect(DEFAULT_REMINDER_MIN_SCORE).toBe(1.25);
        expect(reminderDecisionFrom(level(1.1), OPTIONS, DEFAULT_REMINDER_MIN_SCORE)).toEqual({
            kind: "none",
        });
        expect(
            reminderDecisionFrom(
                level(DEFAULT_REMINDER_MIN_SCORE),
                OPTIONS,
                DEFAULT_REMINDER_MIN_SCORE,
            ),
        ).toEqual({ kind: "reminder", id: "sandbox" });
    });

    it("only enables the subject when the config opts in", () => {
        expect(reminderEnabled({ enabled: true, reminders: true })).toBe(true);
        expect(reminderEnabled({ enabled: true, reminders: false })).toBe(false);
        expect(reminderEnabled({ enabled: true })).toBe(false);
        expect(reminderEnabled({ reminders: true })).toBe(false);
    });
});

describe("ReminderEvaluator", () => {
    it("abstains without asking when the config does not enable reminders", async () => {
        const { evaluator, classify } = harness({ config: { reminders: false } });

        expect(await evaluator.evaluate(context)).toMatchObject({ status: "disabled" });
        expect(classify).not.toHaveBeenCalled();
    });

    it("returns the model's choice and caches the identical consult", async () => {
        const { evaluator, classify } = harness({
            behavior: async (model) =>
                reminderScoreResult(model, { sandbox: 2, todo: 0.1 }, { phase: "implementing" }),
        });

        // The pool consult reports the choice and the scores; the state is the state ask's answer, not this
        // one's, so nothing here reads a label.
        expect(await evaluator.evaluate(context)).toMatchObject({
            status: "answered",
            decision: { kind: "reminder", id: "sandbox" },
            scores: { sandbox: 2, todo: 0.1 },
        });
        expect(await evaluator.evaluate(context)).toMatchObject({
            status: "cached",
            decision: { kind: "reminder", id: "sandbox" },
        });
        expect(classify).toHaveBeenCalledTimes(1);
    });

    it("keys the cache on the conversation the request sends", async () => {
        const { evaluator, classify } = harness();

        expect(await evaluator.evaluate({ ...context, conversation: "User: first" })).toMatchObject(
            { status: "answered" },
        );
        expect(await evaluator.evaluate({ ...context, conversation: "User: first" })).toMatchObject(
            {
                status: "cached",
            },
        );
        // A different conversation is a different state, so the cached answer cannot be served into it.
        expect(
            await evaluator.evaluate({ ...context, conversation: "User: second" }),
        ).toMatchObject({ status: "answered" });
        expect(classify).toHaveBeenCalledTimes(2);

        // The signals and the request are not in the state any more, so they must not fragment the cache:
        // an answer for one conversation stands for the same conversation beside any other signals.
        expect(
            await evaluator.evaluate({
                ...context,
                conversation: "User: first",
                request: "a different request",
                signals: { cwd: "/elsewhere" },
            }),
        ).toMatchObject({ status: "cached" });
        expect(classify).toHaveBeenCalledTimes(2);
    });

    it("preserves a deliberate none when every level is below the threshold", async () => {
        const { evaluator } = harness({
            behavior: async (model) => reminderScoreResult(model, { sandbox: 0.2, todo: 0.3 }),
        });

        expect(await evaluator.evaluate(context)).toMatchObject({
            status: "answered",
            decision: { kind: "none" },
        });
    });

    it("gates on the probability when the configured form is bool", async () => {
        const { evaluator } = harness({
            config: { reminderForm: "bool" },
            behavior: async (model) => reminderResult(model, { sandbox: 0.5, todo: 0.1 }),
        });

        expect(await evaluator.evaluate(context)).toMatchObject({
            status: "answered",
            decision: { kind: "reminder", id: "sandbox" },
        });
    });

    it("gates on reminderMinScore in the score form", async () => {
        const { evaluator } = harness({
            config: { reminderForm: "score", reminderMinScore: 2 },
            behavior: async (model) => reminderScoreResult(model, { sandbox: 1.5, todo: 0.1 }),
        });

        expect(await evaluator.evaluate(context)).toMatchObject({
            status: "answered",
            decision: { kind: "none" },
        });
    });

    it("returns the caller's extra answers with the decision, and caches them", async () => {
        const extra: ClassifierQuestion = {
            type: "bool",
            instructions: "Is the work on the second item?",
            criteria: { true: "yes", false: "no" },
        };
        const withExtras: ReminderContext = {
            ...context,
            extraQuestions: { todo_item_second: extra },
        };
        const extras = { todo_item_second: { type: "bool" as const, probability: 0.8 } };
        const { evaluator, classify } = harness({
            behavior: async (model) => reminderScoreResult(model, { sandbox: 2 }, {}, extras),
        });

        expect(await evaluator.evaluate(withExtras)).toMatchObject({
            status: "answered",
            decision: { kind: "reminder", id: "sandbox" },
            extras,
        });
        expect(await evaluator.evaluate(withExtras)).toMatchObject({ status: "cached", extras });

        // A different extra question is a different request, so the cache cannot serve the first answer.
        await evaluator.evaluate({
            ...context,
            extraQuestions: { ...withExtras.extraQuestions, todo_item_third: extra },
        });
        expect(classify).toHaveBeenCalledTimes(2);
    });

    it("keeps the caller's extra answers when the reminder answer is unreadable", async () => {
        const extra: ClassifierQuestion = {
            type: "bool",
            instructions: "Is the work on the second item?",
            criteria: { true: "yes", false: "no" },
        };
        const extras = { todo_item_second: { type: "bool" as const, probability: 0.8 } };
        const { evaluator } = harness({
            behavior: async (model) => reminderScoreResult(model, { "not-offered": 2 }, {}, extras),
        });

        const consult = await evaluator.evaluate({
            ...context,
            extraQuestions: { todo_item_second: extra },
        });

        expect(consult.status).toBe("abstained");
        expect(consult.extras).toEqual(extras);
    });

    it("abstains on an unreadable answer without inventing a decision", async () => {
        const { evaluator } = harness({
            behavior: async (model) => reminderScoreResult(model, { "not-offered": 2 }),
        });

        const consult = await evaluator.evaluate(context);

        expect(consult.status).toBe("abstained");
        expect(consult.decision).toBeUndefined();
    });

    it("cools down after a failed request and recovers", async () => {
        const clock = { t: 0 };
        const { evaluator, classify } = harness({
            clock,
            behavior: async () => {
                throw new Error("endpoint down");
            },
        });

        expect((await evaluator.evaluate(context)).status).toBe("error");
        expect((await evaluator.evaluate(context)).status).toBe("cooldown");

        clock.t += 30_001;
        expect((await evaluator.evaluate(context)).status).toBe("error");
        expect(classify).toHaveBeenCalledTimes(2);
    });
});

/**
 * A branch whose conversation is longer than the reminder window's budget, so the allocator has to drop items
 * and a carried window can be checked whole against what was actually sent.
 */
function longBranch(): SessionEntry[] {
    const messages: AppendedMessage[] = [];
    for (let turn = 1; turn <= 6; turn += 1) {
        messages.push(userEntry(`ask ${String(turn)}`, turn * 2 - 1));
        messages.push(
            assistantEntry(
                [
                    textPart(
                        `Answer ${String(turn)}. ` +
                            "reviewing the branch and the files around it before editing. ".repeat(
                                12,
                            ),
                    ),
                    toolCall(
                        "bash",
                        {
                            command:
                                `rg step${String(turn)} src` + " --with-line-numbers".repeat(20),
                        },
                        `c${String(turn)}`,
                    ),
                ],
                turn * 2,
            ),
        );
    }

    return branch(messages);
}

describe("consultReminderSelection", () => {
    afterEach(cleanupBranches);

    function consultContext(registry: ClassifierRegistry) {
        return stubContext({
            sessionManager: stubSessionManager({ getBranch: () => [] }),
            modelRegistry: classifierModelRegistry(registry),
        });
    }

    it("returns the decision with the model's question in the request", async () => {
        const { registry, classify } = harness();
        const config = {
            enabled: true,
            reminders: true,
            provider: DECISION_PROVIDER_ID,
            model: MODEL.id,
        };

        const consult = await consultReminderSelection({
            ctx: consultContext(registry),
            config,
            options: OPTIONS,
            request: "run the tests",
            signals: { cwd: "/repo", session: { user_turns: 2, tests_run: false } },
        });

        expect(consult).toMatchObject({
            status: "answered",
            decision: { kind: "reminder", id: "sandbox" },
        });

        const sent = classify.mock.calls[0]?.[1] as ClassifierContext;
        const question = sent.questions[OPTIONS[0]?.id ?? ""];
        expect(question?.type).toBe("score");
        expect(question?.instructions).toContain(OPTIONS[0]?.guidance);
        // The state is one conversation, and it carries the live prompt rather than the branch's previous
        // request: neither the signals nor a separate `request` field rides with it.
        expect(Object.keys(sent.state)).toEqual(["conversation"]);
        expect(sent.state.conversation).toBe("User: run the tests");
    });

    it("sends no state at all when the branch has no conversation to render", async () => {
        const { registry, classify } = harness();

        const consult = await consultReminderSelection({
            ctx: consultContext(registry),
            config: {
                enabled: true,
                reminders: true,
                provider: DECISION_PROVIDER_ID,
                model: MODEL.id,
            },
            options: OPTIONS,
        });

        // An empty window sends `{}` rather than `conversation: ""`: the key would carry no fact, and an
        // empty conversation reads to a small model like a claim that there is no context at all.
        expect(consult.status).toBe("answered");
        expect(classify.mock.calls[0]?.[1]).toMatchObject({ state: {} });
        expect(consult.window).toEqual({ items: [], omitted: 0 });
    });

    it("counts the consult in flight on the caller's bus", async () => {
        const { registry } = harness();
        const events = createEventBus();
        const checks: number[] = [];
        events.on(DECISION_STATUS_EVENT, (data) => {
            if (isDecisionStatusEvent(data)) {
                checks.push(data.checking);
            }
        });

        await consultReminderSelection({
            ctx: consultContext(registry),
            config: {
                enabled: true,
                reminders: true,
                provider: DECISION_PROVIDER_ID,
                model: MODEL.id,
            },
            options: OPTIONS,
            request: "run the tests",
            events,
        });

        // One consult counted once, so the badge animates for the whole answer and returns to idle after it.
        expect(checks).toEqual([1, 0]);
    });

    it("opens no check when the reminder subject is off", async () => {
        const { registry } = harness();
        const events = createEventBus();
        const checks: number[] = [];
        events.on(DECISION_STATUS_EVENT, (data) => {
            if (isDecisionStatusEvent(data)) {
                checks.push(data.checking);
            }
        });

        const consult = await consultReminderSelection({
            ctx: consultContext(registry),
            config: {
                enabled: true,
                reminders: false,
                provider: DECISION_PROVIDER_ID,
                model: MODEL.id,
            },
            options: OPTIONS,
            events,
        });

        // A subject that never reaches the endpoint must not blink the badge on its way out.
        expect(consult.status).toBe("disabled");
        expect(checks).toEqual([]);
    });

    it("carries the window it judged back on the answer", async () => {
        const { registry, classify } = harness();
        const config = {
            enabled: true,
            reminders: true,
            provider: DECISION_PROVIDER_ID,
            model: MODEL.id,
        };
        const entries = longBranch();

        const consult = await consultReminderSelection({
            ctx: stubContext({
                sessionManager: stubSessionManager({ getBranch: () => entries }),
                modelRegistry: classifierModelRegistry(registry),
            }),
            config,
            options: OPTIONS,
            request: "run the tests",
        });

        expect(consult.status).toBe("answered");
        // The window is the read this consult made, and it is the one the state is made of: a debug entry that
        // recorded anything else, or re-read the branch later, would be describing a window that was not sent.
        const sent = classify.mock.calls[0]?.[1] as ClassifierContext;
        const conversation = sent.state.conversation as string;
        const lines = conversation.split("\n");

        expect(Object.keys(sent.state)).toEqual(["conversation"]);
        // The conversation carries the turn's request itself, as its newest user line - the state has no
        // separate `request` field to duplicate it into.
        expect(lines.at(-1)).toBe("User: run the tests");
        // The branch's own turns do not fit the 2000-char budget, so the allocator trimmed it rather than
        // sending everything: the newest fact is never the one that is dropped.
        expect(consult.window?.omitted).toBeGreaterThan(0);
        expect(consult.window?.items.length).toBe(lines.length - 1);
        expect(consult.window?.items.at(-1)).toEqual({ role: "user", text: "run the tests" });
        // The guarantee holds at the newest end too: the turn's own tool call is kept and sent whole from its
        // start, not trimmed away for a longer older item.
        const newestCommand = consult.window?.items.findLast((item) => item.role === "command");
        expect(newestCommand?.text.startsWith("rg step6 src")).toBe(true);
        // Every recorded item is the text the model read, not the branch's unclipped atom.
        for (const item of consult.window?.items ?? []) {
            expect(conversation).toContain(item.text);
            expect(item.text.length).toBeLessThanOrEqual(ITEM_CHARS);
        }
    });

    it("clips a caller-supplied prompt to the window's share of the conversation", async () => {
        const { registry, classify } = harness();
        const config = {
            enabled: true,
            reminders: true,
            provider: DECISION_PROVIDER_ID,
            model: MODEL.id,
        };

        await consultReminderSelection({
            ctx: consultContext(registry),
            config,
            options: OPTIONS,
            request: "x".repeat(1_000),
        });

        const sent = classify.mock.calls[0]?.[1] as ClassifierContext;
        const requestLine = String(sent.state.conversation).split("\n").at(-1);

        // The request is clipped to the state's request limit before it becomes a window item, and the window
        // then gives it its own share, so a template expansion never crowds out the conversation beside it.
        expect(requestLine?.startsWith("User: x")).toBe(true);
        expect(requestLine?.length).toBeLessThanOrEqual(ITEM_CHARS + "User: ".length);
        expect(requestLine).toMatch(/…$/u);
    });

    it("does not ask when the config lacks the opt-in", async () => {
        const { registry, classify } = harness();

        const consult = await consultReminderSelection({
            ctx: consultContext(registry),
            config: { enabled: true },
            options: OPTIONS,
        });

        expect(consult).toMatchObject({ status: "disabled" });
        expect(classify).not.toHaveBeenCalled();
    });
});

describe("consultReminderState", () => {
    afterEach(cleanupBranches);

    function stateContext(registry: ClassifierRegistry, entries: SessionEntry[]) {
        return stubContext({
            sessionManager: stubSessionManager({ getBranch: () => entries }),
            modelRegistry: classifierModelRegistry(registry),
        });
    }

    const config = {
        enabled: true,
        reminders: true,
        provider: DECISION_PROVIDER_ID,
        model: MODEL.id,
    };

    it("asks the state question alone, on the short transcript", async () => {
        const behavior = async (model: Classifier) =>
            reminderResult(model, {}, { phase: "validating", phaseConfidence: 0.9 });
        const { registry, classify } = harness({ behavior });
        const events = createEventBus();
        const checks: number[] = [];
        events.on(DECISION_STATUS_EVENT, (data) => {
            if (isDecisionStatusEvent(data)) {
                checks.push(data.checking);
            }
        });

        const consult = await consultReminderState({
            ctx: stateContext(registry, longBranch()),
            config,
            request: "run the tests",
            events,
            heldPhase: "implementing",
        });

        const sent = classify.mock.calls[0]?.[1] as ClassifierContext;
        // Tier 1 is the state half of the cascade: one question, no per-reminder questions, because the pool it
        // decides does not exist yet. The state is the measured shape - the anchor and the transcript - and the
        // transcript is fitted from the branch, so the request carries no `recent_messages` and no signals.
        expect(Object.keys(sent.questions)).toEqual([REMINDER_PHASE_QUESTION]);
        expect(Object.keys(sent.state ?? {}).toSorted()).toEqual(["conversation", "current_state"]);
        expect(sent.state?.current_state).toBe("implementing");
        expect(typeof sent.state?.conversation).toBe("string");
        expect((sent.state?.conversation as string).length).toBeLessThanOrEqual(SHORT_WINDOW_CHARS);
        // A confident answer moves the phase off the one in hand.
        expect(consult.state).toEqual({ phase: "validating" });
        expect(consult.phaseConfidence).toBe(0.9);
        expect(consult.answeredPhase).toBe("validating");
        // The short transcript is the point of the tier: the long branch does not fit in it, and what was
        // judged is carried back on the consult rather than re-derived from the branch.
        expect(consult.transcript).toBe(sent.state?.conversation);
        expect((consult.transcript ?? "").length).toBeLessThanOrEqual(SHORT_WINDOW_CHARS);
        // Counted in flight like the selection consult, so the badge animates for it too.
        expect(checks).toEqual([1, 0]);
    });

    it("fits the transcript harder on the short ask than on the escalated one", async () => {
        const behavior = async (model: Classifier) =>
            reminderResult(model, {}, { phase: "validating", phaseConfidence: 0.9 });
        const { registry, classify } = harness({ behavior });
        const entries = longBranch();

        const short = await consultReminderState({ ctx: stateContext(registry, entries), config });
        const full = await consultReminderState({
            ctx: stateContext(registry, entries),
            config,
            windowChars: TRANSCRIPT_WINDOW_CHARS,
        });

        const shortSent = classify.mock.calls[0]?.[1] as ClassifierContext;
        const fullSent = classify.mock.calls[1]?.[1] as ClassifierContext;

        // The escalation asks the state question where the short transcript may have hidden what decided the
        // phase: the anchor and the question are the same, only the transcript budget differs.
        expect(fullSent.state?.current_state).toBe(shortSent.state?.current_state);
        expect(Object.keys(fullSent.questions)).toEqual(Object.keys(shortSent.questions));
        expect((fullSent.state?.conversation as string).length).toBeGreaterThan(
            (shortSent.state?.conversation as string).length,
        );
        expect(full.state).toEqual(short.state);
    });

    it("reports the phase confidence the accept rule measured", async () => {
        const behavior = async (model: Classifier) =>
            reminderResult(model, {}, { phase: "validating", phaseConfidence: 0.2 });
        const { registry } = harness({ behavior });

        const consult = await consultReminderState({
            ctx: stateContext(registry, []),
            config,
            heldPhase: "implementing",
        });

        // The state in hand is held, and the raw confidence is reported so the caller knows to escalate.
        expect(consult.state).toEqual({ phase: "implementing" });
        expect(consult.phaseConfidence).toBe(0.2);
        // What the answer itself named is kept beside the accepted state: the gate held `implementing`, the
        // model proposed `validating`, and that difference is the whole diagnosis of a frozen phase.
        expect(consult.answeredPhase).toBe("validating");
    });

    it("asks nothing for a subject that is off", async () => {
        const { registry, classify } = harness();

        const consult = await consultReminderState({
            ctx: stateContext(registry, []),
            config: {
                enabled: true,
                reminders: false,
                provider: DECISION_PROVIDER_ID,
                model: MODEL.id,
            },
        });

        expect(consult).toMatchObject({ status: "disabled", state: {} });
        expect(classify).not.toHaveBeenCalled();
    });
});
