import { describe, expect, it } from "vitest";

import { classifierRecord } from "../modules/decision/classifier";
import {
    attributedBashBlockReason,
    permissionAllowsCall,
    readOnlyGateSentence,
} from "../../src/tools/decision-model";
import type { BashClassifierRecord } from "../../src/modules/sandbox/decision-log";

/**
 * The text an agent reads when a command was blocked and the decision model had a part in it.
 *
 * Each case is one sentence, so each case owns an inline snapshot: the wording is the subject under test and
 * `vitest -u` rewrites it in place. That matters more here than for most text, because the first drafts of
 * these sentences leaked the module's own vocabulary (`host`, `refuse`, `apply is off`) to a runner that
 * cannot act on it - a snapshot diff makes that visible as prose instead of as a failed substring match.
 *
 * The cases are the four kinds of no a Bash gate can reach: a verdict that resolved the prompt, a person who
 * answered, a verdict that cleared the command while the config is record-only, and a withheld verdict with
 * no interface to ask through. Plus the shapes with no criterion or no confidence to name.
 */

function attributed(record: BashClassifierRecord | undefined): string | undefined {
    return attributedBashBlockReason({ subject: "subject", record, humanAsked: false });
}

const refused = (criterion: string): BashClassifierRecord =>
    classifierRecord({
        criterion,
        action: "refuse",
        outcome: "abstain",
        status: "abstained",
        reason: "refuse requires confirmation",
        applied: false,
    });

