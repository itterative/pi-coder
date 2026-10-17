import sandboxConfig from "../../common/config";
import { BASH_DECISION_LOG_PATH } from "../../common/constants";
import { createJsonlRecordLog, type RecordLog } from "../../common/record-log";
import type { Permission } from "./permissions";
import type { BashDecisionSegment, ResolvePermissionDetails, SegmentSource } from "./resolve";

/**
 * Append-only record of how every bash command was resolved by the permission
 * gate. This is development tooling: the log is meant to be mined offline (see
 * `scripts/permission-report.ts`) for command shapes that deserve a heuristic
 * or a curated rule, and for approvals that were refused so the same gap is not
 * re-learned.
 */

const RECORD_VERSION = 1;
/** Rotate instead of growing past this size. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Rotated copies kept, live file excluded. At eight MiB each this can hold eighty MiB of decisions, which on a
 * compressing filesystem costs a couple of MiB - the reason the old single generation was worth replacing.
 */
const DEFAULT_GENERATIONS = 10;
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export interface BashDecisionRecord {
    v: typeof RECORD_VERSION;
    /** ISO timestamp of the decision */
    ts: string;
    /** which bash permission gate produced it */
    surface: "parent" | "child";
    /** delegated agent name, when {@link surface} is `"child"` */
    agent?: string;
    cwd: string;
    /** command exactly as requested, before any sandbox wrapping */
    command: string;
    /** resolver outcome before any human was consulted */
    resolution: {
        permission: Permission;
        source: SegmentSource;
        pattern: string | null;
        segments: BashDecisionSegment[];
    };
    /** present only when a human was asked */
    prompt?: {
        outcome: PromptOutcome;
        /** session rule offered by the suggestion table, when one existed */
        suggestion?: string;
        /** rule the user chose to remember, when they accepted the suggestion */
        rule?: string;
    };
    /** present only when the decision model was consulted */
    classifier?: BashClassifierRecord;
    /** permission actually applied after any prompt */
    decision: Permission;
    sandboxed: boolean;
    /** the command was not run (denied, dismissed, or unrunnable in sandbox mode) */
    blocked: boolean;
    /** note the user attached while approving or denying */
    note?: string;
}

/**
 * How the interactive prompt ended. `"dismissed"` is an Esc/abort, which the
 * gates treat as a denial but which is not an explicit judgement on the command.
 */
export type PromptOutcome = "yes" | "remember" | "no" | "dismissed";

/** The script a consulted command was found to run, as recorded in the decision log. */
export interface BashClassifierScriptRecord {
    /** `package`, `file`, `inline`, or `binary`, as the resolver recognized the command. */
    kind: string;
    /** provenance of each resolved body, in the order sent: `package.json#name` or a repo-relative path */
    sources?: string[];
    /** total characters of the resolved bodies; absent when none was read */
    chars?: number;
    /** references the chase left unresolved, as `reason:source`; absent when it completed */
    omitted?: string[];
    /** one answer per classified body, in send order; absent when no body was classified individually */
    answers?: BashClassifierScriptAnswerRecord[];
}

/**
 * One body's own answer, when the command was classified form by form rather than as one payload.
 *
 * The top-level `criterion`/`confidence` is the fold's answer for the whole command; these are the inputs it
 * read, so a row's score can be attributed to the script that produced it.
 */
export interface BashClassifierScriptAnswerRecord {
    /** provenance of the body: `package.json#name` or a repo-relative path */
    source: string;
    /** criterion the model named for this body, when it answered */
    criterion?: string;
    /** action the criterion maps to, before the fold */
    action?: string;
    confidence?: number;
    /** how this body's request ended: `answered`, `cached`, `error`, `timeout`, or an abstain form */
    status: string;
}

/**
 * The command form's own answer, before the capability fold.
 *
 * The record's top-level `criterion`/`action`/`confidence` is the fold, and a script capability can win it;
 * this keeps the invocation judgment visible beside it, so mining can tell a dangerous command from a
 * dangerous body.
 */
export interface BashClassifierCommandRecord {
    /** criterion the model named for the command, when it answered */
    criterion?: string;
    /** action the criterion maps to, before the fold */
    action?: string;
    confidence?: number;
    /** how the command's request ended: `answered`, `cached`, `error`, `timeout`, or an abstain form */
    status: string;
}

/**
 * The decision model's verdict on a command, when it was consulted.
 *
 * The model is asked about exactly the commands that reach this log as unresolved, so the two records join on
 * the command text and the field answers what mining a permission log otherwise cannot: whether a model would
 * have resolved the prompt, on what criterion, and with how much confidence. `applied` separates the two
 * modes — recorded only (`apply` off) versus actually used instead of the prompt.
 */
