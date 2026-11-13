import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import { yieldToEventLoop } from "../../common/async";
import { applyGlobFilter, candidateFiles, lastComponent } from "./discovery";
import {
    filterNote,
    nextOffsetNote,
    renderWithinBudget,
    shortLine,
    splitSymbolList,
    withinNote,
} from "./format";
import { DEFAULT_CHAR_LIMIT } from "./languages";
import { loadParsedFiles } from "./load";
import { adapterForLanguage, type CallSiteSpec } from "./adapters";
import { withinScope, type WithinScope } from "./scope";
import type { CodeSource } from "./source";
import { CallTiming } from "./timing";
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
    timing: CallTiming = new CallTiming(),
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

    const phase = await timing.measure("discover", () =>
        candidateFiles(source, root, requested, signal),
    );
    const globbed = applyGlobFilter(phase.files, root, params.glob);
    const discovery = { ...phase, files: globbed.files };
    const filter = filterNote({ glob: params.glob, globHidden: globbed.hidden });

    if (discovery.files.length === 0) {
        return {
            text: [
                `# no usages found for ${requested.join(", ")} in ${source.displayPath(root)} · ${params.glob === undefined ? "no supported files" : `no files match glob=${params.glob}`}`,
                filter ?? "",
            ]
                .filter((line) => line.length > 0)
                .join("\n"),
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
    const parsedAll = batch.parsed.toSorted((left, right) => left.path.localeCompare(right.path));
    const scoped =
        params.within === undefined
            ? undefined
            : await timing.measure("search", () =>
                  withinScope({
                      source,
                      root,
                      raw: params.within ?? "",
                      parsed: parsedAll,
                      files: phase.files,
                      signal,
                  }),
              );

    if (scoped !== undefined && "error" in scoped) {
        return {
            text: scoped.error,
            files: 0,
            parseErrors: sumParseErrors(parsedAll),
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const files = scoped?.scope.parsed ?? parsedAll;
    const parseErrors = sumParseErrors(files);
    const languages = Array.from(new Set(files.map((file) => file.language)))
        .toSorted()
        .join(",");
    const within = scoped === undefined ? undefined : withinLine(source, scoped.scope);
    const sections: string[] = [];
    let totalMatches = 0;
    const truncated = discovery.truncated;

    for (const raw of requested) {
        const target: UsageTarget = {
            name: lastComponent(raw),
            typeName: qualifierTypeOf(raw),
        };
        const collected = await collectForFiles(files, target, params.kind, signal);

        totalMatches += collected.total;

        sections.push(
            renderSection(source, raw, collected, languages, parseErrors, source.displayPath(root)),
        );
    }

    if (sections.length === 1) {
        const section = sections[0] ?? "";
        const [header = "", ...blocks] = section.split("\n\n");
        const fitted = renderWithinBudget(header, blocks, limit, offset);
        const next = nextOffsetNote(fitted);

        return {
            text: [fitted.text, next, filter, within]
                .filter((part): part is string => part !== undefined && part.length > 0)
                .join("\n"),
            files: files.length,
            parseErrors,
            truncated: truncated || fitted.truncated,
            matches: totalMatches,
        };
    }

    const header = `# usages ${requested.join(", ")} · ${languages} · syntactic (name-based)`;
    const fitted = renderWithinBudget(header, sections, limit, offset);
    const next = nextOffsetNote(fitted);

    return {
        text: [fitted.text, next, filter, within]
            .filter((part): part is string => part !== undefined && part.length > 0)
            .join("\n"),
        files: files.length,
        parseErrors,
        truncated: truncated || fitted.truncated,
        matches: totalMatches,
    };
}

interface Collected {
    total: number;
    /** The enclosing type the caller named, when it named one. */
    qualifiedType?: string;
    files: Array<{
        path: string;
        scopes: Array<{ name: string; matchedType: boolean; occurrences: Occurrence[] }>;
    }>;
}

interface FileScan {
    total: number;
    scopes: Array<{ name: string; matchedType: boolean; occurrences: Occurrence[] }>;
}

/** A qualified request: the member name plus the type the caller asked for, when it named one. */
interface UsageTarget {
    name: string;
    /** Last component of the qualifier: `A::B::run` asks for `run` on `B`. */
    typeName?: string;
}

async function collectForFiles(
    parsedFiles: readonly ParsedFile[],
    target: UsageTarget,
    kindFilter: UsageKind | undefined,
    signal?: AbortSignal,
): Promise<Collected> {
    const files: Collected["files"] = [];
    let total = 0;
    let processed = 0;

    for (const file of parsedFiles) {
        signal?.throwIfAborted();

        const scan = await scanFile(file, target, kindFilter, signal);

        total += scan.total;

        if (scan.scopes.length > 0) {
            files.push({
                path: file.path,
                scopes: scan.scopes,
            });
        }

        processed += 1;

        if (processed % USAGE_FILE_YIELD_INTERVAL === 0) {
            await yieldToEventLoop(0, signal);
        }
    }

    return { total, qualifiedType: target.typeName, files };
}

async function scanFile(
    file: ParsedFile,
    target: UsageTarget,
    kindFilter: UsageKind | undefined,
    signal?: AbortSignal,
): Promise<FileScan> {
    const index = await usageIndexFor(file, signal);
    const lines = file.source.split("\n");
    const definitions = definitionMap(file);
    const expected = normalizeText(target.name);
    const expectedType = target.typeName?.toLowerCase();
    const scopes = new Map<
        string,
        { name: string; matchedType: boolean; occurrences: Occurrence[] }
    >();
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
        // A declaration of the member itself is qualified by its own name, not by an enclosing scope: the definition
        // of `CallList::attention_paged` sits at namespace scope, and walking outward would find no type at all.
        const declared = definitions.get(entry.startIndex);
        const matchedType =
            declared === undefined
                ? matchesEnclosingType(index.scopes, entry.startIndex, expectedType)
                : qualifiedNameHasParent(declared.qualifiedName, expectedType);
        const group = scopes.get(scope) ?? { name: scope, matchedType, occurrences: [] };

        group.occurrences.push({
            line: entry.line,
            column: entry.column,
            text: shortLine(lines[entry.line - 1] ?? ""),
            tag: entry.tag,
        });
        group.matchedType ||= matchedType;
        scopes.set(scope, group);
        seen.add(entry.startIndex);
    }

    return { total, scopes: sortedScopes(Array.from(scopes.values())) };
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

/**
 * Order groups by evidence: the type the caller named first, then by position.
 *
 * A qualified request used to be matched on its last name component alone, so `CallList::attention_paged` mixed
 * calls through a *different* struct's field into rows that look precise. Ordering and marking keep the rows (an
 * aliased or unqualified use is still a real use) without pretending they are the same symbol.
 */
function sortedScopes(
    scopes: Array<{ name: string; matchedType: boolean; occurrences: Occurrence[] }>,
): FileScan["scopes"] {
    return scopes
        .map((scope) => ({
            ...scope,
            occurrences: scope.occurrences.toSorted(
                (left, right) => left.line - right.line || left.column - right.column,
            ),
        }))
        .toSorted((left, right) => {
            const leftLine = left.occurrences[0]?.line ?? 0;
            const rightLine = right.occurrences[0]?.line ?? 0;

            if (left.matchedType !== right.matchedType) {
                return left.matchedType ? -1 : 1;
            }

            return leftLine - rightLine || left.name.localeCompare(right.name);
        });
}

/** The last component of a request's qualifier, e.g. `CallList` from `A::CallList::run`. */
function qualifierTypeOf(raw: string): string | undefined {
    const doubleColon = raw.lastIndexOf("::");
    const dot = raw.lastIndexOf(".");
    const separator = Math.max(doubleColon, dot);

    if (separator <= 0) {
        return undefined;
    }

    const qualifier = raw.slice(0, separator);
    const last = lastComponent(qualifier).toLowerCase();

    return last.length === 0 ? undefined : last;
}

const TYPE_SCOPE_KINDS = new Set(["class", "struct", "union", "interface", "trait", "enum"]);

/**
 * Whether the nearest enclosing type is the one the caller asked for.
 *
 * Walks outward past the function that holds the use: `rig.ops.attention_paged(...)` inside
 * `bench::run_attention_paged` belongs to the benchmark's own code, not to `CallList`, and only the enclosing
 * *type* can tell the two apart.
 */
/** Whether a declaration's qualified name places it under the named type, e.g. `CallList::attention_paged`. */
function qualifiedNameHasParent(qualifiedName: string, expectedType: string | undefined): boolean {
    if (expectedType === undefined) {
        return false;
    }

    const separator = qualifiedName.lastIndexOf("::");
    const dot = qualifiedName.lastIndexOf(".");

    if (Math.max(separator, dot) <= 0) {
        return false;
    }

    const parent = qualifiedName.slice(0, Math.max(separator, dot));

    return lastComponent(parent).toLowerCase() === expectedType;
}

function matchesEnclosingType(
    scopes: readonly Declaration[],
    index: number,
    expectedType: string | undefined,
): boolean {
    if (expectedType === undefined) {
        return false;
    }

    const contains = (declaration: Declaration): boolean =>
        declaration.range.startIndex <= index && index < declaration.range.endIndex;
    const enclosing = scopes.findLast(
        (declaration) => TYPE_SCOPE_KINDS.has(declaration.kind) && contains(declaration),
    );

    if (enclosing !== undefined) {
        return lastComponent(enclosing.qualifiedName).toLowerCase() === expectedType;
    }

    // An out-of-line member definition has no enclosing type *declaration* in its file: `CallList::run_one` sits at
    // namespace scope in `call_list.cpp`, so every call inside its body used to be tagged `[name-only]` even though
    // the call is in the class the caller asked about. The function's own qualified name carries that fact.
    const enclosingScope = scopes.findLast(contains);

    return (
        enclosingScope !== undefined &&
        qualifiedNameHasParent(enclosingScope.qualifiedName, expectedType)
    );
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
    const mixed =
        collected.qualifiedType !== undefined &&
        collected.files.some((file) => file.scopes.some((scope) => !scope.matchedType));

    for (const file of collected.files) {
        body.push(source.displayPath(file.path));

        for (const scope of file.scopes) {
            const mark = mixed && !scope.matchedType ? "  [name-only]" : "";

            body.push(`  ${scope.name.length === 0 ? "<file scope>" : scope.name}${mark}`);

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

    if (mixed) {
        body.push(
            "# name-only: the name matches but the enclosing type is not the one you qualified; these rows rank after the typed matches",
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

function withinLine(source: CodeSource, scope: WithinScope): string {
    return withinNote({
        direction: scope.direction,
        anchor: source.displayPath(scope.anchor),
        files: scope.parsed.length,
        outside: scope.outside,
    });
}

function sumParseErrors(parsed: readonly ParsedFile[]): number {
    return parsed.reduce((total, file) => total + file.parseErrors, 0);
}
