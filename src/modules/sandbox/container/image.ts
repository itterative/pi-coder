import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { KEEP_SANDBOX_IMAGES, normalizeImageId, pruneSandboxImages } from "./image-retention";
import fs from "node:fs";
import path from "node:path";

import { SANDBOX_IMAGE_PREFIX } from "./recipe";

/**
 * Building the sandbox image from its recipe.
 *
 * The podman invocation is injectable for the same reason the session client's is: the argv, the
 * cache-hit decision, and the failure message are all testable without podman, and only the one line
 * where a real podman exists is left to hands-on verification.
 *
 * A build is host code execution — `RUN curl … | sh` in a recipe runs as the user — so nothing here
 * decides *whether* to build. That decision belongs to the caller, which asks a human first.
 */

/** Injectable launch, so tests can answer as podman would. */
export type ImageLaunch = (command: string, args: readonly string[]) => ChildProcess;

interface ImageBuildRequest {
    imageTag: string;
    /** The generated Containerfile, already written to disk: podman needs a file or a pipe. */
    containerfilePath: string;
    /** Build context, so a recipe may `COPY` files next to itself. */
    contextDir: string;
    onOutput?: (chunk: string) => void;
    signal?: AbortSignal;
}

export interface ImageRunner {
    /** Whether a tagged image is already in local storage; an absent image is the only reason to build. */
    exists(imageTag: string): Promise<boolean>;

    build(request: ImageBuildRequest): Promise<void>;
}

export type EnsureOutcome = "present" | "built";

/** One image in local storage, in the shape a retention pass decides from. */
export interface SandboxImageRecord {
    /** As podman prints it in a table listing, i.e. a short prefix; `image rm` accepts that form. */
    id: string;
    /** `repository:tag`, because a removal is reported to a human by name rather than by hash. */
    reference: string;
    /** Podman's creation stamp, used only to decide "newest". */
    created: string;
}

/**
 * The podman reads and the one removal that housekeeping needs.
 *
 * Deliberately not folded into `ImageRunner`: building and retention share no decision, and one interface
 * would make every build double answer questions about image lists it never asks.
 */
export interface ImageStore {
    /** Only sandbox images, so a retention pass can never name an unrelated image to `rmi`. */
    listSandboxImages(): Promise<SandboxImageRecord[]>;
    /** Image IDs referenced by any container, running or stopped: what a pass must never remove. */
    containersInUse(): Promise<string[]>;
    removeImages(ids: readonly string[]): Promise<void>;
}

export interface EnsureSandboxImageResult {
    outcome: EnsureOutcome;
    /** References the retention pass removed, for the message a human reads. */
    pruned: readonly string[];
    /** Set when the retention pass failed; the image itself is built and usable. */
    pruneError?: string;
}

export interface EnsureSandboxImageOptions {
    runner: ImageRunner;
    imageTag: string;
    /** Effective Containerfile text, i.e. the recipe plus the dispatcher prologue. */
    containerfileText: string;
    /** Where to write that text; podman reads it with `--file`. */
    containerfilePath: string;
    contextDir: string;
    onOutput?: (chunk: string) => void;
    signal?: AbortSignal;
    /**
     * Retention runs after a successful build. Absent means "keep every image", which is what a build test
     * wants, and what a caller that manages images itself would pass.
     */
    store?: ImageStore;
    /** How many recipe images to keep; defaults to {@link KEEP_SANDBOX_IMAGES}. */
    keep?: number;
}

/** Enough context to see the failing step, not so much that a TUI notification becomes a wall. */
const MAX_ERROR_LINES = 20;

export class ImageBuildError extends Error {
    constructor(
        message: string,
        readonly exitCode: number | null,
    ) {
        super(message);
        this.name = "ImageBuildError";
    }
}

export function createPodmanImageRunner(
    podmanPath: string,
    spawn: ImageLaunch = defaultLaunch,
): ImageRunner {
    return {
        async exists(imageTag) {
            const result = await runToEnd(spawn, podmanPath, ["image", "exists", imageTag]);

            if (result.exitCode === 0) {
                return true;
            }

            if (result.exitCode === 1) {
                return false;
            }

            throw new ImageBuildError(
                `podman image exists failed (${describeCode(result.exitCode)}): ${tailError(result.output)}`,
                result.exitCode,
            );
        },

        async build(request) {
            const args = [
                "build",
                "--tag",
                request.imageTag,
                "--file",
                request.containerfilePath,
                request.contextDir,
            ];

            const result = await runToEnd(spawn, podmanPath, args, {
                onOutput: request.onOutput,
                signal: request.signal,
            });

            if (result.exitCode === 0) {
                return;
            }

            throw new ImageBuildError(
                `podman build failed (${describeCode(result.exitCode)}): ${tailError(result.output)}`,
                result.exitCode,
            );
        },
    };
}

