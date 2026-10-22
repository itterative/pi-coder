import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierQuestion } from "@earendil-works/pi-ai";

import { DecisionEvaluator } from "./evaluator";
import {
    ReminderEvaluator,
    reminderEnabled,
    type ReminderConsult,
    type ReminderOption,
    type ReminderSignals,
} from "./reminder";
import { readScriptFile, resolveScriptRun, scriptFileIdentity } from "./script";
import { clipRequest, decisionSessionContext } from "./session-context";
import { SuggestionEvaluator, type SuggestionConsult } from "./suggestion";
import { workspaceStatusFor } from "./workspace";
import type { ClassifierRegistry } from "./model";
import type { DecisionIsolation, DecisionRunner } from "./runner-rules";
import type {
    DecisionAuthority,
    DecisionContext,
    DecisionModelConfig,
    DecisionSurface,
    DecisionVerdict,
    FileAccessDecisionContext,
    FileDecisionSubject,
} from "./types";

/**
 * The permission gate's side of the decision module: build the context, hand it to one shared evaluator, and
 * never let the model break the flow.
 *
 * Everything here is deliberately thin. The strategy owns what is asked, `policy.ts` owns what an answer may
 * do, and the gate owns only the thing it alone knows: the session behind the command.
 */

/** Surfaces allowed to consult the model when the config does not name any. */
export const DEFAULT_SURFACES: readonly DecisionSurface[] = ["parent"];

/** File surfaces allowed to consult the model when `fileSurfaces` is absent: none. */
const DEFAULT_FILE_SURFACES: readonly DecisionSurface[] = [];

let cachedEvaluator: { key: string; evaluator: DecisionEvaluator } | undefined;

/** Whether this surface may consult the model at all. */
export function decisionEnabled(config: DecisionModelConfig, surface: DecisionSurface): boolean {
    if (config.enabled !== true) {
        return false;
    }

    return (config.surfaces ?? DEFAULT_SURFACES).includes(surface);
}

/**
 * Whether this file-access surface may consult the model.
 *
 * Its own predicate over its own list, because the two subjects decide different things and the file one has
 * no sandbox to fall back on: `surfaces` names the Bash gates and `fileSurfaces` the read/write gates, so an
 * existing config keeps exactly the meaning it was written with.
 */
export function fileDecisionEnabled(
    config: DecisionModelConfig,
    surface: DecisionSurface,
): boolean {
    if (config.enabled !== true) {
        return false;
    }

    return (config.fileSurfaces ?? DEFAULT_FILE_SURFACES).includes(surface);
}

/**
 * What each action means to a gate, once `apply` lets a verdict act.
 *
 * `DecisionAction` and the permission vocabulary name the same three things; the table lives here so both
 * gates map a verdict the same way instead of each carrying its own switch. `abstain` is absent on purpose:
 * falling through to the human is not a mapping, it is the absence of one.
 */
export const APPLIED_PERMISSIONS = {
    host: "allow",
    sandbox: "allow:sandbox",
    refuse: "deny",
} as const;

/** Who is running a command, and from where, when that is not the parent in its own checkout. */
export interface DecisionContextShape {
    runner?: DecisionRunner;
    isolation?: DecisionIsolation;
    /**
     * The runner's real authority rung, when a name-only mapping would overstate it. Passed through to the
     * scope gate; absent means the rung follows `runner`.
     */
    authority?: DecisionAuthority;
}

/**
 * The file-access subject for one direct read or write, with the session half beside it.
 *
 * `path` is the gate's own resolved target, so what the classifier judges is the path the tool will open.
 * Only `request` is taken from the session and not `recent`: the measured arm that added the recent window
 * resolved no more approved accesses and cost 40 more tokens, and a path's judgment is about the request the
 * access serves rather than the turns around it.
 */
