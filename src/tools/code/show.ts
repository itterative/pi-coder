import { candidateFiles } from "./discovery";
import {
    declarationLine,
    isContainer,
    isFunctionLike,
    kindLabel,
    pathRange,
    parseSelector,
    shortLine,
    renderWithinBudget,
    nextOffsetNote,
    selectorMatches,
    sourceForDeclaration,
    pairKey,
} from "./format";
import { DEFAULT_CHAR_LIMIT } from "./languages";
import { loadParsedFiles } from "./load";
import type { CodeSource } from "./source";
import type { CodeDetail, CodeToolParams, Declaration, ParsedFile } from "./types";

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
): Promise<ShowResult> {
    const requested = (params.symbols ?? []).map((symbol) => symbol.trim()).filter(Boolean);

    if (requested.length === 0) {
        return {
            text: '# show needs at least one symbol, e.g. outline(action="show", symbols=["Socket::connect"])',
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    const selectors = requested.map(parseSelector);
    const root = source.resolvePath(params.path ?? ".");

    await source.assertReadable(root);

    const discovery = await candidateFiles(source, root, requested, signal);

    if (discovery.files.length === 0) {
        return {
            text: notFound(source, root, requested),
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    const batch = await loadParsedFiles(source, discovery.files, signal);
    const files = batch.parsed.toSorted((left, right) => left.path.localeCompare(right.path));
    const fileOf = new Map<Declaration, ParsedFile>();
    const matches: Declaration[] = [];

    for (const file of files) {
        for (const declaration of file.all) {
            fileOf.set(declaration, file);

            if (selectors.some((selector) => selectorMatches(declaration, selector))) {
                matches.push(declaration);
            }
        }
    }

    if (matches.length === 0) {
        return {
            text: notFound(source, root, requested),
            files: files.length,
            parseErrors: sumParseErrors(files),
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const groups = groupMatches(matches);
    const parseErrors = sumParseErrors(files);
    const header = [
        `# show ${source.displayPath(root)} ${requested.join(", ")}`,
        parseErrors > 0 ? `parse: ${parseErrors} error(s)` : "",
        discovery.truncated ? "file list truncated" : "",
    ]
        .filter((part) => part.length > 0)
        .join(" · ");
    const limit = params.limit ?? DEFAULT_CHAR_LIMIT;
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const ambiguous = groups.length > AMBIGUITY_LIMIT || hasMultipleDefinitionFiles(groups, fileOf);

    if (ambiguous) {
        const text = renderAmbiguous(
            source,
            root,
            requested,
            groups,
            header,
            limit,
            offset,
            fileOf,
        );
        const next = nextOffsetNote(text.nextOffset);

        return {
            text: [text.text, next].filter((part) => part !== undefined).join("\n"),
            files: files.length,
            parseErrors,
            truncated: text.truncated,
            matches: matches.length,
        };
    }

    const detail = params.detail;
    const blocks = groups
        .map((group) => renderGroup(source, group, fileOf, detail))
        .filter((block): block is string => block !== undefined);
    const fitted = renderWithinBudget(header, blocks, limit, offset);
    const note = matchNote(groups);
    const next = nextOffsetNote(fitted.nextOffset);
    const text = [fitted.text, note, next].filter((part) => part !== undefined).join("\n");

    return {
        text,
        files: files.length,
        parseErrors,
        truncated: fitted.truncated || discovery.truncated,
        matches: matches.length,
    };
}

/** A successful result can still need one more narrowing step; teach that only when it applies. */
function matchNote(groups: readonly MatchGroup[]): string | undefined {
    if (groups.length < 2) {
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

function renderGroup(
    source: CodeSource,
    group: MatchGroup,
    fileOf: ReadonlyMap<Declaration, ParsedFile>,
    detail: CodeDetail | undefined,
): string | undefined {
    const declarations = group.declarations.toSorted(compareDeclarations);
    const container =
        declarations.find(
            (declaration) => isContainer(declaration.kind) && declaration.isDefinition,
        ) ?? declarations.find((declaration) => isContainer(declaration.kind));

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
    const header = `# ${pathRange(source.displayPath(file.path), container.range)} · ${kindLabel(container.kind)} ${container.qualifiedName}`;

    if (detail === "full") {
        return `${header}\n${sourceForDeclaration(file.source, container, true).join("\n")}`;
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
    const header = `# ${pathRange(source.displayPath(file.path), declaration.range)} · ${kindLabel(declaration.kind)} ${declaration.qualifiedName} · ${status}`;

    if (mode === "signature") {
        return `${header}\n  ${declaration.signature}`;
    }

    return `${header}\n${sourceForDeclaration(file.source, declaration, true).join("\n")}`;
}

function renderAmbiguous(
    source: CodeSource,
    root: string,
    requested: readonly string[],
    groups: readonly MatchGroup[],
    header: string,
    limit: number,
    offset: number,
    fileOf: ReadonlyMap<Declaration, ParsedFile>,
): { text: string; truncated: boolean; nextOffset?: number } {
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
    const lines = [
        `# ambiguous: ${shown.length} matches for ${requested.join(", ")} in ${source.displayPath(root)}`,
    ];

    for (const declaration of shown) {
        const file = fileOf.get(declaration);
        const displayPath = file === undefined ? "" : source.displayPath(file.path);

        lines.push(
            `  ${pathRange(displayPath, declaration.range)} · ${kindLabel(declaration.kind)} ${declaration.qualifiedName}  ${shortLine(declaration.signature, 120)}`,
        );
    }

    const example = selectorExample(groups);

    lines.push(
        example === undefined
            ? "# narrow with a qualified name, parameter types, or file path"
            : `# narrow with a qualified name, parameter types, or file path, e.g. ${example}`,
    );

    return renderWithinBudget(header, [lines.join("\n")], limit, offset);
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

function compareDeclarations(left: Declaration, right: Declaration): number {
    if (left.isDefinition !== right.isDefinition) {
        return left.isDefinition ? 1 : -1;
    }

    return left.range.startLine - right.range.startLine;
}

function sumParseErrors(parsed: readonly ParsedFile[]): number {
    return parsed.reduce((total, file) => total + file.parseErrors, 0);
}

function notFound(source: CodeSource, root: string, requested: readonly string[]): string {
    return [
        `# not found: ${requested.join(", ")} in ${source.displayPath(root)}`,
        '# next: outline(action="digest", path=...) to see the available declarations, or outline(action="usages", ...) for references',
    ].join("\n");
}
