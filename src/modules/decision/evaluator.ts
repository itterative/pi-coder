import type {
    ClassifierAnswer,
    ClassifierApi,
    ClassifierContext,
    ClassifierModel,
    ClassifierResult,
    Usage,
} from "@earendil-works/pi-ai";

import { resolveClassifier, type ClassifierRegistry } from "./model";
import { decideWithPolicy, foldAnswers, type FoldableAnswer } from "./policy";
import { scopeAnswer } from "./scope";
import { scriptContentHash } from "./script";
import { isScriptCapability, scriptAnswerFrom, scriptRequest } from "./script-classification";
import { resolveStrategy, type DecisionStrategyId } from "./strategies";
import type {
    DecisionContext,
    DecisionFormAnswer,
    DecisionFormStatus,
    DecisionFormSubject,
    DecisionModelConfig,
    DecisionStatus,
    DecisionVerdict,
    ScriptArtifact,
    ScriptCapabilitySummary,
    ScriptRun,
} from "./types";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_COOLDOWN_MS = 30000;

/** How many successful answers one evaluator memorizes. Bounded, evicted oldest first. */
const ANSWER_CACHE_LIMIT = 64;

/** How many deterministic size rejections are remembered. Bounded, evicted oldest first. */
const REJECTION_MEMO_LIMIT = 64;

/** The endpoint's deterministic refusal for a request bigger than its prefill batch. */
const SIZE_REJECTION = /(too large|physical batch size)/i;

/**
 * How many script bodies one consult classifies at once.
 *
 * The configured endpoint runs llama.cpp with `--parallel 4`, so four in-flight requests use its slots and
 * no more of them queue behind the server; a wider fan-out would only wait. Artifact counts are usually one
 * or two, so this bound guards a deep package chase rather than the common case.
 */
export const MAX_CONCURRENT_FORMS = 4;

type Classifier = ClassifierModel<ClassifierApi>;
type Classification = { result: ClassifierResult; timedOut: boolean };

/** A successful model answer: all that policy needs to act on a later identical consult. */
interface CachedAnswer {
    answered: FoldableAnswer | undefined;
    answers: Record<string, ClassifierAnswer>;
}

/** What one form's request produced, before the fold turns the forms back into one verdict. */
interface FormOutcome {
    /** Whether this form answered about the invocation or about one body of code. */
    subject: DecisionFormSubject;
    /** Artifact provenance; absent for the command form. */
    source: string | undefined;
    /** The subject's reading of the answer; `undefined` when it named nothing readable. */
    answer: FoldableAnswer | undefined;
    answers: Record<string, ClassifierAnswer>;
    status: DecisionFormStatus;
    /** Set for every non-answer outcome; absent for a successful classification. */
    reason: string | undefined;
    cached: boolean;
    usage: Usage | undefined;
}

/** One request to make: everything that differs between the command form and a script form. */
interface FormOptions {
    /** Whether this form asks about the invocation or about one body of code. */
    subject: DecisionFormSubject;
    /** Artifact provenance; absent for the command form. */
    source: string | undefined;
    /** What identifies this form's answer in the caches. */
    cacheKey: string;
    /** Built lazily, so a cache hit never pays for a request it will not send. */
    request: () => ClassifierContext;
    /** The reading of the raw answer, per subject. */
    readAnswer: (answers: Record<string, ClassifierAnswer>) => FoldableAnswer | undefined;
}

export interface DecisionEvaluatorOptions {
    registry: ClassifierRegistry;
    config: DecisionModelConfig;
    /** Whether sandboxed execution is available; `sandbox` abstains without it. */
    sandboxAvailable: boolean;
    /** Clock, injectable so cooldown tests can advance time without sleeping. */
    now?: () => number;
}

