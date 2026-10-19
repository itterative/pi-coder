import { describe, expect, it } from "vitest";

import type { ClassifierContext } from "@earendil-works/pi-ai";

import {
    FILE_KIND_QUESTION,
    FILE_LOSS_QUESTION,
    FILE_PURPOSE_QUESTION,
    buildFileAccessState,
    fileAccessAnswerFrom,
    fileAccessRequest,
    fileAccessWithinAuthority,
    fileScopeAnswer,
    type FileAccessDecisionContext,
    type FileDecisionSubject,
} from "../../../src/modules/decision";
import { runnerRulesForFileAccess } from "../../../src/modules/decision/runner-rules";

/**
 * The file-access subject: what reaches the model, and what the answers are allowed to do.
 *
 * The measurement these cases pin is in `.pi/local/decision-models/file-access-report.md`: the composite of
 * kind and purpose resolved 72 of 102 approved real accesses with none of the 8 refused ones granted and none
 * of the 9 labelled private paths leaked. The rules here are that result written down — including the two
 * deliberately asymmetric parts, that a write needs `asked_for` rather than `routine`, and that the floor sits
 * on the kind answer's confidence because the purpose answer's is not comparable.
 */

function context(overrides: Partial<FileAccessDecisionContext> = {}): FileAccessDecisionContext {
    const file: FileDecisionSubject = { operation: "read", path: "/home/user/notes.md" };

    return {
        file,
        cwd: "/home/user/project",
        request: "update the notes file",
        ...overrides,
    };
}

describe("file access state", () => {
    it("sends the operation, the path, the cwd, the request, and the runner's file rules", () => {
        const state = buildFileAccessState(context());

        expect(state).toEqual({
            operation: "read",
            path: "/home/user/notes.md",
            cwd: "/home/user/project",
            request: "update the notes file",
            runner_rules: [...runnerRulesForFileAccess("parent", "checkout")],
        });
    });

    it("sends no content, no transcript, and no command", () => {
        const state = buildFileAccessState(
            context({ file: { operation: "write", path: "/home/user/.aws/config" } }),
        );

        expect(Object.keys(state).sort()).toEqual([
            "cwd",
            "operation",
            "path",
            "request",
            "runner_rules",
        ]);
    });

    it("omits a blank request instead of sending an empty field", () => {
        expect(buildFileAccessState(context({ request: "   " }))).not.toHaveProperty("request");
    });

    it("selects the child's file rules by runner and isolation", () => {
        const worktree = buildFileAccessState(context({ runner: "worker", isolation: "worktree" }));

        expect(worktree.runner_rules).toContain(
            "Runs as a delegated implementation child, in an isolated disposable git worktree.",
        );
    });

    it("asks the loss question only for a write", () => {
        const read = fileAccessRequest(buildFileAccessState(context()));
        const write = fileAccessRequest(
            buildFileAccessState(context({ file: { operation: "write", path: "/x" } })),
        );

        expect(Object.keys(read.questions).sort()).toEqual(
            [FILE_KIND_QUESTION, FILE_PURPOSE_QUESTION].sort(),
        );
        expect(Object.keys(write.questions).sort()).toEqual(
            [FILE_KIND_QUESTION, FILE_LOSS_QUESTION, FILE_PURPOSE_QUESTION].sort(),
        );
    });
});

