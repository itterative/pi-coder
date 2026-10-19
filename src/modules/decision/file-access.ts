import type {
    ClassifierAnswer,
    ClassifierContext,
    ClassifierQuestion,
    JsonObject,
} from "@earendil-works/pi-ai";

import type { FoldableAnswer } from "./policy";
import { RUNNER_AUTHORITY, runnerRulesForFileAccess, type DecisionRunner } from "./runner-rules";
import type {
    DecisionCriterion,
    FileAccessDecisionContext,
    FileDecisionKind,
    FileDecisionOperation,
    FileDecisionPurpose,
} from "./types";

/**
 * The file-access subject: what a path is, whether the runner's request reaches it, and whether writing it
 * loses anything.
 *
 * The command vocabulary does not transfer. Asked the shipped veto question over real outside-cwd accesses, a
 * classifier answered `none` for 105 of 111 and would have resolved 7 of the 8 the user refused, because "is
 * there any reason not to read this .md file?" has no discriminative answer. A path is decided instead by
 * three questions with different confidence shapes, each read on its own terms: the **kind** of file (a
 * property of the location and name, answered confidently — `code` at 0.93 median, and the axis that carries
 * the confidence floor), the **purpose** (a four-way label whose probability sits near 0.24 even when it is
 * right, so it is read as a label and never as a number), and the **loss** risk of a write (a probability read
 * against a threshold). On the measured corpus that composite resolves 62 of 102 approved accesses, grants
 * none of the 8 refused ones, and leaks none of the 9 hand-labelled private paths.
 *
 * All three ride in one request: they are one decision, and splitting them costs a round trip and no fold
 * that means anything. The file's content is never sent — a classifier that read the file to decide whether it
 * was sensitive would leak the thing it is gating.
 */

export const FILE_KIND_QUESTION = "kind";
export const FILE_PURPOSE_QUESTION = "purpose";
export const FILE_LOSS_QUESTION = "loss";

/** The id the decision log records as this subject's strategy. */
export const FILE_ACCESS_STRATEGY = "file-access";

/** A probability at or above this that a write destroys unasked content withholds the grant. */
export const FILE_LOSS_THRESHOLD = 0.5;

/**
 * What the file is, judged from its location and name alone.
 *
 * `code`, `data`, and `settings` are the kinds a coding session touches as its own material; `personal`,
 * `secret`, and `system` are the kinds it has no ordinary reason to touch. They are here because the purpose
 * question cannot see them: a private file the user happens to have mentioned is still a private file.
 */
export const FILE_KIND_CRITERIA: Record<FileDecisionKind, string> = {
    code: "Source code, documentation, or configuration of a software project",
    data: "Program output, logs, caches, or temporary working files",
    settings: "A user's own shell, editor, or tool configuration",
    personal: "A person's private document, message, photo, or recording",
    secret: "Credentials, keys, tokens, or other authentication material",
    system: "An OS or service file the machine depends on",
};

/**
 * Whether the runner's request reaches this file.
 *
 * The read-side phrasing of `routine` is the measured wording and it is not accidental: on the corpus's ten
 * write cases it named every one of them `unrelated`, which is why writes resolve at 2 of 10 today. That is
 * the conservative direction, and it ships unchanged — widening it is a measurement against
 * `file-cases.jsonl`, not a string to swap here.
 */
export const FILE_PURPOSE_CRITERIA: Record<FileDecisionPurpose, string> = {
    asked_for: "The user named or clearly implied this file, or the folder it is in",
    routine: "Reading it is an ordinary step in the work the user asked for",
    tangential: "It might help, but the user did not ask for anything in it",
    unrelated: "Nothing in the request has to do with this file",
};

export const FILE_KIND_INSTRUCTION =
    "What kind of file is this path, from its location and name alone? Choose the single best criterion.";

export const FILE_PURPOSE_INSTRUCTION =
    "Does the user's current request need this file touched? Choose the single best criterion.";

export const FILE_LOSS_INSTRUCTION =
    "Would writing this file remove content the user did not ask to lose?";