/**
 * Consult a classifier about unresolved commands.
 *
 * Two subjects, two requests, one authority, one deterministic gate. A script body is classified as a
 * property of its code: the request carries the body alone and the answer cache keys on its content hash, so
 * the same bytes share one verdict across commands, runners, and sessions. The command is then classified as
 * an invocation, with the bodies' capability summaries beside the runner's rules, so scope is judged where it
 * belongs. On top of both, `scopeAnswer` applies the authority ladder in code: a capability the runner's rung
 * does not cover becomes an `out_of_scope` refusal without a request. `foldAnswers` turns the command answer,
 * every script answer, and that scope answer into one action — any dangerous answer withholds authority, and
 * `host` needs the command answer confident at `minConfidence` — and `policy.ts` stays the only place an
 * answer becomes authority.
 *
 * Script bodies run in waves of {@link MAX_CONCURRENT_FORMS}, preserving their order; the command runs after
 * them because its state carries their summaries. One instance owns the cooldown and both caches, so a
 * failed request skips the model for `cooldownMs` instead of adding the timeout to every prompt, and an
 * unchanged body or command is not sent twice. `classify` is documented never to reject, but a thrown error
 * is caught and treated as a failure rather than escaping into the permission flow. A script without an
 * answer makes the whole verdict abstain before the command is even asked: an unread body is a body the
 * command would run unchecked, and the bodies that did answer stay cached for the retry.
 */
export class DecisionEvaluator {
    private cooldownUntil = 0;
    private readonly now: () => number;

    /**
     * Successful answers for both subjects, in one bounded map.
     *
     * A command answer is keyed by strategy, provider, model, command, runner, isolation, and the capability
     * summaries of the bodies it runs, so the request it settles is the request it was asked. A script answer
     * is keyed by provider, model, and the body's content hash, so a body is judged once no matter how many
     * commands run it. A hit skips the request entirely; policy is applied again on the way out, so `apply`
     * and `minConfidence` were never part of either key. Failures are not cached here — the cooldown governs
     * their retries.
     */
    private readonly answers = new Map<string, CachedAnswer>();

    /**
     * Deterministic size rejections, keyed by the answer-cache key plus the serialized request length.
     *
     * The endpoint refuses a request bigger than its prefill batch outright, and that verdict depends only on
     * the request, so retrying it every consult would spend a round trip to earn the same failure. The memo
     * abstains (a prompt), never approves, and holds until the form's identity or the request changes.
     */
    private readonly rejections = new Set<string>();

    constructor(private readonly options: DecisionEvaluatorOptions) {
        this.now = options.now ?? Date.now;
    }

    async evaluate(context: DecisionContext): Promise<DecisionVerdict> {
        const { config } = this.options;

        if (config.enabled !== true) {
            return abstain("model disabled");
        }

        const model = resolveClassifier(this.options.registry, config);
        if (model === undefined) {
            return abstain("no classifier model available");
        }

        const strategy = resolveStrategy(config.strategy);
        const started = this.now();
        const artifacts = context.script?.artifacts ?? [];
        const scriptOutcomes = await mapWithLimit(artifacts, MAX_CONCURRENT_FORMS, (artifact) =>
            this.classifyScript(artifact, model),
        );
        const profiles = scriptCapabilitySummaries(artifacts, scriptOutcomes);
        if (profiles === undefined) {
            // A body that did not answer, or answered with no readable capability, prompts: asking the
            // command about code nobody has read would be judging half an invocation.
            return this.verdictFromForms(strategy.id, model, scriptOutcomes, this.now() - started);
        }

        const commandContext: DecisionContext = {
            ...context,
            script: undefined,
            ...(profiles.length === 0 ? {} : { scriptProfiles: profiles }),
        };
        const commandOutcome = await this.classifyForm(model, {
            subject: "command",
            source: undefined,
            cacheKey: answerCacheKey(commandContext, strategy.id, model),
            request: () => strategy.buildRequest(commandContext),
            readAnswer: (answers) => strategy.actionFrom(answers),
        });

        const outcomes: FormOutcome[] = [commandOutcome, ...scriptOutcomes];
        const scope = scopeAnswer(profiles, context.runner ?? "parent");
        if (scope !== undefined) {
            // A deterministic form: no request and no model belief, but it folds like any other answer, so a
            // capability the runner's authority forbids withholds whatever the command classification said.
            outcomes.push({
                subject: "scope",
                source: undefined,
                answer: scope,
                answers: {},
                status: "answered",
                reason: undefined,
                cached: true,
                usage: zeroUsage(),
            });
        }

        return this.verdictFromForms(strategy.id, model, outcomes, this.now() - started);
    }

