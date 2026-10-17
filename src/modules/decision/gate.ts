import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DecisionEvaluator } from "./evaluator";
import { readScriptFile, resolveScriptRun, scriptFileIdentity } from "./script";
import { decisionSessionContext } from "./session-context";
import { workspaceStatusFor } from "./workspace";
import type { ClassifierRegistry } from "./model";
import type { DecisionIsolation, DecisionRunner } from "./runner-rules";
import type {
    DecisionContext,
    DecisionModelConfig,
    DecisionSurface,
    DecisionVerdict,
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

let cachedEvaluator: { key: string; evaluator: DecisionEvaluator } | undefined;

/** Whether this surface may consult the model at all. */
export function decisionEnabled(config: DecisionModelConfig, surface: DecisionSurface): boolean {
    if (config.enabled !== true) {
        return false;
    }

    return (config.surfaces ?? DEFAULT_SURFACES).includes(surface);
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
function evaluatorFor(options: ConsultOptions): DecisionEvaluator {
    const key = JSON.stringify([options.config, options.sandboxAvailable]);
    if (cachedEvaluator?.key === key) {
        return cachedEvaluator.evaluator;
    }

    const evaluator = new DecisionEvaluator({
        registry: options.registry ?? options.ctx.modelRegistry,
        config: options.config,
        sandboxAvailable: options.sandboxAvailable,
    });
    cachedEvaluator = { key, evaluator };
    return evaluator;
}

/** Drop the shared evaluator and its verdict and rejection caches, so tests do not inherit a cooldown or a cached answer earned by another. */
export function resetDecisionEvaluator(): void {
    cachedEvaluator = undefined;
}

export interface ConsultOptions {
    ctx: ExtensionContext;
    config: DecisionModelConfig;
    command: string;
    /** Whether sandboxed execution is available right now; `sandbox` abstains without it. */
    sandboxAvailable: boolean;
    /** Who is running the command, when that is not the parent (default `parent`). */
    runner?: DecisionRunner;
    /** Where a mutating runner's working copy is (default `checkout`). */
    isolation?: DecisionIsolation;
    /**
     * The registry the classifier resolves from (default `ctx.modelRegistry`).
     *
     * A child gate passes its parent's: pi's registry is process-wide, and the parent is where the configured
     * provider was registered.
     */
    registry?: ClassifierRegistry;
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
