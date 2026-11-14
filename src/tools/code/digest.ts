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
    const accessHidden = rendered.reduce((total, entry) => total + entry.accessHidden, 0);
    const signatureHidden = new Map<DeclarationKind, number>();
    for (const entry of rendered) {
        for (const [hiddenKind, count] of entry.signatureHidden) {
            signatureHidden.set(hiddenKind, (signatureHidden.get(hiddenKind) ?? 0) + count);
        }
    }
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
    // Not part of the footer: the directory map below shows no members, so the note would describe a filter that did
    // not cost that result anything.
    const visibilityNote =
        accessHidden > 0
            ? `# visibility: ${accessHidden} non-public member(s) hidden; detail=full lists all`
            : "";
    // A single-file digest is the caller asking what is in this file, so naming the kinds signatures mode left out
    // is the difference between a map and a dead end. A directory digest would repeat the line per file, where the
    // visibility footer and `detail="full"` already carry the general rule.
    const signaturesNote =
        discovery.rootIsFile && signatureHidden.size > 0
            ? `# kinds: ${describeSignatureHides(signatureHidden)} hidden in signatures detail; detail=full lists all`
            : "";
    const fullText = [header, fullBody, footer, visibilityNote, signaturesNote]
        .filter((part) => part.length > 0)
        .join("\n");
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
        text: [fitted.text, next, footer, visibilityNote, signaturesNote]
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
    const tally: RenderTally = { accessHidden: 0, signatureHidden: new Map() };
    const roots: Declaration[] = [];

    for (const declaration of file.roots) {
        const reason = hideReason(declaration, detail, true);

        if (reason === "kind") {
            tally.signatureHidden.set(
                declaration.kind,
                (tally.signatureHidden.get(declaration.kind) ?? 0) + 1,
            );
            continue;
        }

        if (reason === undefined) {
            roots.push(declaration);
        }
    }

    for (const declaration of roots) {
        if (huge) {
            lines.push(
                declarationLine(declaration, 0, {
                    includeDefTag: isFunctionLike(declaration.kind),
                }),
            );

            continue;
        }

        lines.push(...renderDeclaration(declaration, 0, detail, tally));
    }

    if (lines.length === 0) {
        const hidden = describeSignatureHides(tally.signatureHidden);

        return {
            text:
                hidden === ""
                    ? `${header}\n  # no declarations`
                    : `${header}\n  # no declarations visible in signatures detail; ${hidden} hidden — use detail="full"`,
            hidden: 0,
            total,
            accessHidden: tally.accessHidden,
            signatureHidden: tally.signatureHidden,
        };
    }

    if (huge) {
        lines.push("  # huge file: member detail omitted; use outline show for a symbol");
    }

    return {
        text: `${header}\n${lines.join("\n")}`,
        hidden: 0,
        total,
        accessHidden: tally.accessHidden,
        signatureHidden: tally.signatureHidden,
    };
}

interface RenderedFile {
    /** Empty when the kind filter removed every declaration in the file. */
    text: string;
    hidden: number;
    total: number;
    /** Members signatures mode left out for their access, so the footer can say so. */
    accessHidden: number;
    /** Declarations signatures mode left out by kind, counted per kind for the single-file note. */
    signatureHidden: ReadonlyMap<DeclarationKind, number>;
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
        return { text: "", hidden: total, total, accessHidden: 0, signatureHidden: new Map() };
    }

    const lines = matched.map((declaration) =>
        declarationLine(declaration, 0, { includeDefTag: isFunctionLike(declaration.kind) }),
    );

    return {
        text: `${header}\n${lines.join("\n")}`,
        hidden: total - matched.length,
        total,
        accessHidden: 0,
        signatureHidden: new Map(),
    };
}

interface RenderTally {
    /** Class, trait, struct, and union members that signatures mode dropped for their access. */
    accessHidden: number;
    /** Declarations signatures mode dropped by kind, counted per kind. */
    signatureHidden: Map<DeclarationKind, number>;
}

/** "2 enum members, 1 field" — the kinds a single-file digest left out, largest group first. */
function describeSignatureHides(counts: ReadonlyMap<DeclarationKind, number>): string {
    return [...counts.entries()]
        .filter(([, count]) => count > 0)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([kind, count]) => {
            if (kind === "enumMember") {
                return count === 1 ? "1 enum member" : `${count} enum members`;
            }

            return count === 1 ? `1 ${kind}` : `${count} ${kind}s`;
        })
        .join(", ");
}

