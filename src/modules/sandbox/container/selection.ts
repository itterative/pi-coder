import type { SandboxBackendChoice, SandboxConfig } from "../../../common/config";
import { checkContainerHost } from "./config";
import { createPodmanImageRunner } from "./image";
import { planSandboxImage } from "./image-plan";

/**
 * Which backend confines a session, decided from configuration and readiness rather than from the environment.
 *
 * The environment used to be the whole answer (`PI_SANDBOX_BACKEND=container`), which made the backend a
 * deliberate act an expert performs before starting pi. Now the answer has three layers:
 *
 * 1. `PI_SANDBOX_BACKEND` — an override, kept for tests and CI where a prompt cannot appear.
 * 2. `sandbox.backend` in the config — what the user answered to the first prompt, or `/sandbox backend`.
 * 3. `auto`, which asks: ready image → container, recipe but no image → offer to build, otherwise bubblewrap.
 *
 * Everything here is a pure decision over data except the readiness probe, so the interesting part — the
 * state machine a user experiences — is testable without podman, a build, or a TTY.
 */

export interface BackendSelection {
    choice: SandboxBackendChoice;
    /** Why the selection is what it is, so `/sandbox status` can say where the answer came from. */
    source: "env" | "config" | "default";
}

const BACKEND_ENV = "PI_SANDBOX_BACKEND";

/**
 * Parse the switch. Unrecognized values fall through to the next layer instead of forcing an error: an
 * environment variable is the least reliable input here, and a typo must not decide how commands run.
 */
export function parseBackendChoice(value: string | undefined): SandboxBackendChoice | undefined {
    const normalized = (value ?? "").trim().toLowerCase();

    if (normalized === "auto" || normalized === "container" || normalized === "bwrap") {
        return normalized;
    }

    return undefined;
}

export function selectBackend(
    config: SandboxConfig | null,
    env: NodeJS.ProcessEnv = process.env,
): BackendSelection {
    const fromEnv = parseBackendChoice(env[BACKEND_ENV]);

    if (fromEnv !== undefined) {
        return { choice: fromEnv, source: "env" };
    }

    const fromConfig = config?.sandbox.backend;

    if (fromConfig !== undefined) {
        return { choice: fromConfig, source: "config" };
    }

    return { choice: "auto", source: "default" };
}

/**
 * What this host and this checkout can actually do, independent of what the user asked for.
 *
 * `needs-build` is not a failure: the tag is content-addressed, so it means "the recipe on disk has never
 * been built", which is exactly the state a prompt should resolve. `no-recipe` is likewise not an error — a
 * repository without a Containerfile simply has nothing to containerize, and silently pulling the default
 * image on first use would be a surprise download rather than a feature.
 */
export type ContainerReadiness =
    | { state: "ready"; image: string }
    | { state: "needs-build"; image: string; recipePath: string }
    | { state: "unavailable"; reason: string }
    | { state: "unsupported"; reason: string }
    | { state: "no-recipe" };

export interface ReadinessDependencies {
    projectDir: string;
    homeDir?: string;
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
    /** Injected by tests; the real check asks for podman and refuses to run inside another user namespace. */
    host?: () => Promise<{ ok: true; podmanPath: string } | { ok: false; reason: string }>;
    /** Injected by tests so no suite needs podman storage. */
    imageExists?: (podmanPath: string, image: string) => Promise<boolean>;
}

export async function inspectContainerReadiness(
    dependencies: ReadinessDependencies,
): Promise<ContainerReadiness> {
    const plan = planSandboxImage({
        projectDir: dependencies.projectDir,
        homeDir: dependencies.homeDir,
        stateDir: dependencies.stateDir,
        env: dependencies.env,
    });

    if (plan.kind === "unsupported") {
        return { state: "unsupported", reason: plan.reason };
    }

    if (plan.kind === "default") {
        return { state: "no-recipe" };
    }

    // An explicitly named image is never "needs a build": podman either has it or pulls it, and the user asked
    // for that tag by name.
    if (plan.kind === "explicit") {
        return { state: "ready", image: plan.image };
    }

    const host = await (dependencies.host ?? checkContainerHost)();

    if (!host.ok) {
        return { state: "unavailable", reason: host.reason };
    }

    const exists = await (dependencies.imageExists ?? defaultImageExists)(
        host.podmanPath,
        plan.image,
    );

    if (!exists) {
        return { state: "needs-build", image: plan.image, recipePath: plan.recipe.path };
    }

    return { state: "ready", image: plan.image };
}

async function defaultImageExists(podmanPath: string, image: string): Promise<boolean> {
    return createPodmanImageRunner(podmanPath).exists(image);
}

/**
 * The action a session start should take, which is the whole point of the two functions above.
 *
 * `ask` is returned only when a prompt can be shown and the answer is not already settled by config, so a
 * child runtime, a `pi -p` run, or a CI job never blocks on a dialog that cannot appear.
 */
export type SessionBackendPlan =
    | { kind: "container"; image: string }
    | { kind: "ask"; image: string; recipePath: string }
    | { kind: "bwrap"; reason?: string };

export function planSessionBackend(options: {
    selection: BackendSelection;
    readiness: ContainerReadiness;
    /** Whether a dialog can be shown at all. */
    interactive: boolean;
    /** The tag the user already declined; the same recipe state does not ask twice. */
    declinedTag?: string;
}): SessionBackendPlan {
    const { selection, readiness, interactive } = options;

    if (selection.choice === "bwrap") {
        return { kind: "bwrap" };
    }

    if (readiness.state === "ready") {
        return { kind: "container", image: readiness.image };
    }

    if (readiness.state === "unavailable" || readiness.state === "unsupported") {
        return { kind: "bwrap", reason: readiness.reason };
    }

    // `no-recipe`: nothing to build, and the default image is not something to containerize unasked.
    if (readiness.state === "no-recipe") {
        return { kind: "bwrap" };
    }

    const declined = options.declinedTag === readiness.image;

    if (!interactive || declined) {
        // A settled "container" answer still gets a reason, because silently using bubblewrap would look
        // like the setting was ignored.
        return {
            kind: "bwrap",
            reason: declined
                ? undefined
                : `the sandbox image for ${readiness.recipePath} has not been built yet`,
        };
    }

    return { kind: "ask", image: readiness.image, recipePath: readiness.recipePath };
}
