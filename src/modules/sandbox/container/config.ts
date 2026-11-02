import fs from "node:fs";

/**
 * The preconditions a container backend needs on this host, and the environment knobs that override its image.
 *
 * Which backend runs is no longer an environment variable: it is `sandbox.backend` in the config, resolved per
 * session, with a prompt for the one state a user cannot be expected to know about (a recipe with no image).
 * `PI_SANDBOX_BACKEND` is still read by `selectBackend` as an override — that is what keeps tests and CI
 * hermetic — and the image variables here remain the escape hatch for a recipe that will not build.
 *
 * `lookpath` is imported lazily inside the one function that needs it. It is a CommonJS module whose
 * `require` cannot be inlined by a bundler, so a static import would make this module unusable from any
 * bundled context — including `scripts/scratch.ts` — even though every other export here is pure.
 */

const CONTAINER_IMAGE_ENV = "PI_SANDBOX_IMAGE";
const CONTAINER_BASE_IMAGE_ENV = "PI_SANDBOX_BASE_IMAGE";
const CONTAINER_SHELL_ENV = "PI_SANDBOX_SHELL";

/**
 * A Node image by default, because the dispatcher is a Node program. Any image with a Node 20+ binary works;
 * the shell inside is whatever the image provides (bash preferred, sh otherwise).
 *
 * Debian 13 (trixie) rather than 12 (bookworm) on purpose: its glibc is 2.41, and this repository's vendored
 * `sqlite3` native binary requires glibc >= 2.38. On a bookworm base the test suite cannot even load — the
 * failure surfaces as `version 'GLIBC_2.38' not found`, which reads like a broken sandbox rather than an
 * image that is too old. Trixie also carries Node 24, matching the host toolchain, so the dispatcher runtime
 * and the commands it runs are the same version.
 */
export const DEFAULT_CONTAINER_IMAGE = "node:24-trixie-slim";

export type ContainerHostCheck = { ok: true; podmanPath: string } | { ok: false; reason: string };

export function containerImage(env: NodeJS.ProcessEnv = process.env): string {
    const configured = (env[CONTAINER_IMAGE_ENV] ?? "").trim();

    return configured.length > 0 ? configured : DEFAULT_CONTAINER_IMAGE;
}

/**
 * The image a recipe's dispatcher runtime is copied out of. Only used when a recipe exists: the copy is
 * what frees a recipe from having to start `FROM node:*`.
 */
export function containerBaseImage(env: NodeJS.ProcessEnv = process.env): string {
    const configured = (env[CONTAINER_BASE_IMAGE_ENV] ?? "").trim();

    return configured.length > 0 ? configured : DEFAULT_CONTAINER_IMAGE;
}

/**
 * Whether the image was named explicitly, which takes precedence over any recipe: the escape hatch for
 * trying an image out, or for working around a recipe that will not build.
 */
export function containerImageOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const configured = (env[CONTAINER_IMAGE_ENV] ?? "").trim();

    return configured.length > 0 ? configured : undefined;
}

export function containerShell(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const configured = (env[CONTAINER_SHELL_ENV] ?? "").trim();

    return configured.length > 0 ? configured : undefined;
}

/**
 * Whether a rootless container can be started from this process.
 *
 * Running podman from inside `bwrap` does not merely fail: it corrupts the rootless pause process, and every
 * later podman invocation needs `podman system migrate` to recover. So the guard is a hard refusal, checked
 * before the first spawn, rather than a retry.
 */
export async function checkContainerHost(): Promise<ContainerHostCheck> {
    if (process.platform !== "linux") {
        return {
            ok: false,
            reason: `container sandboxing needs Linux; this is ${process.platform}`,
        };
    }

    if (!hasFullIdentityMapping(readUidMap())) {
        return {
            ok: false,
            reason:
                "container sandboxing cannot start podman from inside another user namespace (bwrap); " +
                "run pi without the wrapping sandbox",
        };
    }

    const { lookpath } = await import("lookpath");
    const podmanPath = await lookpath("podman");

    if (!podmanPath) {
        return { ok: false, reason: "container sandboxing needs podman on PATH" };
    }

    return { ok: true, podmanPath };
}

/** `/proc/self/uid_map` reads `0 0 4294967295` only when this process sees the full host user namespace. */
export function hasFullIdentityMapping(uidMap: string): boolean {
    const fields = uidMap.trim().split(/\s+/);

    return (
        fields.length === 3 && fields[0] === "0" && fields[1] === "0" && fields[2] === "4294967295"
    );
}

function readUidMap(): string {
    try {
        return fs.readFileSync("/proc/self/uid_map", "utf8");
    } catch {
        // No procfs: nothing to check, and the spawn will report the real problem.
        return "0 0 4294967295";
    }
}
