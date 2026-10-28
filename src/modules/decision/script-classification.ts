import type {
    ClassifierAnswer,
    ClassifierContext,
    ClassifierQuestion,
} from "@earendil-works/pi-ai";

import { SCRIPT_QUESTION, type ScriptState } from "./contract";
import type { FoldableAnswer } from "./policy";
import type { DecisionAction, ScriptCapability } from "./types";

/**
 * The script classifier: what a body of code can do when it runs.
 *
 * This is deliberately not the command classification. A command verdict is about an invocation — who asked,
 * what the runner is allowed to touch, what the arguments do — and its state carries the request, the recent
 * turns, and the runner's rules. A script verdict is about the code: the same bytes are the same subject
 * whether they run from `npm run deploy`, from a bare `./deploy.sh`, or in a worktree. So this request
 * carries the body alone, the evaluator keys its answer cache on the body's content hash, and the vocabulary
 * is capabilities rather than command criteria — `out_of_scope` is runner × capability and is composed when
 * the command classification sees these summaries beside the runner's rules, not answered here.
 */
/** The capability question for a script body: one capability, the most consequential one. */
export const SCRIPT_INSTRUCTION =
    "What can the code below do when it runs? Choose the single most consequential capability, or `read_only`.";

/**
 * The capabilities the classifier chooses between, in the order the model reads them.
 *
 * The labels are effects, not verdicts: `writes_files` is normal work for a runner that owns its copy and
 * forbidden for one that does not, and `network` is allowed for the parent and forbidden for a read-only
 * child — both facts the command classification applies once it has these summaries. `read_only` is the only
 * label that adds no constraint anywhere.
 */
export const SCRIPT_CRITERIA: Record<ScriptCapability, string> = {
    read_only: "Reads files or computes; no side effects on the machine",
    writes_files: "Creates, edits, or deletes files in the working tree",
    writes_outside: "Changes files outside the working tree or system state",
    privileged: "Uses root privileges or changes system services",
    network: "Sends or receives data over the network",
    remote_code: "Downloads and executes code from outside this repository",
    destructive: "Irreversibly destroys data that cannot be recovered",
    process_control: "Signals or kills processes, or manages services",
};

/**
 * Capability to the most that can be done with it, before the runner is considered.
 *
 * `host` rows are the capabilities a runner's own rules may still forbid — the command classification sees
 * these summaries beside those rules, so scope is judged there rather than duplicated here. `sandbox` rows
 * are contained by what the sandbox is: an unprivileged user namespace contains privilege, and no writable
 * path outside the checkout contains system writes. `refuse` rows are not contained by it — the sandbox
 * binds the working tree read-write and shares the host's pid namespace and network, so data loss, remote
 * code, and process control happen regardless.
 */
export const SCRIPT_ACTION_TABLE: Record<ScriptCapability, DecisionAction> = {
    read_only: "host",
    writes_files: "host",
    writes_outside: "sandbox",
    privileged: "sandbox",
    network: "host",
    remote_code: "refuse",
    destructive: "refuse",
    process_control: "refuse",
};

const CAPABILITY_QUESTION: ClassifierQuestion = {
    type: "choice",
    instructions: SCRIPT_INSTRUCTION,
    criteria: SCRIPT_CRITERIA,
};

/** The one request for one body: the code itself, and the capability question. */
export function scriptRequest(body: string): ClassifierContext {
    const state: ScriptState = { code: body };
    return { state, questions: { [SCRIPT_QUESTION]: CAPABILITY_QUESTION } };
}

/** Whether a label is one of the script capabilities, for reading an answer from outside this module. */
export function isScriptCapability(value: string): value is ScriptCapability {
    return Object.hasOwn(SCRIPT_CRITERIA, value);
}

/**
 * Read the capability the model named, and take its action from the table.
 *
 * `undefined` for a missing answer, a non-choice answer, or a label outside the capabilities, so an
 * unreadable reply abstains (the whole command prompts) rather than being mapped to a default capability.
 */
export function scriptAnswerFrom(
    answers: Record<string, ClassifierAnswer>,
): FoldableAnswer | undefined {
    const answer = answers[SCRIPT_QUESTION];
    if (answer === undefined || answer.type !== "choice") {
        return undefined;
    }

    if (!isScriptCapability(answer.choice)) {
        return undefined;
    }

    return {
        action: SCRIPT_ACTION_TABLE[answer.choice],
        reason: answer.choice,
        confidence: answer.confidence,
    };
}