    /** Classify one body as code: the body alone, keyed on its content. */
    private classifyScript(artifact: ScriptArtifact, model: Classifier): Promise<FormOutcome> {
        return this.classifyForm(model, {
            subject: "script",
            source: artifact.source,
            cacheKey: scriptCacheKey(artifact, model),
            request: () => scriptRequest(artifact.text),
            readAnswer: scriptAnswerFrom,
        });
    }

    /** Classify one form, from the answer cache when it holds one, and report what happened. */
    private async classifyForm(model: Classifier, form: FormOptions): Promise<FormOutcome> {
        const { subject, source, cacheKey } = form;
        const cached = this.answers.get(cacheKey);
        if (cached !== undefined) {
            return {
                subject,
                source,
                answer: cached.answered,
                answers: cached.answers,
                status: "cached",
                reason: undefined,
                cached: true,
                usage: zeroUsage(),
            };
        }

        const request = form.request();
        if (this.rejections.has(rejectionKey(cacheKey, request))) {
            return {
                subject,
                source,
                answer: undefined,
                answers: {},
                status: "rejected",
                reason: "model request previously rejected as too large",
                cached: true,
                usage: zeroUsage(),
            };
        }

        if (this.now() < this.cooldownUntil) {
            return {
                subject,
                source,
                answer: undefined,
                answers: {},
                status: "cooldown",
                reason: "model cooling down",
                cached: false,
                usage: undefined,
            };
        }

        const classified = await this.classify(model, request, this.options.config);
        if (classified.result.stopReason !== "stop") {
            return this.formFailure(classified, cacheKey, request, subject, source);
        }

        const answer: CachedAnswer = {
            answered: form.readAnswer(classified.result.answers),
            answers: classified.result.answers,
        };
        this.rememberAnswer(cacheKey, answer);

        return {
            subject,
            source,
            answer: answer.answered,
            answers: answer.answers,
            status: "answered",
            reason: undefined,
            cached: false,
            usage: classified.result.usage,
        };
    }

    /**
     * Fold the forms back into one verdict.
     *
     * No form answering is the sticky case: the verdict abstains whatever the others said, because an unread
     * form is a body the command would run unchecked. The reason names the failing form, so the log and the
     * prompt can say which form the model never got to.
     */
    private verdictFromForms(
        strategyId: DecisionStrategyId,
        model: Classifier,
        outcomes: readonly FormOutcome[],
        latencyMs: number,
    ): DecisionVerdict {
        const forms = outcomes.map(formAnswer);
        const unanswered = outcomes.find((outcome) => outcome.answer === undefined);
        if (unanswered !== undefined) {
            return {
                outcome: "abstain",
                status: failureStatus(unanswered),
                reason: withSource(unanswered.reason ?? "no model answer", unanswered.source),
                answers: unanswered.answers,
                forms,
                latencyMs,
                model: modelRef(model),
                strategy: strategyId,
                ...(unanswered.usage === undefined ? {} : { usage: unanswered.usage }),
                ...(outcomes.every((outcome) => outcome.cached) ? { cached: true } : {}),
            };
        }

        const folded = foldAnswers(outcomes.map((outcome) => outcome.answer));
        if (folded === undefined) {
            // Cannot happen when every outcome answered; kept because an empty fold is the fold's own "no
            // answer" and must still abstain rather than fall through to authority.
            return {
                outcome: "abstain",
                status: "abstained",
                reason: "no model answer",
                answers: {},
                forms,
                latencyMs,
                model: modelRef(model),
                strategy: strategyId,
            };
        }

        // A capability answer says what the code can do, not whether the invocation may run, so it can
        // withhold but never grant: when the fold is `host`, the command answer is what policy gates and what
        // the verdict names. One unsure capability no longer drags a confident command behind the floor.
        const command = outcomes.find((outcome) => outcome.subject === "command");
        const decided =
            command?.answer !== undefined && folded.answer.action === "host"
                ? command.answer
                : folded.answer;
        const policy = decideWithPolicy({
            action: decided.action,
            confidence: decided.confidence,
            config: this.options.config,
            sandboxAvailable: this.options.sandboxAvailable,
        });
        const usage = sumUsage(outcomes);

        return {
            outcome: policy.outcome,
            status: policy.auto ? "applied" : "abstained",
            reason: policy.reason,
            action: decided.action,
            criterion: decided.reason,
            confidence: decided.confidence,
            strategy: strategyId,
            answers: outcomes[folded.index]?.answers ?? {},
            forms,
            latencyMs,
            model: modelRef(model),
            ...(usage === undefined ? {} : { usage }),
            ...(outcomes.every((outcome) => outcome.cached) ? { cached: true } : {}),
        };
    }

