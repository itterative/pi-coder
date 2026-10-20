import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    consultDecisionContext,
    consultFileAccessDecision,
    consultSuggestionRole,
    fileDecisionEnabled,
    suggestionEnabled,
    APPLIED_PERMISSIONS,
    type DecisionContextShape,
} from "../modules/decision/gate";
import { suggestRuleOutcome } from "../modules/sandbox/suggestions";
import { decisionSimilarCommands } from "../modules/decision";
import type {
    ClassifierRegistry,
    DecisionModelConfig,
    DecisionSurface,
    DecisionVerdict,
    FileDecisionOperation,
    ScriptRun,
    SuggestionRole,
} from "../modules/decision";
import { emitDecisionStatus } from "../modules/decision/events";
import { DEFAULT_DECISION_STRATEGY } from "../modules/decision/strategies";
import type {
    BashClassifierCommandRecord,
    BashClassifierRecord,
    BashClassifierScriptAnswerRecord,
    BashClassifierScriptRecord,
} from "../modules/sandbox/decision-log";
import type { Permission } from "../modules/sandbox/permissions";

/**
 * The bridge between the decision module and the two permission gates.
 *
 * The module owns the model — the request, the strategy, the policy — and knows nothing about how this
 * extension spells permissions or what its decision log looks like. Both gates need the same three things
 * from a verdict (a permission when `apply` licenses one, a log record always, and a notification when a
 * verdict replaces a prompt), so that half lives here rather than twice in `tools/bash` and
 * `tools/agent/child`, the way `tools/file-permissions.ts` is shared by the file gates.
 */

/** The permission a verdict resolves to, when `apply` licenses it. `abstain` never resolves anything. */
export function appliedPermission(
    config: DecisionModelConfig,
    verdict: DecisionVerdict,
): Permission | undefined {
    if (config.apply !== true || verdict.outcome === "abstain") {
        return undefined;
    }

    return APPLIED_PERMISSIONS[verdict.outcome];
}

/**
 * The permission a file verdict resolves to, when `apply` licenses it.
 *
 * Narrower than the command mapping on purpose: a direct path access has one useful outcome — let it through —
 * and `allow:sandbox` means nothing to a tool call that does not run under bwrap. A verdict that ever named
 * `sandbox` therefore resolves to nothing here and the human is asked, which is the honest reading of "I do
 * not know how to contain this".
 */
export function appliedFilePermission(
    config: DecisionModelConfig,
    verdict: DecisionVerdict,
): Permission | undefined {
    const permission = appliedPermission(config, verdict);

    return permission === "allow" ? permission : undefined;
}

/**
 * Whether a resolved permission lets the call through.
 *
 * Spelled as the allow set rather than `permission !== "ask"`, because `deny` is a block and not the absence
 * of a prompt: a gate that reads the inequality runs a command the verdict refused, unsandboxed.
 */
export function permissionAllowsCall(permission: Permission): boolean {
    return permission === "allow" || permission === "allow:sandbox";
}

/**
 * How confident the verdict was, spelled the same in every message and in the notification.
 *
 * An absent confidence is named rather than invented, because "(0.00)" would read as a model that believed
 * the command was dangerous when it simply did not answer.
 */
function confidenceText(confidence: number | undefined): string {
    return confidence === undefined ? "no confidence" : confidence.toFixed(2);
}

/**
 * The criteria and capabilities in the runner's own terms.
 *
 * A runner is not told `loses_content`; it is told what `loses_content` means. The phrases follow the
 * criteria the classifier is itself asked with (`questions.ts` and `script-classification.ts`) so the answer
 * the model gave and the explanation the runner reads are one vocabulary, not two.
 */
const VERDICT_PLAIN: Record<string, string> = {
    none: "an ordinary command for this runner",
    destructive: "able to destroy data irreversibly",
    privileged: "in need of root privileges or system changes",
    exfiltration: "able to leak secrets or send data off the machine",
    remote_code: "able to download and run code from outside this repository",
    loses_content: "able to overwrite or remove file content without replacing it",
    out_of_scope: "beyond what this runner is authorized to do",
    read_only: "read-only",
    writes_files: "able to change files in the working tree",
    writes_outside: "able to change files outside the working tree",
    network: "able to send or receive data over the network",
    process_control: "able to signal or kill processes",
};

