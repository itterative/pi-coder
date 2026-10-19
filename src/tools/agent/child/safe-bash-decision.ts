import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import decisionConfig from "../../../modules/decision/config";
import { decisionEnabled } from "../../../modules/decision/gate";
import { decisionRunnerForAgent } from "../../../modules/decision/runner-rules";
import type { DecisionAuthority } from "../../../modules/decision";
import { logBashDecision } from "../../../modules/sandbox/decision-log";
import type { BashClassifierRecord } from "../../../modules/sandbox/decision-log";
import type { HeuristicAssessment } from "../../../modules/sandbox/heuristics";
import { consultForGate, readOnlyGateSentence } from "../../decision-model";
import type { AgentAuthority } from "../definitions/types";
import type { ChildGateRuntime } from "./gates/runtime";
import {
    classifyRelaxedConfinement,
    isModelConsultableAssessment,
    type SafeBashConsultResult,
    type SafeBashOptions,
} from "./safe-bash";

/** What one read-only-gate consult needs: the gate runtime, the event's context, and the command's roots. */
export interface SafeBashConsultOptions {
    runtime: ChildGateRuntime;
    ctx: ExtensionContext;
    command: string;
    /** The child's read roots and declared safe-Bash patterns, shared with the strict assessment. */
    roots: SafeBashOptions;
}

/**
 * The decision-model second opinion for a read-only child's Bash call.
 *
 * Below the `command` rung a child has no prompt to fall back on, so the deterministic guard is the whole
 * policy: `SAFE_READONLY` runs, everything else is blocked. This callback gives an allowlist failure a
 * chance to be judged instead, under three deterministic conditions, all evaluated before the model is
 * asked:
 *
 * 1. the only reasons are allowlist ones — a confinement failure (outside cwd, sensitive path, symlink
 *    escape, dynamic path, dangerous environment, parse failure) belongs to the heuristic and a classifier
 *    cannot overwrite it;
 * 2. the relaxed assessment (the unknown executable admitted as a generic, path-checked command) either
 *    passes, or fails only on dynamic paths while the command's one code subject was read and every
 *    unmodeled word is data (`classifyRelaxedConfinement`);
 * 3. the child surface is enabled in the decision config, and `apply` is what lets a verdict act.
 *
 * The model verdict then faces one more read-only rule: a recognized script whose body was never judged (a
 * `binary` run such as `npx`/`python3 -m`, or an inline operand assembled dynamically) stays blocked, because
 * the scope gate has no capability to fold and an unread body must not gain authority through the invocation
 * answer. Failures abstain, and an abstain blocks — the gate never widens authority on model trouble.
 *
 * Returns whether the call may proceed, and the verdict's sentence when it does not, so the block the child
 * reads names what stopped it. The caller still applies the strict runtime rules (the fsmonitor check) after
 * a clear result.
 */
export function createSafeBashConsult(
    options: SafeBashConsultOptions,
): (assessment: HeuristicAssessment) => Promise<SafeBashConsultResult> {
    const { runtime, ctx, command, roots } = options;
    const { options: childOptions } = runtime;
    const { agentName, isolated, events, onTrace } = childOptions;

    return async (assessment: HeuristicAssessment): Promise<SafeBashConsultResult> => {
        if (!isModelConsultableAssessment(assessment)) {
            return { allowed: false };
        }

        const config = decisionConfig.load(ctx.cwd ?? runtime.cwd);
        if (!decisionEnabled(config, "child")) {
            return { allowed: false };
        }

        const confinement = classifyRelaxedConfinement(command, ctx.cwd ?? runtime.cwd, roots);
        if (confinement === "unsafe") {
            onTrace?.("safe_bash.model_skipped", { reason: "confinement" });
            return { allowed: false };
        }

        const consulted = await consultForGate({
            ctx,
            config,
            command,
            // There is no bwrap execution on this path, so a `sandbox` verdict abstains and the call blocks.
            sandboxAvailable: false,
            runner: decisionRunnerForAgent(agentName),
            isolation: isolated ? "worktree" : "checkout",
            authority: decisionAuthorityFor(childOptions.authority),
            registry: runtime.parentContext.modelRegistry,
            label: `${agentName}'s command`,
            notify: (message, level) => runtime.parentContext.ui.notify(message, level),
            ...(events === undefined ? {} : { events }),
        });

        const granted = consulted.permission === "allow";
        const covered = capabilityCoversReadOnlyCommand(consulted.record);
        const held = granted && !covered;
        recordConsult({
            runtime,
            command,
            record: consulted.record,
            allowed: granted,
            held,
        });

        if (!granted || held) {
            onTrace?.(held ? "safe_bash.model_held" : "safe_bash.model_withheld", {
                reason: consulted.record.reason,
                ...(consulted.record.criterion === undefined
                    ? {}
                    : { criterion: consulted.record.criterion }),
                ...(consulted.record.action === undefined
                    ? {}
                    : { action: consulted.record.action }),
            });

            return {
                allowed: false,
                // `held` needs the grant to be standing (an unjudged body only matters once the command answer
                // cleared it); everything else is the verdict not clearing the command, and whether it refused
                // or was merely not allowed to act is in the record, which the sentence itself reads.
                reason: readOnlyGateSentence(consulted.record, held ? "held" : "withheld"),
            };
        }

        onTrace?.("safe_bash.model_allowed", {
            ...(consulted.record.criterion === undefined
                ? {}
                : { criterion: consulted.record.criterion }),
            ...(consulted.record.confidence === undefined
                ? {}
                : { confidence: consulted.record.confidence }),
        });
        return { allowed: true };
    };
}

/** The child's declared rung, mapped to the decision vocabulary. `read` has no Bash but maps to `inspect`. */
function decisionAuthorityFor(authority: AgentAuthority): DecisionAuthority {
    switch (authority) {
        case "command":
            return "command";
        case "mutate":
            return "mutate";
        default:
            return "inspect";
    }
}

/**
 * Whether a verdict's script facts cover every body the command runs.
 *
 * `package` and `file` bodies are classified and the scope gate folds their capabilities; a body that failed
 * to answer abstained the whole verdict before this point. `binary` runs code from outside the repository, and
 * inline code whose operand was not a literal has no body at all, so neither has anything for the scope gate
 * to judge. `undefined` means no script was recognized and the command answer is the whole verdict.
 */
function capabilityCoversReadOnlyCommand(record: BashClassifierRecord): boolean {
    const script = record.script;
    if (script === undefined) {
        return true;
    }

    if (script.kind === "binary") {
        return false;
    }

    if (script.kind === "inline") {
        return (script.answers?.length ?? 0) > 0;
    }

    return true;
}

/** Record what the read-only gate decided, since its blocks never pass through the resolver's writer. */
function recordConsult(input: {
    runtime: ChildGateRuntime;
    command: string;
    record: BashClassifierRecord;
    allowed: boolean;
    held: boolean;
}): void {
    const { runtime, command, record, allowed, held } = input;
    logBashDecision({
        surface: "child",
        agentName: runtime.options.agentName,
        cwd: runtime.cwd,
        command,
        readOnlyGate: true,
        classifier: record,
        decision: allowed && !held ? "allow" : "deny",
        sandboxed: false,
        blocked: !allowed || held,
        ...(held ? { note: "read-only gate held a script body the model never judged" } : {}),
    });
}
