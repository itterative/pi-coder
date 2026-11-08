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
 * Three consequences shape this module:
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
 * - **Commands and skills type `node`, not an absolute path.** The dispatcher knows to run `/opt/pi/node`,
 *   but a skill's script says `node scripts/…`, so a non-Node base breaks it. The prologue therefore
 *   registers the runtime as the distribution's `node` alternative — only when the base has no `node` on
 *   `PATH`, so a project that pins its own Node is never shadowed by the injected runtime.
 */

/** Project-local recipe location, relative to the checkout root. */
export const RECIPE_RELATIVE_PATH = path.join(".pi", "Containerfile");

/** The in-image path the prologue installs the dispatcher runtime at. */
export const RECIPE_NODE_PATH = "/opt/pi/node";

/**
 * Where the prologue puts the `node` command it registers when the base image has none.
 *
 * `/usr/local/bin` precedes `/usr/bin` in the default `PATH` on every supported base, so the link is
 * found without touching a distribution-owned directory. It stays a single managed link: the alternatives
 * entry is what makes the runtime visible to `update-alternatives --display node` instead of hiding it.
 */
const NODE_LINK_PATH = "/usr/local/bin/node";

/**
 * Priority of that alternatives entry.
 *
 * Only used when nothing else provides `node`, so it must merely be high enough to be selected if the
 * base happens to have a candidate registered without a link on `PATH`.
 */
const NODE_LINK_PRIORITY = 100;

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
        `# Commands and skills call \`node\`, and a non-Node base has none. Register the runtime the`,
        `# dispatcher already uses as the distribution's \`node\` alternative; a base that ships \`node\``,
        `# on PATH is left alone, so a pinned toolchain is never shadowed by the injected runtime.`,
        `RUN if ! command -v node >/dev/null 2>&1; then \\`,
        `      mkdir -p ${path.dirname(NODE_LINK_PATH)} && \\`,
        `      if command -v update-alternatives >/dev/null 2>&1; then \\`,
        `        update-alternatives --install ${NODE_LINK_PATH} node ${RECIPE_NODE_PATH} ${NODE_LINK_PRIORITY} || \\`,
        `          ln -sf ${RECIPE_NODE_PATH} ${NODE_LINK_PATH}; \\`,
        `      elif command -v alternatives >/dev/null 2>&1; then \\`,
        `        alternatives --install ${NODE_LINK_PATH} node ${RECIPE_NODE_PATH} ${NODE_LINK_PRIORITY} || \\`,
        `          ln -sf ${RECIPE_NODE_PATH} ${NODE_LINK_PATH}; \\`,
        `      else \\`,
        `        ln -sf ${RECIPE_NODE_PATH} ${NODE_LINK_PATH}; \\`,
        `      fi; \\`,
        `    fi`,
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
