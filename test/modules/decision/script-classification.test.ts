import { describe, expect, it } from "vitest";

import {
    SCRIPT_ACTION_TABLE,
    SCRIPT_CRITERIA,
    SCRIPT_QUESTION,
    isScriptCapability,
    scriptAnswerFrom,
    scriptRequest,
} from "../../../src/modules/decision";

import { choiceAnswer } from "./classifier";

describe("script classification request", () => {
    it("sends the body alone, under the capability question", () => {
        const request = scriptRequest('print("hello")\n');

        expect(request.state).toEqual({ code: 'print("hello")\n' });
        expect(request.questions[SCRIPT_QUESTION]).toMatchObject({
            type: "choice",
            criteria: SCRIPT_CRITERIA,
        });
    });
});

describe("script criteria and actions", () => {
    it("covers every capability exactly once", () => {
        expect(Object.keys(SCRIPT_ACTION_TABLE).toSorted()).toEqual(
            Object.keys(SCRIPT_CRITERIA).toSorted(),
        );
    });

    it("takes the action from the capability the model named", () => {
        expect(scriptAnswerFrom({ [SCRIPT_QUESTION]: choiceAnswer("privileged", 0.95) })).toEqual({
            action: "sandbox",
            reason: "privileged",
            confidence: 0.95,
        });
        expect(scriptAnswerFrom({ [SCRIPT_QUESTION]: choiceAnswer("read_only", 0.64) })).toEqual({
            action: "host",
            reason: "read_only",
            confidence: 0.64,
        });
    });

    it("abstains rather than guessing on an answer it cannot read", () => {
        expect(scriptAnswerFrom({})).toBeUndefined();
        expect(
            scriptAnswerFrom({ [SCRIPT_QUESTION]: choiceAnswer("writes_everything", 0.9) }),
        ).toBeUndefined();
        expect(
            scriptAnswerFrom({
                [SCRIPT_QUESTION]: { type: "bool", probability: 0.9 },
            }),
        ).toBeUndefined();
    });

    it("recognizes only its own capability labels", () => {
        expect(isScriptCapability("destructive")).toBe(true);
        expect(isScriptCapability("none")).toBe(false);
        expect(isScriptCapability("toString")).toBe(false);
    });
});