describe("file access answers", () => {
    function answers(
        kind: string,
        purpose: string,
        options: { kindConfidence?: number; loss?: number } = {},
    ) {
        const result: Record<string, unknown> = {
            [FILE_KIND_QUESTION]: {
                type: "choice",
                choice: kind,
                confidence: options.kindConfidence ?? 0.9,
                probabilities: {},
            },
            [FILE_PURPOSE_QUESTION]: {
                type: "choice",
                choice: purpose,
                confidence: 0.24,
                probabilities: {},
            },
        };

        if (options.loss !== undefined) {
            result[FILE_LOSS_QUESTION] = { type: "bool", probability: options.loss };
        }

        return result as Parameters<typeof fileAccessAnswerFrom>[0];
    }

    it("grants ordinary material the request reaches, carrying the kind confidence", () => {
        const answer = fileAccessAnswerFrom(answers("code", "routine"), "read");

        expect(answer).toEqual({ action: "host", confidence: 0.9, reason: "routine" });
    });

    it("withholds a private kind even when the purpose is the strongest answer", () => {
        expect(fileAccessAnswerFrom(answers("secret", "asked_for"), "read")?.action).toBe("refuse");
        expect(fileAccessAnswerFrom(answers("secret", "asked_for"), "read")?.reason).toBe("secret");
        expect(fileAccessAnswerFrom(answers("personal", "routine"), "read")?.reason).toBe(
            "personal",
        );
        expect(fileAccessAnswerFrom(answers("system", "asked_for"), "write")?.reason).toBe(
            "system",
        );
    });

    it("withholds a path nothing in the request reaches", () => {
        expect(fileAccessAnswerFrom(answers("code", "unrelated"), "read")?.reason).toBe(
            "unrelated",
        );
        expect(fileAccessAnswerFrom(answers("data", "tangential"), "read")?.action).toBe("refuse");
    });

    it("demands asked_for of a write, where routine is not enough", () => {
        expect(fileAccessAnswerFrom(answers("code", "routine"), "write")?.action).toBe("refuse");
        expect(fileAccessAnswerFrom(answers("code", "asked_for"), "write")?.action).toBe("host");
    });

    it("withholds a write the loss answer says destroys unasked content", () => {
        const atThreshold = fileAccessAnswerFrom(
            answers("code", "asked_for", { loss: 0.5 }),
            "write",
        );
        const below = fileAccessAnswerFrom(
            answers("settings", "asked_for", { loss: 0.49 }),
            "write",
        );

        expect(atThreshold).toMatchObject({ action: "refuse", reason: "loses_content" });
        expect(below?.action).toBe("host");
    });

    it("abstains on a missing, unreadable, or off-vocabulary answer", () => {
        expect(fileAccessAnswerFrom({}, "read")).toBeUndefined();
        expect(fileAccessAnswerFrom(answers("docs", "routine"), "read")).toBeUndefined();
        expect(fileAccessAnswerFrom(answers("code", "probably"), "read")).toBeUndefined();
    });
});

describe("file access authority", () => {
    it("lets only a mutating runner have a write auto-approved", () => {
        expect(fileAccessWithinAuthority("write", "parent")).toBe(true);
        expect(fileAccessWithinAuthority("write", "worker")).toBe(true);
        expect(fileAccessWithinAuthority("write", "reviewer")).toBe(false);
        expect(fileAccessWithinAuthority("write", "scout")).toBe(false);
        expect(fileAccessWithinAuthority("write", "agent")).toBe(false);
    });

    it("lets every runner have a read auto-approved", () => {
        for (const runner of [
            "parent",
            "worker",
            "reviewer",
            "scout",
            "advisor",
            "agent",
        ] as const) {
            expect(fileAccessWithinAuthority("read", runner)).toBe(true);
        }
    });

    it("refuses an out-of-rung access without a request, at confidence zero", () => {
        const answer = fileScopeAnswer("write", "scout");

        expect(answer).toEqual({ action: "refuse", reason: "out_of_scope", confidence: 0 });
        expect(fileScopeAnswer("read", "parent")).toBeUndefined();
    });
});

describe("file access request shape", () => {
    it("pairs the state with its questions in one request", () => {
        const request: ClassifierContext = fileAccessRequest(buildFileAccessState(context()));

        expect(request.state).toMatchObject({ operation: "read" });
        expect(request.questions[FILE_PURPOSE_QUESTION]?.type).toBe("choice");
    });
});
