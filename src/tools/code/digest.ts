import path from "node:path";

import { discoverFiles, filterPathTarget, parsePathTarget, patternWithinTarget } from "./discovery";
import {
    declarationLine,
    discoveryCapNote,
    filterNote,
    isFunctionLike,
    nextOffsetNote,
    renderWithinBudget,
} from "./format";
import { DEFAULT_CHAR_LIMIT, MAX_FILES, languageForPath, sizeLabel } from "./languages";
import { loadParsedFiles } from "./load";
import type { CodeSource } from "./source";
import { CallTiming } from "./timing";
import {
    isDeclarationKind,
    type CodeDetail,
    type CodeToolParams,
    type Declaration,
    type DeclarationKind,
    type ParsedFile,
} from "./types";

export interface DigestResult {
    text: string;
    files: number;
    parseErrors: number;
    truncated: boolean;
}

export async function runDigest(
    source: CodeSource,
    params: CodeToolParams,
    signal?: AbortSignal,
    timing: CallTiming = new CallTiming(),
): Promise<DigestResult> {
    const detail: CodeDetail = params.detail ?? "signatures";
    const limit = params.limit ?? DEFAULT_CHAR_LIMIT;
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const target = parsePathTarget(params.path);
    const root = source.resolvePath(target.base);
    const scope = target.pattern ?? source.displayPath(root);

    await source.assertReadable(root);

    const discovery = await timing.measure("discover", () =>
        discoverFiles(source, root, signal, patternWithinTarget(target)),
    );

    if (discovery.unsupportedRoot) {
        return {
            text: `# digest ${scope} · unsupported file\n# no supported declarations to map`,
            files: 0,
            parseErrors: 0,
            truncated: false,
        };
    }

    if (discovery.files.length === 0) {
        return {
            text: `# digest ${scope} · ${target.pattern === undefined ? "no supported source files" : "no files match"}`,
            files: 0,
            parseErrors: 0,
            truncated: false,
        };
    }

    const targeted = filterPathTarget(discovery.files, source, target);

    if (targeted.files.length === 0) {
        return {
            text: [
                `# digest ${scope} · no files match`,
                discovery.truncated ? discoveryCapNote() : "",
            ]
                .filter((line) => line.length > 0)
                .join("\n"),
            files: 0,
            parseErrors: 0,
            truncated: discovery.truncated,
        };
    }

    const batch = await timing.measure("parse", () =>
        loadParsedFiles(source, targeted.files, signal),
    );
    timing.recordLoad(batch, targeted.files.length);
    const parsed = batch.parsed.toSorted((left, right) => left.path.localeCompare(right.path));
    const parseErrors = parsed.reduce((total, file) => total + file.parseErrors, 0);

    if (parsed.length === 0) {
        return {
            text: [
                `# digest ${scope} · no readable supported files`,
                batch.tooLarge > 0
                    ? `# skipped: ${batch.tooLarge} file(s) above the size limit`
                    : "",
                ...batch.errors.slice(0, 3).map((error) => `# ${error}`),
            ]
                .filter((line) => line.length > 0)
                .join("\n"),
            files: 0,
            parseErrors,
            truncated: discovery.truncated,
        };
    }

    const languages = languagesOf(parsed);
    const kind =
        params.kind !== undefined && isDeclarationKind(params.kind) ? params.kind : undefined;
    const rendered = parsed.map((file) => renderFile(source, file, detail, kind));
    const kindHidden = rendered.reduce((total, entry) => total + entry.hidden, 0);
    const filter = filterNote({
        path: target.pattern,
        pathHidden: targeted.hidden,
        kind,
        kindHidden,
    });

    if (kind !== undefined && rendered.every((entry) => entry.hidden === entry.total)) {
        return {
            text: [
                `# digest ${scope} · filter kind=${kind} · no matching declarations`,
                filter ?? "",
            ]
                .filter((line) => line.length > 0)
                .join("\n"),
            files: parsed.length,
            parseErrors,
            truncated: discovery.truncated,
        };
    }

    const fileBlocks = rendered.map((entry) => entry.text).filter((text) => text.length > 0);

    const fullBody = fileBlocks.join("\n");
    const header = digestHeader(scope, parsed, languages, fullBody);
    const footer = digestFooter(
        batch.tooLarge,
        discovery.unsupportedFiles,
        discovery.truncated,
        parseErrors,
        filter,
    );
    const fullText = [header, fullBody, footer].filter((part) => part.length > 0).join("\n");
    const fits = fullText.length <= limit;

    if (fits && offset === 0) {
        return {
            text: fullText,
            files: parsed.length,
            parseErrors,
            truncated: discovery.truncated,
        };
    }

    // A kind filter must not degrade to the directory map: the caller asked for declarations of one kind, and a map of
    // directory names answers a different question. Page the flat list instead, so `# next: offset=N` continues it.
    if (!fits && !discovery.rootIsFile && kind === undefined) {
        const map = renderDirectoryMap(source, root, targeted.files, limit);

        if (map !== undefined) {
            if (offset === 0) {
                return {
                    text: [map, footer].filter((part) => part.length > 0).join("\n"),
                    files: parsed.length,
                    parseErrors,
                    truncated: true,
                };
            }

            const mapLines = map.split("\n");
            const fitted = renderWithinBudget(
                mapLines[0] ?? "",
                [mapLines.slice(1).join("\n")],
                limit,
                offset,
            );
            const next = nextOffsetNote(fitted);

            return {
                text: [fitted.text, next, footer]
                    .filter((part): part is string => part !== undefined && part.length > 0)
                    .join("\n"),
                files: parsed.length,
                parseErrors,
                truncated: true,
            };
        }
    }

    const fitted = renderWithinBudget(header, [fullBody], limit, offset);
    const next = nextOffsetNote(fitted);

    return {
        text: [fitted.text, next, footer]
            .filter((part): part is string => part !== undefined && part.length > 0)
            .join("\n"),
        files: parsed.length,
        parseErrors,
        truncated: fitted.truncated || discovery.truncated,
    };
}

