import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
    ClassifierAnswer,
    ClassifierApi,
    ClassifierContext,
    ClassifierModel,
    ClassifierResult,
} from "@earendil-works/pi-ai";

import type { BashClassifierRecord } from "../../../src/modules/sandbox/decision-log";

import {
    FILE_KIND_QUESTION,
    FILE_LOSS_QUESTION,
    FILE_PURPOSE_QUESTION,
    REMINDER_FINISHING_QUESTION,
    REMINDER_PHASE_QUESTION,
    REMINDER_UNVALIDATED_QUESTION,
    SCRIPT_QUESTION,
    SUGGESTION_QUESTION_ID,
    VETO_QUESTION,
    type ClassifierRegistry,
} from "../../../src/modules/decision";

export type Classifier = ClassifierModel<ClassifierApi>;

/** A classifier model with the fields the decision module reads. */
export function classifier(provider: string, id: string): Classifier {
    return {
        id,
        name: id,
        api: "typesafe-system-one",
        provider,
        baseUrl: "https://example.invalid",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        type: "classifier",
        contextWindow: 8192,
    };
}

/** A choice answer as the provider returns it: the label, its probability, and a confidence. */
export function choiceAnswer(choice: string, confidence: number): ClassifierAnswer {
    return { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
}

function result(model: Classifier, answers: Record<string, ClassifierAnswer>): ClassifierResult {
    return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers,
        stopReason: "stop",
        timestamp: 0,
    };
}

/**
 * A successful answer to the criterion question: the one request every strategy sends, and the only answer
 * the evaluator reads. The label is a criterion id, not an action — the table in `classification.ts` is what
 * turns it into one.
 */
export function criterionResult(
    model: Classifier,
    reason: string,
    confidence: number,
): ClassifierResult {
    return result(model, { [VETO_QUESTION]: choiceAnswer(reason, confidence) });
}

/** A successful answer to the script capability question, with a capability id as the label. */
export function scriptResult(
    model: Classifier,
    capability: string,
    confidence: number,
): ClassifierResult {
    return result(model, { [SCRIPT_QUESTION]: choiceAnswer(capability, confidence) });
}

/** A successful answer to the suggestion role question: the probability that an argument is executed code. */
export function suggestionResult(model: Classifier, probability: number): ClassifierResult {
    return result(model, { [SUGGESTION_QUESTION_ID]: { type: "bool", probability } });
}

/** The piggybacked reminder-state answers a case can include beside the choice. */
export interface ReminderStateAnswers {
    phase?: string;
    /** Probability that the task is wrapping up. */
    finishing?: number;
    /** Probability that changes are unvalidated. */
    unvalidated?: number;
}

/**
 * A successful answer to the reminder request: one probability per offered reminder, plus any state labels.
 *
 * Every offered id needs an entry, because the endpoint answers every question in the request.
 */
export function reminderResult(
    model: Classifier,
    probabilities: Record<string, number>,
    labels: ReminderStateAnswers = {},
    extras: Record<string, ClassifierAnswer> = {},
): ClassifierResult {
    const answers: Record<string, ClassifierAnswer> = {};
    for (const [id, probability] of Object.entries(probabilities)) {
        answers[id] = { type: "bool", probability };
    }

    return result(model, { ...answers, ...reminderLabelAnswers(labels), ...extras });
}

/**
 * A successful answer to the reminder request in the score form: one helpfulness level per offered reminder.
 *
 * The endpoint returns a continuous level in `[0, criteria.length - 1]` for a `score` question, not a
 * probability, so a case states the level directly.
 */
export function reminderScoreResult(
    model: Classifier,
    scores: Record<string, number>,
    labels: ReminderStateAnswers = {},
    extras: Record<string, ClassifierAnswer> = {},
): ClassifierResult {
    const answers: Record<string, ClassifierAnswer> = {};
    for (const [id, score] of Object.entries(scores)) {
        answers[id] = { type: "score", score, confidence: 0.5 };
    }

    return result(model, { ...answers, ...reminderLabelAnswers(labels), ...extras });
}

/** The piggybacked label answers, which are bool/choice in either reminder form. */
function reminderLabelAnswers(labels: ReminderStateAnswers): Record<string, ClassifierAnswer> {
    const answers: Record<string, ClassifierAnswer> = {};

    if (labels.phase !== undefined) {
        answers[REMINDER_PHASE_QUESTION] = choiceAnswer(labels.phase, 0.9);
    }
    if (labels.finishing !== undefined) {
        answers[REMINDER_FINISHING_QUESTION] = { type: "bool", probability: labels.finishing };
    }
    if (labels.unvalidated !== undefined) {
        answers[REMINDER_UNVALIDATED_QUESTION] = { type: "bool", probability: labels.unvalidated };
    }

    return answers;
}

