import path from "node:path";

import { commentSyntaxFor, maskComments, stringRanges } from "./comments";
import type { ParsedFile } from "./types";

/**
 * File-level imports: what a source file pulls in, and who pulls it in.
 *
 * The graph is syntactic and deliberately literal — an import statement names a specifier, and resolution either
 * finds that specifier in the scanned tree, proves it lives outside it, or fails. It never guesses: `external` and
 * `unresolved` are separate states because "this is a library" and "this path matches nothing" are different facts,
 * and a graph that conflates them teaches the wrong lesson. Dynamic `require`/`import()`, re-export chasing, and
 * type-only imports are out of scope; `usages` remains the call graph.
 */

/** How a specifier is resolved: by file path, or by module/namespace name. */
export type ImportStyle = "path" | "symbol";

/** One import statement's specifier, as written. */
export interface RawImport {
    specifier: string;
    line: number;
    style: ImportStyle;
    /** The specifier is relative to the importing file (JS `./x`, Python `.x`, `require_relative`, C `"x"`). */
    relative: boolean;
}

export type ImportState = "local" | "external" | "unresolved";

export interface ResolvedImport {
    specifier: string;
    line: number;
    state: ImportState;
    /** Display path of the target file, or the package directory for a Go import. */
    target?: string;
    /** Go imports name a package directory rather than a file. */
    directory?: boolean;
}

export interface Dependent {
    path: string;
    /** The line of the import statement that names the subject. */
    line: number;
}

const importCache = new WeakMap<ParsedFile, RawImport[]>();

/** The imports of one parsed file, extracted once per parse. */
export function importsOf(file: ParsedFile): RawImport[] {
    const cached = importCache.get(file);

    if (cached !== undefined) {
        return cached;
    }

    const syntax = commentSyntaxFor(file.language);
    // A commented-out import must not become an edge; line comments are blanked, and offsets are preserved so the
    // line number reported is the original one.
    const text = syntax === undefined ? file.source : maskComments(file.source, syntax);
    const imports = extract(file.language, text);

    importCache.set(file, imports);

    return imports;
}

/** The file set, namespace owners, and package directories one resolution pass needs. */
export interface ResolveIndex {
    root: string;
    files: ReadonlySet<string>;
    /** Namespace name → a file that declares it, for C# and PHP. */
    namespaces: ReadonlyMap<string, string>;
    /** Declaration qualified name (and its dotted form) → the file that declares it. */
    declarations: ReadonlyMap<string, string>;
    /** Directory paths relative to the root, longest first, for Go package specifiers. */
    directories: readonly string[];
}

export function createResolveIndex(options: {
    root: string;
    files: readonly string[];
    parsed: readonly ParsedFile[];
}): ResolveIndex {
    const namespaces = new Map<string, string>();
    const declarations = new Map<string, string>();

    for (const file of options.parsed) {
        for (const declaration of file.all) {
            for (const name of [
                declaration.qualifiedName,
                declaration.qualifiedName.replace(/::/g, "."),
            ]) {
                if (!declarations.has(name)) {
                    declarations.set(name, file.path);
                }
            }

            if (declaration.kind !== "namespace") {
                continue;
            }

            const name = declaration.qualifiedName;

            if (!namespaces.has(name)) {
                namespaces.set(name, file.path);
            }
        }
    }

    const directories = new Set<string>();

    for (const file of options.files) {
        const relative = path.relative(options.root, path.dirname(file));

        if (relative.length === 0 || relative.startsWith("..")) {
            continue;
        }

        directories.add(relative.replace(/\\/g, "/"));
    }

    return {
        root: options.root,
        files: new Set(options.files),
        namespaces,
        declarations,
        directories: Array.from(directories).toSorted((left, right) => right.length - left.length),
    };
}

export function resolveImports(
    file: ParsedFile,
    imports: readonly RawImport[],
    index: ResolveIndex,
): ResolvedImport[] {
    return imports.map((raw) => resolveOne(file, raw, index));
}

