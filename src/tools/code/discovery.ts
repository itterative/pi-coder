import path from "node:path";

import { MAX_FILES, isSupportedPath, languageForPath, matchesGlob } from "./languages";
import type { CodeSource } from "./source";

export interface GlobFilter {
    files: string[];
    /** Files the glob removed, so a result never looks smaller than it is without saying why. */
    hidden: number;
}

/**
 * Keep only the discovered files a `glob` selects, counted against the searched path.
 *
 * A pattern without a slash matches the basename at any depth, which is what `rg --glob '*.ts'` does; a pattern
 * with one is matched against the path relative to the searched root, exactly as `rg --glob` does.
 */
export function applyGlobFilter(
    files: readonly string[],
    root: string,
    glob: string | undefined,
): GlobFilter {
    if (glob === undefined || glob.trim().length === 0) {
        return { files: [...files], hidden: 0 };
    }

    const kept = files.filter((file) => matchesGlob(relativeToRoot(root, file), glob));

    return { files: kept, hidden: files.length - kept.length };
}

function relativeToRoot(root: string, file: string): string {
    const relative = path.relative(root, file);

    // A file target is its own root: `path.relative` says "" and the glob then sees the basename.
    return relative.length === 0 || relative.startsWith("..") ? file : relative;
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

    const found = await source.glob(root, { limit: MAX_FILES + 1, signal });
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
): Promise<Discovery> {
    const stat = await source.stat(root);

    if (stat.isFile) {
        return discoverFiles(source, root, signal);
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