export function fileDecisionContextFor(
    ctx: ExtensionContext,
    file: FileDecisionSubject,
    shape: DecisionContextShape = {},
): FileAccessDecisionContext {
    const cwd = ctx.cwd ?? process.cwd();
    const session = decisionSessionContext(ctx.sessionManager.getBranch());

    return {
        file,
        cwd,
        runner: shape.runner ?? "parent",
        isolation: shape.isolation ?? "checkout",
        ...(session.request === undefined ? {} : { request: session.request }),
    };
}

/** The classifier context for one unresolved command, taken from the active branch. */
export function decisionContextFor(
    ctx: ExtensionContext,
    command: string,
    shape: DecisionContextShape = {},
): DecisionContext {
    const cwd = ctx.cwd ?? process.cwd();
    // The script is a command fact, like the command text, so it is collected here where the caller's cwd is
    // known; the strategies stay pure and only read the field.
    const script = resolveScriptRun(command, {
        cwd,
        readFile: readScriptFile,
        statFile: scriptFileIdentity,
    });

    return {
        command,
        cwd,
        runner: shape.runner ?? "parent",
        isolation: shape.isolation ?? "checkout",
        ...(shape.authority === undefined ? {} : { authority: shape.authority }),
        ...(script === undefined ? {} : { script }),
        ...decisionSessionContext(ctx.sessionManager.getBranch()),
    };
}

/**
 * One evaluator per configuration.
 *
 * The evaluator owns the cooldown after a failed request, which is why the gate does not build one per
 * command. Reusing it across a config change would keep a cooldown earned under other settings, so the key
 * carries the settings: a changed config (or a sandbox that became unavailable) starts fresh.
 */
function evaluatorFor(seed: EvaluatorSeed): DecisionEvaluator {
    const key = JSON.stringify([seed.config, seed.sandboxAvailable]);
    if (cachedEvaluator?.key === key) {
        return cachedEvaluator.evaluator;
    }

    const evaluator = new DecisionEvaluator({
        registry: seed.registry ?? seed.ctx.modelRegistry,
        config: seed.config,
        sandboxAvailable: seed.sandboxAvailable,
    });
    cachedEvaluator = { key, evaluator };
    return evaluator;
}

/**
 * Whether this configuration allows the model to refine a session-rule suggestion.
 *
 * Not `decisionEnabled`: `surfaces` names the prompts a verdict may resolve, and a suggestion grants no
 * authority — it is a second pattern the table already built. `suggestions: false` is the off switch.
 */
export function suggestionEnabled(config: DecisionModelConfig): boolean {
    return config.enabled === true && config.suggestions !== false;
}

/** The evaluator's seed, without the sandbox fact the suggestion subject never reads. */
export interface SuggestionEvaluatorSeed {
    ctx: ExtensionContext;
    config: DecisionModelConfig;
    registry?: ClassifierRegistry;
}

let cachedSuggestionEvaluator: { key: string; evaluator: SuggestionEvaluator } | undefined;

/** One suggestion evaluator per configuration: it owns a cooldown and a cache that must not span configs. */
function suggestionEvaluatorFor(seed: SuggestionEvaluatorSeed): SuggestionEvaluator {
    const key = JSON.stringify(seed.config);
    if (cachedSuggestionEvaluator?.key === key) {
        return cachedSuggestionEvaluator.evaluator;
    }

    const evaluator = new SuggestionEvaluator({
        registry: seed.registry ?? seed.ctx.modelRegistry,
        config: seed.config,
    });
    cachedSuggestionEvaluator = { key, evaluator };
    return evaluator;
}

/** What it takes to reach the reminder evaluator: the config it is keyed by and the registry to resolve from. */
export interface ReminderEvaluatorSeed {
    ctx: ExtensionContext;
    config: DecisionModelConfig;
    registry?: ClassifierRegistry;
}

let cachedReminderEvaluator: { key: string; evaluator: ReminderEvaluator } | undefined;

