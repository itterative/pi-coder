import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_REVIEWER, BUILTIN_SCOUT } from "../../src/tools/agent/definitions/discovery";
import type { AgentDefinition } from "../../src/tools/agent/definitions/types";
import decisionConfig from "../../src/modules/decision/config";
import { resetDecisionEvaluator } from "../../src/modules/decision/gate";
import { buildChildRun, type ChildRunDecision } from "./child-run-fixture";

/**
 * What a delegated child is told when the decision model had a part in blocking its command.
 *
 * Two surfaces, two shapes. A child below the `command` rung has no prompt to fall back on, so a verdict is
 * the whole policy and its abstention belongs in the reason; a command-capable child normally falls through to
 * the parent's dialog, and every case here runs with no parent UI - which is exactly where the wording used to
 * tell a child a person had refused when nobody was asked at all.
 *
 * These are the real gates: the child extension is installed the way `createAgentChild` installs it, the
 * command is one the deterministic layer fails on the *allowlist* axis only (a confinement failure is never
 * consultable and would prove nothing about a verdict), and each block reason is an inline snapshot, because
 * the sentence is what is under test and `-u` rewrites it in place.
 */

const UNUSED_CONFIG_FALLBACK = path.join(os.tmpdir(), "pi-child-decision-unused.json");
const UNCLEARED = "kindly-untagged-tool notes.md";

const WITHHELD: ChildRunDecision = { criterion: "destructive", confidence: 0.9 };
const CLEARED: ChildRunDecision = { criterion: "none", confidence: 0.95 };

interface ChildDecision {
    blocked: boolean;
    reason: string;
    /** The child's cwd, so a reason that embedded a path can be normalized. */
    cwd: string;
    classifyCalls: number;
}

async function runChild(options: {
    definition: AgentDefinition;
    command: string;
    decision?: ChildRunDecision;
}): Promise<ChildDecision> {
    const fixture = buildChildRun(options.definition, {
        parentKind: "no-ui",
        ...(options.decision === undefined ? {} : { decision: options.decision }),
    });
    // A real file the child can read: the confinement checks stat the path, and a missing one changes which
    // reason the heuristic reports rather than what the verdict says.
    fs.writeFileSync(path.join(fixture.cwd, "notes.md"), "# notes\n");

    const installed = fixture.install();
    const sessionManager = SessionManager.create(fixture.cwd, path.join(fixture.cwd, "sessions"));
    sessionManager.appendMessage({
        role: "user",
        content: "summarize what the repo depends on",
        timestamp: 1,
    });
    const ctx = {
        cwd: fixture.cwd,
        sessionManager,
        signal: new AbortController().signal,
    };

    const blocks: { reason: string }[] = [];
    for (const handler of installed.toolCall) {
        const result = (await handler(
            {
                type: "tool_call",
                toolName: "bash",
                toolCallId: "call-1",
                input: { command: options.command },
            },
            ctx,
        )) as { block?: boolean; reason?: string } | undefined;
        if (result?.block) {
            blocks.push({ reason: normalize(result.reason ?? "", fixture.cwd) });
        }
    }

    return {
        blocked: blocks.length > 0,
        reason: blocks.at(-1)?.reason ?? "(allowed)",
        cwd: fixture.cwd,
        classifyCalls: fixture.classifyCalls(),
    };
}

function normalize(text: string, cwd: string): string {
    return text
        .split(cwd)
        .join("<cwd>")
        .split(fs.realpathSync(cwd))
        .join("<cwd>")
        .split(os.homedir())
        .join("<home>")
        .split(process.cwd())
        .join("<repo>");
}

beforeEach(() => {
    // `test/setup.ts` pins both config paths blank, and a blank project path suppresses the walk-up that
    // would find the fixture's own `.pi` file, so the suite has to name a fallback to re-enable it.
    vi.stubEnv("DECISION_MODEL_CONFIG_PATH", UNUSED_CONFIG_FALLBACK);
    decisionConfig.reset();
    resetDecisionEvaluator();
});

afterEach(() => {
    decisionConfig.reset();
    resetDecisionEvaluator();
    vi.unstubAllEnvs();
});