/**
 * Files that import `subject`, with the line that names it.
 *
 * This is a scan of every parsed file's import list, so it costs what `usages` costs: the parse cache makes it
 * cheap while the tree is warm, and a cold tree pays one parse.
 */
export function dependentsOf(
    subject: string,
    parsed: readonly ParsedFile[],
    index: ResolveIndex,
): Dependent[] {
    const dependents: Dependent[] = [];

    for (const file of parsed) {
        if (file.path === subject) {
            continue;
        }

        const hit = resolveImports(file, importsOf(file), index).find(
            (entry) =>
                entry.state === "local" && entry.directory !== true && entry.target === subject,
        );

        if (hit !== undefined) {
            dependents.push({ path: file.path, line: hit.line });
        }
    }

    return dependents.toSorted((left, right) => left.path.localeCompare(right.path));
}

function resolveOne(file: ParsedFile, raw: RawImport, index: ResolveIndex): ResolvedImport {
    const base = { specifier: raw.specifier, line: raw.line };

    if (raw.style === "path") {
        const target = pathCandidates(file, raw, index).find((candidate) =>
            index.files.has(candidate),
        );

        return target === undefined
            ? { ...base, state: "unresolved" }
            : { ...base, state: "local", target };
    }

    const symbol = resolveSymbol(file, raw.specifier, index);

    return symbol === undefined
        ? { ...base, state: "external" }
        : { ...base, state: "local", ...symbol };
}

/** Candidate target paths for a specifier that names a file, in preference order. */
function pathCandidates(file: ParsedFile, raw: RawImport, index: ResolveIndex): string[] {
    const from = path.dirname(file.path);
    const specifier = raw.specifier;

    switch (file.language) {
        case "javascript":
        case "typescript":
        case "tsx": {
            const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
            const base = path.resolve(from, specifier);

            return [
                base,
                ...extensions.map((extension) => `${base}${extension}`),
                ...extensions.map((extension) => path.join(base, `index${extension}`)),
            ];
        }
        case "cpp":
        case "hip": {
            // A quoted include is relative to the including file first, then to the scan root and the `include/`
            // directories above it — the two include roots a CMake/Make build usually has.
            return uniquePaths([
                path.resolve(from, specifier),
                path.resolve(index.root, specifier),
                ...includeCandidates(file, specifier),
            ]);
        }
        case "python": {
            const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
            let base = from;

            for (let level = 1; level < dots; level += 1) {
                base = path.dirname(base);
            }

            const rest = specifier.slice(dots).replace(/\./g, "/");

            if (rest.length === 0) {
                return [path.join(base, "__init__.py")];
            }

            return [path.join(base, `${rest}.py`), path.join(base, rest, "__init__.py")];
        }
        case "rust": {
            return rustCandidates(file, specifier, index);
        }
        case "ruby": {
            const base = path.resolve(from, specifier);

            return [base, `${base}.rb`];
        }
        default: {
            return [path.resolve(from, specifier)];
        }
    }
}

/** `crate::`, `self::`, and `super::` paths, longest first so a type at the end still resolves its module. */
function rustCandidates(file: ParsedFile, specifier: string, index: ResolveIndex): string[] {
    const parts = specifier.split("::").filter((part) => part.length > 0);

    if (parts.length === 0) {
        return [];
    }

    let base = path.dirname(file.path);
    let start = 0;

    if (parts[0] === "crate") {
        base = crateRootOf(file.path) ?? index.root;
        start = 1;
    } else if (parts[0] === "self") {
        start = 1;
    } else if (parts[0] === "super") {
        while (parts[start] === "super") {
            base = path.dirname(base);
            start += 1;
        }
    }

    const rest = parts.slice(start);
    const candidates: string[] = [];

    for (let length = rest.length; length > 0; length -= 1) {
        const target = path.join(base, ...rest.slice(0, length));

        candidates.push(`${target}.rs`, path.join(target, "mod.rs"));
    }

    return candidates;
}