/**
 * Why policy left the verdict unacted, in the runner's terms.
 *
 * Each phrase is written to follow `and`, because every surface composes one sentence out of the finding and
 * this clause. Keyed by the reasons `policy.ts` and `gate.ts` produce, which are all a recorded verdict can
 * carry; a reason this table does not know keeps its own text in parentheses, so the sentence stays readable
 * and the cause stays findable.
 */
const VERDICT_CONSEQUENCE: Record<string, string> = {
    "refuse requires confirmation": "only a person can approve a command it refuses",
    "host below confidence threshold": "it was not confident enough to let the command through",
    "sandbox unavailable": "it needed a sandbox that is not available here",
    "no model answer": "it did not answer",
};

/** What the model made of the command: `judged it able to destroy data irreversibly (0.90)`. */
function verdictFinding(record: BashClassifierRecord): string {
    if (record.criterion === undefined) {
        return `did not produce an answer (${record.status})`;
    }

    const plain = VERDICT_PLAIN[record.criterion] ?? record.criterion;

    return `judged it ${plain} (${confidenceText(record.confidence)})`;
}

/**
 * The finding and the reason it was not acted on, as one story.
 *
 * A request that produced no answer has nothing to explain afterwards, so the finding is the whole story;
 * writing "did not produce an answer, and it did not answer" would state one fact twice.
 */
function verdictStory(record: BashClassifierRecord): string {
    if (record.criterion === undefined) {
        return verdictFinding(record);
    }

    return `${verdictFinding(record)}, and ${verdictConsequence(record)}`;
}

/** What followed from the finding: the policy's reason, or a record-only config, told to the runner. */
function verdictConsequence(record: BashClassifierRecord): string {
    if (isDryRunVerdict(record)) {
        return "this session records verdicts without acting on them (record-only mode)";
    }

    const known = VERDICT_CONSEQUENCE[record.reason];
    if (known !== undefined) {
        return known;
    }

    return `the verdict was not acted on (${record.reason})`;
}

/**
 * Whether a verdict cleared the command but was forbidden to act.
 *
 * `apply` off means exactly that: the gate recorded a verdict that would have resolved the prompt, asked the
 * human anyway, and blocked because there was nobody to ask. Reading it as "the model did not clear it" would
 * blame the model for the configuration.
 */
function isDryRunVerdict(record: BashClassifierRecord): boolean {
    return record.applied !== true && record.outcome !== "abstain";
}

/**
 * The block reason for a command, worded for whoever actually resolved it.
 *
 * Four different no's reach a Bash gate: a verdict that resolved the prompt to a deny (nobody was asked and
 * the model is the authority - the shape a fully automatic mode would produce), a person who answered the
 * prompt, a verdict that cleared the command while `apply` is off, and a withheld verdict with no interface
 * to ask through. Only the first has an author worth naming, and the last two are the cases the plain
 * "blocked by user" sentence gets false: the prompt never ran, so no human ever said no.
 *
 * `undefined` means the gate's own wording is already true - a person answered, or the model never spoke.
 */
export function attributedBashBlockReason(input: {
    /** How the surface names its own subject, e.g. `Command execution` or `Agent bash`. */
    subject: string;
    /** The verdict recorded for this call, when the model was consulted. */
    record: BashClassifierRecord | undefined;
    /** Whether a person was actually asked, which is the surface's `hasUI`, not an outcome. */
    humanAsked: boolean;
}): string | undefined {
    const { subject, record, humanAsked } = input;
    if (record === undefined) {
        return undefined;
    }

    if (record.applied === true) {
        return `${subject} blocked by the decision model, which ${verdictFinding(record)}.`;
    }

    if (humanAsked) {
        return undefined;
    }

    return (
        `${subject} blocked; the decision model ${verdictStory(record)}. ` +
        `There was no user to ask.`
    );
}

/**
 * Why a read-only child's command was blocked after the model was consulted.
 *
 * `withheld` is the verdict not clearing the command - whether it said no or was not allowed to act, which the
 * consequence clause tells apart. `held` is the verdict saying yes to an invocation whose script body it never
 * read, which the gate blocks anyway: an unread body must not gain authority through the command answer.
 */
export type ReadOnlyGateCause = "withheld" | "held";

/**
 * The sentence a read-only child reads when the consult did not clear its command.
 *
 * A child below the `command` rung has no prompt to fall back on, so the verdict is the whole decision; the
 * deterministic allowlist reason alone reads as though no model was involved. Naming the verdict also says
 * the block is not a person's refusal, which is what lets the child report it instead of retrying it.
 */
