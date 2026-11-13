import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveHomeDirectory } from "../../common/home-directory";
import type { ContainerSession } from "../../modules/sandbox/container/client";
import type { ContainerState } from "../../modules/sandbox/container/state";
import { DEFAULT_IGNORE_GLOBS, matchesGlob, shouldIgnorePath } from "./languages";

const execFileAsync = promisify(execFile);

export interface CodeFileStat {
    isDirectory: boolean;
    isFile: boolean;
    size: number;
    mtimeMs: number;
}

/**
 * The filesystem seam for the outline tool.
 *
 * The tool's logic runs in the extension process, but a session with a container must read the container's
 * view. The two implementations below differ only in where the syscalls happen; every path is resolved and
 * confined before it reaches either one.
 */
export interface CodeSource {
    readonly kind: "container" | "local";
    readonly cwd: string;
    glob(
        root: string,
        options: {
            limit: number;
            signal?: AbortSignal;
            /** An rg-style pattern relative to `root`, applied by the walker so the limit counts matches. */
            pattern?: string;
        },
    ): Promise<string[]>;
    stat(target: string): Promise<CodeFileStat>;
    readFile(target: string): Promise<string>;
    /**
     * Files whose text contains `term`, for narrowing a symbol search before parsing.
     *
     * `undefined` means the source has no fast search and the caller should parse the full candidate set.
     */
    grepFiles(
        term: string,
        root: string,
        options: { limit: number; signal?: AbortSignal },
    ): Promise<string[] | undefined>;
    resolvePath(input: string): string;
    displayPath(target: string): string;
    assertReadable(target: string): Promise<void>;
}

export class CodePathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CodePathError";
    }
}

/**
 * Extra roots this session may read, beyond the working directory.
 *
 * The same list `read`, `grep`, and `find` honour (`fileRootsForOperation`), so a root the user declared for the
 * file tools — the user memory directory, a skills store, an explicitly listed host path — does not fail here with
 * "path is outside the working directory". `~` is left unexpanded, exactly as the confinement checks expect.
 */
export type CodeReadRoots = () => readonly string[];

/** Build the source for this call. A container session wins; it is the view `bash` and `read` already have. */
export async function createCodeSource(
    ctx: ExtensionContext,
    container?: ContainerState,
    readRoots?: CodeReadRoots,
): Promise<CodeSource> {
    if (container?.active === true) {
        if (container.sessionFor === undefined) {
            throw new Error(
                "the container backend is active but did not publish a session resolver",
            );
        }

        const session = await container.sessionFor(ctx);

        return new ContainerCodeSource(session, ctx.cwd);
    }

    return new LocalCodeSource(ctx.cwd, readRoots);
}

export class LocalCodeSource implements CodeSource {
    readonly kind = "local" as const;
    private realCwd: Promise<string> | undefined;

    constructor(
        readonly cwd: string,
        /** Read roots beyond the working directory; read at call time so a config reload is picked up. */
        private readonly readRoots?: CodeReadRoots,
    ) {}

    async glob(
        root: string,
        options: { limit: number; signal?: AbortSignal; pattern?: string },
    ): Promise<string[]> {
        // Prefer ripgrep when it exists: it is the same walker the container's glob uses. The stdlib walker
        // is the portable fallback.
        try {
            const noIgnore = scanLiterally(root, this.cwd);
            const result = await execFileAsync(
                "rg",
                buildRipgrepFileArgs(root, noIgnore, options.pattern),
                {
                    cwd: this.cwd,
                    maxBuffer: 16 * 1024 * 1024,
                    signal: options.signal,
                },
            );

            return parseRipgrepPaths(result.stdout, root, options.limit);
        } catch (error) {
            const failure = error as { code?: number | string };

            if (failure.code === 1) {
                return [];
            }
        }

        return await this.globWithNode(root, options);
    }