/** The kinds that may be touched as ordinary work material. */
const GRANTING_KINDS: readonly FileDecisionKind[] = ["code", "data", "settings"];

/** The purposes that grant a read. */
const GRANTING_PURPOSES: readonly FileDecisionPurpose[] = ["asked_for", "routine"];

/**
 * The purpose that grants a write.
 *
 * Reading the wrong file costs a round trip; writing the wrong one costs content the user cannot get back, so
 * a write has to be what the request named rather than merely ordinary for it.
 */
const GRANTING_WRITE_PURPOSES: readonly FileDecisionPurpose[] = ["asked_for"];

/** The criterion recorded when a write is withheld for what it would destroy. */
const LOSES_CONTENT_REASON: DecisionCriterion = "loses_content";

/**
 * The least authority a file operation requires, mirroring `scope.ts` for script capabilities.
 *
 * Decided in code rather than asked, because the measurement says the model does not police authority: shown
 * a scout's own rules, it named a write into another repository ordinary. The rung is what keeps a read-only
 * runner read-only whatever the classifier says about the path.
 */
const REQUIRED_AUTHORITY: Record<FileDecisionOperation, "inspect" | "mutate"> = {
    read: "inspect",
    write: "mutate",
};

const AUTHORITY_ORDER: Record<"inspect" | "command" | "mutate", number> = {
    inspect: 0,
    command: 1,
    mutate: 2,
};

const KIND_QUESTION: ClassifierQuestion = {
    type: "choice",
    instructions: FILE_KIND_INSTRUCTION,
    criteria: FILE_KIND_CRITERIA,
};

const PURPOSE_QUESTION: ClassifierQuestion = {
    type: "choice",
    instructions: FILE_PURPOSE_INSTRUCTION,
    criteria: FILE_PURPOSE_CRITERIA,
};

const LOSS_QUESTION: ClassifierQuestion = {
    type: "bool",
    instructions: FILE_LOSS_INSTRUCTION,
    criteria: {
        true: "Existing content is destroyed or replaced beyond what the request asked for",
        false: "Nothing is lost: a new file, or content the request asked to replace",
    },
};

/**
 * The file-access state.
 *
 * Deliberately not the command state: no `command`, no script body, no working-tree status, no recent
 * transcript. `request` is load-bearing and measured as such — with it dropped, this same composite named 7 of
 * the 8 refused accesses safe enough to grant. `runner_rules` carries the file-access phrasing, because the
 * command phrasing ("read, create, edit, and delete files in the user's working tree") reads every outside
 * path as unauthorised and pushed the corpus toward withholding.
 */
export function buildFileAccessState(context: FileAccessDecisionContext): JsonObject {
    const state: JsonObject = {
        operation: context.file.operation,
        path: context.file.path,
        cwd: context.cwd,
        runner_rules: [
            ...runnerRulesForFileAccess(
                context.runner ?? "parent",
                context.isolation ?? "checkout",
            ),
        ],
    };

    const request = context.request?.trim();
    if (request !== undefined && request !== "") {
        state.request = request;
    }

    return state;
}

/**
 * One request, the questions this subject needs.
 *
 * `loss` is asked only for a write: a read cannot destroy anything, and asking it anyway would add a decision
 * whose answer means nothing.
 */
export function fileAccessRequest(state: JsonObject): ClassifierContext {
    const questions: Record<string, ClassifierQuestion> = {
        [FILE_KIND_QUESTION]: KIND_QUESTION,
        [FILE_PURPOSE_QUESTION]: PURPOSE_QUESTION,
    };

    if (state.operation === "write") {
        questions[FILE_LOSS_QUESTION] = LOSS_QUESTION;
    }

    return { state, questions };
}

function isFileDecisionKind(value: string): value is FileDecisionKind {
    return Object.hasOwn(FILE_KIND_CRITERIA, value);
}

function isFileDecisionPurpose(value: string): value is FileDecisionPurpose {
    return Object.hasOwn(FILE_PURPOSE_CRITERIA, value);
}

interface ChoiceAnswer {
    choice: string;
    confidence: number;
}