export interface BashClassifierRecord {
    /** strategy id, e.g. `veto` */
    strategy: string;
    /** provider and model the verdict came from; absent when the request never happened */
    provider?: string;
    model?: string;
    /** criterion the model named, when it answered */
    criterion?: string;
    /** action the criterion maps to, before policy */
    action?: string;
    confidence?: number;
    /** action the policy settled on: `host`, `sandbox`, `refuse`, or `abstain` */
    outcome: string;
    /** `applied`, `abstained`, `timeout`, or `error` */
    status: string;
    /** machine-readable reason from the policy or the request */
    reason: string;
    latencyMs: number;
    /** the verdict replaced the prompt */
    applied: boolean;
    /** tokens the classifier reported, when it reported any */
    tokens?: { input: number; output: number; total: number };
    /** the verdict came from the evaluator's cache: no request was made and the tokens are zero */
    cached?: boolean;
    /** The command form's own answer, before the capability fold; absent when the model never answered. */
    command?: BashClassifierCommandRecord;
    /** The script form behind the command, when one was recognized; the bodies themselves are not logged */
    script?: BashClassifierScriptRecord;
}

export interface BashDecisionInput {
    surface: "parent" | "child";
    agentName?: string;
    cwd: string;
    command: string;
    details: ResolvePermissionDetails;
    prompt?: { outcome: PromptOutcome; suggestion?: string; rule?: string };
    classifier?: BashClassifierRecord;
    decision: Permission;
    sandboxed: boolean;
    blocked: boolean;
    note?: string;
}

interface DecisionLogConfig {
    enabled: boolean;
    filePath: string;
    maxBytes: number;
    generations: number;
}

/** Treat an unset or blank value as absent so config and defaults can apply. */
function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/** Resolve the log location and whether logging is on, from config plus environment. */
export function getDecisionLogConfig(): DecisionLogConfig {
    const config = sandboxConfig.current?.decisionLog;
    const envPath = nonEmpty(process.env.SANDBOX_DECISION_LOG_PATH);
    const envSwitch = nonEmpty(process.env.SANDBOX_DECISION_LOG)?.toLowerCase();

    let enabled = config?.enabled ?? true;
    if (envSwitch !== undefined) {
        enabled = !DISABLED_VALUES.has(envSwitch);
    }

    return {
        enabled,
        filePath: envPath ?? nonEmpty(config?.path) ?? BASH_DECISION_LOG_PATH,
        maxBytes: config?.maxBytes ?? DEFAULT_MAX_BYTES,
        generations: config?.generations ?? DEFAULT_GENERATIONS,
    };
}

/**
 * One log per target, so append and rotation health accumulates across a session instead of per decision.
 */
const decisionLogs = new Map<string, RecordLog<BashDecisionRecord>>();

function decisionLog(config: DecisionLogConfig): RecordLog<BashDecisionRecord> {
    const key = `${config.filePath}|${String(config.maxBytes)}|${String(config.generations)}`;
    const existing = decisionLogs.get(key);
    if (existing !== undefined) {
        return existing;
    }

    const created = createJsonlRecordLog<BashDecisionRecord>({
        filePath: config.filePath,
        maxBytes: config.maxBytes,
        generations: config.generations,
    });
    decisionLogs.set(key, created);
    return created;
}

function segmentRecords(segments: readonly BashDecisionSegment[]): BashDecisionSegment[] {
    return segments.map((segment) => ({ ...segment }));
}

function classifierRecord(record: BashClassifierRecord): BashClassifierRecord {
    return {
        ...record,
        ...(record.tokens === undefined ? {} : { tokens: { ...record.tokens } }),
        ...(record.command === undefined ? {} : { command: { ...record.command } }),
        ...(record.script === undefined ? {} : { script: cloneScriptRecord(record.script) }),
    };
}

function cloneScriptRecord(script: BashClassifierScriptRecord): BashClassifierScriptRecord {
    return {
        ...script,
        ...(script.sources === undefined ? {} : { sources: [...script.sources] }),
        ...(script.omitted === undefined ? {} : { omitted: [...script.omitted] }),
        ...(script.answers === undefined
            ? {}
            : { answers: script.answers.map((answer) => ({ ...answer })) }),
    };
}

/**
 * Append one decision record. Never throws: a logging failure must not change
 * whether a command runs, so failures are swallowed silently by design.
 */
export function logBashDecision(input: BashDecisionInput): void {
    const config = getDecisionLogConfig();
    if (!config.enabled) {
        return;
    }

    const record: BashDecisionRecord = {
        v: RECORD_VERSION,
        ts: new Date().toISOString(),
        surface: input.surface,
        ...(input.agentName === undefined ? {} : { agent: input.agentName }),
        cwd: input.cwd,
        command: input.command,
        resolution: {
            permission: input.details.permission,
            source: input.details.source,
            pattern: input.details.pattern,
            segments: segmentRecords(input.details.segments),
        },
        ...(input.prompt === undefined
            ? {}
            : {
                  prompt: {
                      outcome: input.prompt.outcome,
                      ...(input.prompt.suggestion === undefined
                          ? {}
                          : { suggestion: input.prompt.suggestion }),
                      ...(input.prompt.rule === undefined ? {} : { rule: input.prompt.rule }),
                  },
              }),
        decision: input.decision,
        sandboxed: input.sandboxed,
        blocked: input.blocked,
        ...(input.classifier === undefined
            ? {}
            : { classifier: classifierRecord(input.classifier) }),
        ...(input.note === undefined ? {} : { note: input.note }),
    };

    decisionLog(config).append(record);
}
