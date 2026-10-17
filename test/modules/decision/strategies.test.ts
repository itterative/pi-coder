import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { JsonObject } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
    ACTION_TABLE,
    CLASSIFICATION_CRITERIA,
    DECISION_STRATEGIES,
    HISTORY_COMMAND_CHARS,
    HISTORY_DEPTH,
    VETO_QUESTION,
    classificationAnswerFrom,
    clipHistoryCommand,
    commandHistoryField,
    historyState,
    historyStrategy,
    resolveStrategy,
    vetoStrategy,
    type DecisionStrategyId,
} from "../../../src/modules/decision";
import { decisionContextFor } from "../../../src/modules/decision/gate";
import { zeroUsage } from "../../helpers/agent-doubles";
import { stubContext } from "../../helpers/pi-stub";
import { choiceAnswer } from "./classifier";
import { FIXTURES, indentedJson, parentRewrite, scoutNote } from "./fixtures";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("decision strategy requests", () => {
    for (const strategy of Object.values(DECISION_STRATEGIES)) {
        for (const [name, context] of Object.entries(FIXTURES)) {
            it(`sends the ${strategy.id} request for ${name}`, async () => {
                await expect(indentedJson(strategy.buildRequest(context))).toMatchFileSnapshot(
                    `__snapshots__/decision-strategy.${strategy.id}.${name}.json`,
                );
            });
        }
    }

    it("sends the veto request for a body read from a real file", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decision-strategies-"));
        temporaryDirectories.push(directory);
        const body = [
            "# the body the model receives is read from this file",
            'print("hello from example.py")',
            "",
        ].join("\n");
        fs.writeFileSync(path.join(directory, "example.py"), body);

        const session = SessionManager.create(process.cwd(), directory);
        session.appendMessage({
            role: "user",
            content: "what does example.py print?",
            timestamp: 1,
        });
        session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "I'll read it first." }],
            api: "test",
            provider: "test",
            model: "test",
            usage: zeroUsage(),
            stopReason: "stop",
            timestamp: 2,
        });
        session.appendMessage({ role: "user", content: "now run example.py", timestamp: 3 });

        // The context comes from the production builder, which resolves the command and reads the file
        // itself; no script body is handed to it from here.
        const context = decisionContextFor(
            stubContext({ cwd: directory, sessionManager: session }),
            "python3 example.py",
        );
        const request = vetoStrategy.buildRequest(context);

        expect(context.script?.kind).toBe("file");
        expect(request.state.scripts).toEqual([body]);

        // The temp directory's absolute path changes per run and machine. Replacing it with a stable
        // placeholder keeps this pin reproducible; `cwd` is the only field carrying it, because the
        // command is relative and `scripts` sends the body's text alone.
        const pinned = indentedJson(request).replaceAll(directory, "<test-directory>");

        await expect(pinned).toMatchFileSnapshot(
            "__snapshots__/decision-strategy.veto.real-file-read.json",
        );
    });
});

describe("decision strategies", () => {
    it("ask one question, from the shared criteria", () => {
        const request = vetoStrategy.buildRequest(parentRewrite);

        expect(Object.keys(request.questions)).toEqual([VETO_QUESTION]);
        expect(request.questions[VETO_QUESTION]).toMatchObject({
            type: "choice",
            criteria: CLASSIFICATION_CRITERIA,
        });
    });

    it("differ only in the state, so a verdict difference can only come from it", () => {
        const veto = vetoStrategy.buildRequest(parentRewrite);
        const history = historyStrategy.buildRequest(parentRewrite);

        expect(history.questions).toEqual(veto.questions);
        expect(historyStrategy.actionFrom).toBe(vetoStrategy.actionFrom);
        expect(history.state).toHaveProperty("command_history");
        expect(veto.state).not.toHaveProperty("command_history");
    });

    it("omit the history field when there is none, sending the veto state unchanged", () => {
        expect(historyStrategy.buildRequest(scoutNote).state).toEqual(
            vetoStrategy.buildRequest(scoutNote).state,
        );
        expect(historyState({ ...parentRewrite, history: [] })).toEqual(
            vetoStrategy.buildRequest(parentRewrite).state,
        );
    });
});