    private async globWithNode(
        root: string,
        options: { limit: number; signal?: AbortSignal; pattern?: string },
    ): Promise<string[]> {
        const found: string[] = [];
        const entries = fs.promises.glob("**/*", {
            cwd: root,
            withFileTypes: true,
            exclude: (entry) => {
                const candidate = entry as unknown as string | { parentPath: string; name: string };

                if (typeof candidate === "string") {
                    return shouldIgnorePath(candidate);
                }

                return shouldIgnorePath(
                    path.relative(root, path.join(candidate.parentPath, candidate.name)),
                );
            },
        });

        for await (const entry of entries) {
            options.signal?.throwIfAborted();

            if (!entry.isFile()) {
                continue;
            }

            const absolute = path.resolve(entry.parentPath, entry.name);

            if (shouldIgnorePath(path.relative(root, absolute))) {
                continue;
            }

            if (
                options.pattern !== undefined &&
                options.pattern.length > 0 &&
                !matchesGlob(path.relative(root, absolute), options.pattern)
            ) {
                continue;
            }

            found.push(absolute);

            if (found.length >= options.limit) {
                break;
            }
        }

        return found;
    }

    async stat(target: string): Promise<CodeFileStat> {
        const stat = await fs.promises.stat(target);

        return {
            isDirectory: stat.isDirectory(),
            isFile: stat.isFile(),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        };
    }

    async readFile(target: string): Promise<string> {
        return await fs.promises.readFile(target, "utf8");
    }

    async grepFiles(
        term: string,
        root: string,
        options: { limit: number; signal?: AbortSignal },
    ): Promise<string[] | undefined> {
        try {
            const noIgnore = scanLiterally(root, this.cwd);
            const result = await execFileAsync("rg", buildRipgrepArgs(term, root, noIgnore), {
                cwd: this.cwd,
                maxBuffer: 16 * 1024 * 1024,
                signal: options.signal,
            });

            return parseRipgrepPaths(result.stdout, root, options.limit);
        } catch (error) {
            const failure = error as { code?: number | string };

            if (failure.code === 1) {
                return [];
            }

            // No ripgrep, or a ripgrep failure: let the caller fall back to parsing the candidate set.
            return undefined;
        }
    }

    resolvePath(input: string): string {
        return resolveInputPath(this.cwd, input);
    }

    displayPath(target: string): string {
        return displayPathFrom(this.cwd, target);
    }

    async assertReadable(target: string): Promise<void> {
        this.realCwd ??= fs.promises.realpath(this.cwd);

        const root = await this.realCwd;
        const real = await fs.promises.realpath(target);

        if (isWithin(root, real)) {
            return;
        }

        // A declared root is a session statement about where reads may go, and `read` already honours it. Resolving
        // the candidate too keeps a symlinked root from being accepted by name and refused by path; an unreadable
        // declaration is skipped rather than fatal, the same way an absent declared root is for the file tools.
        for (const candidate of this.readRoots?.() ?? []) {
            const declared = await fs.promises
                .realpath(resolveInputPath(this.cwd, candidate))
                .catch(() => undefined);

            if (declared !== undefined && isWithin(declared, real)) {
                return;
            }
        }

        throw new CodePathError(
            `path is outside the working directory: ${this.displayPath(target)}`,
        );
    }
}

export class ContainerCodeSource implements CodeSource {
    readonly kind = "container" as const;

    constructor(
        private readonly session: ContainerSession,
        readonly cwd: string,
    ) {}

    async glob(
        root: string,
        options: { limit: number; signal?: AbortSignal; pattern?: string },
    ): Promise<string[]> {
        options.signal?.throwIfAborted();

        const result = await this.session.fs({
            op: "glob",
            path: root,
            pattern: options.pattern ?? "",
            ignore: DEFAULT_IGNORE_GLOBS,
            noIgnore: scanLiterally(root, this.cwd),
            limit: options.limit,
        });

        return result.paths.map((entry) =>
            path.isAbsolute(entry) ? entry : path.resolve(root, entry),
        );
    }