    private rememberAnswer(key: string, answer: CachedAnswer): void {
        if (this.answers.size >= ANSWER_CACHE_LIMIT) {
            const oldest = this.answers.keys().next().value;
            if (oldest !== undefined) {
                this.answers.delete(oldest);
            }
        }
        this.answers.set(key, answer);
    }

    private rememberRejection(key: string): void {
        if (this.rejections.size >= REJECTION_MEMO_LIMIT) {
            const oldest = this.rejections.values().next().value;
            if (oldest !== undefined) {
                this.rejections.delete(oldest);
            }
        }
        this.rejections.add(key);
    }

    private async classify(
        model: Classifier,
        context: ClassifierContext,
        config: DecisionModelConfig,
    ): Promise<Classification> {
        const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const result = await this.options.registry.classify(model, context, {
                signal: controller.signal,
            });
            return { result, timedOut: controller.signal.aborted };
        } catch (error) {
            return {
                result: errorResult(model, messageOf(error)),
                timedOut: controller.signal.aborted,
            };
        } finally {
            clearTimeout(timer);
        }
    }

    private formFailure(
        classified: Classification,
        cacheKey: string,
        request: ClassifierContext,
        subject: DecisionFormSubject,
        source: string | undefined,
    ): FormOutcome {
        const { result, timedOut } = classified;
        this.cooldownUntil = this.now() + (this.options.config.cooldownMs ?? DEFAULT_COOLDOWN_MS);

        if (!timedOut && isSizeRejection(result.errorMessage)) {
            this.rememberRejection(rejectionKey(cacheKey, request));
        }

        return {
            subject,
            source,
            answer: undefined,
            answers: {},
            status: timedOut ? "timeout" : "error",
            reason: timedOut
                ? "model request timed out"
                : `model request failed: ${result.errorMessage ?? "unknown error"}`,
            cached: false,
            usage: result.usage,
        };
    }
}

/**
 * The command form's capability facts, or `undefined` when any body failed to produce one.
 *
 * One unread body is enough to stop the consult: the command state renders these summaries instead of the
 * code, so a missing summary would quietly hide a capability from the scope judgment, and a prompt is the
 * safe reading of "this command runs something nobody read".
 */
function scriptCapabilitySummaries(
    artifacts: readonly ScriptArtifact[],
    outcomes: readonly FormOutcome[],
): ScriptCapabilitySummary[] | undefined {
    const summaries: ScriptCapabilitySummary[] = [];

    for (const [index, artifact] of artifacts.entries()) {
        const answer = outcomes[index]?.answer;
        if (answer === undefined || !isScriptCapability(answer.reason)) {
            return undefined;
        }

        summaries.push({ source: artifact.source, capability: answer.reason });
    }

    return summaries;
}

/**
 * Run `work` over `items` with at most `limit` in flight, preserving the input order in the result.
 *
 * Waves rather than a work queue on purpose: the result order is the fold's tie-break order, and a later form
 * must not be folded before an earlier one because it happened to finish first.
 */
async function mapWithLimit<T, R>(
    items: readonly T[],
    limit: number,
    work: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = [];
    for (let start = 0; start < items.length; start += limit) {
        const wave = items.slice(start, start + limit);
        results.push(...(await Promise.all(wave.map(work))));
    }

    return results;
}

function formAnswer(outcome: FormOutcome): DecisionFormAnswer {
    return {
        subject: outcome.subject,
        ...(outcome.source === undefined ? {} : { source: outcome.source }),
        ...(outcome.answer === undefined
            ? {}
            : {
                  criterion: outcome.answer.reason,
                  action: outcome.answer.action,
                  confidence: outcome.answer.confidence,
              }),
        status: outcome.status,
        answers: outcome.answers,
    };
}

