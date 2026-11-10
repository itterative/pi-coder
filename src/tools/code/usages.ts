import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import { yieldToEventLoop } from "../../common/async";
import { candidateFiles, lastComponent } from "./discovery";
import { nextOffsetNote, renderWithinBudget, shortLine, splitSymbolList } from "./format";
import { DEFAULT_CHAR_LIMIT } from "./languages";
import { loadParsedFiles } from "./load";
import { adapterForLanguage, type CallSiteSpec } from "./adapters";
import type { CodeSource } from "./source";
import { parseSyntax } from "./tree-sitter";
import type { CodeToolParams, Declaration, ParsedFile, UsageKind } from "./types";
import { WORKER_PARSE_THRESHOLD_BYTES, buildUsageIndexInWorker } from "./worker";

export interface UsagesResult {
    text: string;
    files: number;
    parseErrors: number;
    truncated: boolean;
    matches: number;
}

type UsageTag = "def" | "decl" | "call" | "launch" | "ref";

interface Occurrence {
    line: number;
    column: number;
    text: string;
    tag: UsageTag;
}

export interface UsageEntry {
    /** The normalized identifier text; operator casts keep only the operator name. */
    name: string;
    startIndex: number;
    line: number;
    column: number;
    tag: UsageTag;
}

export interface UsageIndex {
    entries: UsageEntry[];
    scopes: Declaration[];
}

const IDENTIFIER_NODES = new Set([
    "identifier",
    "field_identifier",
    "type_identifier",
    "namespace_identifier",
    "property_identifier",
    "private_property_identifier",
    "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
    "destructor_name",
    "operator_name",
    "operator_cast",
    "constant",
    "name",
    "variable_name",
    "package_identifier",
]);

/** Yield after this many files or identifier nodes while indexing. */
const USAGE_FILE_YIELD_INTERVAL = 16;
const USAGE_INDEX_YIELD_INTERVAL = 512;
const USAGE_ENTRY_YIELD_INTERVAL = 4_096;

const SCOPE_KINDS = new Set([
    "namespace",
    "class",
    "struct",
    "union",
    "interface",
    "function",
    "method",
    "constructor",
    "destructor",
    "operator",
]);

/** The identifier index is tied to the cached ParsedFile object, so cache eviction releases it with the file. */
const usageIndexes = new WeakMap<ParsedFile, UsageIndex>();