function renderFile(
    source: CodeSource,
    file: ParsedFile,
    detail: CodeDetail,
    kind: DeclarationKind | undefined,
): RenderedFile {
    const header = `${source.displayPath(file.path)} [${sizeLabel(file.lineCount)}]`;
    const total = file.all.length;

    if (kind !== undefined) {
        return renderKind(file, header, kind, total);
    }

    const lines: string[] = [];
    const huge = sizeLabel(file.lineCount) === "huge" && detail !== "full";

    for (const declaration of visibleRoots(file, detail)) {
        if (huge) {
            lines.push(
                declarationLine(declaration, 0, {
                    includeDefTag: isFunctionLike(declaration.kind),
                }),
            );

            continue;
        }

        lines.push(...renderDeclaration(declaration, 0, detail));
    }

    if (lines.length === 0) {
        return { text: `${header}\n  # no declarations`, hidden: 0, total };
    }

    if (huge) {
        lines.push("  # huge file: member detail omitted; use outline show for a symbol");
    }

    return { text: `${header}\n${lines.join("\n")}`, hidden: 0, total };
}

interface RenderedFile {
    /** Empty when the kind filter removed every declaration in the file. */
    text: string;
    hidden: number;
    total: number;
}

/**
 * A kind filter lists the matching declarations flat.
 *
 * No ancestor lines: the qualified name already carries the container, and an indented child whose parent was
 * filtered out would read as a tree that does not exist.
 */
function renderKind(
    file: ParsedFile,
    header: string,
    kind: DeclarationKind,
    total: number,
): RenderedFile {
    const matched = file.all.filter((declaration) => declaration.kind === kind);

    if (matched.length === 0) {
        return { text: "", hidden: total, total };
    }

    const lines = matched.map((declaration) =>
        declarationLine(declaration, 0, { includeDefTag: isFunctionLike(declaration.kind) }),
    );

    return {
        text: `${header}\n${lines.join("\n")}`,
        hidden: total - matched.length,
        total,
    };
}

function visibleRoots(file: ParsedFile, detail: CodeDetail): Declaration[] {
    return file.roots.filter((declaration) => isVisible(declaration, detail, true));
}

function renderDeclaration(declaration: Declaration, depth: number, detail: CodeDetail): string[] {
    const lines = [
        declarationLine(declaration, depth, {
            includeLine: true,
            includeDefTag: isFunctionLike(declaration.kind),
        }),
    ];

    for (const child of declaration.children) {
        if (!isVisible(child, detail, false, declaration)) {
            continue;
        }

        lines.push(...renderDeclaration(child, depth + 1, detail));
    }

    return lines;
}