describe("child decision-model block reasons", () => {
    it("consults the model once for a read-only child's allowlist failure", async () => {
        const outcome = await runChild({
            definition: BUILTIN_SCOUT,
            command: UNCLEARED,
            decision: WITHHELD,
        });

        expect(outcome.classifyCalls).toBe(1);
        expect(outcome.blocked).toBe(true);
    });

    it("appends the verdict to a read-only child's deterministic reason", async () => {
        const outcome = await runChild({
            definition: BUILTIN_SCOUT,
            command: UNCLEARED,
            decision: WITHHELD,
        });

        expect(outcome.reason).toMatchInlineSnapshot(
            `"Read-only agent bash blocked: the command is not in the curated read-only allowlist [UNKNOWN_COMMAND]. Commands must be cwd-confined and classified SAFE_READONLY. The decision model judged it able to destroy data irreversibly (0.90), and only a person can approve a command it refuses. This agent has no prompt to ask through."`,
        );
    });

    it("blames the record-only config rather than the model that cleared it", async () => {
        const outcome = await runChild({
            definition: BUILTIN_SCOUT,
            command: UNCLEARED,
            decision: { ...CLEARED, config: { apply: false } },
        });

        expect(outcome.blocked).toBe(true);
        expect(outcome.reason).toMatchInlineSnapshot(
            `"Read-only agent bash blocked: the command is not in the curated read-only allowlist [UNKNOWN_COMMAND]. Commands must be cwd-confined and classified SAFE_READONLY. The decision model judged it an ordinary command for this runner (0.95), and this session records verdicts without acting on them (record-only mode). This agent has no prompt to ask through."`,
        );
    });

    it("holds a granted command whose script body was never read", async () => {
        const outcome = await runChild({
            definition: BUILTIN_SCOUT,
            // A `binary` run: the invocation is classifiable, the code it pulls in was never read.
            command: "npx cowsay hi",
            decision: CLEARED,
        });

        expect(outcome.blocked).toBe(true);
        expect(outcome.reason).toMatchInlineSnapshot(
            `"Read-only agent bash blocked: the command is not in the curated read-only allowlist [UNKNOWN_COMMAND]. Commands must be cwd-confined and classified SAFE_READONLY. The decision model judged it an ordinary command for this runner (0.95) and cleared the command, but the command runs a script the model never read (script kind binary). This agent has no prompt to ask through."`,
        );
    });

    it("says the scope gate refused a read-only child's command", async () => {
        const outcome = await runChild({
            definition: BUILTIN_SCOUT,
            command: UNCLEARED,
            decision: { criterion: "none", confidence: 0.4 },
        });

        expect(outcome.blocked).toBe(true);
        expect(outcome.reason).toMatchInlineSnapshot(
            `"Read-only agent bash blocked: the command is not in the curated read-only allowlist [UNKNOWN_COMMAND]. Commands must be cwd-confined and classified SAFE_READONLY. The decision model judged it an ordinary command for this runner (0.40), and it was not confident enough to let the command through. This agent has no prompt to ask through."`,
        );
    });

    it("lets a read-only child through when the verdict clears it", async () => {
        const outcome = await runChild({
            definition: BUILTIN_SCOUT,
            command: UNCLEARED,
            decision: CLEARED,
        });

        expect(outcome.blocked).toBe(false);
        expect(outcome.reason).toBe("(allowed)");
    });

    it("keeps the deterministic wording when no endpoint is configured", async () => {
        const outcome = await runChild({
            definition: BUILTIN_SCOUT,
            command: UNCLEARED,
        });

        expect(outcome.classifyCalls).toBe(0);
        expect(outcome.reason).toMatchInlineSnapshot(
            `"Read-only agent bash blocked: the command is not in the curated read-only allowlist [UNKNOWN_COMMAND]. Commands must be cwd-confined and classified SAFE_READONLY."`,
        );
    });

    it("tells a command-capable child that nobody was there to ask", async () => {
        const outcome = await runChild({
            definition: BUILTIN_REVIEWER,
            command: UNCLEARED,
            decision: WITHHELD,
        });

        expect(outcome.classifyCalls).toBe(1);
        expect(outcome.blocked).toBe(true);
        expect(outcome.reason).toMatchInlineSnapshot(
            `"Agent bash blocked; the decision model judged it able to destroy data irreversibly (0.90), and only a person can approve a command it refuses. There was no user to ask."`,
        );
    });

    it("names the record-only config for a command-capable child too", async () => {
        const outcome = await runChild({
            definition: BUILTIN_REVIEWER,
            command: UNCLEARED,
            decision: { ...CLEARED, config: { apply: false } },
        });

        expect(outcome.blocked).toBe(true);
        expect(outcome.reason).toMatchInlineSnapshot(
            `"Agent bash blocked; the decision model judged it an ordinary command for this runner (0.95), and this session records verdicts without acting on them (record-only mode). There was no user to ask."`,
        );
    });
});
