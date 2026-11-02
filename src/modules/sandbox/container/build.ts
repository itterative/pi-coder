import { checkContainerHost } from "./config";
import { createPodmanImageRunner, createPodmanImageStore, ensureSandboxImage } from "./image";
import type { ImagePlan } from "./image-plan";

/**
 * Building the recipe's image, in the one place both callers agree on.
 *
 * Two flows need it: the `/sandbox build` command, and the session-start prompt that offers the build. They
 * share the host check, the tag, and the generated Containerfile, so a build that works from one cannot
 * silently differ from a build that works from the other. They also share the retention pass, which is why a
 * rebuild from either flow leaves the same number of images behind.
 */

export type RecipePlan = Extract<ImagePlan, { kind: "recipe" }>;

export interface BuildRecipeImageResult {
    /** `present` when the tag was already built, so nothing was built and nothing was pruned. */
    outcome: "present" | "built";
    elapsedMs: number;
    /** Older recipe images removed after the build, newest first by reference. */
    pruned: readonly string[];
    /** Set when housekeeping failed; the build itself succeeded. */
    pruneError?: string;
}

export async function buildRecipeImage(plan: RecipePlan): Promise<BuildRecipeImageResult> {
    const host = await checkContainerHost();

    if (!host.ok) {
        throw new Error(host.reason);
    }

    const started = Date.now();
    const result = await ensureSandboxImage({
        runner: createPodmanImageRunner(host.podmanPath),
        store: createPodmanImageStore(host.podmanPath),
        imageTag: plan.image,
        containerfileText: plan.effectiveText,
        containerfilePath: plan.containerfilePath,
        contextDir: plan.contextDir,
    });

    return {
        outcome: result.outcome,
        elapsedMs: Date.now() - started,
        pruned: result.pruned,
        pruneError: result.pruneError,
    };
}