/** The answered label and its confidence, or `undefined` when the answer is missing or unusable. */
function choiceOf(
    answers: Record<string, ClassifierAnswer>,
    question: string,
): ChoiceAnswer | undefined {
    const answer = answers[question];
    if (answer === undefined || answer.type !== "choice") {
        return undefined;
    }

    if (typeof answer.confidence !== "number") {
        return undefined;
    }

    return { choice: answer.choice, confidence: answer.confidence };
}

/** The probability the loss answer put on "content is destroyed", or 0 when the question was not asked. */
function lossProbability(answers: Record<string, ClassifierAnswer>): number {
    const answer = answers[FILE_LOSS_QUESTION];
    if (answer === undefined || answer.type !== "bool") {
        return 0;
    }

    return typeof answer.probability === "number" ? answer.probability : 0;
}

/**
 * Read the answers as one verdict.
 *
 * The confidence handed back is the **kind** answer's, because that is the calibrated axis and `policy.ts`
 * gates a grant by it: it is what stops a hesitant guess about a private path from becoming an approval, while
 * gating the thin-spread purpose answer by the same floor collapses the subject to 2 of 102 approved accesses.
 *
 * A `refuse` is what policy never applies by itself, so a withheld access still reaches the human. This subject
 * can prevent a prompt; it can never replace one with a denial.
 */
export function fileAccessAnswerFrom(
    answers: Record<string, ClassifierAnswer>,
    operation: FileDecisionOperation,
): FoldableAnswer | undefined {
    const kind = choiceOf(answers, FILE_KIND_QUESTION);
    const purpose = choiceOf(answers, FILE_PURPOSE_QUESTION);
    if (kind === undefined || purpose === undefined) {
        return undefined;
    }

    if (!isFileDecisionKind(kind.choice) || !isFileDecisionPurpose(purpose.choice)) {
        return undefined;
    }

    const withholds = withholdReason(kind.choice, purpose.choice, operation, answers);

    return {
        action: withholds === undefined ? "host" : "refuse",
        confidence: kind.confidence,
        reason: withholds ?? purpose.choice,
    };
}

/**
 * Which answer withheld the grant, or `undefined` when none did.
 *
 * Checked in the order a reader would ask about it: is this the kind of file a session touches as its own
 * material, does the request reach it, and for a write, does it destroy anything. The kind is checked first
 * because it is the one answer that must stay withheld whatever the request says — a confident `asked_for` on
 * a key file is still a key file.
 */
function withholdReason(
    kind: FileDecisionKind,
    purpose: FileDecisionPurpose,
    operation: FileDecisionOperation,
    answers: Record<string, ClassifierAnswer>,
): DecisionCriterion | undefined {
    if (!GRANTING_KINDS.includes(kind)) {
        return kind;
    }

    const grantingPurposes = operation === "write" ? GRANTING_WRITE_PURPOSES : GRANTING_PURPOSES;
    if (!grantingPurposes.includes(purpose)) {
        return purpose;
    }

    if (operation === "write" && lossProbability(answers) >= FILE_LOSS_THRESHOLD) {
        return LOSES_CONTENT_REASON;
    }

    return undefined;
}

/** Whether this runner's authority reaches this operation, decided from the ladder rather than the model. */
export function fileAccessWithinAuthority(
    operation: FileDecisionOperation,
    runner: DecisionRunner,
): boolean {
    const required = AUTHORITY_ORDER[REQUIRED_AUTHORITY[operation]];

    return AUTHORITY_ORDER[RUNNER_AUTHORITY[runner]] >= required;
}

/**
 * The scope verdict for an operation the runner has no authority to perform, or `undefined` when it has.
 *
 * Confidence 0 like the command scope gate: there is no model belief to report, and a named danger should
 * outrank the scope label when both withhold.
 */
export function fileScopeAnswer(
    operation: FileDecisionOperation,
    runner: DecisionRunner,
): FoldableAnswer | undefined {
    if (fileAccessWithinAuthority(operation, runner)) {
        return undefined;
    }

    return { action: "refuse", reason: "out_of_scope", confidence: 0 };
}
