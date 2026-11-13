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
    /**
     * Set when the anchor resolved from the cwd instead of from `path`'s literal prefix.
     *
     * The documented reading is `path`-relative, and it is tried first; this only records that the caller wrote a
     * path that reads naturally from the cwd (`within="src/tui/pager.ts"` under `path=src/tui`), so the footer can
     * say which file was actually searched.
     */
    relativeTo?: "cwd";
}

export type WithinResult = { error: string } | { scope: WithinScope };

/** The footer line for a computed scope. */
export function withinLine(source: CodeSource, scope: WithinScope): string {
    return withinNote({
        direction: scope.direction,
        anchor: source.displayPath(scope.anchor),
        files: scope.parsed.length,
        outside: scope.outside,
        relativeTo: scope.relativeTo,
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

    const base = await withinBase(options.source, options.root);
    const anchored = path.resolve(base, request.anchor);
    const fromCwd = path.resolve(options.source.cwd, request.anchor);
    const choice = await resolveWithinAnchor(
        options.source,
        anchored,
        fromCwd,
        options.parsed,
        options.signal,
    );

    if ("error" in choice) {
        return choice;
    }

    const anchorFile = choice.file;

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
            ...(choice.relativeTo === undefined ? {} : { relativeTo: choice.relativeTo }),
        },
    };
}

type AnchorLoad = { file: ParsedFile } | { missing: true } | { unsupported: true };

/**
 * Resolve the `within` anchor, trying the documented reading before the cwd one.
 *
 * An anchor is documented as relative to `path`'s literal prefix, which is what makes `within="pager.ts"` the short
 * form. A caller reasonably writes the path as it reads from the cwd instead — `within="src/tui/pager.ts"` under
 * `path=src/tui` — and that used to double-prefix into a file that does not exist. The second reading is tried only
 * when the first is *missing*: never when it resolved, and never when it failed for another reason, so the
 * documented meaning still decides whenever both could apply.
 */
async function resolveWithinAnchor(
    source: CodeSource,
    anchored: string,
    fromCwd: string,
    parsed: readonly ParsedFile[],
    signal?: AbortSignal,
): Promise<{ file: ParsedFile; relativeTo?: "cwd" } | { error: string }> {
    const first = await loadWithinAnchor(source, anchored, parsed, signal);

    if ("file" in first) {
        return { file: first.file };
    }

    const second =
        "missing" in first && fromCwd !== anchored
            ? await loadWithinAnchor(source, fromCwd, parsed, signal)
            : undefined;

    if (second !== undefined && "file" in second) {
        return { file: second.file, relativeTo: "cwd" };
    }

    if ("unsupported" in first) {
        return {
            error: `# within: ${source.displayPath(anchored)} is not a supported source file`,
        };
    }

    return { error: missingAnchorError(source, anchored, fromCwd) };
}

/**
 * A missing anchor names both readings it was tried as.
 *
 * The doubled path in `src/tui/src/tui/pager.ts` is what teaches the rule, and a caller who sees `also tried …`
 * knows their value is simply wrong rather than mis-anchored.
 */
function missingAnchorError(source: CodeSource, anchored: string, fromCwd: string): string {
    const tried =
        fromCwd === anchored ? "" : ` · also tried ${source.displayPath(fromCwd)} from the cwd`;

    return `# within: no such file: ${source.displayPath(anchored)}${tried}`;
}

async function loadWithinAnchor(
    source: CodeSource,
    target: string,
    parsed: readonly ParsedFile[],
    signal?: AbortSignal,
): Promise<AnchorLoad> {
    try {
        await source.assertReadable(target);
    } catch (error) {
        // A missing anchor is the caller's typo, not an outline failure; a confinement error is rethrown so the
        // normal failure text can explain it.
        if (!isMissingPath(error)) {
            throw error;
        }

        return { missing: true };
    }

    const parsedAnchor = parsed.find((file) => file.path === target);

    if (parsedAnchor !== undefined) {
        return { file: parsedAnchor };
    }

    const batch = await loadParsedFiles(source, [target], signal);
    const file = batch.parsed[0];

    if (file !== undefined) {
        return { file };
    }

    // A container source answers missing reads per file instead of throwing from `assertReadable`, so the reason has
    // to come from the read errors: "not found" is a typo the caller can fix, and anything else (unsupported
    // language, size cap) is a different answer.
    return batch.errors.some(isMissingPath) ? { missing: true } : { unsupported: true };
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