/** The verdict status for an unanswered form: only a real request failure is not an abstain. */
function failureStatus(outcome: FormOutcome): DecisionStatus {
    if (outcome.status === "error" || outcome.status === "timeout") {
        return outcome.status;
    }

    return "abstained";
}

/** Name the form a reason came from, so a multi-body command's log says which body failed. */
function withSource(reason: string, source: string | undefined): string {
    return source === undefined ? reason : `${reason} (${source})`;
}

/** Sum what every request in one consult reported; `undefined` when none reported usage. */
function sumUsage(outcomes: readonly FormOutcome[]): Usage | undefined {
    const usages = outcomes.flatMap((outcome) =>
        outcome.usage === undefined ? [] : [outcome.usage],
    );
    if (usages.length === 0) {
        return undefined;
    }

    return usages.reduce(
        (total, usage) => ({
            input: total.input + usage.input,
            output: total.output + usage.output,
            cacheRead: total.cacheRead + usage.cacheRead,
            cacheWrite: total.cacheWrite + usage.cacheWrite,
            totalTokens: total.totalTokens + usage.totalTokens,
            cost: {
                input: total.cost.input + usage.cost.input,
                output: total.cost.output + usage.cost.output,
                cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
                cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
                total: total.cost.total + usage.cost.total,
            },
        }),
        zeroUsage(),
    );
}

function answerCacheKey(
    context: DecisionContext,
    strategy: DecisionStrategyId,
    model: Classifier,
): string {
    return JSON.stringify([
        strategy,
        model.provider,
        model.id,
        context.command,
        context.runner ?? "parent",
        context.isolation ?? "checkout",
        scriptIdentity(context.script),
        profileIdentity(context.scriptProfiles),
        context.workspace ?? null,
    ]);
}

/**
 * The command request's identity for script facts: one [source, capability] pair per body, in chase order.
 *
 * A body edit that changes what the code can do is a different command request because the state renders
 * these summaries; one that does not change a capability is a command cache hit while the script form itself
 * is still re-classified by content.
 */
function profileIdentity(profiles: readonly ScriptCapabilitySummary[] | undefined): unknown {
    return profiles === undefined
        ? null
        : profiles.map((profile) => [profile.source, profile.capability]);
}

/**
 * The scripts' cache identity for a context that still carries bodies: one entry per artifact from its path,
 * mtime, and size. Production command contexts carry `scriptProfiles` instead; this keeps the direct strategy
 * requests (probe arms and strategy snapshots) identified by the bodies they actually render.
 */
function scriptIdentity(script: ScriptRun | undefined): unknown {
    if (script === undefined) {
        return null;
    }

    return script.artifacts.map((artifact) =>
        artifact.path !== undefined && artifact.identity !== undefined
            ? [artifact.path, artifact.identity.mtimeMs, artifact.identity.size]
            : artifact.text,
    );
}

/**
 * A script body's cache identity: its content, the one thing the verdict is a property of.
 *
 * Content-addressed on purpose — the same bytes run by `npm run deploy`, a bare `./deploy.sh`, or a scout in
 * a worktree are one verdict, so the hit is the deterministic "this code is safe" the subject allows.
 * Provider and model stay in the key because a different model is a different judge.
 */
function scriptCacheKey(artifact: ScriptArtifact, model: Classifier): string {
    return JSON.stringify(["script", model.provider, model.id, scriptContentHash(artifact.text)]);
}

function rejectionKey(cacheKey: string, request: ClassifierContext): string {
    return `${cacheKey}\u0000${JSON.stringify(request).length}`;
}

function isSizeRejection(message: string | undefined): boolean {
    return message !== undefined && SIZE_REJECTION.test(message);
}

function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function abstain(reason: string): DecisionVerdict {
    return { outcome: "abstain", status: "abstained", reason, answers: {}, latencyMs: 0 };
}

function modelRef(model: Classifier): { provider: string; id: string } {
    return { provider: model.provider, id: model.id };
}

function errorResult(model: Classifier, message: string): ClassifierResult {
    return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers: {},
        stopReason: "error",
        errorMessage: message,
        timestamp: Date.now(),
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