describe("criterion to action table", () => {
    it("covers every criterion exactly once", () => {
        expect(ACTION_TABLE).toEqual({
            none: "host",
            privileged: "sandbox",
            destructive: "refuse",
            loses_content: "refuse",
            exfiltration: "refuse",
            remote_code: "refuse",
            out_of_scope: "refuse",
        });
        // A criterion with no row could be named but not acted on, so the two are one vocabulary.
        expect(Object.keys(ACTION_TABLE).toSorted()).toEqual(
            Object.keys(CLASSIFICATION_CRITERIA).toSorted(),
        );
    });

    it("takes the action from the criterion the model named", () => {
        expect(
            classificationAnswerFrom({ [VETO_QUESTION]: choiceAnswer("out_of_scope", 0.72) }),
        ).toEqual({ action: "refuse", reason: "out_of_scope", confidence: 0.72 });
        expect(
            classificationAnswerFrom({ [VETO_QUESTION]: choiceAnswer("privileged", 0.95) }),
        ).toEqual({ action: "sandbox", reason: "privileged", confidence: 0.95 });
        expect(classificationAnswerFrom({ [VETO_QUESTION]: choiceAnswer("none", 0.64) })).toEqual({
            action: "host",
            reason: "none",
            confidence: 0.64,
        });
    });

    it("abstains rather than guessing on an answer it cannot read", () => {
        expect(classificationAnswerFrom({})).toBeUndefined();
        expect(
            classificationAnswerFrom({ [VETO_QUESTION]: choiceAnswer("sounds_fine", 0.9) }),
        ).toBeUndefined();
        expect(
            classificationAnswerFrom({ [VETO_QUESTION]: { type: "bool", probability: 0.9 } }),
        ).toBeUndefined();
    });
});

describe("command history field", () => {
    it("carries the last HISTORY_DEPTH commands, oldest first", () => {
        const history = Array.from(
            { length: 45 },
            (_, index) => `cd /repo && npm run step-${index + 1}`,
        );
        const expected = history.slice(-HISTORY_DEPTH).map((command) => ({ command }));

        expect(commandHistoryField(history)).toEqual({ command_history: expected });
    });

    it("collapses whitespace and clips with an ellipsis at the limit", () => {
        const long = `  cd /repo &&\n  python3 - <<'PY'\n${"x".repeat(300)}\nPY  `;
        const clipped = clipHistoryCommand(long);

        expect(clipped.startsWith("cd /repo && python3")).toBe(true);
        expect(clipped).toHaveLength(HISTORY_COMMAND_CHARS);
        expect(clipped.endsWith("…")).toBe(true);
        expect(clipped).not.toContain("\n");
        expect(clipHistoryCommand("  npm   run\n  typecheck  ")).toBe("npm run typecheck");
        expect(clipHistoryCommand("git status")).toBe("git status");
    });

    it("adds nothing when the session has no earlier commands", () => {
        expect(commandHistoryField([])).toEqual({});
    });
});

describe("strategy selection", () => {
    it("defaults to the measured winner and resolves the others by id", () => {
        expect(resolveStrategy()).toBe(vetoStrategy);
        expect(resolveStrategy("veto")).toBe(vetoStrategy);
        expect(resolveStrategy("history")).toBe(historyStrategy);
    });

    it("falls back to the default for a name that is not a strategy", () => {
        // The id arrives from a config file, so inherited object names are in reach; returning one of those
        // would hand the evaluator a value without `buildRequest`.
        for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
            expect(resolveStrategy(name as DecisionStrategyId)).toBe(vetoStrategy);
        }
    });

    it("describes each strategy for config help", () => {
        expect(Object.values(DECISION_STRATEGIES).map((strategy) => strategy.id)).toEqual([
            "veto",
            "history",
        ]);
        for (const strategy of Object.values(DECISION_STRATEGIES)) {
            expect(strategy.description).not.toBe("");
        }
    });
});

describe("history state", () => {
    it("is the production state plus one field, in that order", () => {
        const state: JsonObject = historyState(parentRewrite);

        expect(Object.keys(state)).toEqual([
            "command",
            "cwd",
            "runner_rules",
            "request",
            "recent_messages",
            "command_history",
        ]);
    });
});