/** One reminder evaluator per configuration: a failed reminder request must not pause a permission verdict. */
function reminderEvaluatorFor(seed: ReminderEvaluatorSeed): ReminderEvaluator {
    const key = JSON.stringify(seed.config);
    if (cachedReminderEvaluator?.key === key) {
        return cachedReminderEvaluator.evaluator;
    }

    const evaluator = new ReminderEvaluator({
        registry: seed.registry ?? seed.ctx.modelRegistry,
        config: seed.config,
    });
    cachedReminderEvaluator = { key, evaluator };
    return evaluator;
}

export interface ReminderConsultOptions extends ReminderEvaluatorSeed {
    /** The reminders the model may choose from, in the order their criteria should read. */
    options: readonly ReminderOption[];
    /**
     * The request being judged, when the caller already has it and the session branch does not yet carry
     * it. A `before_agent_start` consult passes the live prompt, because the user message has not been
     * persisted at that point and the branch's request is the previous turn's. Clipped like a branch-built
     * request.
     */
    request?: string;
    /** Activity, prior reminders, TODO progress, and the memory list. */
    signals?: ReminderSignals;
    /** Extra questions the caller wants answered in the same round trip; returned under `consult.extras`. */
    extraQuestions?: Readonly<Record<string, ClassifierQuestion>>;
}

/**
 * Ask the model whether the coming turn should receive a reminder, and which one.
 *
 * Never rejects, and never grants anything: a disabled, failed, or unreadable answer comes back without a
 * decision and the caller falls back to its deterministic schedule. The answer only picks among reminders the
 * caller already wrote; the model never authors the text shown to the agent.
 */
export async function consultReminderSelection(
    options: ReminderConsultOptions,
): Promise<ReminderConsult> {
    if (!reminderEnabled(options.config)) {
        return { status: "disabled", latencyMs: 0 };
    }

    try {
        const session = decisionSessionContext(options.ctx.sessionManager.getBranch());
        const request =
            options.request === undefined ? session.request : clipRequest(options.request);

        return await reminderEvaluatorFor(options).evaluate({
            options: options.options,
            ...(request === undefined ? {} : { request }),
            ...(session.recent.length === 0 ? {} : { recent: session.recent }),
            ...(options.signals === undefined ? {} : { signals: options.signals }),
            ...(options.extraQuestions === undefined
                ? {}
                : { extraQuestions: options.extraQuestions }),
        });
    } catch {
        return { status: "error", latencyMs: 0 };
    }
}

export interface SuggestionConsultOptions extends SuggestionEvaluatorSeed {
    /** The single uncovered segment, as text. */
    command: string;
    /** Commands from this session that name the same tool, oldest first. */
    recentCommands?: readonly string[];
}

/**
 * Ask the model whether one uncovered segment's arguments are code or data.
 *
 * Never rejects, and never grants anything: a disabled, failed, or unreadable answer comes back without a
 * role and the caller keeps the suggestion the table built. This is the second evaluator rather than more
 * questions on the veto's request, so the veto state and wording — which were measured to ship as they are —
 * stay byte-identical.
 */
export async function consultSuggestionRole(
    options: SuggestionConsultOptions,
): Promise<SuggestionConsult> {
    if (!suggestionEnabled(options.config)) {
        return { status: "disabled", latencyMs: 0 };
    }

    try {
        return await suggestionEvaluatorFor(options).evaluate({
            command: options.command,
            cwd: options.ctx.cwd ?? process.cwd(),
            ...(options.recentCommands === undefined
                ? {}
                : { recentCommands: options.recentCommands }),
        });
    } catch (error) {
        return { status: "error", latencyMs: 0 };
    }
}

/** What it takes to get the shared evaluator: the settings it is keyed by and where the model resolves from. */
export interface EvaluatorSeed {
    ctx: ExtensionContext;
    config: DecisionModelConfig;
    /** Whether sandboxed execution is available right now; `sandbox` abstains without it. */
    sandboxAvailable: boolean;
    /**
     * The registry the classifier resolves from (default `ctx.modelRegistry`).
     *
     * A child gate passes its parent's: pi's registry is process-wide, and the parent is where the configured
     * provider was registered.
     */
    registry?: ClassifierRegistry;
}

