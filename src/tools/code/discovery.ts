import path from "node:path";

import { MAX_FILES, isSupportedPath } from "./languages";
import type { CodeSource } from "./source";

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

    for (const term of terms) {
        const found = await source.grepFiles(term, root, { limit: MAX_FILES, signal });

        if (found === undefined) {
            return await discoverFiles(source, root, signal);
        }

        for (const file of found) {
            hits.add(path.resolve(file));
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