export async function runUsages(
    source: CodeSource,
    params: CodeToolParams,
    signal?: AbortSignal,
): Promise<UsagesResult> {
    const requested = splitSymbolList(params.symbols ?? []);

    if (requested.length === 0) {
        return {
            text: '# usages needs at least one symbol, e.g. outline(action="usages", symbols=["Socket::connect"])',
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    const root = source.resolvePath(params.path ?? ".");
    const limit = params.limit ?? DEFAULT_CHAR_LIMIT;
    const offset = Math.max(0, Math.floor(params.offset ?? 0));

    await source.assertReadable(root);

    const discovery = await candidateFiles(source, root, requested, signal);

    if (discovery.files.length === 0) {
        return {
            text: `# no usages found for ${requested.join(", ")} in ${source.displayPath(root)} · no supported files`,
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    const batch = await loadParsedFiles(source, discovery.files, signal);
    const files = batch.parsed.toSorted((left, right) => left.path.localeCompare(right.path));
    const parseErrors = sumParseErrors(files);
    const languages = Array.from(new Set(files.map((file) => file.language)))
        .toSorted()
        .join(",");
    const sections: string[] = [];
    let totalMatches = 0;
    const truncated = discovery.truncated;

    for (const raw of requested) {
        const targetName = lastComponent(raw);
        const collected = await collectForFiles(files, targetName, params.kind, signal);

        totalMatches += collected.total;

        sections.push(
            renderSection(source, raw, collected, languages, parseErrors, source.displayPath(root)),
        );
    }

    if (sections.length === 1) {
        const section = sections[0] ?? "";
        const [header = "", ...blocks] = section.split("\n\n");
        const fitted = renderWithinBudget(header, blocks, limit, offset);
        const next = nextOffsetNote(fitted.nextOffset);

        return {
            text: [fitted.text, next].filter((part) => part !== undefined).join("\n"),
            files: files.length,
            parseErrors,
            truncated: truncated || fitted.truncated,
            matches: totalMatches,
        };
    }

    const header = `# usages ${requested.join(", ")} · ${languages} · syntactic (name-based)`;
    const fitted = renderWithinBudget(header, sections, limit, offset);
    const next = nextOffsetNote(fitted.nextOffset);

    return {
        text: [fitted.text, next].filter((part) => part !== undefined).join("\n"),
        files: files.length,
        parseErrors,
        truncated: truncated || fitted.truncated,
        matches: totalMatches,
    };
}

interface Collected {
    total: number;
    files: Array<{ path: string; scopes: Array<{ name: string; occurrences: Occurrence[] }> }>;
}

interface FileScan {
    total: number;
    scopes: Map<string, Occurrence[]>;
}

async function collectForFiles(
    parsedFiles: readonly ParsedFile[],
    targetName: string,
    kindFilter: UsageKind | undefined,
    signal?: AbortSignal,
): Promise<Collected> {
    const files: Collected["files"] = [];
    let total = 0;
    let processed = 0;

    for (const file of parsedFiles) {
        signal?.throwIfAborted();

        const scan = await scanFile(file, targetName, kindFilter, signal);

        total += scan.total;

        if (scan.scopes.size > 0) {
            files.push({
                path: file.path,
                scopes: sortedScopes(scan.scopes),
            });
        }

        processed += 1;

        if (processed % USAGE_FILE_YIELD_INTERVAL === 0) {
            await yieldToEventLoop(0, signal);
        }
    }

    return { total, files };
}

async function scanFile(
    file: ParsedFile,
    targetName: string,
    kindFilter: UsageKind | undefined,
    signal?: AbortSignal,
): Promise<FileScan> {
    const index = await usageIndexFor(file, signal);
    const lines = file.source.split("\n");
    const expected = normalizeText(targetName);
    const scopes = new Map<string, Occurrence[]>();
    const seen = new Set<number>();
    let total = 0;
    let processed = 0;

    for (const entry of index.entries) {
        processed += 1;

        if (processed % USAGE_ENTRY_YIELD_INTERVAL === 0) {
            signal?.throwIfAborted();
            await yieldToEventLoop(0, signal);
        }

        if (entry.name !== expected) {
            continue;
        }

        if (kindFilter !== undefined && !matchesFilter(entry.tag, kindFilter)) {
            continue;
        }

        if (seen.has(entry.startIndex)) {
            continue;
        }

        total += 1;

        const scope = scopeFor(index.scopes, entry.startIndex);
        const occurrences = scopes.get(scope) ?? [];

        occurrences.push({
            line: entry.line,
            column: entry.column,
            text: shortLine(lines[entry.line - 1] ?? ""),
            tag: entry.tag,
        });
        scopes.set(scope, occurrences);
        seen.add(entry.startIndex);
    }

    return { total, scopes };
}

async function usageIndexFor(file: ParsedFile, signal?: AbortSignal): Promise<UsageIndex> {
    const cached = usageIndexes.get(file);

    if (cached !== undefined) {
        return cached;
    }

    if (adapterForLanguage(file.language).grammar === undefined) {
        return { entries: [], scopes: [] };
    }

    const index =
        file.size >= WORKER_PARSE_THRESHOLD_BYTES
            ? ((await buildUsageIndexInWorker(file, signal)) ??
              (await buildUsageIndex(file, signal)))
            : await buildUsageIndex(file, signal);

    usageIndexes.set(file, index);

    return index;
}

export async function buildUsageIndex(file: ParsedFile, signal?: AbortSignal): Promise<UsageIndex> {
    signal?.throwIfAborted();

    const adapter = adapterForLanguage(file.language);

    if (adapter.grammar === undefined) {
        return { entries: [], scopes: [] };
    }

    const source = adapter.preprocess(file.source);
    const { tree, root } = await parseSyntax(adapter.grammar, source);

    try {
        const definitions = definitionMap(file);
        const scopes = file.all
            .filter((declaration) => SCOPE_KINDS.has(declaration.kind))
            .toSorted((left, right) => left.range.startIndex - right.range.startIndex);
        const entries: UsageEntry[] = [];
        const stack: SyntaxNode[] = [root];
        let processed = 0;

        while (stack.length > 0) {
            signal?.throwIfAborted();

            const node = stack.pop();

            if (node === undefined) {
                continue;
            }

            processed += 1;

            if (processed % USAGE_INDEX_YIELD_INTERVAL === 0) {
                await yieldToEventLoop(0, signal);
            }

            if (!IDENTIFIER_NODES.has(node.type)) {
                pushChildren(stack, node);

                continue;
            }

            const text = file.source.slice(node.startIndex, node.endIndex);

            entries.push({
                name: usageName(node.type, text),
                startIndex: node.startIndex,
                line: node.startPosition.row + 1,
                column: node.startPosition.column,
                tag: classify(
                    node,
                    definitions,
                    file.source,
                    adapter.callTargets,
                    adapter.kernelLaunch === true,
                ),
            });

            pushChildren(stack, node);
        }

        return { entries, scopes };
    } finally {
        // The index is plain data; free the WASM tree immediately instead of keeping it with the cache entry.
        tree.delete();
    }
}

function definitionMap(file: ParsedFile): Map<number, Declaration> {
    const definitions = new Map<number, Declaration>();

    for (const declaration of file.all) {
        if (declaration.nameRange !== undefined) {
            definitions.set(declaration.nameRange.startIndex, declaration);
        }
    }

    return definitions;
}

function sortedScopes(
    scopes: ReadonlyMap<string, Occurrence[]>,
): Array<{ name: string; occurrences: Occurrence[] }> {
    return Array.from(scopes.entries())
        .map(([name, occurrences]) => ({
            name,
            occurrences: occurrences.toSorted(
                (left, right) => left.line - right.line || left.column - right.column,
            ),
        }))
        .toSorted((left, right) => {
            const leftLine = left.occurrences[0]?.line ?? 0;
            const rightLine = right.occurrences[0]?.line ?? 0;

            return leftLine - rightLine || left.name.localeCompare(right.name);
        });
}

function pushChildren(stack: SyntaxNode[], node: SyntaxNode): void {
    for (let index = node.namedChildCount - 1; index >= 0; index -= 1) {
        const child = node.namedChild(index);

        if (child !== null) {
            stack.push(child);
        }
    }
}

function renderSection(
    source: CodeSource,
    raw: string,
    collected: Collected,
    languages: string,
    parseErrors: number,
    rootDisplay: string,
): string {
    const headerNotes = [
        `# usages ${raw} · ${collected.total} matches · ${languages} · syntactic (name-based)`,
    ];

    if (parseErrors > 0) {
        headerNotes.push(`# parse: ${parseErrors} error node(s)`);
    }

    if (collected.files.length === 0) {
        headerNotes.push(`# no usages found in ${rootDisplay}`);
    }

    const body: string[] = [];

    for (const file of collected.files) {
        body.push(source.displayPath(file.path));

        for (const scope of file.scopes) {
            body.push(`  ${scope.name.length === 0 ? "<file scope>" : scope.name}`);

            for (const occurrence of scope.occurrences) {
                body.push(`    :${occurrence.line}  ${occurrence.text}  [${occurrence.tag}]`);
            }
        }
    }

    if (body.length > 0) {
        body.push(
            "# note: overloads, generics, templates, macros, and dynamic dispatch are not resolved",
        );
    }

    return [headerNotes.join("\n"), body.join("\n")].filter((part) => part.length > 0).join("\n\n");
}

function usageName(nodeType: string, text: string): string {
    const normalized = normalizeText(text);

    if (nodeType === "operator_cast") {
        const open = normalized.indexOf("(");

        return open < 0 ? normalized : normalized.slice(0, open);
    }

    if (nodeType === "variable_name") {
        return normalized.replace(/^\$/, "");
    }

    return normalized;
}

function classify(
    node: SyntaxNode,
    definitions: ReadonlyMap<number, Declaration>,
    originalSource: string,
    callTargets: readonly CallSiteSpec[],
    kernelLaunch: boolean,
): UsageTag {
    const declaration = definitions.get(node.startIndex);

    if (declaration !== undefined) {
        return declaration.isDefinition ? "def" : "decl";
    }

    if (isCallTarget(node, callTargets)) {
        const after = originalSource.slice(node.endIndex);

        return kernelLaunch && /^\s*<<</.test(after) ? "launch" : "call";
    }

    return "ref";
}

function isCallTarget(node: SyntaxNode, callTargets: readonly CallSiteSpec[]): boolean {
    let current: SyntaxNode | null = node;

    for (let depth = 0; depth < 8; depth += 1) {
        const parent: SyntaxNode | null = current?.parent ?? null;

        if (parent === null) {
            return false;
        }

        for (const spec of callTargets) {
            if (parent.type !== spec.type) {
                continue;
            }

            const target =
                (spec.field === undefined ? null : parent.childForFieldName(spec.field)) ??
                parent.namedChildren[0] ??
                null;

            if (target !== null && contains(target, node)) {
                return true;
            }
        }

        current = parent;
    }

    return false;
}

function contains(ancestor: SyntaxNode, node: SyntaxNode): boolean {
    return ancestor.startIndex <= node.startIndex && node.endIndex <= ancestor.endIndex;
}

function scopeFor(scopes: readonly Declaration[], index: number): string {
    for (let position = scopes.length - 1; position >= 0; position -= 1) {
        const declaration = scopes[position];

        if (
            declaration !== undefined &&
            declaration.range.startIndex <= index &&
            index < declaration.range.endIndex
        ) {
            return declaration.qualifiedName;
        }
    }

    return "";
}

function matchesFilter(tag: UsageTag, filter: UsageKind): boolean {
    switch (filter) {
        case "def":
            return tag === "def" || tag === "decl";
        case "call":
            return tag === "call" || tag === "launch";
        case "ref":
            return tag === "ref";
    }
}

function normalizeText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function sumParseErrors(parsed: readonly ParsedFile[]): number {
    return parsed.reduce((total, file) => total + file.parseErrors, 0);
}