/** Drop the shared evaluators and their caches, so tests do not inherit a cooldown or a cached answer earned by another. */
export function resetDecisionEvaluator(): void {
    cachedEvaluator = undefined;
    cachedSuggestionEvaluator = undefined;
    cachedReminderEvaluator = undefined;
}

export interface ConsultOptions extends EvaluatorSeed {
    command: string;
    /** Who is running the command, when that is not the parent (default `parent`). */
    runner?: DecisionRunner;
    /** Where a mutating runner's working copy is (default `checkout`). */
    isolation?: DecisionIsolation;
    /** The runner's real authority rung, when the runner name would overstate it. */
    authority?: DecisionAuthority;
}

/**
 * Ask the model about one command.
 *
 * Never rejects: a failure comes back as an abstaining verdict, because a permission prompt must still appear
 * when the endpoint is unreachable. The catch covers context building as well as the request — reading the
 * session can fail too, and the hook that calls this has no error handling of its own by design.
 */
export async function consultDecisionModel(options: ConsultOptions): Promise<DecisionVerdict> {
    const consulted = await consultDecisionContext(options);
    return consulted.verdict;
}

/**
 * Judge one direct file access.
 *
 * The same never-reject contract as `consultDecisionModel`, and the same evaluator machinery: caches,
 * cooldown, timeout, and one policy. `sandboxAvailable` is reported as absent rather than looked up, because
 * a file access has no sandboxed form — the subject's table maps every withheld criterion to `refuse`, so
 * nothing can ask for a sandbox, and passing `false` means a future row that *did* map to `sandbox` would
 * abstain to the human instead of pretending the access was contained.
 */
export async function consultFileAccessDecision(
    options: FileConsultOptions,
): Promise<DecisionVerdict> {
    try {
        const context = fileDecisionContextFor(options.ctx, options.file, {
            runner: options.runner,
            isolation: options.isolation,
        });
        const evaluator = evaluatorFor({
            ctx: options.ctx,
            config: options.config,
            sandboxAvailable: false,
            ...(options.registry === undefined ? {} : { registry: options.registry }),
        });
        return await evaluator.evaluateFileAccess(context);
    } catch (error) {
        return {
            outcome: "abstain",
            status: "error",
            reason: `decision model failed: ${messageOf(error)}`,
            answers: {},
            latencyMs: 0,
        };
    }
}

export interface FileConsultOptions {
    ctx: ExtensionContext;
    config: DecisionModelConfig;
    /** The access, already resolved by the gate that is asking. */
    file: FileDecisionSubject;
    /** Who is asking, when that is not the parent (default `parent`). */
    runner?: DecisionRunner;
    /** Where a mutating runner's working copy is (default `checkout`). */
    isolation?: DecisionIsolation;
    /** The registry the classifier resolves from (default `ctx.modelRegistry`). */
    registry?: ClassifierRegistry;
}

/** What one consult observed: the verdict, and the context it judged when one could be built. */
export interface DecisionConsultation {
    verdict: DecisionVerdict;
    /** Absent when context building failed; the caller then has no script fact either. */
    context?: DecisionContext;
}

/**
 * The same consult as `consultDecisionModel`, keeping the built context for the caller.
 *
 * The permission bridge needs the context to summarize the script it sent in the decision log, and it must
 * not build the context itself or a failure there would escape the gate.
 */
export async function consultDecisionContext(
    options: ConsultOptions,
): Promise<DecisionConsultation> {
    try {
        const built = decisionContextFor(options.ctx, options.command, {
            runner: options.runner,
            isolation: options.isolation,
            ...(options.authority === undefined ? {} : { authority: options.authority }),
        });
        const workspace = await workspaceStatusFor(built.cwd);
        const context = workspace === undefined ? built : { ...built, workspace };
        return { verdict: await evaluatorFor(options).evaluate(context), context };
    } catch (error) {
        return {
            verdict: {
                outcome: "abstain",
                status: "error",
                reason: `decision model failed: ${messageOf(error)}`,
                answers: {},
                latencyMs: 0,
            },
        };
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