/**
 * The podman side of retention: list what belongs to this feature, find what is pinned, remove the rest.
 *
 * Two calls answer "which images, and how new": a table listing has the references but only a short ID and a
 * relative age, so creation stamps come from `image inspect` by ID in one invocation. Removal takes IDs, not
 * tags, so a tag that moved between the listing and the removal cannot redirect the `rmi`.
 */
export function createPodmanImageStore(
    podmanPath: string,
    spawn: ImageLaunch = defaultLaunch,
): ImageStore {
    return {
        async listSandboxImages() {
            const listed = await runToEnd(spawn, podmanPath, [
                "images",
                "--format",
                "{{.ID}} {{.Repository}}:{{.Tag}}",
            ]);

            if (listed.exitCode !== 0) {
                throw new ImageBuildError(
                    `podman images failed (${describeCode(listed.exitCode)}): ${tailError(listed.output)}`,
                    listed.exitCode,
                );
            }

            const entries = parseSandboxImageEntries(listed.output);

            if (entries.length === 0) {
                return [];
            }

            const inspected = await runToEnd(spawn, podmanPath, [
                "image",
                "inspect",
                "--format",
                "{{.Id}} {{.Created}}",
                ...entries.map((entry) => entry.id),
            ]);

            if (inspected.exitCode !== 0) {
                throw new ImageBuildError(
                    `podman image inspect failed (${describeCode(inspected.exitCode)}): ` +
                        tailError(inspected.output),
                    inspected.exitCode,
                );
            }

            return parseImageRecords(inspected.output, entries);
        },

        async containersInUse() {
            const listed = await runToEnd(spawn, podmanPath, ["ps", "--all", "--quiet"]);

            if (listed.exitCode !== 0) {
                throw new ImageBuildError(
                    `podman ps failed (${describeCode(listed.exitCode)}): ${tailError(listed.output)}`,
                    listed.exitCode,
                );
            }

            const containers = nonEmptyLines(listed.output);

            if (containers.length === 0) {
                return [];
            }

            // `ps -a`, not `ps`: a stopped session's container still owns its image, and removing that image
            // would break `podman start` on a container the user may come back to.
            const inspected = await runToEnd(spawn, podmanPath, [
                "inspect",
                "--format",
                "{{.Image}}",
                ...containers,
            ]);

            if (inspected.exitCode !== 0) {
                throw new ImageBuildError(
                    `podman inspect failed (${describeCode(inspected.exitCode)}): ` +
                        tailError(inspected.output),
                    inspected.exitCode,
                );
            }

            // Normalised, because one container prints `sha256:` and another does not, and the caller
            // compares these against short IDs from the listing.
            return [...new Set(nonEmptyLines(inspected.output).map(normalizeImageId))];
        },

        async removeImages(ids) {
            if (ids.length === 0) {
                return;
            }

            const removed = await runToEnd(spawn, podmanPath, ["image", "rm", ...ids]);

            if (removed.exitCode !== 0) {
                throw new ImageBuildError(
                    `podman image rm failed (${describeCode(removed.exitCode)}): ` +
                        tailError(removed.output),
                    removed.exitCode,
                );
            }
        },
    };
}

/**
 * Ensure an image exists for this exact recipe, building it only when it does not.
 *
 * The generated Containerfile is written only on the build path, because its path is stable: a cache hit
 * would otherwise overwrite the record of the last real build with text that was never built. `podman build
 * --file` needs a real file, which is the only reason it exists on disk at all; keeping the last one is a
 * debugging convenience, not an input anything reads back.
 *
 * A build is the only moment tags accumulate, so retention hangs off it rather than off session start: a
 * session that never rebuilds has nothing to clean up, and a pass at start could remove an image another
 * idle session is about to use.
 */
