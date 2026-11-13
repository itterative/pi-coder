import path from "node:path";

import { matchesGlob, shouldIgnorePath } from "../../src/tools/code/languages";
import type { CodeFileStat, CodeSource } from "../../src/tools/code/source";

/**
 * A `CodeSource` over an in-memory tree.
 *
 * The outline tool's actions are pure once they have a source, so tests exercise digest/search/show/usages without
 * a container or a temp checkout. The real local and container adapters are covered separately.
 */
export class MemoryCodeSource implements CodeSource {
    readonly kind = "local" as const;
    private readonly files = new Map<string, string>();
    private readonly directories = new Set<string>();

    constructor(
        readonly cwd: string,
        files: Record<string, string>,
        /** Per-file mtimes, for callers that need to distinguish "written before the build" from "written after". */
        private readonly mtimes: Record<string, number> = {},
    ) {
        this.directories.add(path.resolve(cwd));

        for (const [relative, content] of Object.entries(files)) {
            const absolute = path.resolve(cwd, relative);

            this.files.set(absolute, content);
            this.addParents(absolute);
        }
    }

    async glob(
        root: string,
        options: { limit: number; signal?: AbortSignal; pattern?: string },
    ): Promise<string[]> {
        const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

        return Array.from(this.files.keys())
            .filter((file) => file.startsWith(prefix))
            .filter((file) => !shouldIgnorePath(path.relative(root, file)))
            .filter(
                (file) =>
                    options.pattern === undefined ||
                    options.pattern.length === 0 ||
                    matchesGlob(path.relative(root, file), options.pattern),
            )
            .sort()
            .slice(0, options.limit);
    }

    async stat(target: string): Promise<CodeFileStat> {
        const file = this.files.get(target);

        if (file !== undefined) {
            return {
                isDirectory: false,
                isFile: true,
                size: file.length,
                mtimeMs: this.mtimes[path.relative(this.cwd, target)] ?? this.mtimes[target] ?? 1,
            };
        }

        if (this.directories.has(target)) {
            return { isDirectory: true, isFile: false, size: 0, mtimeMs: 1 };
        }

        throw new Error(`not found: ${target}`);
    }

    async readFile(target: string): Promise<string> {
        const file = this.files.get(target);

        if (file === undefined) {
            throw new Error(`not found: ${target}`);
        }

        return file;
    }

    async grepFiles(
        term: string,
        root: string,
        options: { limit: number; signal?: AbortSignal },
    ): Promise<string[] | undefined> {
        const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

        return Array.from(this.files.entries())
            .filter(([file]) => file.startsWith(prefix))
            .filter(([, content]) => content.includes(term))
            .map(([file]) => file)
            .sort()
            .slice(0, options.limit);
    }

    resolvePath(input: string): string {
        return path.resolve(this.cwd, input);
    }

    displayPath(target: string): string {
        const relative = path.relative(this.cwd, target);

        if (relative === "") {
            return ".";
        }

        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            return target;
        }

        return relative;
    }

    async assertReadable(target: string): Promise<void> {
        await this.stat(target);
    }

    private addParents(target: string): void {
        let directory = path.dirname(target);

        while (directory.startsWith(this.cwd)) {
            this.directories.add(directory);

            const parent = path.dirname(directory);

            if (parent === directory) {
                break;
            }

            directory = parent;
        }
    }
}
