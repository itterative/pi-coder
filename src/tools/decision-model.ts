import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    consultDecisionContext,
    APPLIED_PERMISSIONS,
    type DecisionContextShape,
} from "../modules/decision/gate";
import type {
    ClassifierRegistry,
    DecisionModelConfig,
    DecisionVerdict,
    ScriptRun,
} from "../modules/decision";
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

/**
 * Consult the model for one gate, and translate the verdict into what the gate needs.
 *
 * Never rejects: the verdict abstains when the endpoint fails, and the prompt path stays intact.
 */
export async function consultForGate(options: GateConsultOptions): Promise<GateConsultedDecision> {
    const consulted = await consultDecisionContext({
        ctx: options.ctx,
        config: options.config,
        command: options.command,
        sandboxAvailable: options.sandboxAvailable,
        ...(options.runner === undefined ? {} : { runner: options.runner }),
        ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
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
}
