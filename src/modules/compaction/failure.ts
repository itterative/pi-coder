import {
    isContextOverflow,
    isRecoverableLength,
    isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Why a summarization call failed, and what the cascade may do about it.
 *
 * Before this existed every failure collapsed to `{ ok: false, detail: <message string> }`, which made context
 * overflow and exhausted quota look identical — and the right response to each is the opposite: overflow means
 * the next rung (bounded, no tools, one message) is the fix, while quota means the next rung is a second doomed
 * request and core's default a third.
 *
 * Provider failures never throw here. pi-ai normalizes them into an `AssistantMessage` with
 * `stopReason: "error"` and `errorMessage`, and the HTTP status survives only as a string prefix (`"429 ..."`)
 * because both vendored SDKs format errors as `${status} ${message}`. So classification reads the message, and
 * `Retry-After` is out of reach: the header-carrying error object is discarded inside the adapter's catch, and
 * `onResponse` fires only on the resolved path for the OpenAI/Anthropic adapters.
 *
 * The predicates that carry genuine provider knowledge are pi's own, imported from its root export. What is
 * deliberately ours is the *policy*: which causes deserve a resend, which deserve the next rung, and which end
 * the compaction. pi treats a throttle 429 as retryable (`retry.js:20-76`) and only a subscription-limit 429 as
 * fatal (`retry.js:4-19`); we treat every 429 as fatal for this compaction, because a summarization request that
 * is rate-limited will still be rate-limited in a second, and the session has work to get back to.
 */

/** Why one summarization attempt failed. */
export type SummarizationFailureCause =
    /** The context does not fit the window. Retrying the same bytes cannot help; the bounded next rung can. */
    | "overflow"
    /** The reply was cut off by the output limit, so its tail is missing. */
    | "truncated"
    /** A reply that arrived and was unusable: a tool call, a blank, an answer with no checkpoint sections. */
    | "content"
    /** Throttled, including every 429 that is not plainly an account limit. */
    | "rate-limit"
    /** An account or subscription limit: nothing we send will help until it resets. */
    | "quota"
    /** Credentials the provider rejects, or a provider we were never configured to reach. */
    | "auth"
    /** Server-side or transport trouble that a short wait can genuinely clear. */
    | "transient"
    /** The user stopped it. */
    | "aborted"
    /** Unrecognized, including anything that never became a response at all. */
    | "unknown";

/** What the cascade may do with a failure of a given cause. */
export interface SummarizationFailureAction {
    /** Resend the same request after a backoff. Only honest when the failure is not in the bytes we sent. */
    retry: boolean;
    /** Fall through to the next rung. False means that rung would fail for the same reason we just saw. */
    cascade: boolean;
}

interface CausePolicy extends SummarizationFailureAction {
    /** Why this is the answer, phrased for whoever reads the trace or the report. */
    rationale: string;
}

/**
 * One row per cause. `unknown` cascades and does not retry: an unrecognized failure has not earned a resend,
 * but it has also not earned the right to abandon a session that still needs compacting.
 */
const CAUSE_POLICY: Record<SummarizationFailureCause, CausePolicy> = {
    overflow: {
        retry: false,
        cascade: true,
        rationale:
            "the next rung sends a bounded, tool-free request; resending the same oversized one will not fit",
    },
    truncated: {
        retry: false,
        cascade: true,
        rationale:
            "the model ran out of output budget mid-answer, so the next rung has to be asked differently",
    },
    content: {
        retry: false,
        cascade: true,
        rationale:
            "deterministic in the bytes we sent, so the rung that sends different bytes is the fix",
    },
    "rate-limit": {
        retry: false,
        cascade: false,
        rationale:
            "throttled now, throttled in a second, and the next rung is another request against the same limit",
    },
    quota: {
        retry: false,
        cascade: false,
        rationale:
            "an account limit: every rung, and core's own default path, would fail the same way",
    },
    auth: {
        retry: false,
        cascade: false,
        rationale:
            "the credentials or the provider configuration are wrong, which no request can fix",
    },
    transient: {
        retry: true,
        cascade: true,
        rationale:
            "server-side or transport trouble, so a short backoff is worth one or two resends",
    },
    aborted: {
        retry: false,
        cascade: false,
        rationale: "the user asked to stop",
    },
    unknown: {
        retry: false,
        cascade: true,
        rationale:
            "unrecognized: the next rung is cheap and might succeed, but a blind resend is not owed",
    },
};

export function summarizationFailureAction(
    cause: SummarizationFailureCause,
): SummarizationFailureAction {
    const { retry, cascade } = CAUSE_POLICY[cause];
    return { retry, cascade };
}

/** Causes that end the whole compaction rather than moving down the cascade. */
export function isTerminalCause(cause: SummarizationFailureCause): boolean {
    return !CAUSE_POLICY[cause].cascade;
}

export function causeRationale(cause: SummarizationFailureCause): string {
    return CAUSE_POLICY[cause].rationale;
}

export interface FailureClassificationInput {
    contextWindow: number;
    /**
     * The output budget this call actually asked for. `isRecoverableLength` compares the produced output against
     * it to tell "the provider ran out of context" from "the answer was long", so it must be the limit the
     * request was sent with, not the model's ceiling.
     */
    outputBudgetTokens: number;
}

/**
 * Account limits, stated as limits. Checked before the rate-limit patterns because providers deliver quota
 * failures with a 429 status, and pi-ai's own block-list (`retry.js:4-19`) makes the same ordering; the wording
 * list is not exported, so it is restated here and `failure.test.ts` pins both orders.
 */
const QUOTA_PATTERN =
    /go usagelimiterror|free usagelimiterror|monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|exceeded your current quota|insufficient balance|billing|usage limit reached/i;

/** Rejected credentials or an unconfigured provider: never worth a second request. */
const AUTH_PATTERN =
    /authentication_error|authentication failed|invalid api key|incorrect api key|no api key|api key not|unauthorized|forbidden|permission_denied|does not have access|not configured|not authorized|oauth|expired token/i;

/** Throttling, in the shapes providers use when they mean "come back later". */
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|throttl|resourceexhausted|\b429\b/i;

/** The status both vendored SDKs prefix into the message, and pi-ai's `formatProviderError` composes as `"429: body"`. */
const STATUS_PREFIX_PATTERN = /^\s*(\d{3})\b/;

export function providerStatus(errorMessage: string | undefined): number | undefined {
    if (!errorMessage) {
        return undefined;
    }
    const match = STATUS_PREFIX_PATTERN.exec(errorMessage);

    return match ? Number(match[1]) : undefined;
}

/**
 * Name the reason a summarization response cannot be used.
 *
 * Order matters twice over. Context overflow is tested first because it is the one failure compaction exists to
 * resolve, and because pi's own composition does the same (`agent-session.js:2083-2088`: overflow is not a
 * retryable error). Quota is tested before rate-limiting because a 429 carrying `insufficient_quota` is an
 * account limit, not a throttle.
 */
export function classifySummarizationFailure(
    response: AssistantMessage,
    input: FailureClassificationInput,
): SummarizationFailureCause {
    if (response.stopReason === "aborted") {
        return "aborted";
    }

    const errorMessage = response.errorMessage ?? "";
    if (isContextOverflow(response, input.contextWindow)) {
        return "overflow";
    }
    if (response.stopReason === "length") {
        // A `length` stop that produced almost none of the requested output is context pressure, not a long
        // answer: the provider stopped because it had nowhere left to write.
        return isRecoverableLength(response, input.outputBudgetTokens) ? "overflow" : "truncated";
    }

    if (response.stopReason !== "error") {
        return "content";
    }
    if (QUOTA_PATTERN.test(errorMessage)) {
        return "quota";
    }
    if (AUTH_PATTERN.test(errorMessage)) {
        return "auth";
    }
    if (RATE_LIMIT_PATTERN.test(errorMessage) || providerStatus(errorMessage) === 429) {
        return "rate-limit";
    }
    if (isRetryableAssistantError(response)) {
        return "transient";
    }

    return "unknown";
}

/**
 * Cause for a failure that never produced a response — our own call threw, which in pi-ai means a programming
 * error or a setup fault rather than a provider answer, since provider failures arrive as `stopReason: "error"`.
 *
 * Deliberately not retried and still cascaded: we cannot tell the difference between the two from here, and the
 * conservative reading of "something we did not expect" is to try the rung that sends less.
 */
export const UNCLASSIFIED_THROWN_ERROR: SummarizationFailureCause = "unknown";