/** What a file-access answer pair says, in the shape a case reads as one line. */
export interface FileAccessAnswer {
    /** The kind label, e.g. `code`. */
    kind: string;
    /** The purpose label, e.g. `routine`. */
    purpose: string;
    /** The kind answer's confidence, which is the axis `policy.ts` gates a grant by (default 0.9). */
    confidence?: number;
    /** The purpose answer's confidence. Thin by nature on this subject, so it is only worth pinning to. */
    purposeConfidence?: number;
    /**
     * The probability a write destroys unasked content. Absent means the loss question was not asked, which
     * is what a read's request looks like — so a case that sets it here is claiming the write arm ran.
     */
    loss?: number;
}

/**
 * A successful answer to the file-access subject: the kind and purpose choices, plus the write's loss bool.
 *
 * Built as one result because the subject asks all of its questions in one request; a test that wanted them
 * separated would be testing a request shape the module never sends.
 */
export function fileAccessResult(model: Classifier, answer: FileAccessAnswer): ClassifierResult {
    const answers: Record<string, ClassifierAnswer> = {
        [FILE_KIND_QUESTION]: choiceAnswer(answer.kind, answer.confidence ?? 0.9),
        [FILE_PURPOSE_QUESTION]: choiceAnswer(answer.purpose, answer.purposeConfidence ?? 0.24),
    };

    if (answer.loss !== undefined) {
        answers[FILE_LOSS_QUESTION] = { type: "bool", probability: answer.loss };
    }

    return result(model, answers);
}

/** The same result with the raw answers exposed, for a case that needs to assert on the request's labels. */
export function fileAccessAnswerOf(result: ClassifierResult): FileAccessAnswer {
    const kind = result.answers[FILE_KIND_QUESTION];
    const purpose = result.answers[FILE_PURPOSE_QUESTION];
    const loss = result.answers[FILE_LOSS_QUESTION];

    return {
        kind: kind?.type === "choice" ? kind.choice : "?",
        purpose: purpose?.type === "choice" ? purpose.choice : "?",
        confidence: kind?.type === "choice" ? kind.confidence : 0,
        purposeConfidence: purpose?.type === "choice" ? purpose.confidence : 0,
        loss: loss?.type === "bool" ? loss.probability : undefined,
    };
}

/**
 * A decision-log record, as a gate would write one after consulting the model.
 *
 * The gates render agent-facing text from this shape (`attributedBashBlockReason`, `readOnlyGateSentence`), so a test
 * that pins a sentence needs a record rather than a verdict. Defaults describe an applied host verdict; each
 * case states only the fields that make its sentence different.
 */
export function classifierRecord(
    overrides: Partial<BashClassifierRecord> = {},
): BashClassifierRecord {
    return {
        strategy: "veto",
        provider: "test-provider",
        model: "test-classifier",
        criterion: "none",
        action: "host",
        confidence: 0.9,
        outcome: "host",
        status: "applied",
        reason: "model chose host above threshold",
        latencyMs: 12,
        applied: true,
        ...overrides,
    };
}

/** A registry that resolves models but never classifies; for testing model selection. */
export function selectionRegistry(models: Classifier[]): ClassifierRegistry {
    return {
        getModelOfType: (_type, provider, modelId) =>
            models.find((model) => model.provider === provider && model.id === modelId),
        getModelsOfType: (_type, provider) =>
            provider === undefined ? models : models.filter((model) => model.provider === provider),
        classify: async () => {
            throw new Error("selectionRegistry does not classify");
        },
    };
}

/** How a registry double answers a classification. */
export type ClassifierBehavior = (
    model: Classifier,
    context: ClassifierContext,
    signal: AbortSignal | undefined,
) => Promise<ClassifierResult>;

/** A registry that resolves `models` and answers every classification through `behavior`. */
export function answeringRegistry(
    models: Classifier[],
    behavior: ClassifierBehavior,
): ClassifierRegistry {
    return {
        ...selectionRegistry(models),
        classify: (model, context, options) => behavior(model, context, options?.signal),
    };
}

/**
 * The registry face of an `ExtensionContext`. pi's `ModelRegistry` is a class surface with no partial
 * construction path, so the one cast lives here; the decision module only reads the classifier members this
 * double promises.
 */
export function classifierModelRegistry(
    registry: ClassifierRegistry,
): ExtensionContext["modelRegistry"] {
    return registry as unknown as ExtensionContext["modelRegistry"];
}
