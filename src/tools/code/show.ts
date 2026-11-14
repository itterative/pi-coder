import path from "node:path";

import {
    candidateFiles,
    filterPathTarget,
    parsePathTarget,
    patternWithinTarget,
} from "./discovery";
import {
    declarationHeading,
    declarationLine,
    filterNote,
    headingMatch,
    type HeadingMatch,
    isContainer,
    isFunctionLike,
    pathRange,
    parseSelector,
    scopeLabel,
    selectorHintIsPartial,
    shortLine,
    renderWithinBudget,
    nextOffsetNote,
    type BudgetedText,
    selectorMatches,
    sourceForDeclaration,
    splitSymbolList,
    lineRange,
    pairKey,
    bodyThenFooter,
} from "./format";
import { DEFAULT_CHAR_LIMIT } from "./languages";
import { loadParsedFiles } from "./load";
import type { CodeSource } from "./source";
import { CallTiming } from "./timing";
import type { CodeDetail, CodeToolParams, Declaration, ParsedFile, SymbolSelector } from "./types";

export interface ShowResult {
    text: string;
    files: number;
    parseErrors: number;
    truncated: boolean;
    matches: number;
}

interface MatchGroup {
    key: string;
    declarations: Declaration[];
}

const AMBIGUITY_LIMIT = 5;

