import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The sandbox image as a *recipe* rather than a live container that was mutated until it worked.
 *
 * A `Containerfile` is the only provisioning path on purpose. It is text, so the agent's proposal is a
 * diff a human can read and `git` can track; it is reproducible, so a second machine gets the same image;
 * and it is cached by layer, so adding one `RUN` rebuilds in about a second. The alternative — run
 * `apt-get` inside a session and commit the result — produces an opaque layer nobody reviews, which is
 * the same failure mode as trusting a mutated `.git`.
 *
 * Two consequences shape this module:
 *
 * - **The dispatcher needs a Node runtime, and a user's base image probably has none.** Rather than
 *   forcing `FROM node:*` on every recipe, the effective Containerfile prepends a stage that copies
 *   `node` out of a Node image into `/opt/pi/node`. The dispatcher is stdlib-only, so the binary alone is
 *   enough, and the recipe stays free-form. The copy is appended *after* the user's body so that a later
 *   `apt-get remove` in the recipe cannot take the dispatcher with it.
 * - **The copy must be verified at build time, not at session start.** A glibc-linked Node in a musl
 *   (Alpine) base fails with `Exec format error` at startup, which reads like a pi-coder bug. A trailing
 *   `RUN /opt/pi/node --version` turns that into a failed build naming the real cause, and Alpine bases
 *   are rejected before podman is even invoked.
 */

/** Project-local recipe location, relative to the checkout root. */
export const RECIPE_RELATIVE_PATH = path.join(".pi", "Containerfile");

/** The in-image path the prologue installs the dispatcher runtime at. */
export const RECIPE_NODE_PATH = "/opt/pi/node";

/**
 * Name prefix for images built from a recipe; the tag carries the recipe hash.
 *
 * `localhost/` is not decoration. An unqualified name is a *short name*: when the exact tag is missing from
 * local storage, podman resolves it against the search registries and either prompts (failing with "cannot
 * prompt without a TTY") or, with permissive short-name mode, pulls whatever that registry serves. A
 * sandbox image must never be fetched from a registry on a guess, and the recipe hash is derived from
 * public text, so the name is not a secret. Qualifying it makes an unbuilt image a clean "not found".
 */
const IMAGE_TAG_PREFIX = "localhost/pi-coder-sandbox";

/**
 * The `name:tag` prefix every recipe image shares, so housekeeping can select only those images.
 *
 * Exported because a retention pass has to answer "is this image mine?" from a `podman images` listing, and
 * duplicating the string is how a prune quietly starts looking at images it must not touch.
 */
export const SANDBOX_IMAGE_PREFIX = `${IMAGE_TAG_PREFIX}:`;

/** Name of the stage the prologue copies `node` out of. */
const RUNTIME_STAGE = "pi-dispatcher-node";

type RecipeSource = "project" | "global";

export interface SandboxRecipe {
    /** Absolute path to the Containerfile that was found. */
    path: string;
    /** Absolute directory used as the build context, so a recipe may `COPY` its own sibling files. */
    contextDir: string;
    text: string;
    source: RecipeSource;
}

/**
 * Locate the recipe: the project's, then the user's global one.
 *
 * A missing recipe is not an error: without one, the configured default image is used exactly as before,
 * so adding this feature cannot break an existing session.
 */
export function findRecipe(
    projectDir: string,
    homeDir: string = os.homedir(),
): SandboxRecipe | undefined {
    const candidates: readonly { path: string; source: RecipeSource }[] = [
        { path: path.join(projectDir, RECIPE_RELATIVE_PATH), source: "project" },
        { path: path.join(homeDir, RECIPE_RELATIVE_PATH), source: "global" },
    ];

    for (const candidate of candidates) {
        let text: string;

        try {
            text = fs.readFileSync(candidate.path, "utf8");
        } catch {
            continue;
        }

        return {
            path: candidate.path,
            contextDir: path.dirname(candidate.path),
            text: normalizeRecipe(text),
            source: candidate.source,
        };
    }

    return undefined;
}

/** Recipes are hashed byte-identically, so a trailing-newline edit must not invalidate the cache. */
function normalizeRecipe(text: string): string {
    return `${text.trimEnd()}\n`;
}

/**
 * The recipe that podman actually builds: the user's text, with a dispatcher runtime injected after it.
 *
 * The appended lines run in the *final* stage of the user's Containerfile, which is also what podman
 * treats as the resulting image — so a multi-stage recipe must end on the stage it wants to hand over.
 */
export function effectiveContainerfile(recipe: SandboxRecipe, baseImage: string): string {
    return [
        `# Generated by pi-coder from ${recipe.path}`,
        `# The first and last lines are appended; everything between them is the recipe verbatim.`,
        `FROM ${baseImage} AS ${RUNTIME_STAGE}`,
        "",
        recipe.text.trimEnd(),
        "",
        `# The dispatcher is a Node program with no dependencies, so the binary alone is enough.`,
        `COPY --from=${RUNTIME_STAGE} /usr/local/bin/node ${RECIPE_NODE_PATH}`,
        `# Fail the build, not the session, when the base cannot run that binary (e.g. a musl base).`,
        `RUN ${RECIPE_NODE_PATH} --version`,
        "",
    ].join("\n");
}

/**
 * Reject bases the injected runtime cannot run in, with an explanation rather than podman's error.
 *
 * This is a best-effort scan of `FROM` lines: it catches the common `FROM alpine` case, and the
 * build-time `RUN /opt/pi/node --version` catches everything else.
 */
export function findUnsupportedBase(text: string): string | undefined {
    for (const line of text.split("\n")) {
        const match = /^\s*FROM\s+(?<image>\S+)/i.exec(line);

        if (match?.groups?.image === undefined) {
            continue;
        }

        const image = match.groups.image.toLowerCase();

        if (image.includes("alpine") || image.includes("musl")) {
            return (
                `the sandbox dispatcher needs a glibc base image, and ${image} is musl-based; ` +
                `use a Debian/Ubuntu/Fedora base, or install a static Node yourself and set ` +
                `PI_SANDBOX_IMAGE`
            );
        }
    }

    return undefined;
}

/**
 * Content hash of everything that determines the image: the effective Containerfile and the base image
 * the prologue copies from. Twelve hex characters, which is ample for a per-machine tag and readable
 * inside `podman images`.
 */
export function recipeHash(effectiveText: string, baseImage: string): string {
    return createHash("sha256")
        .update(baseImage)
        .update("\0")
        .update(effectiveText)
        .digest("hex")
        .slice(0, 12);
}

/** Tag for an image built from a recipe hash. */
export function sandboxImageTag(hash: string): string {
    return `${SANDBOX_IMAGE_PREFIX}${hash}`;
}
