import type { AnsweredVeto } from "./questions";
import { isDangerousVeto } from "./questions";
import type {
    DecisionAction,
    DecisionCriterion,
    DecisionModelConfig,
    DecisionOutcome,
} from "./types";

/** Default confidence needed before `host` may run without a prompt. */
export const DEFAULT_MIN_CONFIDENCE = 0.8;

/** Default confidence below which a `host` answer triggers the second-opinion veto. */
export const DEFAULT_VETO_GATE = 0.6;

/** Default minimum confidence in a dangerous veto reason before it changes the action. */
export const DEFAULT_VETO_MIN_CONFIDENCE = 0.6;

export interface PolicyInput {
    /** The model's recommended action, or `undefined` when it did not answer. */
    action: DecisionAction | undefined;
    confidence: number | undefined;
    config: DecisionModelConfig;
    /** Whether sandboxed execution is available; `sandbox` cannot be applied without it. */
    sandboxAvailable: boolean;
}

export interface PolicyVerdict {
    outcome: DecisionOutcome;
    /** True when the outcome is applied without a prompt. */
    auto: boolean;
    reason: string;
}

/**
 * Turn a model answer into an authority decision.
 *
 * One toggle decides whether the model may act at all (`apply`); what it may do with an answer is policy, not
 * configuration, and every rule here is about the direction of authority:
 *
 * - `sandbox` withholds capability, so it applies at any confidence (when a sandbox exists).
 * - `refuse` also withholds, and it never applies by itself. The measured false positive is a formatter whose
 *   `--write` reads as `loses_content`, and a wrong refusal blocks work that a prompt would have surfaced, so
 *   a dangerous criterion always reaches the human with its reason recorded.
 * - `host` is the one direction that gains authority, so it needs a confidence floor (`minConfidence`).
 */
export function decideWithPolicy(input: PolicyInput): PolicyVerdict {
    const { action, confidence, config, sandboxAvailable } = input;

    if (action === undefined) {
        return { outcome: "abstain", auto: false, reason: "no model answer" };
    }

    switch (action) {
        case "refuse":
            return { outcome: "abstain", auto: false, reason: "refuse requires confirmation" };
        case "sandbox":
            if (!sandboxAvailable) {
                return { outcome: "abstain", auto: false, reason: "sandbox unavailable" };
            }
            return { outcome: "sandbox", auto: true, reason: "model chose sandbox" };
        case "host":
            return decideHost(confidence, config);
    }
}

function decideHost(confidence: number | undefined, config: DecisionModelConfig): PolicyVerdict {
    const minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    if (confidence === undefined || confidence < minConfidence) {
        return { outcome: "abstain", auto: false, reason: "host below confidence threshold" };
    }

    return { outcome: "host", auto: true, reason: "model chose host above threshold" };
}

/**
 * What the fold needs from any classified form: an action, the confidence policy may gate it by, and the
 * reason the decision log records. Both vocabularies satisfy it — a command answer's criterion and a script
 * answer's capability are criteria by the time they fold.
 */
export interface FoldableAnswer {
    action: DecisionAction;
    confidence: number;
    reason: DecisionCriterion;
}

/** The answer a fold settled on, with where it sat in the input so the caller can keep its raw answers. */
export interface FoldedAnswer {
    answer: FoldableAnswer;
    index: number;
}

/** Severity of an action when folding: `host` is the most permissive, `refuse` the most withholding. */
const ACTION_SEVERITY: Record<DecisionAction, number> = {
    host: 0,
    sandbox: 1,
    refuse: 2,
};

/**
 * Fold the answers of one command's classified forms into the command's answer.
 *
 * The forms have different subjects now — one command verdict plus one script verdict per body — and the fold
 * is where they become one action. It is the conservative half: a `refuse` answer on any form sends the
 * command to the human, a `sandbox` answer on any form withholds host execution, and `host` is the answer
 * only when every form answered safely. `host` is also the one direction the confidence floor gates, so the
 * fold hands policy the *least* confident form: one unsure form is enough to keep the command behind the
 * floor, where averaging would let confident forms outvote it.
 *
 * The chosen answer is the most severe form (ties: higher confidence, then earlier form), so the criterion in
 * the log names what is actually wrong rather than whichever form answered last. An entry with no answer is
 * skipped — the caller has already decided an unanswered form means the command prompts — and a fold with
 * nothing left to fold is `undefined`, which the caller reads as no answer at all.
 */
