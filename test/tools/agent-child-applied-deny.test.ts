import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_WORKER } from "../../src/tools/agent/definitions/discovery";
import decisionConfig from "../../src/modules/decision/config";
import { resetDecisionEvaluator } from "../../src/modules/decision/gate";
import { classifierRecord } from "../modules/decision/classifier";
import { buildChildRun } from "./child-run-fixture";

/**
 * A mutating child facing a verdict that resolved its prompt to a deny.
 *
 * No shipped policy can produce that verdict: `decideWithPolicy` turns every `refuse` into an abstain, so the
 * gates record a dangerous answer and ask a person. The command gate nevertheless has to treat the resulting
 * permission as a block, and the bug it had was the opposite reading - `allowed: permission !== "ask"` - which
 * would have run a denied command unsandboxed the day a verdict is allowed to refuse (a fully automatic mode,
 * or a policy change). This file therefore replaces one function, `consultForGate`, with a fixed answer, and
 * leaves every other export real, so the gate's own reasoning is what is under test.
 *
 * The mock is the narrowest seam available: the verdict is a property of the evaluator and the config, and a
 * test could not reach it by configuration without also changing what policy does with it.
 */

const DENIED = classifierRecord({
    criterion: "destructive",
    action: "refuse",
    outcome: "refuse",
    status: "applied",
    reason: "model chose refuse",
});

const UNUSED_CONFIG_FALLBACK = path.join(os.tmpdir(), "pi-child-deny-unused.json");

vi.mock("../../src/tools/decision-model", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/tools/decision-model")>();

    return {
        ...actual,
        consultForGate: async () => ({ permission: "deny", record: DENIED }),
    };
});

beforeEach(() => {
    // The gate only consults when the surface is enabled from a real project file, and `test/setup.ts` pins
    // the project path blank, which suppresses the walk-up that would find the fixture's own `.pi` file.
    vi.stubEnv("DECISION_MODEL_CONFIG_PATH", UNUSED_CONFIG_FALLBACK);
    decisionConfig.reset();
    resetDecisionEvaluator();
});

afterEach(() => {
    decisionConfig.reset();
    resetDecisionEvaluator();
    vi.unstubAllEnvs();
});

describe("a worker whose command the model denied", () => {
    it("blocks the call instead of running it", async () => {
        const fixture = buildChildRun(BUILTIN_WORKER, {
            parentKind: "no-ui",
            decision: { criterion: "destructive", confidence: 0.9 },
        });
        fs.writeFileSync(path.join(fixture.cwd, "notes.md"), "# notes\n");

        const installed = fixture.install();
        const sessionManager = SessionManager.create(
            fixture.cwd,
            path.join(fixture.cwd, "sessions"),
        );
        sessionManager.appendMessage({
            role: "user",
            content: "clean up the build directory",
            timestamp: 1,
        });
        const ctx = {
            cwd: fixture.cwd,
            sessionManager,
            signal: new AbortController().signal,
        };

        const command = "rm -rf build";
        const results = [];
        for (const handler of installed.toolCall) {
            results.push(
                await handler(
                    {
                        type: "tool_call",
                        toolName: "bash",
                        toolCallId: "call-1",
                        input: { command },
                    },
                    ctx,
                ),
            );
        }

        const blocks = results.filter(
            (result) => (result as { block?: boolean } | undefined)?.block === true,
        );
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchInlineSnapshot(`
            {
              "block": true,
              "reason": "Agent bash blocked by the decision model, which judged it able to destroy data irreversibly (0.90).",
            }
        `);

        // Nothing was approved, and the command was never rewritten to run sandboxed.
        expect(fixture.tracker.bashApproved).toBe(false);
        expect(fixture.notifications).toEqual([]);
        // The gate did consult: the answer it got is the mocked deny, not a verdict from the registry.
        expect(fixture.classifyCalls()).toBe(0);
    });
});