describe("decision-model block attribution", () => {
    it("names the model when its verdict resolved the prompt to a deny", () => {
        const denied = classifierRecord({
            criterion: "destructive",
            action: "refuse",
            outcome: "refuse",
            status: "applied",
            reason: "model chose refuse",
        });

        expect(
            attributedBashBlockReason({
                subject: "Command execution",
                record: denied,
                humanAsked: false,
            }),
        ).toMatchInlineSnapshot(
            `"Command execution blocked by the decision model, which judged it able to destroy data irreversibly (0.90)."`,
        );

        // The same verdict on the child surface, and with a person actually available: the verdict resolved
        // the block either way, so nobody was asked and nobody is blamed.
        expect(
            attributedBashBlockReason({
                subject: "Agent bash",
                record: denied,
                humanAsked: true,
            }),
        ).toMatchInlineSnapshot(
            `"Agent bash blocked by the decision model, which judged it able to destroy data irreversibly (0.90)."`,
        );
    });

    it("says nobody was available when the verdict withheld and no prompt could run", () => {
        expect(attributed(refused("destructive"))).toMatchInlineSnapshot(
            `"subject blocked; the decision model judged it able to destroy data irreversibly (0.90), and only a person can approve a command it refuses. There was no user to ask."`,
        );

        expect(attributed(refused("exfiltration"))).toMatchInlineSnapshot(
            `"subject blocked; the decision model judged it able to leak secrets or send data off the machine (0.90), and only a person can approve a command it refuses. There was no user to ask."`,
        );

        expect(attributed(refused("out_of_scope"))).toMatchInlineSnapshot(
            `"subject blocked; the decision model judged it beyond what this runner is authorized to do (0.90), and only a person can approve a command it refuses. There was no user to ask."`,
        );

        // A criterion the model invented (or a future one this table has not caught up with) is quoted, not
        // dropped, so the sentence never claims the model said nothing.
        expect(attributed(refused("unheard_of"))).toMatchInlineSnapshot(
            `"subject blocked; the decision model judged it unheard_of (0.90), and only a person can approve a command it refuses. There was no user to ask."`,
        );
    });

    it("names the floor and the configuration, not the model, when those are what stopped it", () => {
        expect(
            attributed(
                classifierRecord({
                    criterion: "loses_content",
                    confidence: 0.512,
                    outcome: "abstain",
                    status: "abstained",
                    reason: "host below confidence threshold",
                    applied: false,
                }),
            ),
        ).toMatchInlineSnapshot(
            `"subject blocked; the decision model judged it able to overwrite or remove file content without replacing it (0.51), and it was not confident enough to let the command through. There was no user to ask."`,
        );

        expect(
            attributed(
                classifierRecord({
                    criterion: "none",
                    confidence: 0.95,
                    outcome: "host",
                    status: "applied",
                    reason: "model chose host above threshold",
                    applied: false,
                }),
            ),
        ).toMatchInlineSnapshot(
            `"subject blocked; the decision model judged it an ordinary command for this runner (0.95), and this session records verdicts without acting on them (record-only mode). There was no user to ask."`,
        );

        expect(
            attributed(
                classifierRecord({
                    criterion: "privileged",
                    confidence: undefined,
                    outcome: "abstain",
                    status: "abstained",
                    reason: "sandbox unavailable",
                    applied: false,
                }),
            ),
        ).toMatchInlineSnapshot(
            `"subject blocked; the decision model judged it in need of root privileges or system changes (no confidence), and it needed a sandbox that is not available here. There was no user to ask."`,
        );

        // A policy reason this table does not know keeps its own text, so the cause stays findable.
        expect(
            attributed(
                classifierRecord({
                    criterion: "network",
                    reason: "some future reason",
                    outcome: "abstain",
                    status: "abstained",
                    applied: false,
                }),
            ),
        ).toMatchInlineSnapshot(
            `"subject blocked; the decision model judged it able to send or receive data over the network (0.90), and the verdict was not acted on (some future reason). There was no user to ask."`,
        );
    });

    it("reports a request that never answered", () => {
        expect(
            attributed(
                classifierRecord({
                    criterion: undefined,
                    action: undefined,
                    confidence: undefined,
                    outcome: "abstain",
                    status: "timeout",
                    reason: "decision model request timed out",
                    applied: false,
                }),
            ),
        ).toMatchInlineSnapshot(
            `"subject blocked; the decision model did not produce an answer (timeout). There was no user to ask."`,
        );

        expect(
            attributed(
                classifierRecord({
                    criterion: undefined,
                    confidence: undefined,
                    outcome: "abstain",
                    status: "error",
                    reason: "decision model failed: no classifier model",
                    applied: false,
                }),
            ),
        ).toMatchInlineSnapshot(
            `"subject blocked; the decision model did not produce an answer (error). There was no user to ask."`,
        );
    });

    it("leaves the gate's wording alone when a person answered or the model never spoke", () => {
        const withheld = classifierRecord({ applied: false, outcome: "abstain" });

        expect(
            attributedBashBlockReason({
                subject: "Command execution",
                record: withheld,
                humanAsked: true,
            }),
        ).toBeUndefined();

        expect(
            attributedBashBlockReason({
                subject: "Command execution",
                record: undefined,
                humanAsked: false,
            }),
        ).toBeUndefined();
    });

    it("treats only an allow as letting the call through", () => {
        expect(permissionAllowsCall("allow")).toBe(true);
        expect(permissionAllowsCall("allow:sandbox")).toBe(true);
        // The hole this closes: a `deny` is a block, not the absence of a prompt.
        expect(permissionAllowsCall("deny")).toBe(false);
        expect(permissionAllowsCall("ask")).toBe(false);
    });

    it("tells a read-only child that its verdict is the whole decision", () => {
        expect(readOnlyGateSentence(refused("out_of_scope"), "withheld")).toMatchInlineSnapshot(
            `"The decision model judged it beyond what this runner is authorized to do (0.90), and only a person can approve a command it refuses. This agent has no prompt to ask through."`,
        );

        expect(
            readOnlyGateSentence(
                classifierRecord({
                    criterion: "none",
                    confidence: 0.95,
                    outcome: "host",
                    status: "applied",
                    reason: "model chose host above threshold",
                    applied: false,
                }),
                "withheld",
            ),
        ).toMatchInlineSnapshot(
            `"The decision model judged it an ordinary command for this runner (0.95), and this session records verdicts without acting on them (record-only mode). This agent has no prompt to ask through."`,
        );

        const granted = classifierRecord({
            criterion: "none",
            action: "host",
            outcome: "host",
            status: "applied",
            reason: "model chose host above threshold",
            confidence: 0.95,
        });

        expect(
            readOnlyGateSentence({ ...granted, script: { kind: "binary" } }, "held"),
        ).toMatchInlineSnapshot(
            `"The decision model judged it an ordinary command for this runner (0.95) and cleared the command, but the command runs a script the model never read (script kind binary). This agent has no prompt to ask through."`,
        );

        expect(readOnlyGateSentence(granted, "held")).toMatchInlineSnapshot(
            `"The decision model judged it an ordinary command for this runner (0.95) and cleared the command, but the command runs a script the model never read (script kind unrecognized). This agent has no prompt to ask through."`,
        );
    });
});
