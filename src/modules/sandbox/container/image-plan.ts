import { containerBaseImage, containerImage, containerImageOverride } from "./config";
import {
    RECIPE_NODE_PATH,
    effectiveContainerfile,
    findRecipe,
    findUnsupportedBase,
    recipeHash,
    sandboxImageTag,
    type SandboxRecipe,
} from "./recipe";
import { containerStatePaths } from "./state";

/**
 * What image this session should run, decided without touching podman.
 *
 * Splitting the decision from the podman calls keeps the interesting part — precedence, hashing, and the
 * paths a recipe produces — unit-testable, and leaves the command and the session start with nothing to
 * do but follow the plan.
 *
 * Precedence is deliberate:
 *
 * 1. `PI_SANDBOX_IMAGE`, because an explicit image is how a user works around a recipe that will not build.
 * 2. A recipe, because it is the provisioning path this feature exists for.
 * 3. The default image, unchanged, so a checkout without a recipe behaves exactly as before.
 */

export type ImagePlan =
    | { kind: "explicit"; image: string; nodePath: string }
    | { kind: "default"; image: string; nodePath: string }
    | {
          kind: "recipe";
          recipe: SandboxRecipe;
          image: string;
          /** The dispatcher runtime the prologue installs, rather than the image's own `node`. */
          nodePath: string;
          effectiveText: string;
          /** Where the generated Containerfile is written, so `podman build --file` can read it. */
          containerfilePath: string;
          contextDir: string;
          hash: string;
      }
    | { kind: "unsupported"; reason: string };

export interface PlanSandboxImageOptions {
    projectDir: string;
    homeDir?: string;
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
}

/** The image a session runs, and the Node binary the dispatcher runs from inside it. */
export interface SessionImage {
    image: string;
    nodePath: string;
}

export type SessionImageDecision = ({ ok: true } & SessionImage) | { ok: false; reason: string };

/**
 * Turn a plan into the image a session should run, given whether that image is already built.
 *
 * A recipe whose image is missing is **an error, not a fallback**. Falling back to the default image was
 * tried and is worse in practice: the session starts, every command runs in a bare image, and the agent sees
 * failures that look like product bugs — `spawn git ENOENT`, no `rg`, no `ps` — instead of one actionable
 * message. The tag is content-addressed, so a missing image is always a "build me" state, never a runtime
 * condition to absorb.
 */
export function decideSessionImage(plan: ImagePlan, imageExists: boolean): SessionImageDecision {
    if (plan.kind === "unsupported") {
        return { ok: false, reason: plan.reason };
    }

    if (plan.kind !== "recipe") {
        return { ok: true, image: plan.image, nodePath: plan.nodePath };
    }

    if (!imageExists) {
        return {
            ok: false,
            reason:
                `sandbox image ${plan.image} is not built (recipe: ${plan.recipe.path}); ` +
                `run /sandbox build, or set PI_SANDBOX_IMAGE to use an image you already have`,
        };
    }

    return { ok: true, image: plan.image, nodePath: plan.nodePath };
}

export function planSandboxImage(options: PlanSandboxImageOptions): ImagePlan {
    const env = options.env ?? process.env;
    const override = containerImageOverride(env);

    if (override !== undefined) {
        return { kind: "explicit", image: override, nodePath: "node" };
    }

    const recipe = findRecipe(options.projectDir, options.homeDir);

    if (recipe === undefined) {
        return { kind: "default", image: containerImage(env), nodePath: "node" };
    }

    const unsupported = findUnsupportedBase(recipe.text);

    if (unsupported !== undefined) {
        return { kind: "unsupported", reason: `${recipe.path}: ${unsupported}` };
    }

    const baseImage = containerBaseImage(env);
    const effectiveText = effectiveContainerfile(recipe, baseImage);
    const hash = recipeHash(effectiveText, baseImage);

    return {
        kind: "recipe",
        recipe,
        image: sandboxImageTag(hash),
        nodePath: RECIPE_NODE_PATH,
        effectiveText,
        containerfilePath: containerStatePaths(options.stateDir).containerfile,
        contextDir: recipe.contextDir,
        hash,
    };
}
