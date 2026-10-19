import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    consultDecisionContext,
    consultFileAccessDecision,
    fileDecisionEnabled,
    APPLIED_PERMISSIONS,
    type DecisionContextShape,
} from "../modules/decision/gate";
import type {
    ClassifierRegistry,
    DecisionModelConfig,
    DecisionSurface,
    DecisionVerdict,
    FileDecisionOperation,
    ScriptRun,
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
