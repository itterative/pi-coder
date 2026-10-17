import type { ClassifierAnswer, Usage } from "@earendil-works/pi-ai";

import type { DecisionIsolation, DecisionRunner } from "./runner-rules";
import type { DecisionStrategyId } from "./strategies/types";

/** The handling the decision model can recommend for an unresolved command. */
export type DecisionAction = "host" | "sandbox" | "refuse";

/**
 * Why the second-opinion model thinks a command should not run directly on the host.
 *
 * `none` is the only safe answer; every other id is a reason to withhold host execution. `off_task` is not
 * here: it is a workflow judgement, not a permission one. `loses_content` is its permission-scoped
 * replacement, and it is what catches accidental destruction — a criterion that is not named cannot be
 * answered, so before it existed a script that truncated a tracked file read as an ordinary edit
 * (`destructive` 0.19 on a file whose loss git could recover). Named, it scores 0.75-0.87 on those scripts
 * and <=0.17 on benign edits.
 */
export type DecisionVetoReason =
    "none" | "destructive" | "privileged" | "exfiltration" | "remote_code" | "loses_content";

/**
 * The criteria the classification form answers with: the six veto reasons plus `out_of_scope`.
 *
 * `out_of_scope` is what the runner's rules forbid. It exists because the model otherwise reached for a
 * content criterion to say the same thing: with the slot, a read-only runner's in-workspace edit family
 * went 1/6 to 6/6 (reviewer) and 4/6 to 6/6 (scout), while every parent-rule verdict stayed put and corpus
 * friction *fell* (11 denials of 185, no routine rewrite refused) because the model stopped using
 * `destructive`/`loses_content` to express "this runner may not do that". The alternative, `unrequested`, was
 * rejected: redundant with `loses_content`, and an eighth criterion dilutes the choice into losing a harm.
 */
export type DecisionReason = DecisionVetoReason | "out_of_scope";

/**
 * What a script body can do when it runs, as the script classifier answers it.
 *
 * A script verdict is a property of the code, not of an invocation: the request carries the body alone and
 * the answer cache keys on its content hash, so the same bytes share one verdict across commands, runners,
 * and sessions. `network` and `writes_files` are capabilities, not verdicts — whether they are allowed is a
 * composition question (runner authority for one, sandbox containment for the other), which is why the
 * command state receives these summaries beside the runner's rules.
 */
export type ScriptCapability =
    | "read_only"
    | "writes_files"
    | "writes_outside"
    | "privileged"
    | "network"
    | "remote_code"
    | "destructive"
    | "process_control";

/** A criterion a classified form can name: a command reason, or a script's capability. */
export type DecisionCriterion = DecisionReason | ScriptCapability;

/** Which subject a classified form answers about: the invocation, one body of code it runs, or the runner's authority over those bodies. */
export type DecisionFormSubject = "command" | "script" | "scope";

/** What the caller should do: apply a recommended action, or fall through to the human prompt. */
export type DecisionOutcome = DecisionAction | "abstain";

/** How the model request itself ended, for the decision log. */
export type DecisionStatus = "applied" | "abstained" | "error" | "timeout";

/** How one form's classifier request ended, for the decision log. */
export type DecisionFormStatus =
    "answered" | "cached" | "budget" | "rejected" | "cooldown" | "error" | "timeout";

/** The question sets the module ships. `single` is one 3-way choice: host, sandbox, or refuse. */
export type DecisionQuestionSet = "single";

/**
 * How the command and its context are shaped into the classifier `state`.
 *
 * `command_cwd` sends only the command, the directory, and the runner's rules. `request_context` adds the
 * request the command serves plus the recent turns, and it is the default: on a 25-case hand-labelled set it
 * took accidental-destruction detection from 1/6 to 5/6 while leaving benign-edit false positives unmoved,
 * for +38 tokens over `command_cwd`. The earlier finding that conversation "let the model rationalize
 * dangerous commands" was measured with the request flattened into a transcript; sent as its own `request`
 * field beside `recent_messages`, the effect reverses.
 */
export type DecisionContextShape = "command_cwd" | "request_context";

/** Which permission surfaces may consult the model. */
export type DecisionSurface = "parent" | "child";

/**
 * The second-opinion ("veto") request.
 *
 * A `host` answer is the only model direction that gains authority, so it is the one worth a second look.
 * When a `host` answer is not confident, a second request asks specifically whether there is a strong reason
 * not to run on the host; a dangerous answer reclassifies the command instead of letting it through.
 */
export interface DecisionVetoConfig {
    /** Run the veto request at all (default true). */
    enabled?: boolean;
    /** Consult the veto when a `host` answer's confidence is below this (default 0.6). */
    gateBelow?: number;
    /** Minimum confidence in a dangerous veto reason to act on it (default 0.6). */
    minConfidence?: number;
    /** Action applied when the veto is dangerous (default `sandbox`). */
    escalateTo?: DecisionAction;
}