function renderDeclaration(
    declaration: Declaration,
    depth: number,
    detail: CodeDetail,
    tally: RenderTally,
): string[] {
    const lines = [
        declarationLine(declaration, depth, {
            includeLine: true,
            includeDefTag: isFunctionLike(declaration.kind),
        }),
    ];

    for (const child of declaration.children) {
        const reason = hideReason(child, detail, false, declaration);

        if (reason !== undefined) {
            if (reason === "access") {
                tally.accessHidden += 1;
            } else {
                tally.signatureHidden.set(
                    child.kind,
                    (tally.signatureHidden.get(child.kind) ?? 0) + 1,
                );
            }

            continue;
        }

        lines.push(...renderDeclaration(child, depth + 1, detail, tally));
    }

    return lines;
}

/**
 * Why signatures mode leaves a declaration out, if it does.
 *
 * `access` is reported separately from `kind`: dropping an `enumMember` or a nested `variable` is the documented
 * shape of a signature list, but dropping every non-public member is a visibility rule, and a caller reading the
 * class's own extension points (`getItemPrefix`, `handleAction`) has no way to tell a class with no such members
 * from a class whose members were filtered. The footer names that count. A **root** variable is different: it is
 * a module-level constant, part of the file's own map, so it stays visible even though a const inside a namespace
 * or function body does not.
 */
type HideReason = "access" | "kind";

function hideReason(
    declaration: Declaration,
    detail: CodeDetail,
    isRoot: boolean,
    parent?: Declaration,
): HideReason | undefined {
    if (detail === "full") {
        return undefined;
    }

    if (declaration.kind === "enumMember") {
        return "kind";
    }

    if (declaration.kind === "field") {
        return parent?.kind === "struct" || parent?.kind === "union" || parent?.kind === "interface"
            ? undefined
            : "kind";
    }

    if (declaration.kind === "variable" && !isRoot) {
        return "kind";
    }

    if (parent?.kind === "class" || parent?.kind === "trait") {
        return declaration.access === "public" ? undefined : "access";
    }

    if (parent?.kind === "struct" || parent?.kind === "union") {
        return declaration.access === "private" || declaration.access === "protected"
            ? "access"
            : undefined;
    }

    return undefined;
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
    const directories = new Map<
        string,
        { count: number; languages: Set<string>; names: string[] }
    >();
    const rootNames: string[] = [];

    for (const file of files) {
        const relative = path.relative(root, file);

        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            continue;
        }

        const parts = relative.split(path.sep);

        if (parts.length === 1) {
            rootNames.push(path.basename(file));

            continue;
        }

        const directory = parts[0] ?? "";

        if (directory.length === 0) {
            continue;
        }

        const entry = directories.get(directory) ?? {
            count: 0,
            languages: new Set<string>(),
            names: [],
        };

        entry.count += 1;
        entry.names.push(parts.slice(1).join("/"));

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
    const largest = sorted[0]?.[0];
    const next =
        largest === undefined
            ? undefined
            : `# next: outline digest ${joinDisplay(displayRoot, largest)}`;

    // A map of directory names answers "where is the code" but not "which file", and a caller who asked for
    // `src/tui` is usually after one of the fifteen files sitting right there. So names are added while the budget
    // allows, most informative first: the root's own files (no subdirectory to find them in), then each directory in
    // size order. A truncated list says how many it left out, and the elided directories are one `digest` away.
    let remaining = limit - lines[0].length - (next === undefined ? 1 : next.length + 2);

    const addNames = (names: readonly string[]): void => {
        let shown = 0;

        for (const line of nameLines(names)) {
            if (line.text.length + 1 > remaining) {
                break;
            }

            lines.push(line.text);
            remaining -= line.text.length + 1;
            shown += line.count;
        }

        const more = `  # … ${names.length - shown} more`;

        if (shown < names.length && more.length + 1 <= remaining) {
            lines.push(more);
            remaining -= more.length + 1;
        }
    };

    if (rootNames.length > 0) {
        const summary = `.  ${rootNames.length} files`;

        lines.push(summary);
        remaining -= summary.length + 1;
        addNames(rootNames.toSorted());
    }

    for (const [directory, entry] of sorted) {
        const languages = Array.from(entry.languages).toSorted().join(",");
        const summary = `${directory}/  ${entry.count} files  ${languages}`;

        lines.push(summary);
        remaining -= summary.length + 1;
        addNames(entry.names.toSorted());
    }

    if (next !== undefined) {
        lines.push(next);
    }

    return lines.join("\n");
}

interface NameLine {
    text: string;
    /** Names on the line, so a truncated list can report how many it left out. */
    count: number;
}

/** Indented, space-separated file names packed into lines of at most `width` characters. */
function nameLines(names: readonly string[], width = 110): NameLine[] {
    const lines: NameLine[] = [];
    let current: string[] = [];

    const flush = (): void => {
        if (current.length > 0) {
            lines.push({ text: `  ${current.join(" ")}`, count: current.length });
            current = [];
        }
    };

    for (const name of names) {
        if (current.length > 0 && [...current, name].join(" ").length + 2 > width) {
            flush();
        }

        current.push(name);
    }

    flush();

    return lines;
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
