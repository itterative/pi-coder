import path from "node:path";

import { discoverFiles, parsePathTarget, type Discovery } from "./discovery";
import { discoveryCapNote, nextOffsetNote, renderWithinBudget } from "./format";
import {
    createResolveIndex,
    dependentsOf,
    importsOf,
    resolveImports,
    type ResolvedImport,
} from "./imports";
import { DEFAULT_CHAR_LIMIT, isSupportedPath } from "./languages";
import { loadParsedFiles } from "./load";
import type { CodeSource } from "./source";
import { CallTiming } from "./timing";
import type { CodeToolParams } from "./types";

export interface DepsResult {
    text: string;
    files: number;
    parseErrors: number;
    truncated: boolean;
    matches: number;
}

/**
 * `deps`: one file's imports, and the files that import it.
 *
 * The subject is `path`; the tree scanned for dependents is the working directory when the subject lives inside it,
 * or the subject's own directory otherwise. That asymmetry is deliberate: a file's imports are local to it, but
 * "who imports it" is a question about the whole tree, and scanning only the subject's directory would answer
 * "nobody" for every file whose dependents live elsewhere.
 */
export async function runDeps(
    source: CodeSource,
    params: CodeToolParams,
    signal?: AbortSignal,
    timing: CallTiming = new CallTiming(),
): Promise<DepsResult> {
    const limit = params.limit ?? DEFAULT_CHAR_LIMIT;
    const offset = Math.max(0, Math.floor(params.offset ?? 0));

    if (params.path === undefined) {
        return empty(
            '# deps needs a file, e.g. outline(action="deps", path="src/tools/code/search.ts")',
        );
    }

    const requested = parsePathTarget(params.path);

    if (requested.pattern !== undefined) {
        return empty(`# deps takes a file, not a pattern: ${requested.pattern}`);
    }

    const target = source.resolvePath(requested.base);
    const stat = await source.stat(target);

    if (!stat.isFile) {
        return empty(
            `# deps ${source.displayPath(target)} · needs a file, not a directory\n# name one file, e.g. path="src/tools/code/search.ts"`,
        );
    }

    if (!isSupportedPath(target)) {
        return empty(`# deps ${source.displayPath(target)} · unsupported file`);
    }

    await source.assertReadable(target);

    const scanned = await timing.measure("discover", () => scanRootFor(source, target, signal));
    const root = scanned.root;
    const discovery =
        scanned.discovery ??
        (await timing.measure("discover", () => discoverFiles(source, root, signal)));
    // The subject is the question, so the discovery never removes it from the parse set.
    const files = discovery.files.includes(target)
        ? discovery.files
        : [...discovery.files, target].toSorted();

    const batch = await timing.measure("parse", () => loadParsedFiles(source, files, signal));

    timing.recordLoad(batch, files.length);

    const parsed = batch.parsed.toSorted((left, right) => left.path.localeCompare(right.path));
    const parseErrors = parsed.reduce((total, file) => total + file.parseErrors, 0);
    const subject = parsed.find((file) => file.path === target);

    if (subject === undefined) {
        return {
            text: [
                `# deps ${source.displayPath(target)} · not parsed`,
                batch.tooLarge > 0
                    ? `# skipped: ${batch.tooLarge} file(s) above the size limit`
                    : "",
                ...batch.errors.slice(0, 3).map((error) => `# ${error}`),
            ]
                .filter((line) => line.length > 0)
                .join("\n"),
            files: parsed.length,
            parseErrors,
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    // Resolution sees the whole scan root, so a dependent or import target outside the subject's own directory is
    // still classified from the project's files. Filtering the resolve index instead flipped every `include/` target
    // to `external` as soon as the scan root narrowed.
    const index = createResolveIndex({
        root,
        files: discovery.files.includes(target) ? discovery.files : [...discovery.files, target],
        parsed,
    });
    const imports = await timing.measure("search", async () =>
        resolveImports(subject, importsOf(subject), index),
    );
    const dependents = dependentsOf(target, parsed, index);
    const local = imports.filter((entry) => entry.state === "local").length;
    const external = imports.filter((entry) => entry.state === "external").length;
    const unresolved = imports.length - local - external;
    const header = [
        `# deps ${source.displayPath(target)}`,
        plural(imports.length, "import"),
        `(${local} local, ${external} external, ${unresolved} unresolved)`,
        plural(dependents.length, "dependent"),
        subject.language,
    ].join(" · ");
    const blocks = [importBlock(imports, source), dependentBlock(dependents, source, root)];
    const fitted = renderWithinBudget(header, blocks, limit, offset);
    const next = nextOffsetNote(fitted);
    const footer = footerFor({
        discoveryTruncated: discovery.truncated,
        parseErrors,
        filter: undefined,
    });

    return {
        text: [fitted.text, next, ...footer]
            .filter((part): part is string => part !== undefined && part.length > 0)
            .join("\n"),
        files: parsed.length,
        parseErrors,
        truncated: discovery.truncated || fitted.truncated,
        matches: imports.length + dependents.length,
    };
}

/**
 * The tree to scan, and the cwd discovery when it already covers the subject.
 *
 * A subject inside the working directory is usually scanned from there, so dependents are looked for in the whole
 * checkout. When the cwd walk skips the subject — a gitignored test tree, `.pi/local/…` — scanning it would resolve
 * nothing and report "no dependents" for a file that has plenty, so the nearest enclosing project root is scanned
 * literally instead (naming a tree is what makes discovery literal).
 */
async function scanRootFor(
    source: CodeSource,
    target: string,
    signal?: AbortSignal,
): Promise<{ root: string; discovery?: Discovery }> {
    const inside = insideRoot(source, target);

    if (inside !== source.cwd) {
        return { root: inside };
    }

    const discovery = await discoverFiles(source, source.cwd, signal);

    if (discovery.files.includes(target)) {
        return { root: source.cwd, discovery };
    }

    return { root: await nearestProjectRoot(source, target) };
}

/** Markers that make a directory the root of a project rather than just a folder inside one. */
const PROJECT_MARKERS = [
    "CMakeLists.txt",
    "Makefile",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    ".git",
];

/** The closest ancestor of the subject that looks like a project root, stopping before the cwd itself. */
async function nearestProjectRoot(source: CodeSource, target: string): Promise<string> {
    let directory = path.dirname(target);

    while (isStrictlyInside(directory, source.cwd)) {
        if (await hasProjectMarker(source, directory)) {
            return directory;
        }

        const parent = path.dirname(directory);

        if (parent === directory) {
            break;
        }

        directory = parent;
    }

    return path.dirname(target);
}

function isStrictlyInside(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);

    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function hasProjectMarker(source: CodeSource, directory: string): Promise<boolean> {
    for (const marker of PROJECT_MARKERS) {
        try {
            await source.stat(path.join(directory, marker));

            return true;
        } catch {
            // Not this marker; keep looking.
        }
    }

    return false;
}

/** The working directory when the subject is inside it, otherwise the subject's own directory. */
function insideRoot(source: CodeSource, target: string): string {
    const relative = path.relative(source.cwd, target);

    return relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)
        ? path.dirname(target)
        : source.cwd;
}

function importBlock(imports: readonly ResolvedImport[], source: CodeSource): string {
    if (imports.length === 0) {
        return "imports\n  # no imports found";
    }

    const rows = imports.map((entry) => {
        const state = entry.state.padEnd(10);
        const target =
            entry.target === undefined
                ? ""
                : `  → ${source.displayPath(entry.target)}${entry.directory === true ? "/" : ""}`;

        return `  ${state} ${entry.specifier}  :${entry.line}${target}`;
    });

    return ["imports", ...rows].join("\n");
}

function dependentBlock(
    dependents: readonly { path: string; line: number }[],
    source: CodeSource,
    root: string,
): string {
    const rows = dependents.map(
        (dependent) => `  ${source.displayPath(dependent.path)}  :${dependent.line}`,
    );

    if (rows.length === 0) {
        return ["dependents", `  # no file under ${source.displayPath(root)} imports it`].join(
            "\n",
        );
    }

    return ["dependents", ...rows].join("\n");
}

function footerFor(options: {
    discoveryTruncated: boolean;
    parseErrors: number;
    filter: string | undefined;
}): string[] {
    const footer = [
        "# note: imports only — a call graph is `usages`; resolution is syntactic (relative paths, crate and module names)",
        "# states: local = a parsed file in this tree · external = a module or namespace outside it · unresolved = a relative path that matched no parsed file",
    ];

    if (options.filter !== undefined) {
        footer.push(options.filter);
    }

    if (options.parseErrors > 0) {
        footer.push(`# parse: ${options.parseErrors} error node(s); imports may be incomplete`);
    }

    if (options.discoveryTruncated) {
        footer.push(discoveryCapNote());
    }

    return footer;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function empty(text: string): DepsResult {
    return { text, files: 0, parseErrors: 0, truncated: false, matches: 0 };
}
