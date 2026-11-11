import path from "node:path";

import { discoverFiles } from "./discovery";
import { declarationLine, isFunctionLike, nextOffsetNote, renderWithinBudget } from "./format";
import { DEFAULT_CHAR_LIMIT, MAX_FILES, languageForPath, sizeLabel } from "./languages";
import { loadParsedFiles } from "./load";
import type { CodeSource } from "./source";
import { CallTiming } from "./timing";
import type { CodeDetail, CodeToolParams, Declaration, ParsedFile } from "./types";

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
    const root = source.resolvePath(params.path ?? ".");

    await source.assertReadable(root);

    const discovery = await timing.measure("discover", () => discoverFiles(source, root, signal));

    if (discovery.unsupportedRoot) {
        return {
            text: `# digest ${source.displayPath(root)} · unsupported file\n# no supported declarations to map`,
            files: 0,
            parseErrors: 0,
            truncated: false,
        };
    }

    if (discovery.files.length === 0) {
        return {
            text: `# digest ${source.displayPath(root)} · no supported source files`,
            files: 0,
            parseErrors: 0,
            truncated: false,
        };
    }

    const batch = await timing.measure("parse", () =>
        loadParsedFiles(source, discovery.files, signal),
    );
    timing.recordLoad(batch, discovery.files.length);
    const parsed = batch.parsed.toSorted((left, right) => left.path.localeCompare(right.path));
    const parseErrors = parsed.reduce((total, file) => total + file.parseErrors, 0);

    if (parsed.length === 0) {
        return {
            text: [
                `# digest ${source.displayPath(root)} · no readable supported files`,
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
    const fileBlocks = parsed.map((file) => renderFile(source, file, detail));

    const fullBody = fileBlocks.join("\n");
    const header = digestHeader(source, root, parsed, languages, fullBody);
    const footer = digestFooter(
        batch.tooLarge,
        discovery.unsupportedFiles,
        discovery.truncated,
        parseErrors,
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

    if (!fits && !discovery.rootIsFile) {
        const map = renderDirectoryMap(source, root, discovery.files, limit);

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

function renderFile(source: CodeSource, file: ParsedFile, detail: CodeDetail): string {
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

    const header = `${source.displayPath(file.path)} [${sizeLabel(file.lineCount)}]`;

    if (lines.length === 0) {
        return `${header}\n  # no declarations`;
    }

    if (huge) {
        lines.push("  # huge file: member detail omitted; use outline show for a symbol");
    }

    return `${header}\n${lines.join("\n")}`;
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
    source: CodeSource,
    root: string,
    parsed: readonly ParsedFile[],
    languages: string,
    body: string,
): string {
    return `# digest ${source.displayPath(root)} · ${parsed.length} files · ${languages} · ~${body.length} chars`;
}

function digestFooter(
    tooLarge: number,
    unsupported: number,
    truncated: boolean,
    parseErrors: number,
): string {
    const notes: string[] = [];

    if (tooLarge > 0) {
        notes.push(`# skipped: ${tooLarge} file(s) above the size limit`);
    }

    if (unsupported > 0) {
        notes.push(`# skipped: ${unsupported} unsupported file(s)`);
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