export function readOnlyGateSentence(
    record: BashClassifierRecord,
    cause: ReadOnlyGateCause,
): string {
    if (cause === "held") {
        const kind = record.script?.kind ?? "unrecognized";

        return (
            `The decision model ${verdictFinding(record)} and cleared the command, but the command runs ` +
            `a script the model never read (script kind ${kind}). ` +
            `This agent has no prompt to ask through.`
        );
    }

    return `The decision model ${verdictStory(record)}. This agent has no prompt to ask through.`;
}

/** The log record for a verdict, identical whichever gate asked. */
export function classifierRecord(
    verdict: DecisionVerdict,
    config: DecisionModelConfig,
    applied: boolean,
    script?: ScriptRun,
): BashClassifierRecord {
    const usage = verdict.usage;
    const command = commandAnswer(verdict.forms);

    return {
        strategy: verdict.strategy ?? config.strategy ?? DEFAULT_DECISION_STRATEGY,
        ...(verdict.model === undefined
            ? {}
            : { provider: verdict.model.provider, model: verdict.model.id }),
        ...(verdict.criterion === undefined ? {} : { criterion: verdict.criterion }),
        ...(verdict.action === undefined ? {} : { action: verdict.action }),
        ...(verdict.confidence === undefined ? {} : { confidence: verdict.confidence }),
        outcome: verdict.outcome,
        status: verdict.status,
        reason: verdict.reason,
        latencyMs: verdict.latencyMs,
        applied,
        ...(usage === undefined
            ? {}
            : { tokens: { input: usage.input, output: usage.output, total: usage.totalTokens } }),
        ...(verdict.cached === true ? { cached: true } : {}),
        ...(command === undefined ? {} : { command }),
        ...(script === undefined ? {} : { script: scriptSummary(script, verdict.forms) }),
    };
}

/**
 * The command form's own answer, before the capability fold.
 *
 * The record's top-level `criterion`/`action`/`confidence` is the fold, which a script capability can win;
 * this keeps the invocation judgment visible beside it, so mining can tell a dangerous command from a
 * dangerous body.
 */
function commandAnswer(forms: DecisionVerdict["forms"]): BashClassifierCommandRecord | undefined {
    const form = forms?.find((candidate) => candidate.subject === "command");
    if (form === undefined) {
        return undefined;
    }

    return {
        ...(form.criterion === undefined ? {} : { criterion: form.criterion }),
        ...(form.action === undefined ? {} : { action: form.action }),
        ...(form.confidence === undefined ? {} : { confidence: form.confidence }),
        status: form.status,
    };
}

/**
 * What the log keeps about the resolved scripts: their forms, each body's provenance and total size, and the
 * answer each body's own request produced when the command was classified form by form.
 */
function scriptSummary(
    script: ScriptRun,
    forms: DecisionVerdict["forms"],
): BashClassifierScriptRecord {
    const omitted = (script.omissions ?? []).map(
        (omission) => `${omission.reason}:${omission.source}`,
    );
    const answers = formAnswers(forms);

    return {
        kind: script.kind,
        ...(script.artifacts.length === 0
            ? {}
            : {
                  sources: script.artifacts.map((artifact) => artifact.source),
                  chars: script.artifacts.reduce(
                      (total, artifact) => total + artifact.text.length,
                      0,
                  ),
              }),
        ...(omitted.length === 0 ? {} : { omitted }),
        ...(answers.length === 0 ? {} : { answers }),
    };
}

/**
 * The per-body answers, one per form that named an artifact. The command form (a run with no readable body)
 * has no source and is already the record's top-level answer.
 */
function formAnswers(forms: DecisionVerdict["forms"]): BashClassifierScriptAnswerRecord[] {
    return (forms ?? []).flatMap((form) =>
        form.subject !== "script" || form.source === undefined
            ? []
            : [
                  {
                      source: form.source,
                      ...(form.criterion === undefined ? {} : { criterion: form.criterion }),
                      ...(form.action === undefined ? {} : { action: form.action }),
                      ...(form.confidence === undefined ? {} : { confidence: form.confidence }),
                      status: form.status,
                  },
              ],
    );
}