export function foldAnswers(
    answers: readonly (FoldableAnswer | undefined)[],
): FoldedAnswer | undefined {
    const defined = answers.filter((answer): answer is FoldableAnswer => answer !== undefined);
    if (defined.length === 0) {
        return undefined;
    }

    const severity = Math.max(...defined.map((answer) => ACTION_SEVERITY[answer.action]));
    let folded: FoldedAnswer | undefined;

    for (const [index, answer] of answers.entries()) {
        if (answer === undefined) {
            continue;
        }

        if (severity !== ACTION_SEVERITY.host && ACTION_SEVERITY[answer.action] !== severity) {
            continue;
        }

        if (folded === undefined || outranks(answer, folded.answer, severity)) {
            folded = { answer, index };
        }
    }

    return folded;
}

/**
 * Whether `candidate` beats `chosen` within one severity.
 *
 * The two directions point opposite ways on purpose: a dangerous form is the one the model believed most
 * (higher confidence is the stronger warning), while a `host` fold keeps the least confident form, because
 * that answer is what the confidence floor has to clear.
 */
function outranks(candidate: FoldableAnswer, chosen: FoldableAnswer, severity: number): boolean {
    if (severity === ACTION_SEVERITY.host) {
        return candidate.confidence < chosen.confidence;
    }

    return candidate.confidence > chosen.confidence;
}

/** Whether the second-opinion veto is enabled (default true). */
export function vetoEnabled(config: DecisionModelConfig): boolean {
    return config.veto?.enabled !== false;
}

/**
 * Whether an answer is unsure enough to warrant a second request.
 *
 * Both directions that *grant* execution are second-guessed. `host` because it is the only unconfined one,
 * and `sandbox` because the sandbox does not contain what the veto reasons about: it binds cwd rw, so
 * in-workspace destruction still happens, and it shares the host network, so `exfiltration` and
 * `remote_code` are unaffected. Measured: `curl … | bash` and a truncating heredoc both come back R1
 * `sandbox`, and with the veto limited to `host` neither was ever looked at again. An absent confidence
 * gates, because an answer without one cannot be trusted.
 */
export function shouldConsultVeto(
    action: DecisionAction | undefined,
    confidence: number | undefined,
    config: DecisionModelConfig,
): boolean {
    if (!vetoEnabled(config) || (action !== "host" && action !== "sandbox")) {
        return false;
    }

    const gateBelow = config.veto?.gateBelow ?? DEFAULT_VETO_GATE;
    return (confidence ?? 0) < gateBelow;
}

/** The action after applying the veto: unchanged, or escalated when the veto is dangerous. */
export interface VetoOutcome {
    action: DecisionAction;
    escalated: boolean;
}

/**
 * Apply a veto answer to a `host` action.
 *
 * Only a dangerous reason at or above `minConfidence` escalates; everything else leaves the first answer in
 * place, so a low-confidence or `none` veto cannot grant authority it did not already have.
 */
export function applyVeto(
    action: DecisionAction,
    veto: AnsweredVeto,
    config: DecisionModelConfig,
): VetoOutcome {
    const minConfidence = config.veto?.minConfidence ?? DEFAULT_VETO_MIN_CONFIDENCE;
    if (!isDangerousVeto(veto.reason) || veto.confidence < minConfidence) {
        return { action, escalated: false };
    }

    // A dangerous reason on an already-sandboxed command cannot be contained by escalating further: the
    // sandbox binds cwd rw, so in-workspace destruction still happens, and it shares the host network, so
    // `exfiltration` and `remote_code` are unaffected. Withholding is the only honest answer, so it refuses.
    if (action === "sandbox") {
        return { action: "refuse", escalated: true };
    }

    return { action: config.veto?.escalateTo ?? "sandbox", escalated: true };
}
