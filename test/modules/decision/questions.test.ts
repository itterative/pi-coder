import { describe, expect, it } from "vitest";

import type { ClassifierAnswer } from "@earendil-works/pi-ai";

import {
    ACTION_QUESTION,
    VETO_QUESTION,
    actionFromAnswers,
    buildQuestions,
    buildVetoQuestions,
    isDangerousVeto,
    vetoFromAnswers,
} from "../../../src/modules/decision";

function actionInstructions(questions: ReturnType<typeof buildQuestions>): string | undefined {
    const question = questions[ACTION_QUESTION];
    return question?.type === "choice" ? question.instructions : undefined;
}

describe("decision questions", () => {
    it("builds one choice question naming the three actions", () => {
        const questions = buildQuestions("single");
        const question = questions[ACTION_QUESTION];

        expect(question?.type).toBe("choice");
        if (question?.type !== "choice") {
            throw new Error("expected a choice question");
        }
        expect(Object.keys(question.criteria).toSorted()).toEqual(["host", "refuse", "sandbox"]);
    });

    it("changes the action instruction when the state carries history", () => {
        const plain = actionInstructions(buildQuestions("single"));
        const withHistory = actionInstructions(buildQuestions("single", { hasHistory: true }));

        expect(plain).toBeDefined();
        expect(withHistory).not.toBe(plain);
    });

    it("reads a valid choice answer", () => {
        const answers: Record<string, ClassifierAnswer> = {
            [ACTION_QUESTION]: {
                type: "choice",
                choice: "sandbox",
                probabilities: { sandbox: 0.8 },
                confidence: 0.8,
            },
        };

        expect(actionFromAnswers(answers)).toEqual({ action: "sandbox", confidence: 0.8 });
    });

    it("returns undefined for a missing answer", () => {
        expect(actionFromAnswers({})).toBeUndefined();
    });

    it("returns undefined for a non-choice answer", () => {
        const answers: Record<string, ClassifierAnswer> = {
            [ACTION_QUESTION]: { type: "bool", probability: 0.9 },
        };

        expect(actionFromAnswers(answers)).toBeUndefined();
    });

    it("returns undefined for a label outside the criteria", () => {
        const answers: Record<string, ClassifierAnswer> = {
            [ACTION_QUESTION]: {
                type: "choice",
                choice: "maybe",
                probabilities: { maybe: 1 },
                confidence: 1,
            },
        };

        expect(actionFromAnswers(answers)).toBeUndefined();
    });
});

describe("decision veto questions", () => {
    it("builds one choice question naming every veto reason", () => {
        const questions = buildVetoQuestions();
        const question = questions[VETO_QUESTION];

        expect(question?.type).toBe("choice");
        if (question?.type !== "choice") {
            throw new Error("expected a choice question");
        }
        expect(Object.keys(question.criteria).toSorted()).toEqual([
            "destructive",
            "exfiltration",
            "loses_content",
            "none",
            "privileged",
            "remote_code",
        ]);
    });

    it("reads a valid veto answer", () => {
        const answers: Record<string, ClassifierAnswer> = {
            [VETO_QUESTION]: {
                type: "choice",
                choice: "privileged",
                probabilities: { privileged: 0.95 },
                confidence: 0.95,
            },
        };

        expect(vetoFromAnswers(answers)).toEqual({ reason: "privileged", confidence: 0.95 });
    });

    it("returns undefined for a missing answer", () => {
        expect(vetoFromAnswers({})).toBeUndefined();
    });

    it("returns undefined for a non-choice answer", () => {
        const answers: Record<string, ClassifierAnswer> = {
            [VETO_QUESTION]: { type: "bool", probability: 0.9 },
        };

        expect(vetoFromAnswers(answers)).toBeUndefined();
    });

    it("returns undefined for a label outside the criteria", () => {
        const answers: Record<string, ClassifierAnswer> = {
            [VETO_QUESTION]: {
                type: "choice",
                choice: "bad",
                probabilities: { bad: 1 },
                confidence: 1,
            },
        };

        expect(vetoFromAnswers(answers)).toBeUndefined();
    });

    it("treats only `none` as not dangerous", () => {
        expect(isDangerousVeto("none")).toBe(false);

        for (const reason of [
            "destructive",
            "privileged",
            "exfiltration",
            "remote_code",
            "loses_content",
        ] as const) {
            expect(isDangerousVeto(reason)).toBe(true);
        }
    });
});
