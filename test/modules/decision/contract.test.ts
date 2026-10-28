import type { ClassifierContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
    DECISION_REQUEST_SUBJECTS,
    buildFileAccessState,
    buildSuggestionState,
    fileAccessRequest,
    reminderChoiceRequest,
    reminderStateRequest,
    scriptRequest,
    suggestionRequest,
    vetoStrategy,
    type DecisionRequestSubject,
    type ReminderOption,
} from "../../../src/modules/decision";

import { indentedJson } from "./fixtures";

/**
 * One built example of every request the decision model can send.
 *
 * This is the traceable index: `contract.ts` names the wire shapes and question ids, and each file below is
 * what a subject actually puts on the wire — state and questions together, with the wording the model reads.
 * A changed key, a dropped question, or reworded criteria shows up here as a snapshot diff.
 *
 * Each example is the smallest request of its subject, so the required shape is what stands out. Richer cases
 * are pinned where they are built: `decision-strategy.*.json` for a full session transcript, a dirty working
 * tree, and both script forms, and `decision-evaluator.*.json` for the per-body forms.
 */

const REMINDER_OPTIONS: readonly ReminderOption[] = [
    { id: "todo", guidance: "Track the open items in the TODO list." },
    { id: "validation", guidance: "Run the tests before claiming the work is done." },
];

const BUILT_REQUESTS: Record<DecisionRequestSubject, ClassifierContext> = {
    command: vetoStrategy.buildRequest({ command: "git status", cwd: "/repo" }),
    script: scriptRequest('print("hello")\n'),
    file: fileAccessRequest(
        buildFileAccessState({
            file: { operation: "write", path: "/home/user/.aws/config" },
            cwd: "/home/user/project",
            request: "update the credentials file",
        }),
    ),
    suggestion: suggestionRequest(
        buildSuggestionState({
            command: "npx zorch run test/a.test.ts",
            cwd: "/repo",
            recentCommands: ["npx zorch run test/b.test.ts"],
        }),
    ),
    "reminder-phase": reminderStateRequest("validating", "User: run the tests"),
    "reminder-choice": reminderChoiceRequest(
        { conversation: "User: run the tests" },
        REMINDER_OPTIONS,
    ),
};

describe("decision request shapes", () => {
    it("pins one request per subject", () => {
        expect(Object.keys(BUILT_REQUESTS).toSorted()).toEqual(
            [...DECISION_REQUEST_SUBJECTS].toSorted(),
        );
    });

    for (const subject of DECISION_REQUEST_SUBJECTS) {
        it(`sends the ${subject} request`, async () => {
            await expect(indentedJson(BUILT_REQUESTS[subject])).toMatchFileSnapshot(
                `__snapshots__/decision-request.${subject}.json`,
            );
        });
    }
});