function isVisible(
    declaration: Declaration,
    detail: CodeDetail,
    isRoot: boolean,
    parent?: Declaration,
): boolean {
    if (detail === "full") {
        return true;
    }

    if (isRoot && declaration.kind === "variable") {
        return false;
    }

    if (declaration.kind === "enumMember") {
        return false;
    }

    if (declaration.kind === "field") {
        return (
            parent?.kind === "struct" || parent?.kind === "union" || parent?.kind === "interface"
        );
    }

    if (declaration.kind === "variable") {
        return false;
    }

    if (parent?.kind === "class" || parent?.kind === "trait") {
        return declaration.access === "public";
    }

    if (parent?.kind === "struct" || parent?.kind === "union") {
        return declaration.access !== "private" && declaration.access !== "protected";
    }

    return true;
}

function digestHeader(
    scope: string,
    parsed: readonly ParsedFile[],
    languages: string,
    body: string,
): string {
    return `# digest ${scope} · ${parsed.length} files · ${languages} · ~${body.length} chars`;
}

function digestFooter(
    tooLarge: number,
    unsupported: number,
    truncated: boolean,
    parseErrors: number,
    filter: string | undefined,
): string {
    const notes: string[] = [];

    if (tooLarge > 0) {
        notes.push(`# skipped: ${tooLarge} file(s) above the size limit`);
    }

    if (unsupported > 0) {
        notes.push(`# skipped: ${unsupported} unsupported file(s)`);
    }

    if (filter !== undefined) {
        notes.push(filter);
    }

    if (truncated) {
        notes.push(`# skipped: file list truncated at ${MAX_FILES} files`);
    }

    if (parseErrors > 0) {
        notes.push(
            `# parse: ${parseErrors} error node(s); declarations still shown where possible`,
        );
    }

    if (notes.length === 0) {
        return "";
    }

    return notes.join("\n");
}

function renderDirectoryMap(
    source: CodeSource,
    root: string,
    files: readonly string[],
    limit: number,
): string | undefined {
    const directories = new Map<string, { count: number; languages: Set<string> }>();
    let rootFiles = 0;

    for (const file of files) {
        const relative = path.relative(root, file);

        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            continue;
        }

        const parts = relative.split(path.sep);

        if (parts.length === 1) {
            rootFiles += 1;

            continue;
        }

        const directory = parts[0] ?? "";

        if (directory.length === 0) {
            continue;
        }

        const entry = directories.get(directory) ?? { count: 0, languages: new Set<string>() };

        entry.count += 1;

        const language = languageForPath(file);

        if (language !== undefined) {
            entry.languages.add(language);
        }

        directories.set(directory, entry);
    }

    const displayRoot = source.displayPath(root);

    if (directories.size === 0) {
        const names = files.map((file) => path.basename(file)).toSorted();
        const shownNames = names.slice(0, 80);
        const lines = [
            `# digest ${displayRoot} · ${files.length} files · over character limit (~${limit} chars)`,
            ...shownNames.map((name) => `  ${name}`),
        ];

        if (names.length > shownNames.length) {
            lines.push(`  # … ${names.length - shownNames.length} more file(s)`);
        }

        if (names.length > 0) {
            lines.push(`# next: outline digest ${joinDisplay(displayRoot, names[0] ?? "")}`);
        }

        return lines.join("\n");
    }

    const sorted = Array.from(directories.entries()).toSorted(
        (left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]),
    );
    const lines = [
        `# digest ${displayRoot} · ${files.length} files · over character limit (~${limit} chars)`,
    ];

    if (rootFiles > 0) {
        lines.push(`.  ${rootFiles} files`);
    }

    for (const [directory, entry] of sorted) {
        const languages = Array.from(entry.languages).toSorted().join(",");

        lines.push(`${directory}/  ${entry.count} files  ${languages}`);
    }

    const largest = sorted[0]?.[0];

    if (largest !== undefined) {
        lines.push(`# next: outline digest ${joinDisplay(displayRoot, largest)}`);
    }

    return lines.join("\n");
}

function languagesOf(parsed: readonly ParsedFile[]): string {
    return Array.from(new Set(parsed.map((file) => file.language)))
        .toSorted()
        .join(",");
}

function joinDisplay(root: string, child: string): string {
    if (root === ".") {
        return child;
    }

    return `${root.replace(/\/$/, "")}/${child}`;
}
