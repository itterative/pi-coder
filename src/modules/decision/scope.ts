import type { FoldableAnswer } from "./policy";
import { RUNNER_AUTHORITY, type DecisionRunner } from "./runner-rules";
import type { ScriptCapability, ScriptCapabilitySummary } from "./types";

/** The authority rungs a capability can require, lowest first. */
type DecisionAuthority = "inspect" | "command" | "mutate";

const AUTHORITY_ORDER: Record<DecisionAuthority, number> = {
    inspect: 0,
    command: 1,
    mutate: 2,
};

/**
 * The least authority a capability requires.
 *
 * Grounded in the runner rules the state already carries, but decided in code because "may this runner run
 * code that does X" has a fixed answer per rung, and the model measured worse at it once the bodies stopped
 * travelling with the command: `npm run scratch` under a reviewer came back `none @ 0.488` with
 * `writes_outside` in the state, where the composite could read the body and answer `out_of_scope`.
 * `read_only` is the inspect floor; `writes_files` is what a reviewer's own build and test commands do;
 * everything else — writing outside the checkout, network, privilege, remote code, destruction, process
 * control — needs a mutating runner.
 */
const REQUIRED_AUTHORITY: Record<ScriptCapability, DecisionAuthority> = {
    read_only: "inspect",
    writes_files: "command",
    writes_outside: "mutate",
    network: "mutate",
    privileged: "mutate",
    remote_code: "mutate",
    destructive: "mutate",
    process_control: "mutate",
};

/**
 * The scope verdict for a set of capabilities under one runner, or `undefined` when its authority covers all
 * of them.
 *
 * This is a `refuse`/`out_of_scope` answer that needs no request, and it composes into the fold like any
 * other form, so a capability the runner may not execute prompts whatever the command classification said.
 * Confidence is 0 on purpose: there is no model belief here, and it lets a named danger outrank the scope
 * label when both refuse.
 *
 * The rung comes from `RUNNER_AUTHORITY`, which mirrors the delegated-agent ladder. A custom agent maps to
 * the `agent` baseline (command rung), so a custom mutating definition is treated conservatively — prompted
 * rather than trusted; passing its real ladder into the decision context is the follow-up.
 */
export function scopeAnswer(
    profiles: readonly ScriptCapabilitySummary[],
    runner: DecisionRunner,
): FoldableAnswer | undefined {
    const authority = AUTHORITY_ORDER[RUNNER_AUTHORITY[runner]];
    const forbidden = profiles.find(
        (profile) => AUTHORITY_ORDER[REQUIRED_AUTHORITY[profile.capability]] > authority,
    );
    if (forbidden === undefined) {
        return undefined;
    }

    return { action: "refuse", reason: "out_of_scope", confidence: 0 };
}