export async function ensureSandboxImage(
    options: EnsureSandboxImageOptions,
): Promise<EnsureSandboxImageResult> {
    if (await options.runner.exists(options.imageTag)) {
        return { outcome: "present", pruned: [] };
    }

    await fs.promises.mkdir(path.dirname(options.containerfilePath), { recursive: true });
    await fs.promises.writeFile(options.containerfilePath, options.containerfileText, "utf8");

    await options.runner.build({
        imageTag: options.imageTag,
        containerfilePath: options.containerfilePath,
        contextDir: options.contextDir,
        onOutput: options.onOutput,
        signal: options.signal,
    });

    if (options.store === undefined) {
        return { outcome: "built", pruned: [] };
    }

    const prune = await pruneSandboxImages({
        store: options.store,
        keep: options.keep ?? KEEP_SANDBOX_IMAGES,
        protect: [options.imageTag],
    });

    return { outcome: "built", pruned: prune.removed, pruneError: prune.error };
}

function defaultLaunch(command: string, args: readonly string[]): ChildProcess {
    return nodeSpawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
}

interface RunOptions {
    onOutput?: (chunk: string) => void;
    signal?: AbortSignal;
}

interface RunResult {
    exitCode: number | null;
    output: string;
}

function runToEnd(
    launch: ImageLaunch,
    command: string,
    args: readonly string[],
    options: RunOptions = {},
): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
        const { signal } = options;

        if (signal?.aborted) {
            reject(new ImageBuildError("build aborted before it started", null));

            return;
        }

        const child = launch(command, args);
        let output = "";

        const onChunk = (chunk: Buffer): void => {
            const text = chunk.toString("utf8");
            output += text;
            options.onOutput?.(text);
        };

        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);

        const abort = (): void => {
            child.kill("SIGTERM");
        };

        signal?.addEventListener("abort", abort, { once: true });

        const settle = (finish: () => void): void => {
            signal?.removeEventListener("abort", abort);
            finish();
        };

        child.once("error", (error) => {
            settle(() =>
                reject(new ImageBuildError(`cannot run ${command}: ${error.message}`, null)),
            );
        });

        child.once("close", (code, signalName) => {
            settle(() => {
                if (signal?.aborted) {
                    reject(new ImageBuildError("build aborted", code));

                    return;
                }

                resolve({
                    exitCode: signalName === null ? code : (code ?? null),
                    output,
                });
            });
        });
    });
}

/**
 * The sandbox images in a `podman images` listing.
 *
 * Filtered in code rather than with `--filter reference=`: that filter is a substring match, and this pass
 * must only ever see images this feature builds. The ID is the short form the listing prints, which is also
 * what `image rm` and the in-use comparison use.
 */
function parseSandboxImageEntries(output: string): { id: string; reference: string }[] {
    const entries: { id: string; reference: string }[] = [];

    for (const line of nonEmptyLines(output)) {
        const separator = line.indexOf(" ");

        if (separator === -1) {
            continue;
        }

        const reference = line.slice(separator + 1).trim();
        const id = line.slice(0, separator).trim();

        if (id === "" || !reference.startsWith(SANDBOX_IMAGE_PREFIX)) {
            continue;
        }

        entries.push({ id, reference });
    }

    return entries;
}

/**
 * `{{.Id}} {{.Created}}` lines joined with the references from the listing.
 *
 * Only the creation stamp has to survive parsing here: the listing already said which images belong to this
 * feature, so an inspect line whose ID matches none of them is dropped rather than guessed at.
 */
function parseImageRecords(
    output: string,
    entries: readonly { id: string; reference: string }[],
): SandboxImageRecord[] {
    const references = new Map(
        entries.map((entry) => [normalizeImageId(entry.id), entry.reference]),
    );
    const records: SandboxImageRecord[] = [];

    for (const line of nonEmptyLines(output)) {
        const separator = line.indexOf(" ");

        if (separator === -1) {
            continue;
        }

        const id = normalizeImageId(line.slice(0, separator));
        const created = line.slice(separator + 1).trim();
        const reference = references.get(id);

        if (reference === undefined || created === "") {
            continue;
        }

        records.push({ id, reference, created });
    }

    return records;
}

function nonEmptyLines(output: string): string[] {
    return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
}

function describeCode(exitCode: number | null): string {
    return exitCode === null ? "no exit code" : `exit ${exitCode}`;
}

function tailError(output: string): string {
    const lines = output.trimEnd().split("\n");

    return lines.slice(-MAX_ERROR_LINES).join("\n");
}
