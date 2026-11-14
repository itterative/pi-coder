import path from "node:path";

import { discoverFiles, filterPathTarget, parsePathTarget, patternWithinTarget } from "./discovery";
import {
    bodyThenFooter,
    counted,
    declarationKindCounts,
    declarationLine,
    discoveryCapNote,
    filterNote,
    isDefinitionTagged,
    nextOffsetNote,
    renderWithinBudget,
    scopeLabel,
} from "./format";
import { DEFAULT_CHAR_LIMIT, MAX_FILES, sizeLabel } from "./languages";
import { loadParsedFiles } from "./load";
import type { CodeSource } from "./source";
import { CallTiming } from "./timing";
import { buildUsageIndex, scopeAt } from "./usages";
import {
    isDeclarationKind,
    matchesDeclarationKind,
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
            text: bodyThenFooter(
                [`# digest ${scope} · no files match`],
                [discovery.truncated ? discoveryCapNote() : ""],
            ),
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
            text: bodyThenFooter(
                [`# digest ${scope} · no readable supported files`],
                [
                    batch.tooLarge > 0
                        ? `# skipped: ${batch.tooLarge} file(s) above the size limit`
                        : "",
                    ...batch.errors.slice(0, 3).map((error) => `# ${error}`),
                ],
            ),
            files: 0,
            parseErrors,
            truncated: discovery.truncated,
        };
    }

    const languages = languagesOf(parsed);
    const kind =
        params.kind !== undefined && isDeclarationKind(params.kind) ? params.kind : undefined;
    const rendered = await timing.measure("search", async () => {
        const files: RenderedFile[] = [];

        for (const file of parsed) {
            files.push(await renderFile(source, file, detail, kind, signal));
        }

        return files;
    });
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
        kindCounts: kind === undefined ? undefined : declarationKindCounts(parsed),
    });

    if (kind !== undefined && rendered.every((entry) => entry.hidden === entry.total)) {
        return {
            text: bodyThenFooter(
                [`# digest ${scope} · filter kind=${kind} · no matching declarations`],
                [filter],
            ),
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
    const fullText = bodyThenFooter([header, fullBody], [footer, visibilityNote, signaturesNote]);
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
        const map = renderDirectoryMap(source, root, parsed, limit, scope);

        if (map !== undefined) {
            if (offset === 0) {
                return {
                    text: bodyThenFooter([map], [footer]),
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
                text: bodyThenFooter([fitted.text], [next, footer]),
                files: parsed.length,
                parseErrors,
                truncated: true,
            };
        }
    }

    const fitted = renderWithinBudget(header, [fullBody], limit, offset);
    const next = nextOffsetNote(fitted);

    return {
        text: bodyThenFooter([fitted.text], [next, footer, visibilityNote, signaturesNote]),
        files: parsed.length,
        parseErrors,
        truncated: fitted.truncated || discovery.truncated,
    };
}

async function renderFile(
    source: CodeSource,
    file: ParsedFile,
    detail: CodeDetail,
    kind: DeclarationKind | undefined,
    signal?: AbortSignal,
): Promise<RenderedFile> {
    // The line count, not a size band: `[tiny]` told a reader nothing they could act on, while `[812 lines]` says both
    // how big the file is and whether the rows below are all of it.
    const header = `${source.displayPath(file.path)} [${file.lineCount} ${file.lineCount === 1 ? "line" : "lines"}]`;
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
                    includeDefTag: isDefinitionTagged(declaration.kind),
                }),
            );

            continue;
        }

        lines.push(...renderDeclaration(declaration, 0, detail, tally));
    }

    if (lines.length === 0) {
        const hidden = describeSignatureHides(tally.signatureHidden);

        if (hidden !== "") {
            return {
                text: `${header}\n  # no declarations visible in signatures detail; ${hidden} hidden — use detail="full"`,
                hidden: 0,
                total,
                accessHidden: tally.accessHidden,
                signatureHidden: tally.signatureHidden,
            };
        }

        return {
            text: `${header}\n${await emptyMap(source, file, signal)}`,
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
/**
 * What a file with nothing to map says instead of "no declarations".
 *
 * The declaration model cannot see a script: an entrypoint is a list of calls, and `# no declarations` reads as
 * "this file holds no structure" - the one answer that teaches an agent the tool does not apply here. So the empty
 * case counts the call sites the file does have and names the action that lists them.
 */
async function emptyMap(
    source: CodeSource,
    file: ParsedFile,
    signal?: AbortSignal,
): Promise<string> {
    const calls = await topLevelCalls(file, signal);

    if (calls === 0) {
        return "  # no declarations · no top-level statements (a re-export, a comment, or a file the parser could not read)";
    }

    const where = source.displayPath(file.path);

    return `  # no declarations · ${calls} top-level call site${calls === 1 ? "" : "s"} · outline(action="flow", path="${where}") lists them`;
}

/** Call sites that belong to no declaration: the body of a script or an entrypoint. One per line, like `flow`. */
async function topLevelCalls(file: ParsedFile, signal?: AbortSignal): Promise<number> {
    const index = await buildUsageIndex(file, signal);
    const lines = new Set<number>();

    for (const entry of index.entries) {
        if (entry.tag !== "call" && entry.tag !== "launch") {
            continue;
        }

        if (scopeAt(index.scopes, entry.startIndex) !== undefined) {
            continue;
        }

        lines.add(entry.line);
    }

    return lines.size;
}

function renderKind(
    file: ParsedFile,
    header: string,
    kind: DeclarationKind,
    total: number,
): RenderedFile {
    const matched = file.all.filter((declaration) =>
        matchesDeclarationKind(declaration.kind, kind),
    );

    if (matched.length === 0) {
        return { text: "", hidden: total, total, accessHidden: 0, signatureHidden: new Map() };
    }

    // A kind filter lists members flat, so the container that the tree would have carried has to be named — but only
    // when it is a type. A namespace-level function's owner (`vibes::hip::blas`) is not a class the caller can select
    // on, and printing it made every row read like a qualified name with no member on the end.
    const typeOwners = new Set(
        file.all
            .filter(
                (declaration) =>
                    declaration.kind === "class" ||
                    declaration.kind === "struct" ||
                    declaration.kind === "union" ||
                    declaration.kind === "interface" ||
                    declaration.kind === "trait" ||
                    declaration.kind === "enum",
            )
            .map((declaration) => declaration.qualifiedName),
    );
    const lines = matched.map((declaration) => {
        const row = declarationLine(declaration, 0, {
            includeDefTag: isDefinitionTagged(declaration.kind),
        });
        const separator = declaration.qualifiedName.lastIndexOf("::");
        const owner = separator === -1 ? "" : declaration.qualifiedName.slice(0, separator);

        return owner.length === 0 || !typeOwners.has(owner) ? row : `${owner}::  ${row}`;
    });

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
            includeDefTag: isDefinitionTagged(declaration.kind),
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
    return `# digest ${scopeLabel(scope)} · ${counted(parsed.length, "file")} · ${languages} · ~${body.length} chars`;
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

/** Child directories named on a directory's structure line before the rest are counted. */
const MAX_CHILD_DIRS = 12;

/** Room reserved per named directory for its `# … N more` note, so a note never falls off a full page. */
const NAME_NOTE_RESERVE = 24;

/** Files a flat map names before summarising the rest; one name per line, as it always was. */
const FLAT_MAP_NAMES = 80;

function renderDirectoryMap(
    source: CodeSource,
    root: string,
    parsed: readonly ParsedFile[],
    limit: number,
    scope: string,
): string | undefined {
    const directories = new Map<string, MapDirectory>();
    const rootFiles: MapFile[] = [];

    for (const file of parsed) {
        const relative = path.relative(root, file.path);

        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            continue;
        }

        const parts = relative.split(path.sep);
        const entry: MapFile = {
            label: parts.at(-1) ?? relative,
            declarations: file.all.length,
        };

        if (parts.length === 1) {
            rootFiles.push(entry);

            continue;
        }

        const directory = parts[0] ?? "";

        if (directory.length === 0) {
            continue;
        }

        const dir = directories.get(directory) ?? {
            name: directory,
            files: 0,
            languages: new Set<string>(),
            direct: [],
            children: new Map<string, number>(),
        };

        dir.files += 1;
        dir.languages.add(file.language);

        if (parts.length === 2) {
            dir.direct.push(entry);
        } else {
            const child = parts[1] ?? "";
            dir.children.set(child, (dir.children.get(child) ?? 0) + 1);
        }

        directories.set(directory, dir);
    }

    const displayRoot = source.displayPath(root);
    const header = `# digest ${scopeLabel(scope)} · ${counted(parsed.length, "file")} · declarations exceed the ${limit}-char limit; showing the map with declaration counts`;

    if (directories.size === 0) {
        return renderFlatMap(header, rootFiles);
    }

    const sortedDirs = [...directories.values()].toSorted(
        (left, right) => right.files - left.files || left.name.localeCompare(right.name),
    );
    const deeper = sortedDirs
        .slice(0, 3)
        .map((dir) => `outline digest ${joinDisplay(displayRoot, dir.name)}`);
    const notes = [
        "# names: file (declarations) · dir/ files",
        deeper.length === 0 ? "" : `# deeper: ${deeper.join(" · ")}`,
    ].filter((line) => line.length > 0);
    const namedDirs =
        sortedDirs.filter((dir) => dir.direct.length > 0).length + (rootFiles.length > 0 ? 1 : 0);
    const budget = {
        remaining:
            limit -
            header.length -
            notes.reduce((sum, line) => sum + line.length + 1, 0) -
            NAME_NOTE_RESERVE * Math.min(namedDirs, 20),
    };

    // Structure first: every directory gets its summary and its child directories, so none is a bare count. Then
    // names are spread one packed line at a time across directories, so a 173-file directory cannot spend a 4000-char
    // budget before the 10-file one has been named. Size order alone used to leave every later directory anonymous.
    const blocks = sortedDirs.map((dir) => directoryBlock(dir));

    for (const block of blocks) {
        for (const line of block) {
            budget.remaining -= line.length + 1;
        }
    }

    const rootSorted = rootFiles.toSorted(compareMapFiles);
    const rootShown = emitNameLines(nameLines(rootSorted.map(mapFileLabel)), budget);
    const packed = sortedDirs.map((dir) =>
        nameLines(dir.direct.toSorted(compareMapFiles).map(mapFileLabel)),
    );
    const shown = packed.map<NameLine[]>(() => []);
    const next = packed.map(() => 0);
    let progress = true;

    while (progress) {
        progress = false;

        for (let index = 0; index < packed.length; index += 1) {
            const pool = packed[index] ?? [];
            const position = next[index] ?? 0;
            const line = pool[position];

            if (line === undefined || line.text.length + 1 > budget.remaining) {
                continue;
            }

            budget.remaining -= line.text.length + 1;
            shown[index]?.push(line);
            next[index] = position + 1;
            progress = true;
        }
    }

    const lines = [header];

    if (rootFiles.length > 0) {
        lines.push(
            `.  ${counted(rootFiles.length, "file")}`,
            ...rootShown.map((line) => line.text),
        );
        appendMoreNote(lines, rootSorted.length, rootShown);
    }

    sortedDirs.forEach((dir, index) => {
        lines.push(...(blocks[index] ?? []), ...(shown[index] ?? []).map((line) => line.text));
        appendMoreNote(lines, dir.direct.length, shown[index] ?? []);
    });

    lines.push(...notes);

    return lines.join("\n");
}

/** What a block could not name, said where its names stopped. */
function appendMoreNote(lines: string[], total: number, shown: readonly NameLine[]): void {
    const named = shown.reduce((sum, line) => sum + line.count, 0);

    // A list that never started is not a partial list: `tui/ 31 files` already says the names were dropped.
    if (named === 0 || named >= total) {
        return;
    }

    lines.push(`  # … ${total - named} more`);
}

/** Fill one bucket from its packed lines, stopping at the budget. */
function emitNameLines(packed: readonly NameLine[], budget: { remaining: number }): NameLine[] {
    const emitted: NameLine[] = [];

    for (const line of packed) {
        if (line.text.length + 1 > budget.remaining) {
            break;
        }

        budget.remaining -= line.text.length + 1;
        emitted.push(line);
    }

    return emitted;
}

/** A directory with no subdirectories: one name per line, the shape the map has always had. */
function renderFlatMap(header: string, files: readonly MapFile[]): string {
    const names = files.toSorted(compareMapFiles).map(mapFileLabel);

    if (names.length === 0) {
        return header;
    }

    const shown = names.slice(0, FLAT_MAP_NAMES);
    const lines = [header, ...shown.map((name) => `  ${name}`)];

    if (names.length > shown.length) {
        lines.push(`  # … ${names.length - shown.length} more file(s)`);
    }

    return lines.join("\n");
}

/**
 * A directory summary plus its child directories.
 *
 * Children are rows, not longer file paths: `models/qwen35/checkpoint.hpp` says the directory twice and hides that
 * `qwen35` is a group, while `models/ 15` plus `qwen35/ 14` answers "which subdirectory" without a second call.
 */
function directoryBlock(dir: MapDirectory): string[] {
    const languages = Array.from(dir.languages).toSorted().join(",");
    const block = [`${dir.name}/  ${counted(dir.files, "file")}  ${languages}`];
    const children = [...dir.children.entries()].toSorted(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    );
    const capped = children.slice(0, MAX_CHILD_DIRS);
    const labels = capped.map(([name, count]) => `${name}/ ${count}`);

    if (children.length > capped.length) {
        labels.push(`# … ${children.length - capped.length} more dir(s)`);
    }

    if (labels.length > 0) {
        block.push(...nameLines(labels).map((line) => line.text));
    }

    return block;
}

interface MapFile {
    /** File name without its directory; the directory is the block heading. */
    label: string;
    declarations: number;
}

interface MapDirectory {
    name: string;
    /** Files under it at any depth. */
    files: number;
    languages: Set<string>;
    /** Files sitting directly in it; children get their own rows. */
    direct: MapFile[];
    /** Immediate child directory to its recursive file count. */
    children: Map<string, number>;
}

/** What the caller can act on first: the biggest declaration count, then the name. */
function compareMapFiles(left: MapFile, right: MapFile): number {
    return right.declarations - left.declarations || left.label.localeCompare(right.label);
}

/** `(0)` is omitted: a file with no declarations is still a file, not a failed parse. */
function mapFileLabel(file: MapFile): string {
    return file.declarations > 0 ? `${file.label} (${file.declarations})` : file.label;
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