/**
 * Configuration for consulting a classifier model about unresolved commands.
 *
 * `provider`/`model` name a classifier in pi's model registry; there is no URL or token here because pi
 * resolves provider credentials and transport. Pair with `src/common/config.ts`'s `decisionModel` section.
 */
export interface DecisionModelConfig {
    /** Whether the gate may consult the model at all (default false). */
    enabled?: boolean;
    /**
     * Whether a verdict may resolve a prompt (default false).
     *
     * The one toggle for the whole feature: off means the model is consulted and its verdict is logged while
     * every unresolved command still reaches the human, on means the verdict decides. A `refuse` is the one
     * answer that never resolves anything by itself — a denial on the model's word is not worth the work it
     * blocks — and a `host` needs `minConfidence`, because it is the direction that grants authority.
     */
    apply?: boolean;
    /** Endpoint registered as a classifier provider. Omit it to use a classifier another provider already offers. */
    baseUrl?: string;
    /** Credential for that endpoint. Prefer the global config file or `SYSTEMONE_API_TOKEN` over a project file. */
    apiKey?: string;
    /** Classifier provider, e.g. `systemone` or `llamacpp`. */
    provider?: string;
    /** Classifier model id. When omitted, the first classifier for `provider` is used. */
    model?: string;
    /** Context window declared for the registered classifier model (default 32768). */
    contextWindow?: number;
    /** Which way of asking the classifier. Default is the measured `veto`. */
    strategy?: DecisionStrategyId;
    /** Abort the classifier request after this long (default 5000 ms). */
    timeoutMs?: number;
    /** After a failed request, skip the model for this long (default 30000 ms). */
    cooldownMs?: number;
    /** Minimum confidence for a `host` verdict to resolve a prompt (default 0.8). */
    minConfidence?: number;
    /** Surfaces that may consult the model (default `["parent"]`). */
    surfaces?: readonly DecisionSurface[];
    /** Second-opinion veto for low-confidence `host` answers. */
    veto?: DecisionVetoConfig;
}

/** A recent conversation turn included in the state. */
export interface DecisionRecentMessage {
    role: string;
    text: string;
}

/**
 * Which form of script run a command is.
 *
 * `package` and `file` have a body on disk and are the only two the state carries; `inline` puts the code in
 * the command itself, so the state gains nothing, and `binary` runs code from outside the repository, where
 * there is no body to read.
 */
export type ScriptKind = "package" | "file" | "inline" | "binary";

/** One resolved body's capability as the command classifier receives it; the body itself is not re-sent. */
export interface ScriptCapabilitySummary {
    source: string;
    capability: ScriptCapability;
}

/** mtime and size of the file a script body came from, taken when the body was read. */
export interface ScriptFileIdentity {
    mtimeMs: number;
    size: number;
}

/**
 * One body the resolver read for a command, with where it came from.
 *
 * `source` is provenance, not a semantic label: `package.json#deploy` for a package script line and the
 * repo-relative path for a file body. The text is captured whole — no clipping and no budget guard — because
 * a body too large for the endpoint is meant to fail the consult (which prompts) rather than be silently
 * trimmed into something the model would judge as a different script.
 */
export interface ScriptArtifact {
    /** `package.json#deploy` for a script line; the repo-relative path for a file body. */
    source: string;
    /** Absolute path the text was read from. */
    path?: string;
    /** The body, whole. */
    text: string;
    /**
     * The identity of the file behind `path`, when the reader could report it. The verdict cache keys on
     * this, so an edited script is a different request; absent for a reader that only supplies text.
     */
    identity?: ScriptFileIdentity;
}

/** Why the chase stopped with package-script references unresolved. */
export type ScriptOmissionReason = "depth" | "cycle";

/** One reference the chase left unresolved, so an incomplete resolution is visible rather than silent. */
export interface ScriptOmission {
    /** `depth` for the nesting cap, `cycle` for a name the guard has already visited. */
    reason: ScriptOmissionReason;
    /** The unresolved reference in artifact-source form, e.g. `package.json#build`. */
    source: string;
}

/**
 * The scripts a command runs, when one was recognized.
 *
 * `artifacts` is ordered deterministically: the original script line first, then nested script lines in the
 * order the chase reached them, then file bodies in resolution order. The chase never clips a body; it stops
 * following references at the depth cap or when the visited set sees a name twice, and records that stop in
 * `omissions` instead.
 */
export interface ScriptRun {
    kind: ScriptKind;
    /** The resolved bodies, in the order the model receives them. */
    artifacts: readonly ScriptArtifact[];
    /** References a cap or the cycle guard left unresolved; absent when the chase completed. */
    omissions?: readonly ScriptOmission[];
}

/**
 * Everything a strategy may draw on when it shapes the classifier state.
 *
 * The caller gathers these facts once and every strategy decides which of them reach the model — that is the
 * lever `veto` and `history` differ on. `runner` and `isolation` select the runner rules, and default to
 * `parent`/`checkout`.
 */