/** `include/<specifier>` and `<specifier>` under every ancestor of the importing file. */
function includeCandidates(file: ParsedFile, specifier: string): string[] {
    const candidates: string[] = [];
    let directory = path.dirname(file.path);

    for (let depth = 0; depth < 12; depth += 1) {
        candidates.push(
            path.join(directory, "include", specifier),
            path.join(directory, specifier),
        );

        const parent = path.dirname(directory);

        if (parent === directory) {
            break;
        }

        directory = parent;
    }

    return candidates;
}

function uniquePaths(paths: readonly string[]): string[] {
    return Array.from(new Set(paths));
}

/** The `src` directory a Rust file belongs to, when it has one. */
function crateRootOf(filePath: string): string | undefined {
    let directory = path.dirname(filePath);

    while (directory.length > 0) {
        if (path.basename(directory) === "src") {
            return directory;
        }

        const parent = path.dirname(directory);

        if (parent === directory) {
            return undefined;
        }

        directory = parent;
    }

    return undefined;
}

/** Resolve a module, namespace, or package specifier against the scanned tree. */
function resolveSymbol(
    file: ParsedFile,
    specifier: string,
    index: ResolveIndex,
): Pick<ResolvedImport, "target" | "directory"> | undefined {
    if (file.language === "cpp" || file.language === "hip") {
        // `<vibes/core/x.hpp>` names a header through the build's include path, not a relative path. The candidates
        // are the `include/` and root directories of every ancestor of the importing file.
        const target = includeCandidates(file, specifier).find((candidate) =>
            index.files.has(candidate),
        );

        return target === undefined ? undefined : { target };
    }

    if (file.language === "python") {
        const relative = specifier.replace(/\./g, "/");
        // An absolute module can be rooted at the project or at the importing script's directory; both are common
        // `sys.path` entries, and trying both is what makes a script next to its package resolve.
        const target = firstExisting(index, [
            path.join(path.dirname(file.path), `${relative}.py`),
            path.join(path.dirname(file.path), relative, "__init__.py"),
            path.join(index.root, `${relative}.py`),
            path.join(index.root, relative, "__init__.py"),
        ]);

        return target === undefined ? undefined : { target };
    }

    if (file.language === "java") {
        const wildcard = specifier.endsWith(".*");
        const stem = (wildcard ? specifier.slice(0, -2) : specifier).replace(/\./g, "/");
        const suffix = wildcard ? `/${stem}/` : `/${stem}.java`;
        const match = Array.from(index.files)
            .filter((candidate) => candidate.replace(/\\/g, "/").endsWith(suffix))
            .toSorted()[0];

        return match === undefined ? undefined : { target: match };
    }

    if (file.language === "csharp" || file.language === "php") {
        // A namespace import names every type in it, so the file declaring the namespace is the target; an import of
        // a type names the declaration itself. PHP spells namespaces with backslashes, so compare in dotted form.
        const dotted = specifier.replace(/\\/g, ".");

        for (const [namespace, target] of index.namespaces) {
            const name = namespace.replace(/::/g, ".");

            if (name === dotted || name.startsWith(`${dotted}.`)) {
                return { target };
            }
        }

        const declared = index.declarations.get(dotted);

        return declared === undefined ? undefined : { target: declared };
    }

    if (file.language === "go") {
        const match = index.directories.find(
            (directory) => specifier === directory || specifier.endsWith(`/${directory}`),
        );

        return match === undefined
            ? undefined
            : { target: path.join(index.root, match), directory: true };
    }

    return undefined;
}

function firstExisting(index: ResolveIndex, candidates: readonly string[]): string | undefined {
    return candidates.find((candidate) => index.files.has(candidate));
}

