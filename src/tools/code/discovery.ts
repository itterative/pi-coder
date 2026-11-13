import path from "node:path";

import { MAX_FILES, isSupportedPath, languageForPath, matchesGlob } from "./languages";
import { expandHomePath, type CodeSource } from "./source";

/** The characters rg treats as making a path a pattern rather than a literal target. */
const GLOB_META = /[*?[{]/;

/**
 * A `path` argument split into the literal prefix discovery scans and the rg-style pattern it matches.
 *
 * The pattern is matched as a whole against the workspace-relative path, exactly as `rg --glob` matches one: a
 * pattern containing `/` is anchored (`*` is one level, `**` crosses), and a pattern without a slash matches the
 * basename at any depth. `base` is only the discovery bound, so a scoped pattern does not scan the whole cwd.
 */
export interface PathTarget {
    /** The literal prefix that bounds discovery, as the caller wrote it (before `resolvePath`). */
    base: string;
    /** The pattern, expanded when absolute, matched against the workspace path. */
    pattern?: string;
    /** Whether the pattern is absolute after `~` expansion, so files match in absolute paths. */
    absolute: boolean;
}

export function parsePathTarget(input: string | undefined): PathTarget {
    const requested = input?.trim() ?? "";
    const value = requested.length === 0 ? "." : requested;

    if (!GLOB_META.test(value)) {
        return { base: value, absolute: false };
    }

    const expanded = expandHomePath(value);
    const absolute = path.isAbsolute(expanded);
    const segments = value.split("/");
    const patternIndex = segments.findIndex((segment) => GLOB_META.test(segment));
    const prefix = segments.slice(0, patternIndex).join("/");
    const base = prefix.length === 0 ? (absolute ? "/" : ".") : prefix;

    return { base, pattern: absolute ? expanded : value, absolute };
}

/**
 * The pattern expressed relative to the literal root, for the source walker.
 *
 * `PathTarget.pattern` is workspace-relative, while a source's `glob` matches relative to the root it is given, so
 * the literal prefix is stripped (`src/tools/**` under base `src` becomes `tools/**`). A pattern starting with `!`
 * is left to the post-filter: rg would read it as an exclusion, and `matchesGlob` treats it literally.
 */
export function patternWithinTarget(target: PathTarget): string | undefined {
    if (target.pattern === undefined || target.pattern.startsWith("!")) {
        return undefined;
    }

    const pattern = expandHomePath(target.pattern);
    const base = expandHomePath(target.base);

    if (base === "." || base.length === 0) {
        return pattern;
    }

    if (base === "/") {
        return pattern.startsWith("/") ? pattern.slice(1) : pattern;
    }

    if (pattern === base) {
        return undefined;
    }

    return pattern.startsWith(`${base}/`) ? pattern.slice(base.length + 1) : pattern;
}

export interface PathFilter {
    files: string[];
    /** Files the pattern removed, so a result never looks smaller than it is without saying why. */
    hidden: number;
}

/** Keep only the discovered files the `path` pattern selects, counted against the whole discovery. */
export function filterPathTarget(
    files: readonly string[],
    source: CodeSource,
    target: PathTarget,
): PathFilter {
    if (target.pattern === undefined) {
        return { files: [...files], hidden: 0 };
    }

    const pattern = target.pattern;
    const cwd = source.resolvePath(".");
    const kept = files.filter((file) =>
        matchesGlob(target.absolute ? file : path.relative(cwd, file), pattern),
    );

    return { files: kept, hidden: files.length - kept.length };
}

export interface Discovery {
    files: string[];
    rootIsFile: boolean;
    truncated: boolean;
    unsupportedRoot: boolean;
    unsupportedFiles: number;
}

/** Every supported file below a path, with the same bound for a file and a directory target. */
export async function discoverFiles(
    source: CodeSource,
    root: string,
    signal?: AbortSignal,
    pattern?: string,
): Promise<Discovery> {
    const stat = await source.stat(root);

    if (stat.isFile) {
        return {
            files: isSupportedPath(root) ? [root] : [],
            rootIsFile: true,
            truncated: false,
            unsupportedRoot: !isSupportedPath(root),
            unsupportedFiles: isSupportedPath(root) ? 0 : 1,
        };
    }

    if (!stat.isDirectory) {
        return {
            files: [],
            rootIsFile: false,
            truncated: false,
            unsupportedRoot: true,
            unsupportedFiles: 0,
        };
    }

    const found = await source.glob(root, { limit: MAX_FILES + 1, signal, pattern });
    const supported = found
        .filter((file) => isSupportedPath(file))
        .map((file) => path.resolve(file))
        .sort();

    return {
        files: supported.slice(0, MAX_FILES),
        rootIsFile: false,
        truncated: supported.length > MAX_FILES || found.length > MAX_FILES,
        unsupportedRoot: false,
        unsupportedFiles: found.length - supported.length,
    };
}

/**
 * Narrow a directory target to files that contain a symbol's name before parsing them.
 *
 * A qualified selector still searches by its last component: call sites normally say
 * `socket.connect(...)`, not `Socket::connect(...)`, so requiring the qualifier would miss the uses the
 * caller wants.
 */
/**
 * Names a parser emits that no grep can find, because the source says something else.
 *
 * `frontmatter` is one: the block is delimited by `---`, and the word itself appears only in the docs. Markdown
 * headings are not in the list — their names are the heading text.
 */
const SYNTHETIC_NAMES = new Set(["frontmatter"]);

function isSyntheticName(term: string): boolean {
    return SYNTHETIC_NAMES.has(term.toLowerCase());
}

export async function candidateFiles(
    source: CodeSource,
    root: string,
    selectors: readonly string[],
    signal?: AbortSignal,
    pattern?: string,
): Promise<Discovery> {
    const stat = await source.stat(root);

    if (stat.isFile) {
        return discoverFiles(source, root, signal, pattern);
    }

    // With a pattern, let the walker narrow the set so the cap counts matches instead of every candidate file.
    if (pattern !== undefined && pattern.length > 0) {
        return discoverFiles(source, root, signal, pattern);
    }

    const terms = Array.from(
        new Set(
            selectors
                .map((selector) => lastComponent(selector))
                .map((term) => term.replace(/^~/, ""))
                .filter((term) => term.length > 0),
        ),
    );
    const hits = new Set<string>();
    const synthetic = terms.filter(isSyntheticName);

    for (const term of terms.filter((term) => !isSyntheticName(term))) {
        const found = await source.grepFiles(term, root, { limit: MAX_FILES, signal });

        if (found === undefined) {
            return await discoverFiles(source, root, signal);
        }

        for (const file of found) {
            hits.add(path.resolve(file));
        }
    }

    if (synthetic.length > 0) {
        // A synthetic declaration has no text of its own to grep for: the frontmatter block is `---` in the file, so
        // `show frontmatter` has to look at the markdown files directly instead of quoting a name that never appears.
        const all = await discoverFiles(source, root, signal);

        for (const file of all.files) {
            if (languageForPath(file) === "markdown") {
                hits.add(path.resolve(file));
            }
        }
    }

    const files = Array.from(hits)
        .filter((file) => isSupportedPath(file))
        .sort();

    return {
        files: files.slice(0, MAX_FILES),
        rootIsFile: false,
        truncated: files.length > MAX_FILES,
        unsupportedRoot: false,
        unsupportedFiles: 0,
    };
}

export function lastComponent(selector: string): string {
    const withoutHint = selector.replace(/\(.*\)\s*$/, "");
    const parts = withoutHint.split(/::|\./).filter((part) => part.length > 0);

    return parts.at(-1) ?? selector;
}
