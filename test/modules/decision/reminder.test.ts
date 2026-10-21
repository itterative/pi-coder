import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
    ClassifierAnswer,
    ClassifierContext,
    ClassifierQuestion,
    ClassifierResult,
    ModelsClassifierOptions,
} from "@earendil-works/pi-ai";

import {
    DEFAULT_REMINDER_MIN_PROBABILITY,
    REMINDER_FINISHING_QUESTION,
    REMINDER_PHASE_CRITERIA,
    REMINDER_PHASE_QUESTION,
    REMINDER_UNVALIDATED_QUESTION,
    ReminderEvaluator,
    buildReminderState,
    consultReminderSelection,
    reminderDecisionFrom,
    reminderEnabled,
    reminderRequest,
    reminderStateFrom,
    resetDecisionEvaluator,
    type ClassifierRegistry,
    type DecisionModelConfig,
    type ReminderContext,
    type ReminderEvaluatorOptions,
    type ReminderOption,
} from "../../../src/modules/decision";
import { DECISION_PROVIDER_ID } from "../../../src/modules/decision/provider";
import { stubContext, stubSessionManager } from "../../helpers/pi-stub";

import {
    choiceAnswer,
    classifier,
    classifierModelRegistry,
    reminderResult,
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
        options.behavior ?? (async (model) => reminderResult(model, { sandbox: 0.9, todo: 0.05 }));
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
    it("carries the request and the recent window only when present", () => {
        expect(buildReminderState({ options: OPTIONS })).toEqual({});

        const state = buildReminderState({
            request: "run the tests",
            recent: [{ role: "command", text: "npm test" }],
            options: OPTIONS,
        });

        expect(state).toEqual({
            request: "run the tests",
            recent_messages: [{ role: "command", text: "npm test" }],
        });
    });

    it("merges the caller's signals into the state", () => {
        const state = buildReminderState({
            request: "run the tests",
            options: OPTIONS,
            signals: {
                cwd: "/repo",
                session: {
                    user_turns: 4,
                    context_tokens: 12_000,
                    tools: { bash: 2 },
                    tests_run: false,
                },
                reminders_shown: [{ id: "sandbox", turns_ago: 3 }],
                todo: { completed: 1, total: 2, current: "wire it" },
                memories: ["agents", "testing"],
            },
        });

        expect(state).toEqual({
            request: "run the tests",
            cwd: "/repo",
            session: {
                user_turns: 4,
                context_tokens: 12_000,
                tools: { bash: 2 },
                tests_run: false,
            },
            reminders_shown: [{ id: "sandbox", turns_ago: 3 }],
            todo: { completed: 1, total: 2, current: "wire it" },
            memories: ["agents", "testing"],
        });
    });

    it("asks one probability question per offered reminder", () => {
        const request = reminderRequest({ request: "run the tests" }, OPTIONS);

        for (const option of OPTIONS) {
            const question = request.questions[option.id];

            expect(question?.type).toBe("bool");
            expect(question?.instructions).toContain(option.guidance);
        }

        expect(Object.keys(request.questions)).toEqual([
            ...OPTIONS.map((option) => option.id),
            REMINDER_PHASE_QUESTION,
            REMINDER_FINISHING_QUESTION,
            REMINDER_UNVALIDATED_QUESTION,
        ]);
    });

    it("piggybacks the phase, finishing, and unvalidated questions", () => {
        const request = reminderRequest({ request: "run the tests" }, OPTIONS);

        expect(choiceCriteria(request.questions[REMINDER_PHASE_QUESTION])).toEqual(
            REMINDER_PHASE_CRITERIA,
        );
        expect(request.questions[REMINDER_FINISHING_QUESTION]?.type).toBe("bool");
        expect(request.questions[REMINDER_UNVALIDATED_QUESTION]?.type).toBe("bool");
    });

    it("reads the piggybacked labels and drops unreadable ones", () => {
        const read = (answers: Record<string, ClassifierAnswer>) => reminderStateFrom(answers);

        expect(
            read({
                [REMINDER_PHASE_QUESTION]: choiceAnswer("debugging", 0.9),
                [REMINDER_FINISHING_QUESTION]: { type: "bool", probability: 0.2 },
                [REMINDER_UNVALIDATED_QUESTION]: { type: "bool", probability: 0.8 },
            }),
        ).toEqual({ phase: "debugging", finishing: false, unvalidated: true });

        expect(read({})).toEqual({});
        expect(read({ [REMINDER_PHASE_QUESTION]: choiceAnswer("not-a-phase", 0.9) })).toEqual({});
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

    it("returns the model's choice and labels, and caches the identical consult", async () => {
        const { evaluator, classify } = harness({
            behavior: async (model) =>
                reminderResult(
                    model,
                    { sandbox: 0.9, todo: 0.05 },
                    {
                        phase: "debugging",
                        finishing: 0.2,
                        unvalidated: 0.8,
                    },
                ),
        });

        expect(await evaluator.evaluate(context)).toMatchObject({
            status: "answered",
            decision: { kind: "reminder", id: "sandbox" },
            state: { phase: "debugging", finishing: false, unvalidated: true },
            scores: { sandbox: 0.9, todo: 0.05 },
        });
        expect(await evaluator.evaluate(context)).toMatchObject({
            status: "cached",
            decision: { kind: "reminder", id: "sandbox" },
            state: { phase: "debugging", finishing: false, unvalidated: true },
        });
        expect(classify).toHaveBeenCalledTimes(1);
    });

    it("preserves a deliberate none when every probability is below the threshold", async () => {
        const { evaluator } = harness({
            behavior: async (model) => reminderResult(model, { sandbox: 0.1, todo: 0.2 }),
        });

        expect(await evaluator.evaluate(context)).toMatchObject({
            status: "answered",
            decision: { kind: "none" },
        });
    });

    it("abstains on an unreadable answer but keeps readable labels", async () => {
        const { evaluator } = harness({
            behavior: async (model) =>
                reminderResult(model, { "not-offered": 0.8 }, { phase: "verifying" }),
        });

        const consult = await evaluator.evaluate(context);

        expect(consult.status).toBe("abstained");
        expect(consult.decision).toBeUndefined();
        expect(consult.state).toEqual({ phase: "verifying" });
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

describe("consultReminderSelection", () => {
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
        expect(question?.type).toBe("bool");
        expect(question?.instructions).toContain(OPTIONS[0]?.guidance);
        // The live prompt is what the model judges, not the branch's previous request.
        expect(sent.state.request).toBe("run the tests");
        expect(sent.state.cwd).toBe("/repo");
        expect(sent.state.session).toEqual({ user_turns: 2, tests_run: false });
    });

    it("clips a caller-supplied prompt to the state's request limit", async () => {
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
        const request = sent.state.request;

        expect(typeof request).toBe("string");
        expect((request as string).length).toBeLessThanOrEqual(600);
        expect(request as string).toMatch(/…$/u);
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
