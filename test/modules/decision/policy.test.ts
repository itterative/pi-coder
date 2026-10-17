import { describe, expect, it } from "vitest";

import {
    DEFAULT_MIN_CONFIDENCE,
    DEFAULT_VETO_GATE,
    DEFAULT_VETO_MIN_CONFIDENCE,
    applyVeto,
    decideWithPolicy,
    foldAnswers,
    shouldConsultVeto,
    vetoEnabled,
    type DecisionReason,
    type PolicyInput,
    type StrategyAnswer,
} from "../../../src/modules/decision";

function decide(overrides: Partial<PolicyInput> = {}) {
    return decideWithPolicy({
        action: undefined,
        confidence: undefined,
        config: {},
        sandboxAvailable: true,
        ...overrides,
    });
}

describe("decision policy", () => {
    it("abstains when the model did not answer", () => {
        expect(decide()).toEqual({ outcome: "abstain", auto: false, reason: "no model answer" });
    });

    it("abstains on refuse regardless of confidence or config", () => {
        expect(decide({ action: "refuse", confidence: 1 })).toEqual({
            outcome: "abstain",
            auto: false,
            reason: "refuse requires confirmation",
        });

        // `apply` licenses a verdict at the gate bridge, but policy never lets a refuse act by itself: a
        // wrong refusal blocks work a prompt would have surfaced, so a dangerous criterion always reaches
        // the human with its reason recorded.
        expect(decide({ action: "refuse", confidence: 1, config: { apply: true } })).toEqual({
            outcome: "abstain",
            auto: false,
            reason: "refuse requires confirmation",
        });
    });

    it("applies sandbox regardless of confidence when sandboxing is available", () => {
        expect(decide({ action: "sandbox", confidence: 0.1 })).toEqual({
            outcome: "sandbox",
            auto: true,
            reason: "model chose sandbox",
        });
    });

    it("abstains on sandbox when sandboxing is unavailable", () => {
        expect(decide({ action: "sandbox", sandboxAvailable: false })).toEqual({
            outcome: "abstain",
            auto: false,
            reason: "sandbox unavailable",
        });
    });

    it("abstains on host below the default threshold", () => {
        expect(decide({ action: "host", confidence: 0.79 })).toEqual({
            outcome: "abstain",
            auto: false,
            reason: "host below confidence threshold",
        });
    });

    it("applies host at or above the threshold with no separate toggle", () => {
        expect(decide({ action: "host", confidence: 0.9 })).toEqual({
            outcome: "host",
            auto: true,
            reason: "model chose host above threshold",
        });
    });

    it("treats the default threshold as inclusive", () => {
        expect(
            decide({
                action: "host",
                confidence: DEFAULT_MIN_CONFIDENCE,
            }).outcome,
        ).toBe("host");
        expect(
            decide({
                action: "host",
                confidence: DEFAULT_MIN_CONFIDENCE - 0.01,
            }).outcome,
        ).toBe("abstain");
    });

    it("honors a configured threshold", () => {
        expect(
            decide({
                action: "host",
                confidence: 0.6,
                config: { minConfidence: 0.5 },
            }).outcome,
        ).toBe("host");
        expect(
            decide({
                action: "host",
                confidence: 0.4,
                config: { minConfidence: 0.5 },
            }),
        ).toEqual({
            outcome: "abstain",
            auto: false,
            reason: "host below confidence threshold",
        });
    });
});