export interface GateConsultOptions extends DecisionContextShape {
    /** Where the session half of the context comes from: the asking surface's own session. */
    ctx: ExtensionContext;
    config: DecisionModelConfig;
    command: string;
    /** Whether sandboxed execution is available right now; `sandbox` abstains without it. */
    sandboxAvailable: boolean;
    /** What the resolved command is called in the notification, e.g. `this command`. */
    label: string;
    /** The asking surface's UI, for the notification a resolution produces. */
    notify: (message: string, level: "info") => void;
    /**
     * Where in-flight check notifications go, when the caller has a bus.
     *
     * Both gates pass the parent process's bus, so the parent footer can animate its auto badge for a
     * child's check as well as its own.
     */
    events?: EventBus;
    /**
     * The registry the classifier resolves from (default `ctx.modelRegistry`).
     *
     * A child gate passes its parent's: pi's registry is process-wide, and the parent is where the
     * configured provider was registered.
     */
    registry?: ClassifierRegistry;
}

export interface GateConsultedDecision {
    /** Present only when `apply` let the verdict resolve the prompt. */
    permission?: Permission;
    /** What the decision log records; present whenever the model was consulted. */
    record: BashClassifierRecord;
}

/** What one file-access consult produced, in the shape the read/write gates use. */
export interface FileAccessConsultOptions extends DecisionContextShape {
    /** Where the session half of the context comes from: the asking surface's own session. */
    ctx: ExtensionContext;
    config: DecisionModelConfig;
    /** Which file surface is asking: `parent` or `child`. */
    surface: DecisionSurface;
    operation: FileDecisionOperation;
    /** The gate's own resolved target, so the verdict is about the path that will be opened. */
    path: string;
    /** What the resolved access is called in the notification, e.g. `that read`. */
    label: string;
    /** The asking surface's UI, for the notification a resolution produces. */
    notify: (message: string, level: "info") => void;
    /**
     * Where in-flight check notifications go, when the caller has a bus.
     *
     * Both gates pass the parent process's bus, so the parent footer can animate its auto badge for a
     * child's check as well as its own.
     */
    events?: EventBus;
    /**
     * The registry the classifier resolves from (default `ctx.modelRegistry`).
     *
     * A child gate passes its parent's: pi's registry is process-wide, and the parent is where the
     * configured provider was registered.
     */
    registry?: ClassifierRegistry;
}

/**
 * Consult the model about one direct file access, and translate the verdict into what the gate needs.
 *
 * The sibling of {@link consultForGate} rather than a flag on it: the two subjects ask different questions and
 * only the Bash one can be contained by a sandbox, so the file path maps a verdict through
 * {@link appliedFilePermission} and reports through the same in-flight counter the footer animates.
 *
 * `undefined` means the surface is not enabled, which is the gate's cue to ask the human exactly as it does
 * when the model has nothing to say; the disabled check lives here so every caller gets the same rule. Never
 * rejects: a withheld, failed, or unconfigured verdict leaves `permission` unset.
 */
export async function consultFileAccessForGate(
    options: FileAccessConsultOptions,
): Promise<FileAccessConsultResult | undefined> {
    if (!fileDecisionEnabled(options.config, options.surface)) {
        return undefined;
    }

    checksInFlight += 1;
    emitDecisionStatus(options.events, checksInFlight);

    try {
        const verdict = await consultFileAccessDecision({
            ctx: options.ctx,
            config: options.config,
            file: { operation: options.operation, path: options.path },
            ...(options.runner === undefined ? {} : { runner: options.runner }),
            ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
            ...(options.registry === undefined ? {} : { registry: options.registry }),
        });
        const permission = appliedFilePermission(options.config, verdict);

        if (permission !== undefined) {
            options.notify(
                `pi-file-sandbox: decision model resolved ${options.label}: ` +
                    `${verdict.criterion ?? verdict.status} ` +
                    `(${verdict.confidence?.toFixed(2) ?? "no confidence"}) - ${permission}`,
                "info",
            );
        }

        return {
            ...(permission === undefined ? {} : { permission }),
            record: classifierRecord(verdict, options.config, permission !== undefined),
        };
    } finally {
        checksInFlight = Math.max(0, checksInFlight - 1);
        emitDecisionStatus(options.events, checksInFlight);
    }
}

/** What a consulted file access produced: the permission when `apply` licensed it, and the log record. */
export interface FileAccessConsultResult {
    /** Present only when `apply` let the verdict approve the access. */
    permission?: Permission;
    record: BashClassifierRecord;
}

/** Consults in flight across both gates; the shared evaluator can serve several concurrently. */
let checksInFlight = 0;

/** A rule a permission prompt may remember, and what offered it. */
export interface PromptRuleSuggestion {
    pattern: string;
    source: "table" | "model";
}

