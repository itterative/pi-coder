import path from "node:path";

import {
    createResolveIndex,
    importsOf,
    resolveImports,
    type ResolveIndex,
    type ResolvedImport,
} from "./imports";
import { withinNote } from "./format";
import { discoverFiles } from "./discovery";
import { loadParsedFiles } from "./load";
import type { CodeSource } from "./source";
import type { CallTiming } from "./timing";
import type { ParsedFile } from "./types";

/** Which side of a file's dependency edges `within` scopes to. */
export type WithinDirection = "imports" | "dependents";

/** A file's direct dependency neighbourhood, plus the anchor that defined it. */
export interface WithinScope {
    direction: WithinDirection;
    /** The anchor file, absolute. */
    anchor: string;
    /** The anchor and its direct neighbours, sorted by path. The anchor survives the `path` pattern. */
    parsed: ParsedFile[];
    /** Neighbours that are not among the searched files, so a caller can see why they are absent. */
    outside: number;
}

export type WithinResult = { error: string } | { scope: WithinScope };

/** The footer line for a computed scope. */
export function withinLine(source: CodeSource, scope: WithinScope): string {
    return withinNote({
        direction: scope.direction,
        anchor: source.displayPath(scope.anchor),
        files: scope.parsed.length,
        outside: scope.outside,
    });
}

/**
 * A `within` value is a file, optionally prefixed by a direction.
 *
 * Only the two known words are treated as a prefix: a path that happens to contain `:` keeps working, and a typo
 * such as `import:x.ts` is read as a path rather than silently changing the direction.
 */
const WITHIN_PREFIX = /^(imports|dependents):/;

export function parseWithin(
    raw: string,
): { direction: WithinDirection; anchor: string } | { error: string } {
    const trimmed = raw.trim();
    const match = WITHIN_PREFIX.exec(trimmed);
    const direction: WithinDirection = match?.[1] === "dependents" ? "dependents" : "imports";
    const anchor = (match === null ? trimmed : trimmed.slice(match[0].length)).trim();

    if (anchor.length === 0) {
        return {
            error: `# within needs a file · within="${direction}:<file>"`,
        };
    }

    return { direction, anchor };
}

/**
 * Narrow a parsed file set to one file's direct imports or direct dependents.
 *
 * The caller has already discovered and parsed the searched tree, so the neighbourhood is an intersection with
 * what it parsed: the anchor is the only file that is loaded on demand, because naming it explicitly is what makes
 * it part of the scope even when `path` or `glob` excludes it.
 */