export async function runShow(
    source: CodeSource,
    params: CodeToolParams,
    signal?: AbortSignal,
    timing: CallTiming = new CallTiming(),
): Promise<ShowResult> {
    const requested = splitSymbolList(params.query === undefined ? [] : [params.query]);

    if (requested.length === 0) {
        return {
            text: '# show needs at least one symbol, e.g. outline(action="show", query="Socket::connect")',
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    const selectors = requested.map(parseSelector);
    const target = parsePathTarget(params.path);
    const root = source.resolvePath(target.base);
    const scope = target.pattern ?? source.displayPath(root);
    const matchedSelectors = new Set<number>();

    await source.assertReadable(root);

    const candidates = await timing.measure("discover", () =>
        candidateFiles(source, root, requested, signal, patternWithinTarget(target)),
    );
    const targeted = filterPathTarget(candidates.files, source, target);
    const discovery = { ...candidates, files: targeted.files };

    if (discovery.files.length === 0) {
        const filter = filterNote({ path: target.pattern, pathHidden: targeted.hidden });

        return {
            text:
                target.pattern === undefined
                    ? notFound(
                          scope,
                          requested,
                          await elsewhereNote(source, root, requested, signal, timing),
                      )
                    : bodyThenFooter(
                          [`# not found: ${requested.join(", ")} in ${scope} · no files match`],
                          [filter],
                      ),
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    const batch = await timing.measure("parse", () =>
        loadParsedFiles(source, discovery.files, signal),
    );
    timing.recordLoad(batch, discovery.files.length);
    const files = batch.parsed.toSorted((left, right) => left.path.localeCompare(right.path));
    const fileOf = new Map<Declaration, ParsedFile>();
    const matches: Declaration[] = [];

    for (const file of files) {
        for (const declaration of file.all) {
            fileOf.set(declaration, file);

            const selectorIndex = selectors.findIndex((selector) =>
                selectorMatches(declaration, selector),
            );

            if (selectorIndex >= 0) {
                matches.push(declaration);
                matchedSelectors.add(selectorIndex);
            }
        }
    }

    // A heading's name is prose, so exact-name matching would make most of them unreachable. This pass runs only for
    // the selectors the exact one left empty.
    const headingTiers = new Map<Declaration, HeadingMatch>();
    const commaNotes = matchHeadings(
        files,
        selectors,
        params.query,
        matchedSelectors,
        matches,
        headingTiers,
    );

    // A hint that matches no signature must not silently pick one — a wrong overload is worse than a miss. It should
    // not leave the caller guessing either: `choose_splits(int64_t, int64_t)` against a `std::int64_t` definition used
    // to be an unexplained "not found", which makes the advertised parameter-list affordance a trap. So the miss is
    // answered with the signatures that do exist, ready to copy.
    const hintNotes = signaturesForUnmatchedHints(files, selectors, matchedSelectors);

    const missing = requested.filter((_, index) => !matchedSelectors.has(index));

    if (matches.length === 0) {
        const elsewhere = await elsewhereNote(source, root, missing, signal, timing);

        return {
            text: notFound(scope, requested, elsewhere, hintNotes),
            files: files.length,
            parseErrors: sumParseErrors(files),
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const groups = groupMatches(matches);
    const parseErrors = sumParseErrors(files);
    const legend = legendFor(source, groups, fileOf);
    const notes = [...commaNotes, headingTextNote(source, headingTiers, fileOf)].filter(
        (note): note is string => note !== undefined,
    );
    const summary = [
        `# show ${scopeLabel(scope)} ${requested.join(", ")}`,
        parseErrors > 0 ? `parse: ${parseErrors} error(s)` : "",
        discovery.truncated ? "file list truncated" : "",
    ]
        .filter((part) => part.length > 0)
        .join(" · ");

    // The legend names the candidate locations the header summarises, so it stays with the page; the notes are footer.
    const header = bodyThenFooter([summary, ...legend], notes);
    const limit = params.limit ?? DEFAULT_CHAR_LIMIT;
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const filter = filterNote({ path: target.pattern, pathHidden: targeted.hidden });
    const ambiguous = groups.length > AMBIGUITY_LIMIT || hasMultipleDefinitionFiles(groups, fileOf);

    if (ambiguous) {
        const ambiguous = renderAmbiguous(
            source,
            scope,
            requested,
            groups,
            header,
            limit,
            offset,
            fileOf,
        );
        const next = nextOffsetNote(ambiguous.fitted);

        return {
            text: bodyThenFooter([ambiguous.fitted.text], [ambiguous.note, next, filter]),
            files: files.length,
            parseErrors,
            truncated: ambiguous.fitted.truncated,
            matches: matches.length,
        };
    }

    const detail = params.detail;
    const blocks = groups
        .map((group) => renderGroup(source, group, fileOf, detail))
        .filter((block): block is string => block !== undefined);
    const fitted = renderWithinBudget(header, blocks, limit, offset);
    const note = matchNote(groups, selectors);
    const partial = partialHintNote(selectors, groups);
    const elsewhere = await elsewhereNote(source, root, missing, signal, timing);
    // Every requested symbol reports its outcome. A missing one used to vanish entirely as soon as another one
    // resolved, and the caller cannot tell that from "not reached".
    const absent =
        missing.length === 0 ? undefined : `# not found: ${missing.join(", ")} in ${scope}`;
    const next = nextOffsetNote(fitted);
    const text = bodyThenFooter(
        [fitted.text],
        [note, partial, ...hintNotes, absent, ...elsewhere, next, filter],
    );

    return {
        text,
        files: files.length,
        parseErrors,
        truncated: fitted.truncated || discovery.truncated,
        matches: matches.length,
    };
}

/**
 * One line per resolved symbol, printed before any body.
 *
 * A body that fills the character budget leaves `# next: offset=N` and nothing else, so without this index the
 * second symbol of a two-symbol request is invisible: the caller cannot tell "not found" from "not reached". One
 * line per symbol is cheap enough to pay on every multi-symbol call, and it is where the span for a `read` comes
 * from.
 */
function legendFor(
    source: CodeSource,
    groups: readonly MatchGroup[],
    fileOf: ReadonlyMap<Declaration, ParsedFile>,
): string[] {
    if (groups.length < 2) {
        return [];
    }

    return groups.flatMap((group) => {
        const declaration = group.declarations.toSorted(compareDeclarations)[0];
        const file = declaration === undefined ? undefined : fileOf.get(declaration);

        if (declaration === undefined || file === undefined) {
            return [];
        }

        return [
            `#   ${pathRange(source.displayPath(file.path), declaration.range)} · ${declarationHeading(declaration)}`,
        ];
    });
}

/**
 * The heading pass, run for the selectors the exact pass left empty.
 *
 * A comma inside a prose selector is text, not a separator: `Framing, viewport restore, and the render cache` splits
 * into three selectors that match nothing, while the entry as written names one heading. So the whole entry is tried
 * first, and only when it names no heading do the split parts get their own prefix/substring pass.
 */
function matchHeadings(
    files: readonly ParsedFile[],
    selectors: readonly SymbolSelector[],
    entry: string | undefined,
    matchedSelectors: Set<number>,
    matches: Declaration[],
    tiers: Map<Declaration, HeadingMatch>,
): string[] {
    const unmatched = selectors
        .map((_, index) => index)
        .filter((index) => !matchedSelectors.has(index));

    if (unmatched.length === 0) {
        return [];
    }

    const add = (found: readonly FoundHeading[]): void => {
        for (const [declaration, match] of found) {
            if (matches.includes(declaration)) {
                continue;
            }

            matches.push(declaration);
            tiers.set(declaration, match);
        }
    };

    const whole =
        selectors.length > 1 && entry !== undefined
            ? findHeadings(files, parseSelector(entry))
            : [];

    if (whole.length > 0) {
        for (const index of selectors.keys()) {
            matchedSelectors.add(index);
        }

        add(whole);

        return [
            `# comma: "${shortLine(entry ?? "", 80)}" matched as one heading title, not ${selectors.length} selectors`,
        ];
    }

    for (const index of unmatched) {
        const selector = selectors[index];

        if (selector === undefined) {
            continue;
        }

        const found = findHeadings(files, selector);

        if (found.length === 0) {
            continue;
        }

        matchedSelectors.add(index);
        add(found);
    }

    return [];
}

type FoundHeading = readonly [Declaration, HeadingMatch];

function findHeadings(files: readonly ParsedFile[], selector: SymbolSelector): FoundHeading[] {
    const found: FoundHeading[] = [];

    for (const file of files) {
        for (const declaration of file.all) {
            const match = headingMatch(declaration, selector);

            if (match !== undefined) {
                found.push([declaration, match]);
            }
        }
    }

    return found;
}

/**
 * Name the prose that matched by a remembered piece of its title.
 *
 * Without the note a substring hit and an exact one render identically, and the caller has no way to tell that the
 * title it is looking at is not the title it asked for. The noun follows the kind: a test case is named by a title,
 * a Markdown section by a heading.
 */
function headingTextNote(
    source: CodeSource,
    tiers: ReadonlyMap<Declaration, HeadingMatch>,
    fileOf: ReadonlyMap<Declaration, ParsedFile>,
): string | undefined {
    const loose = Array.from(tiers.entries()).filter(([, match]) => match !== "exact");

    if (loose.length === 0) {
        return undefined;
    }

    const noun = loose.every(([declaration]) => declaration.kind === "block") ? "title" : "heading";
    const examples = loose.slice(0, 3).map(([declaration, match]) => {
        const file = fileOf.get(declaration);
        const where =
            file === undefined
                ? ""
                : `${pathRange(source.displayPath(file.path), declaration.range)} `;

        return `${where}${shortLine(declaration.name, 80)} (${match} of the title)`;
    });

    return `# ${noun}: ${loose.length} matched by title text, not the full title: ${examples.join(" · ")}`;
}

/**
 * A successful result can still need one more narrowing step; teach that only when it applies.
 *
 * `groups.length > 1` is not the signal. A caller who asked for two different symbols gets two groups by design, and
 * telling them to "use a qualified name or parameter types to select one" describes a problem that does not exist —
 * the example it offers is a truncated eleven-parameter kernel signature. Ambiguity is *one selector* reaching more
 * than one group, which is what this checks.
 */
function matchNote(
    groups: readonly MatchGroup[],
    selectors: readonly SymbolSelector[],
): string | undefined {
    if (groups.length < 2) {
        return undefined;
    }

    const ambiguous = selectors.some((selector) => {
        const keys = new Set<string>();

        for (const group of groups) {
            if (group.declarations.some((declaration) => selectorMatches(declaration, selector))) {
                keys.add(group.key);
            }
        }

        return keys.size > 1;
    });

    if (!ambiguous) {
        return undefined;
    }

    const declarations = groups
        .map((group) => group.declarations[0])
        .filter((declaration): declaration is Declaration => declaration !== undefined);

    if (declarations.length === 0) {
        return undefined;
    }

    const names = new Set(declarations.map((declaration) => declaration.qualifiedName));
    const overloads =
        names.size === 1 && declarations.every((declaration) => isFunctionLike(declaration.kind));
    const example = selectorExample(groups);
    const noun = overloads ? "overloads" : "declarations";
    const action = overloads
        ? "add parameter types to select one"
        : "use a qualified name or parameter types to select one";

    return `# note: ${groups.length} ${noun} match; ${action}${example === undefined ? "" : `, e.g. ${example}`}`;
}

function selectorExample(groups: readonly MatchGroup[]): string | undefined {
    for (const group of groups) {
        const declaration = group.declarations[0];

        if (declaration === undefined) {
            continue;
        }

        const parameters = declaration.paramTexts ?? declaration.paramTypes;

        if (parameters.length === 0) {
            continue;
        }

        return shortLine(`${declaration.qualifiedName}(${parameters.join(", ")})`, 180);
    }

    return undefined;
}

/**
 * A block is a section only when it holds blocks: a suite has members (`it` cases), while a case's body is plain
 * code, so `show` must return that code instead of an empty member list. Every other container kind keeps its
 * existing meaning, where an empty class still answers "no public members".
 */
function isSection(declaration: Declaration): boolean {
    if (declaration.kind === "block") {
        return declaration.children.length > 0;
    }

    return isContainer(declaration.kind);
}

function renderGroup(
    source: CodeSource,
    group: MatchGroup,
    fileOf: ReadonlyMap<Declaration, ParsedFile>,
    detail: CodeDetail | undefined,
): string | undefined {
    const declarations = group.declarations.toSorted(compareDeclarations);
    const container =
        declarations.find((declaration) => isSection(declaration) && declaration.isDefinition) ??
        declarations.find((declaration) => isSection(declaration));

    if (container !== undefined) {
        const file = fileOf.get(container);

        if (file === undefined) {
            return undefined;
        }

        return renderContainer(source, container, file, detail ?? "signatures");
    }

    return renderLeafGroup(source, declarations, fileOf, detail ?? "full");
}

function renderContainer(
    source: CodeSource,
    container: Declaration,
    file: ParsedFile,
    detail: CodeDetail,
): string {
    const header = `# ${pathRange(source.displayPath(file.path), container.range)} · ${declarationHeading(container)}`;

    if (detail === "full") {
        const body = sourceForDeclaration(file.source, container, true);
        const note = body.dedented ? dedentNote(source, file, container) : "";

        return `${header}\n${[note, body.lines.join("\n")].filter((part) => part.length > 0).join("\n")}`;
    }

    const children = showChildren(container);
    const body = [`  ${container.signature}`];

    if (children.length === 0) {
        body.push("  # no public members");

        return [`${header} · no public members`, ...body].join("\n");
    }

    body.push(
        ...children.map((child) =>
            declarationLine(child, 1, { signatureLimit: Number.POSITIVE_INFINITY }),
        ),
    );

    return [`${header} · ${children.length} member(s)`, ...body].join("\n");
}

function renderLeafGroup(
    source: CodeSource,
    declarations: readonly Declaration[],
    fileOf: ReadonlyMap<Declaration, ParsedFile>,
    detail: CodeDetail,
): string {
    const blocks: string[] = [];
    const definitions = declarations.filter((declaration) => declaration.isDefinition);
    const declarationsOnly = declarations.filter((declaration) => !declaration.isDefinition);

    if (detail === "signatures") {
        for (const declaration of declarationsOnly.length > 0 ? declarationsOnly : definitions) {
            const block = renderLeaf(source, declaration, fileOf, "signature");

            if (block !== undefined) {
                blocks.push(block);
            }
        }

        return blocks.join("\n\n");
    }

    for (const declaration of declarationsOnly) {
        const block = renderLeaf(source, declaration, fileOf, "full");

        if (block !== undefined) {
            blocks.push(block);
        }
    }

    for (const declaration of definitions) {
        const block = renderLeaf(source, declaration, fileOf, "full");

        if (block !== undefined) {
            blocks.push(block);
        }
    }

    if (definitions.length === 0 && declarations[0] !== undefined) {
        blocks.push(`# no definition found for ${declarations[0].qualifiedName} in this path`);
    }

    return blocks.join("\n\n");
}

function renderLeaf(
    source: CodeSource,
    declaration: Declaration,
    fileOf: ReadonlyMap<Declaration, ParsedFile>,
    mode: "signature" | "full",
): string | undefined {
    const file = fileOf.get(declaration);

    if (file === undefined) {
        return undefined;
    }

    const status = declaration.isDefinition ? "definition" : "declaration";
    const header = `# ${pathRange(source.displayPath(file.path), declaration.range)} · ${declarationHeading(declaration)} · ${status}`;

    if (mode === "signature") {
        return `${header}\n  ${declaration.signature}`;
    }

    const body = sourceForDeclaration(file.source, declaration, true);
    const note = body.dedented ? dedentNote(source, file, declaration) : "";

    return `${header}\n${[note, body.lines.join("\n")].filter((part) => part.length > 0).join("\n")}`;
}

/**
 * A dedented body is a readable slice, not the file's bytes: every line lost the declaration's own indent, so a
 * string replacement taken from it may not match the file. An edit needs the original range. The note sits before
 * the body so a line-comment language cannot mistake it for the last line of the code.
 */
function dedentNote(source: CodeSource, file: ParsedFile, declaration: Declaration): string {
    return `# dedented: read ${pathRange(source.displayPath(file.path), declaration.range)} for the exact indentation before editing`;
}

function renderAmbiguous(
    source: CodeSource,
    scope: string,
    requested: readonly string[],
    groups: readonly MatchGroup[],
    header: string,
    limit: number,
    offset: number,
    fileOf: ReadonlyMap<Declaration, ParsedFile>,
): { fitted: BudgetedText; note: string } {
    const shown = groups
        .flatMap((group) => {
            const definitions = group.declarations.filter(
                (declaration) => declaration.isDefinition,
            );

            return definitions.length > 0 ? definitions : group.declarations.slice(0, 1);
        })
        .toSorted((left, right) => {
            const leftFile = fileOf.get(left)?.path ?? "";
            const rightFile = fileOf.get(right)?.path ?? "";

            return (
                leftFile.localeCompare(rightFile) || left.range.startLine - right.range.startLine
            );
        });
    const lines = [`# ambiguous: ${shown.length} matches for ${requested.join(", ")} in ${scope}`];

    for (const declaration of shown) {
        const file = fileOf.get(declaration);
        const displayPath = file === undefined ? "" : source.displayPath(file.path);

        lines.push(
            `  ${pathRange(displayPath, declaration.range)} · ${declarationHeading(declaration)}  ${shortLine(declaration.signature, 120)}`,
        );
    }

    const example = selectorExample(groups);
    // Footer, not a row: it is advice about the whole list, so it goes under the page and not after the last match.
    const note =
        example === undefined
            ? "# narrow with a qualified name, parameter types, or file path"
            : `# narrow with a qualified name, parameter types, or file path, e.g. ${example}`;

    return { fitted: renderWithinBudget(header, [lines.join("\n")], limit, offset), note };
}

/** Two definitions with the same signature in different files are separate targets, not a pair. */
function hasMultipleDefinitionFiles(
    groups: readonly MatchGroup[],
    fileOf: ReadonlyMap<Declaration, ParsedFile>,
): boolean {
    return groups.some((group) => {
        const files = new Set(
            group.declarations
                .filter((declaration) => declaration.isDefinition)
                .map((declaration) => fileOf.get(declaration)?.path)
                .filter((filePath): filePath is string => filePath !== undefined),
        );

        return files.size > 1;
    });
}

function groupMatches(matches: readonly Declaration[]): MatchGroup[] {
    const groups = new Map<string, Declaration[]>();

    for (const declaration of matches) {
        const key = pairKey(declaration);
        const group = groups.get(key) ?? [];

        group.push(declaration);
        groups.set(key, group);
    }

    return Array.from(groups.entries())
        .map(([key, declarations]) => ({ key, declarations }))
        .toSorted((left, right) => {
            const leftName = left.declarations[0]?.qualifiedName ?? "";
            const rightName = right.declarations[0]?.qualifiedName ?? "";

            return leftName.localeCompare(rightName) || left.key.localeCompare(right.key);
        });
}

function showChildren(container: Declaration): Declaration[] {
    if (container.kind === "enum") {
        return container.children;
    }

    if (container.kind === "class" || container.kind === "trait") {
        return container.children.filter(
            (child) => child.access === "public" && child.kind !== "field",
        );
    }

    if (container.kind === "struct" || container.kind === "union") {
        return container.children.filter(
            (child) => child.access !== "private" && child.access !== "protected",
        );
    }

    if (container.kind === "interface") {
        return container.children;
    }

    if (container.kind === "namespace") {
        return container.children.filter((child) => child.kind !== "variable");
    }

    return container.children;
}

/**
 * One note per selector whose parameter hint matched nothing, naming the signatures that do exist.
 *
 * The name is matched without the hint, so this reports the candidates the caller meant; when even that is empty the
 * note would be pointless and is left out.
 */
function signaturesForUnmatchedHints(
    files: readonly ParsedFile[],
    selectors: readonly SymbolSelector[],
    matched: ReadonlySet<number>,
): string[] {
    const notes: string[] = [];

    for (const [index, selector] of selectors.entries()) {
        if (matched.has(index) || selector.signatureHint.length === 0) {
            continue;
        }

        const candidates = files.flatMap((file) =>
            file.all.filter((declaration) =>
                selectorMatches(declaration, { ...selector, signatureHint: [] }),
            ),
        );

        if (candidates.length === 0) {
            continue;
        }

        const shown = candidates.slice(0, 3).map((candidate) => signatureOf(candidate));
        const withheld = candidates.length - shown.length;

        notes.push(
            `# hint: no signature matched "${selector.raw}"; ${selector.name}: ${shown.join(" · ")}${withheld > 0 ? ` (+${withheld} more)` : ""}`,
        );
    }

    return notes;
}

/** A declaration's selector form, for a note the caller can copy. */
function signatureOf(declaration: Declaration): string {
    const parameters = declaration.paramTypes.join(", ");

    return `${declaration.qualifiedName}(${parameters})`;
}

function compareDeclarations(left: Declaration, right: Declaration): number {
    if (left.isDefinition !== right.isDefinition) {
        return left.isDefinition ? 1 : -1;
    }

    return left.range.startLine - right.range.startLine;
}

function sumParseErrors(parsed: readonly ParsedFile[]): number {
    return parsed.reduce((total, file) => total + file.parseErrors, 0);
}

function notFound(
    scope: string,
    requested: readonly string[],
    elsewhere: readonly string[],
    hintNotes: readonly string[] = [],
): string {
    const next =
        '# next: outline(action="digest", path=...) to see the available declarations, or outline(action="usages", ...) for references';

    return bodyThenFooter(
        [`# not found: ${requested.join(", ")} in ${scopeLabel(scope)}`],
        [...hintNotes, ...elsewhere, ...(elsewhere.length === 0 ? [next] : [])],
    );
}

/** How many locations to name per missing symbol. */
const ELSEWHERE_LOCATIONS = 3;

/**
 * Name the files a missing selector actually lives in.
 *
 * A symbol asked for in the wrong file used to read like a symbol that does not exist, which is the answer that
 * sends an agent to `rg`. The containing directory is searched first and the working directory second, so
 * `step.cpp` naming `Qwen35Model::attention_block` is answered with `blocks.cpp:35-153` and the next call can
 * be right. Each root is grepped for the selector's last component before parsing, so the miss costs one
 * narrowed scan rather than a full tree walk.
 */
async function elsewhereNote(
    source: CodeSource,
    root: string,
    missing: readonly string[],
    signal: AbortSignal | undefined,
    timing: CallTiming,
): Promise<string[]> {
    if (missing.length === 0) {
        return [];
    }

    const cwd = source.resolvePath(".");
    const candidates = root === cwd ? [] : [path.dirname(root), cwd];
    const roots = Array.from(new Set(candidates)).filter((candidate) => candidate !== root);

    for (const searchRoot of roots) {
        const lines = await locateIn(source, searchRoot, missing, signal, timing);

        if (lines.length > 0) {
            return [`# elsewhere — searched ${source.displayPath(searchRoot)}:`, ...lines];
        }
    }

    return [];
}

async function locateIn(
    source: CodeSource,
    searchRoot: string,
    missing: readonly string[],
    signal: AbortSignal | undefined,
    timing: CallTiming,
): Promise<string[]> {
    const discovery = await timing.measure("discover", () =>
        candidateFiles(source, searchRoot, missing, signal),
    );

    if (discovery.files.length === 0) {
        return [];
    }

    const batch = await timing.measure("parse", () =>
        loadParsedFiles(source, discovery.files, signal),
    );
    timing.recordLoad(batch, discovery.files.length);
    const selectors = missing.map(parseSelector);
    const lines: string[] = [];

    for (const [index, selector] of selectors.entries()) {
        const found = batch.parsed.flatMap((file) =>
            file.all
                .filter((declaration) => selectorMatches(declaration, selector))
                .map((declaration) => ({ file, declaration })),
        );

        if (found.length === 0) {
            continue;
        }

        const definitions = found.filter((hit) => hit.declaration.isDefinition);
        const pool = definitions.length > 0 ? definitions : found;
        const chosen = pool.slice(0, ELSEWHERE_LOCATIONS);
        const locations = chosen.map(
            (hit) => `${source.displayPath(hit.file.path)}:${lineRange(hit.declaration.range)}`,
        );
        const withheld = pool.length - chosen.length;
        const suffix = withheld > 0 ? ` (+${withheld} more)` : "";

        lines.push(`#   ${missing[index]} → ${locations.join(", ")}${suffix}`);
    }

    return lines;
}

/** Say when a selector matched on a leading parameter list, so "matched" is not read as "exact". */
function partialHintNote(
    selectors: readonly SymbolSelector[],
    groups: readonly MatchGroup[],
): string | undefined {
    for (const group of groups) {
        for (const declaration of group.declarations) {
            const selector = selectors.find(
                (candidate) =>
                    selectorMatches(declaration, candidate) &&
                    selectorHintIsPartial(declaration, candidate),
            );

            if (selector === undefined) {
                continue;
            }

            const parameters = declaration.paramTexts ?? declaration.paramTypes;
            const full = shortLine(`${declaration.qualifiedName}(${parameters.join(", ")})`, 180);
            const hint = selector.signatureHint.length;

            return `# note: "${selector.raw}" matched the first ${hint} of ${parameters.length} parameters; full: ${full}`;
        }
    }

    return undefined;
}