/**
 * The session rule to offer with a permission prompt, or null when no row applies.
 *
 * The table's own rule is the default. When it pinned a path-like argument only because the package runner was
 * unrecognized, the decision model may answer that the arguments are data, in which case the table's wider
 * alternative is offered instead. The model never supplies a pattern — it chooses between two the table built
 * — and any failure leaves the narrow one in place. Only one uncovered segment can carry a suggestion;
 * multiple uncovered segments keep the plain dialog (manual patterns are the tool for those).
 *
 * `consultModel` is the caller's judgement that a request is worth sending: a prompt no one can answer needs
 * no model-chosen width, and an endpoint that just failed will only fail again.
 */
export async function suggestRuleForPrompt(options: {
    ctx: ExtensionContext;
    config: DecisionModelConfig;
    unresolved: readonly string[][];
    /** Whether to ask the endpoint at all; false keeps the table's own suggestion. */
    consultModel: boolean;
    registry?: ClassifierRegistry;
}): Promise<PromptRuleSuggestion | null> {
    if (options.unresolved.length !== 1) {
        return null;
    }

    const tokens = options.unresolved[0];
    const outcome = suggestRuleOutcome(tokens);
    if (outcome.pattern === null) {
        return null;
    }

    const table: PromptRuleSuggestion = { pattern: outcome.pattern, source: "table" };
    if (
        outcome.widened === undefined ||
        !options.consultModel ||
        !suggestionEnabled(options.config)
    ) {
        return table;
    }

    const role = await consultSuggestionForPrompt({
        ctx: options.ctx,
        config: options.config,
        tokens,
        ...(options.registry === undefined ? {} : { registry: options.registry }),
    });

    return role === "data" ? { pattern: outcome.widened, source: "model" } : table;
}

export interface SuggestionForPromptOptions {
    ctx: ExtensionContext;
    config: DecisionModelConfig;
    /** The single uncovered segment, tokenized. */
    tokens: readonly string[];
    registry?: ClassifierRegistry;
}

/**
 * Ask whether an uncovered segment's arguments are code or data, for a caller deciding between two table
 * patterns.
 *
 * The session half is the same-tool command window, which is what makes an unrecognized package's argument
 * role answerable at all. `undefined` means no usable answer (disabled, failed, unreadable), and the caller
 * keeps the pattern the table built. Never rejects.
 */
export async function consultSuggestionForPrompt(
    options: SuggestionForPromptOptions,
): Promise<SuggestionRole | undefined> {
    if (!suggestionEnabled(options.config)) {
        return undefined;
    }

    const consulted = await consultSuggestionRole({
        ctx: options.ctx,
        config: options.config,
        command: options.tokens.join(" "),
        recentCommands: decisionSimilarCommands(
            options.ctx.sessionManager.getBranch(),
            options.tokens,
        ),
        ...(options.registry === undefined ? {} : { registry: options.registry }),
    });

    return consulted.role;
}

/**
 * Consult the model for one gate, and translate the verdict into what the gate needs.
 *
 * Never rejects: the verdict abstains when the endpoint fails, and the prompt path stays intact.
 */
export async function consultForGate(options: GateConsultOptions): Promise<GateConsultedDecision> {
    checksInFlight += 1;
    emitDecisionStatus(options.events, checksInFlight);

    try {
        const consulted = await consultDecisionContext({
            ctx: options.ctx,
            config: options.config,
            command: options.command,
            sandboxAvailable: options.sandboxAvailable,
            ...(options.runner === undefined ? {} : { runner: options.runner }),
            ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
            ...(options.authority === undefined ? {} : { authority: options.authority }),
            ...(options.registry === undefined ? {} : { registry: options.registry }),
        });
        const permission = appliedPermission(options.config, consulted.verdict);

        if (permission !== undefined) {
            options.notify(
                `pi-bash-sandbox: decision model resolved ${options.label}: ${consulted.verdict.action ?? "abstain"} (${consulted.verdict.criterion ?? consulted.verdict.status}) - ${permission}`,
                "info",
            );
        }

        return {
            ...(permission === undefined ? {} : { permission }),
            record: classifierRecord(
                consulted.verdict,
                options.config,
                permission !== undefined,
                consulted.context?.script,
            ),
        };
    } finally {
        checksInFlight = Math.max(0, checksInFlight - 1);
        emitDecisionStatus(options.events, checksInFlight);
    }
}