export async function withinScope(options: {
    source: CodeSource;
    /** The searched root (the literal prefix of `path`): a relative anchor is resolved against it. */
    root: string;
    raw: string;
    parsed: readonly ParsedFile[];
    /**
     * The discovered files of the whole searched root, before the `path` pattern narrowed them.
     *
     * Resolution has to see them for the same reason `deps` does: a neighbour hidden by the pattern (or living
     * beside a pattern-narrowed subtree) still counts as a real edge, and the footer reports it as outside the
     * searched path instead of pretending the anchor imports nothing.
     */
    files?: readonly string[];
    signal?: AbortSignal;
}): Promise<WithinResult> {
    const request = parseWithin(options.raw);

    if ("error" in request) {
        return request;
    }

    const anchor = path.resolve(await withinBase(options.source, options.root), request.anchor);

    try {
        await options.source.assertReadable(anchor);
    } catch (error) {
        // A missing anchor is the caller's typo, not an outline failure; a confinement error is rethrown so the
        // normal failure text can explain it.
        if (!isMissingPath(error)) {
            throw error;
        }

        return {
            error: `# within: no such file: ${options.source.displayPath(anchor)}`,
        };
    }

    const parsedAnchor = options.parsed.find((file) => file.path === anchor);
    const anchorBatch =
        parsedAnchor === undefined
            ? await loadParsedFiles(options.source, [anchor], options.signal)
            : undefined;
    const anchorFile = parsedAnchor ?? anchorBatch?.parsed[0];

    if (anchorFile === undefined) {
        // A container source answers missing reads per file instead of throwing from `assertReadable`, so the
        // reason has to come from the read errors: "not found" is a typo the caller can fix, and anything else
        // (unsupported language, size cap) is a different answer.
        const missing = (anchorBatch?.errors ?? []).some(isMissingPath);

        return {
            error: missing
                ? `# within: no such file: ${options.source.displayPath(anchor)}`
                : `# within: ${options.source.displayPath(anchor)} is not a supported source file`,
        };
    }

    const searched = new Set(options.parsed.map((file) => file.path));
    const index = createResolveIndex({
        root: options.source.cwd,
        files: Array.from(new Set([...(options.files ?? []), ...searched, anchorFile.path])),
        parsed: [...options.parsed, anchorFile],
    });
    const wanted = new Set([anchorFile.path]);
    const outside = new Set<string>();

    if (request.direction === "imports") {
        for (const entry of resolveImports(anchorFile, importsOf(anchorFile), index)) {
            addNeighbour(entry, options.parsed, searched, wanted, outside);
        }
    } else {
        for (const file of options.parsed) {
            if (file.path !== anchorFile.path && importsTarget(file, anchorFile.path, index)) {
                wanted.add(file.path);
            }
        }
    }

    const parsed = options.parsed
        .filter((file) => wanted.has(file.path))
        .toSorted((left, right) => left.path.localeCompare(right.path));

    if (!parsed.includes(anchorFile)) {
        parsed.push(anchorFile);
    }

    return {
        scope: {
            direction: request.direction,
            anchor: anchorFile.path,
            parsed,
            outside: outside.size,
        },
    };
}

/**
 * The unfiltered discovery a `within` scope resolves against when a `path` pattern narrowed the parse set.
 *
 * Discovery applies the pattern, so the main file list is only the matches. A neighbour outside the pattern still
 * counts as a real edge, so a second walk (only for within-plus-pattern) supplies the resolution index.
 */
export async function withinResolution(
    source: CodeSource,
    root: string,
    pattern: string | undefined,
    signal: AbortSignal | undefined,
    timing: CallTiming,
): Promise<readonly string[] | undefined> {
    if (pattern === undefined) {
        return undefined;
    }

    const discovery = await timing.measure("discover", () => discoverFiles(source, root, signal));

    return discovery.files;
}

/** The root as a directory: a search can name a single file, and a relative anchor is then its sibling. */
async function withinBase(source: CodeSource, root: string): Promise<string> {
    try {
        const stat = await source.stat(root);

        return stat.isDirectory ? root : path.dirname(root);
    } catch {
        // The anchor's own error explains a root that cannot be stat'd.
        return root;
    }
}

function isMissingPath(error: unknown): boolean {
    const code = (error as { code?: unknown }).code;

    return code === "ENOENT" || isMissingPathText(String(error));
}

function isMissingPathText(message: string): boolean {
    return (
        message.includes("ENOENT") ||
        message.includes("no such file") ||
        message.includes("not found")
    );
}

function addNeighbour(
    entry: ResolvedImport,
    parsed: readonly ParsedFile[],
    searched: ReadonlySet<string>,
    wanted: Set<string>,
    outside: Set<string>,
): void {
    if (entry.state !== "local" || entry.target === undefined) {
        return;
    }

    if (entry.directory === true) {
        // A Go import names a package directory, so every searched file in it is a neighbour.
        for (const file of parsed) {
            if (path.dirname(file.path) === entry.target) {
                wanted.add(file.path);
            }
        }

        return;
    }

    if (searched.has(entry.target)) {
        wanted.add(entry.target);
    } else {
        outside.add(entry.target);
    }
}

function importsTarget(file: ParsedFile, target: string, index: ResolveIndex): boolean {
    return resolveImports(file, importsOf(file), index).some(
        (entry) => entry.state === "local" && entry.directory !== true && entry.target === target,
    );
}