// ---------------------------------------------------------------------------------------------------------------
// Extraction. Text-based and comment-masked: imports are a small, regular surface in every supported language, and
// the parse tree is released by the time a dependents scan asks for them.

type Push = (specifier: string, offset: number, style: ImportStyle, relative?: boolean) => void;

/** Extractor per language family; each sees comment-masked source. */
function extract(language: string, text: string): RawImport[] {
    const starts = lineStarts(text);
    const strings = stringRanges(text, 0, text.length);
    const found: Array<{
        specifier: string;
        offset: number;
        style: ImportStyle;
        relative: boolean;
    }> = [];
    const push: Push = (specifier, offset, style, relative = false) => {
        if (specifier.length === 0) {
            return;
        }

        // A specifier that names a file is resolved by path, everything else by module/namespace name. A leading dot
        // marks a relative path in every language that spells one that way, so it promotes the style too.
        const isPath = style === "path" || relative || specifier.startsWith(".");

        found.push({
            specifier,
            offset,
            style: isPath ? "path" : "symbol",
            relative: isPath,
        });
    };

    switch (language) {
        case "javascript":
        case "typescript":
        case "tsx":
            extractJavaScript(text, push);
            break;
        case "cpp":
        case "hip":
            extractCFamily(text, push);
            break;
        case "python":
            extractPython(text, push);
            break;
        case "rust":
            extractRust(text, push);
            break;
        case "java":
            extractJava(text, push);
            break;
        case "csharp":
            extractCSharp(text, push);
            break;
        case "go":
            extractGo(text, push);
            break;
        case "php":
            extractPhp(text, push);
            break;
        case "ruby":
            extractRuby(text, push);
            break;
        default:
            break;
    }

    const seen = new Set<string>();

    return found
        .filter(
            (entry) =>
                !strings.some((range) => range.start <= entry.offset && entry.offset < range.end),
        )
        .toSorted((left, right) => left.offset - right.offset)
        .filter((entry) => {
            const key = `${entry.specifier}\u0000${entry.style}\u0000${entry.relative}`;

            if (seen.has(key)) {
                return false;
            }

            seen.add(key);

            return true;
        })
        .map((entry) => ({
            specifier: entry.specifier,
            line: lineAt(starts, entry.offset),
            style: entry.style,
            relative: entry.relative,
        }));
}

function extractJavaScript(text: string, push: Push): void {
    // `import x from "y"`, `import "y"`, `export {a} from "y"`.
    forEachMatch(
        text,
        /(?:^|\n)[ \t]*import\b[\s\S]{0,300}?\bfrom\s*["']([^"'\n]+)["']/g,
        (match) => {
            push(match[1] ?? "", match.offset, "symbol");
        },
    );
    forEachMatch(text, /(?:^|\n)[ \t]*import\s*["']([^"'\n]+)["']/g, (match) => {
        push(match[1] ?? "", match.offset, "symbol");
    });
    forEachMatch(
        text,
        /(?:^|\n)[ \t]*export\b[\s\S]{0,300}?\bfrom\s*["']([^"'\n]+)["']/g,
        (match) => {
            push(match[1] ?? "", match.offset, "symbol");
        },
    );
    forEachMatch(text, /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g, (match) => {
        push(match[1] ?? "", match.offset, "symbol");
    });
}

function extractCFamily(text: string, push: Push): void {
    forEachMatch(text, /^[ \t]*#[ \t]*include[ \t]*([<"])([^>"]+)[>"]/gm, (match) => {
        const relative = (match[1] ?? "<") === '"';

        push(match[2] ?? "", match.offset, relative ? "path" : "symbol", relative);
    });
}