describe("decision answer fold", () => {
    function answer(
        action: StrategyAnswer["action"],
        confidence: number,
        reason: DecisionReason = "none",
    ): StrategyAnswer {
        return { action, confidence, reason };
    }

    it("folds to the most severe answer regardless of order", () => {
        const benign = answer("host", 0.99);
        const sandbox = answer("sandbox", 0.4, "privileged");

        expect(foldAnswers([benign, sandbox])).toEqual({ answer: sandbox, index: 1 });
        expect(foldAnswers([sandbox, benign])).toEqual({ answer: sandbox, index: 0 });
    });

    it("prefers the more confident of two dangerous answers", () => {
        const weak = answer("sandbox", 0.4, "privileged");
        const strong = answer("sandbox", 0.8, "remote_code");

        expect(foldAnswers([weak, strong])).toEqual({ answer: strong, index: 1 });
        expect(foldAnswers([strong, weak])).toEqual({ answer: strong, index: 0 });
    });

    it("lets a refusal outrank a sandbox", () => {
        const sandbox = answer("sandbox", 0.99, "privileged");
        const refuse = answer("refuse", 0.4, "destructive");

        expect(foldAnswers([sandbox, refuse])).toEqual({ answer: refuse, index: 1 });
    });

    it("keeps the least confident host answer, because the floor must clear every body", () => {
        const sure = answer("host", 0.95);
        const unsure = answer("host", 0.6);

        expect(foldAnswers([sure, unsure])).toEqual({ answer: unsure, index: 1 });
        expect(foldAnswers([unsure, sure])).toEqual({ answer: unsure, index: 0 });
    });

    it("skips unanswered forms without renumbering the rest", () => {
        const sandbox = answer("sandbox", 0.7, "privileged");

        expect(foldAnswers([undefined, sandbox, undefined])).toEqual({
            answer: sandbox,
            index: 1,
        });
    });

    it("folds nothing when nothing answered", () => {
        expect(foldAnswers([])).toBeUndefined();
        expect(foldAnswers([undefined])).toBeUndefined();
    });
});

describe("decision veto policy", () => {
    it("is enabled by default and only disabled explicitly", () => {
        expect(vetoEnabled({})).toBe(true);
        expect(vetoEnabled({ veto: { enabled: true } })).toBe(true);
        expect(vetoEnabled({ veto: { enabled: false } })).toBe(false);
    });

    it("consults the veto for both directions that grant execution, below the gate", () => {
        expect(shouldConsultVeto("host", 0.5, {})).toBe(true);
        expect(shouldConsultVeto("host", DEFAULT_VETO_GATE, {})).toBe(false);
        expect(shouldConsultVeto("host", 0.9, {})).toBe(false);
        // `sandbox` is second-guessed too: the sandbox binds cwd rw and shares the host network, so it does
        // not contain in-workspace loss, exfiltration, or remote code.
        expect(shouldConsultVeto("sandbox", 0.1, {})).toBe(true);
        expect(shouldConsultVeto("sandbox", 0.9, {})).toBe(false);
        expect(shouldConsultVeto("refuse", 0.1, {})).toBe(false);
        expect(shouldConsultVeto(undefined, 0.1, {})).toBe(false);
    });

    it("gates an absent confidence and honors a configured gate", () => {
        expect(shouldConsultVeto("host", undefined, {})).toBe(true);
        expect(shouldConsultVeto("host", 0.7, { veto: { gateBelow: 0.8 } })).toBe(true);
    });

    it("does not consult the veto when disabled", () => {
        expect(shouldConsultVeto("host", 0.1, { veto: { enabled: false } })).toBe(false);
    });

    it("escalates a dangerous veto at or above the threshold", () => {
        expect(
            applyVeto(
                "host",
                { reason: "privileged", confidence: DEFAULT_VETO_MIN_CONFIDENCE },
                {},
            ),
        ).toEqual({ action: "sandbox", escalated: true });
        expect(
            applyVeto(
                "host",
                { reason: "destructive", confidence: 0.9 },
                { veto: { escalateTo: "refuse" } },
            ),
        ).toEqual({ action: "refuse", escalated: true });
        // A dangerous reason on an already-sandboxed command has nowhere softer to go.
        expect(applyVeto("sandbox", { reason: "remote_code", confidence: 0.9 }, {})).toEqual({
            action: "refuse",
            escalated: true,
        });
        expect(applyVeto("sandbox", { reason: "loses_content", confidence: 0.75 }, {})).toEqual({
            action: "refuse",
            escalated: true,
        });
    });

    it("leaves the action unchanged for a safe or low-confidence veto", () => {
        expect(applyVeto("host", { reason: "none", confidence: 1 }, {})).toEqual({
            action: "host",
            escalated: false,
        });
        expect(applyVeto("host", { reason: "privileged", confidence: 0.5 }, {})).toEqual({
            action: "host",
            escalated: false,
        });
        expect(
            applyVeto(
                "host",
                { reason: "privileged", confidence: 0.5 },
                { veto: { minConfidence: 0.4 } },
            ),
        ).toEqual({ action: "sandbox", escalated: true });
    });
});