    async stat(target: string): Promise<CodeFileStat> {
        const result = await this.session.fs({ op: "stat", path: target });

        return {
            isDirectory: result.isDirectory,
            isFile: result.isFile,
            size: result.size,
            mtimeMs: result.mtimeMs ?? 0,
        };
    }

    async readFile(target: string): Promise<string> {
        const result = await this.session.fs({ op: "readFile", path: target });

        return Buffer.from(result.data, "base64").toString("utf8");
    }

    async grepFiles(
        term: string,
        root: string,
        options: { limit: number; signal?: AbortSignal },
    ): Promise<string[] | undefined> {
        let stdout = "";

        try {
            const result = await this.session.spawn({
                file: "rg",
                args: buildRipgrepArgs(term, root, scanLiterally(root, this.cwd)),
                cwd: this.cwd,
                signal: options.signal,
                onChunk: (stream, chunk) => {
                    if (stream === "stdout") {
                        stdout += chunk.toString("utf8");
                    }
                },
            });

            if (result.exitCode === 1) {
                return [];
            }

            if (result.exitCode !== 0) {
                return undefined;
            }

            return parseRipgrepPaths(stdout, root, options.limit);
        } catch {
            // A missing rg in the image is not a failure of the outline tool; parse the candidates instead.
            return undefined;
        }
    }

    resolvePath(input: string): string {
        return resolveInputPath(this.cwd, input);
    }

    displayPath(target: string): string {
        return displayPathFrom(this.cwd, target);
    }

    async assertReadable(target: string): Promise<void> {
        // The container's mount set is the read boundary, exactly as `readConfinementFor` says for the file
        // tools. The dispatcher performs one syscall on an already-resolved path; it does not widen anything.
        if (!path.isAbsolute(target)) {
            throw new CodePathError(`container path must be absolute: ${target}`);
        }
    }
}

/**
 * Whether a scan should read an explicitly named target literally.
 *
 * A scan rooted at the working directory honors the tree's ignore files, so `digest .` does not wander into
 * vendored or generated trees. An explicitly named subdirectory is the caller's choice: bypass parent ignore
 * files there, while still applying the built-in build/third-party list. A fixture under a gitignored path
 * is otherwise invisible even though `read` can open it.
 */
function scanLiterally(root: string, cwd: string): boolean {
    return path.resolve(root) !== path.resolve(cwd);
}

function buildRipgrepFileArgs(root: string, noIgnore: boolean, pattern?: string): string[] {
    const args = ["--files", "--hidden", "--color=never", "--no-messages"];

    if (noIgnore) {
        args.push("--no-ignore");
    }

    if (pattern !== undefined && pattern.length > 0) {
        args.push("--glob", pattern);
    }

    for (const glob of DEFAULT_IGNORE_GLOBS) {
        args.push("--glob", `!${glob}`);
    }

    args.push("--", root);

    return args;
}

function buildRipgrepArgs(term: string, root: string, noIgnore: boolean): string[] {
    const args = [
        "--files-with-matches",
        "--fixed-strings",
        "--word-regexp",
        "--hidden",
        "--color=never",
        "--no-messages",
    ];

    if (noIgnore) {
        args.push("--no-ignore");
    }

    for (const glob of DEFAULT_IGNORE_GLOBS) {
        args.push("--glob", `!${glob}`);
    }

    args.push("--", term, root);

    return args;
}

function parseRipgrepPaths(stdout: string, root: string, limit: number): string[] {
    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, limit)
        .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(root, entry)));
}

/** Expand a leading `~` without resolving against a working directory. */
export function expandHomePath(input: string): string {
    return input === "~" || input.startsWith("~/")
        ? resolveHomeDirectory() + input.slice(1)
        : input;
}

function resolveInputPath(cwd: string, input: string): string {
    return path.resolve(cwd, expandHomePath(input));
}

function displayPathFrom(cwd: string, target: string): string {
    const relative = path.relative(cwd, target);

    if (relative === "") {
        return ".";
    }

    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return target;
    }

    return relative;
}

function isWithin(root: string, target: string): boolean {
    const relative = path.relative(root, target);

    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