function extractPython(text: string, push: Push): void {
    forEachMatch(
        text,
        /^[ \t]*from[ \t]+(\.*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\.+)[ \t]+import\b/gm,
        (match) => {
            const specifier = match[1] ?? "";

            push(specifier, match.offset, specifier.startsWith(".") ? "path" : "symbol");
        },
    );
    forEachMatch(
        text,
        /^[ \t]*import[ \t]+([A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*)/gm,
        (match) => {
            for (const part of (match[1] ?? "").split(",")) {
                const specifier = part.trim();

                push(specifier, match.offset, "symbol");
            }
        },
    );
}

function extractRust(text: string, push: Push): void {
    forEachMatch(text, /^[ \t]*(?:pub[ \t]+)?use[ \t]+([^;\n]+);/gm, (match) => {
        const statement = (match[1] ?? "").replace(/\s+as\s+\w+$/, "").trim();
        const specifier = statement.split("::{")[0]?.replace(/::\*$/, "") ?? "";
        const rooted = /^(crate|self|super)(::|$)/.test(specifier);

        push(specifier, match.offset, rooted ? "path" : "symbol", rooted);
    });
}

function extractJava(text: string, push: Push): void {
    forEachMatch(
        text,
        /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+(?:\.\*)?)[ \t]*;/gm,
        (match) => {
            push(match[1] ?? "", match.offset, "symbol");
        },
    );
}

function extractCSharp(text: string, push: Push): void {
    forEachMatch(
        text,
        /^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:[A-Za-z_]\w*[ \t]*=[ \t]*)?([\w.]+)[ \t]*;/gm,
        (match) => {
            push(match[1] ?? "", match.offset, "symbol");
        },
    );
}

function extractGo(text: string, push: Push): void {
    forEachMatch(
        text,
        /^[ \t]*import[ \t]+(?:[._A-Za-z]\w*[ \t]+)?["']([^"'\n]+)["']/gm,
        (match) => {
            push(match[1] ?? "", match.offset, "symbol");
        },
    );
    forEachMatch(text, /^[ \t]*import[ \t]*\(([\s\S]*?)\)/gm, (match) => {
        forEachMatch(match[1] ?? "", /["']([^"'\n]+)["']/g, (inner) => {
            // The match inside a block starts at the quote, which the string filter would drop; a block import's
            // line is the `import` keyword's line anyway.
            push(inner[1] ?? "", match.offset, "symbol");
        });
    });
}

function extractPhp(text: string, push: Push): void {
    forEachMatch(
        text,
        /^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?\\?([A-Za-z_][\w\\]*)/gm,
        (match) => {
            push(match[1] ?? "", match.offset, "symbol");
        },
    );
}

function extractRuby(text: string, push: Push): void {
    forEachMatch(
        text,
        /\b(require_relative|require)\b[ \t]*\(?[ \t]*["']([^"'\n]+)["']/g,
        (match) => {
            const relative = match[1] === "require_relative";

            push(match[2] ?? "", match.offset, relative ? "path" : "symbol", relative);
        },
    );
}

/** RegExpExecArray plus the absolute offset of the match, since `^` matches make `index` the newline. */
interface Match {
    [index: number]: string | undefined;
    offset: number;
}

function forEachMatch(text: string, pattern: RegExp, visit: (match: Match) => void): void {
    for (const match of text.matchAll(pattern)) {
        const raw = match[0];

        if (raw === undefined) {
            continue;
        }

        // `^` matches after a newline, so skip to the first non-newline character for the offset.
        const leading = raw.length - raw.replace(/^\n/, "").length;
        const found: Match = { offset: (match.index ?? 0) + leading };

        for (const [index, group] of match.entries()) {
            found[index] = group;
        }

        visit(found);
    }
}

function lineStarts(text: string): number[] {
    const starts = [0];

    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "\n") {
            starts.push(index + 1);
        }
    }

    return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
    let low = 0;
    let high = starts.length - 1;

    while (low < high) {
        const middle = Math.ceil((low + high) / 2);

        if ((starts[middle] ?? 0) <= offset) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    return low + 1;
}