export interface DecisionContext {
    /** The unresolved command, exact text. */
    command: string;
    cwd: string;
    /**
     * Who is running the command. Selects the generic runner rules that go into the state, so the model
     * can judge a routine action against the authority the runner actually has. Defaults to `parent`.
     */
    runner?: DecisionRunner;
    /** Where a mutating runner's working copy is, when it is a child. Defaults to `checkout`. */
    isolation?: DecisionIsolation;
    /** The request the command serves: the delegated task for a child, the current user request for the parent. */
    request?: string;
    /** The items immediately before the command, sent as `recent_messages`; the current request is excluded. */
    recent?: readonly DecisionRecentMessage[];
    /**
     * The runner's uncommitted changes, read from git by the gate.
     *
     * Best-effort: absent when the cwd is not a repository, git failed or timed out, or nothing is changed.
     * A clean tree carries no fact the command needs, so only a dirty one reaches the state.
     */
    workspace?: DecisionWorkspace;
    /**
     * Commands already run in this session, oldest first. Only a strategy that asks for a history reads it,
     * and collecting it is the caller's job: the caller is what knows the session. The resolver's own
     * classification is deliberately not here — sent as `resolution` it changed 0 of 208 verdicts, so it was
     * two fields of state that bought nothing.
     */
    history?: readonly string[];
    /**
     * The scripts the command runs, resolved from disk by the caller. Strategies put the bodies into the state
     * whenever any were read; a recognized form without one is collected so the decision log can say the body
     * was unavailable.
     */
    script?: ScriptRun;
    /**
     * The capabilities of the bodies this command runs, as the evaluator resolved them.
     *
     * Present on the command request the evaluator builds after the script classifications: the bodies are
     * classified once, as content, and the command classifier receives the facts it needs for scope — can
     * this runner run code that writes files or uses the network — without the code itself. A context that
     * carries both `script` and these is a caller error; production sets one or the other.
     */
    scriptProfiles?: readonly ScriptCapabilitySummary[];
}

/** One uncommitted path in the runner's working tree, as `git status` reports it. */
export interface DecisionWorkspaceChange {
    status: "added" | "conflicted" | "deleted" | "modified" | "renamed" | "untracked";
    /** The cwd-relative path; a rename keeps git's `old -> new` form. */
    path: string;
}

/** The runner's working tree, clipped: the uncommitted state the classifier gets to see. */
export interface DecisionWorkspace {
    changes: readonly DecisionWorkspaceChange[];
    /** True when paths were dropped to keep the field small. */
    truncated: boolean;
}

/** The second-opinion answer, recorded when the veto was consulted. */
export interface DecisionVetoAnswer {
    reason: DecisionVetoReason;
    confidence: number;
    /** True when the veto changed the recommended action. */
    escalated: boolean;
}

/**
 * One classified form of a command: one script body, or the command itself when it resolved no body.
 *
 * A script run is classified form by form rather than as a single payload, so each body gets its own
 * request, its own cache entry, and its own answer. The decision log keeps them per source, and `foldAnswers`
 * is what turns them back into the one answer a command needs.
 */
export interface DecisionFormAnswer {
    /** Whether this form answered about the invocation or about one body of code. */
    subject: DecisionFormSubject;
    /** Artifact provenance (`package.json#deploy` or a path); absent for the command form. */
    source?: string;
    /** The criterion the strategy read for this form, when it answered. */
    criterion?: DecisionCriterion;
    /** The action this form's criterion maps to, before the fold and the policy. */
    action?: DecisionAction;
    confidence?: number;
    /** How this form's request ended. */
    status: DecisionFormStatus;
    /** Raw answers by question id, for offline analysis. */
    answers: Record<string, ClassifierAnswer>;
}

/** One model verdict, whether it resolved the command or abstained. */
export interface DecisionVerdict {
    /** Apply this action without a prompt, or fall through to the human prompt. */
    outcome: DecisionOutcome;
    /** How the model request ended. */
    status: DecisionStatus;
    /** Machine-readable reason, for the decision log and notifications. */
    reason: string;
    /** The raw recommended action, present whenever the model answered. */
    action?: DecisionAction;
    /** The model's confidence in `action`, present for choice answers. */
    confidence?: number;
    /** The second-opinion answer, present when the veto was consulted and answered. */
    veto?: DecisionVetoAnswer;
    /** The criterion the strategy read out of the answer; what the decision log records. */
    criterion?: DecisionCriterion;
    /** Which strategy produced this verdict. */
    strategy?: DecisionStrategyId;
    /** Raw answers by question id, for offline analysis. */
    answers: Record<string, ClassifierAnswer>;
    /** The per-form answers the fold combined, in send order. Absent when the model was never consulted. */
    forms?: readonly DecisionFormAnswer[];
    latencyMs: number;
    model?: { provider: string; id: string };
    usage?: Usage;
    /** True when the answer came from the evaluator's verdict cache and no request was made. */
    cached?: boolean;
}
