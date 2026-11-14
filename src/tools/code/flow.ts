import {
    bodyThenFooter,
    discoveryCapNote,
    filterNote,
    lineRange,
    nextOffsetNote,
    parseSelector,
    renderWithinBudget,
    scopeLabel,
    selectorMatches,
    splitSymbolList,
} from "./format";
import { DEFAULT_CHAR_LIMIT } from "./languages";
import { discoverFiles, filterPathTarget, parsePathTarget } from "./discovery";
import { loadParsedFiles } from "./load";
import { adapterForLanguage } from "./adapters";
import type { CodeSource } from "./source";
import { CallTiming } from "./timing";
import { parseSyntax } from "./tree-sitter";
import type { CodeToolParams, Declaration, ParsedFile, SymbolSelector } from "./types";
import { isScopeKind, scopeAt } from "./usages";
import { yieldToEventLoop } from "../../common/async";

export interface FlowResult {
    text: string;
    files: number;
    parseErrors: number;
    truncated: boolean;
    matches: number;
}

/** One call site: the callee, the whole call collapsed to a line, and where it starts. */
interface CallSite {
    target: string;
    text: string;
    line: number;
    start: number;
    /** The call expression's own span, used to drop a call that is part of another one's callee. */
    end: number;
    calleeStart: number;
    calleeEnd: number;
}

/** Call sites of one callee, in source order. */
interface CallGroup {
    target: string;
    sites: CallSite[];
}

/** The call sites of one scope, grouped by callee in first-appearance order. */
interface ScopeCalls {
    /** The scope, or `undefined` for calls that sit at file scope. */
    scope: Declaration | undefined;
    groups: CallGroup[];
    /** Call sites in this scope, including the ones the cap withheld. */
    total: number;
}

/**
 * Callees one scope may print before the rest are counted instead of listed.
 *
 * Grouping by callee made a directory of test files legible, but a 143-call method still needs a ceiling: the cap
 * keeps one scope scannable, and the hidden count is printed so a capped scope never reads as a small one.
 */
const MAX_ROWS_PER_SCOPE = 40;

/** Lines named per repeat, so `×12` stays one row instead of twelve. */
const MAX_LINES_PER_GROUP = 6;

/** Characters kept from a single call before it is cut. */
const ROW_CHARS = 96;

/** Files between event-loop yields, so a directory scan does not starve the TUI. */
const FILE_YIELD_INTERVAL = 16;

/**
 * `flow` - the call sites of a file or directory, grouped by scope and then by callee.
 *
 * `digest` answers where things are declared and `show` returns one body; this answers what a stretch of code *does*,
 * which is the question behind reading a function to see what it calls. Rows are call expressions, not source lines:
 * a line that merely *contains* an identifier and an open paren reads as a fragment of an expression (`.filter((line)`
 * or `filter ?? ""`), while the callee plus its arguments is the unit a reader scans.
 *
 * The call shape comes from the language adapter's `callTargets`, so all ten languages work without a node type
 * leaking into this file. A call that sits inside another call's *callee* is dropped (the inner `expect(x)` of
 * `expect(x).toBe(y)`), while a call in another call's arguments is kept: `timing.measure("x", () => work())` is two
 * things the scope does.
 *
 * `query` narrows to scopes matching a selector instead of resolving a call: every match is reported under its own
 * heading, so a title shared by two suites is listed rather than guessed between.
 */
export async function runFlow(
    source: CodeSource,
    params: CodeToolParams,
    signal?: AbortSignal,
    timing: CallTiming = new CallTiming(),
): Promise<FlowResult> {
    const target = parsePathTarget(params.path);
    const root = source.resolvePath(target.base);
    const label = target.pattern ?? source.displayPath(root);
    const limit = params.limit ?? DEFAULT_CHAR_LIMIT;
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const query = params.query?.trim() ?? "";
    const selectors = splitSymbolList(query.length === 0 ? [] : [query]).map(parseSelector);
    const filter = filterNote({ path: target.pattern });

    await source.assertReadable(root);

    const discovery = await timing.measure("discover", () =>
        discoverFiles(source, root, signal, undefined),
    );
    const targeted = filterPathTarget(discovery.files, source, target);
    const files = targeted.files;

    if (files.length === 0) {
        return {
            text: [
                header(query, label, []),
                target.pattern === undefined ? "# no supported files" : "# no files match",
                '# next: outline(action="digest", path=.) lists the files this path resolves to',
                filter ?? "",
                discovery.truncated ? discoveryCapNote() : "",
            ]
                .filter((line) => line.length > 0)
                .join("\n"),
            files: 0,
            parseErrors: 0,
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const batch = await timing.measure("parse", () => loadParsedFiles(source, files, signal));
    timing.recordLoad(batch, files.length);

    const parsed = batch.parsed.toSorted((left, right) => left.path.localeCompare(right.path));
    const scanned = await timing.measure("search", async () => {
        const perFile: Array<{ file: ParsedFile; scopes: ScopeCalls[] }> = [];

        for (const [index, file] of parsed.entries()) {
            if (index > 0 && index % FILE_YIELD_INTERVAL === 0) {
                await yieldToEventLoop(0, signal);
            }

            perFile.push({ file, scopes: await scopeCalls(file, signal) });
        }

        return perFile;
    });

    const selected = scanned
        .map((entry) => ({ ...entry, scopes: narrow(entry.scopes, selectors) }))
        .filter((entry) => entry.scopes.length > 0);
    const languages = languagesOf(parsed);
    const parseErrors = parsed.reduce((sum, file) => sum + file.parseErrors, 0);
    const total = selected.reduce(
        (sum, entry) => sum + entry.scopes.reduce((inner, scope) => inner + scope.total, 0),
        0,
    );

    if (total === 0) {
        return {
            text: bodyThenFooter(
                [
                    header(query, label, []),
                    query.length === 0
                        ? "# no call sites"
                        : "# no call sites in a scope matching that query",
                ],
                [
                    query.length === 0
                        ? undefined
                        : "# scope: query selects scopes by name; digest lists them",
                    '# next: outline(action="digest", path=...) lists what the file declares and what each scope is called',
                    filter,
                    discovery.truncated ? discoveryCapNote() : "",
                ],
            ),
            files: selected.length,
            parseErrors,
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const notes = [
        "# note: a call is a callee followed by its argument list; overloads, generics, macros, and dynamic dispatch are not resolved",
        selectors.length > 0
            ? "# scope: query selects scopes by name; digest lists them"
            : undefined,
        filter,
        discovery.truncated ? discoveryCapNote() : undefined,
    ].filter((note): note is string => note !== undefined && note.length > 0);
    const body = selected.map((entry) => renderFile(source, entry.file, entry.scopes));
    const fitted = renderWithinBudget(
        header(query, label, selected, languages),
        body,
        limit,
        offset,
    );
    const next = nextOffsetNote(fitted);

    return {
        text: bodyThenFooter([fitted.text], [...notes, next]),
        files: selected.length,
        parseErrors,
        truncated: fitted.truncated || discovery.truncated,
        matches: total,
    };
}

/**
 * The scope a call site belongs to.
 *
 * A call that *opens* a block belongs to the enclosing scope, not to the block it opens: `describe("suite", () =>
 * ...)` is a call made by the file, and `it("case", () => ...)` is a call made by the suite. Excluding a scope whose
 * own body starts at the call (`startIndex < index`) is what expresses that, and it is why a suite's rows are its
 * cases rather than a repeat of its own heading.
 */
function ownerScope(scopes: readonly Declaration[], index: number): Declaration | undefined {
    return scopes.findLast(
        (scope) => scope.range.startIndex < index && index < scope.range.endIndex,
    );
}

/** The call sites of one file, grouped by scope: file scope first, then scopes in source order. */
async function scopeCalls(file: ParsedFile, signal?: AbortSignal): Promise<ScopeCalls[]> {
    const calls = await callsOf(file, signal);

    if (calls.length === 0) {
        return [];
    }

    const scopes = file.all
        .filter((declaration) => isScopeKind(declaration.kind))
        .toSorted((left, right) => left.range.startIndex - right.range.startIndex);
    const grouped = new Map<
        number,
        { scope: Declaration | undefined; groups: Map<string, CallSite[]> }
    >();

    for (const call of calls) {
        const scope = ownerScope(scopes, call.start);
        const key = scope?.range.startIndex ?? -1;
        const entry = grouped.get(key) ?? { scope, groups: new Map<string, CallSite[]>() };
        const sites = entry.groups.get(call.target) ?? [];
        // A call that opens a block is the block's heading, not a paragraph of its parent: its arguments span the
        // whole body, so printing them would put a suite's 90 lines inside the file's row.
        const opener = scopeAt(scopes, call.start)?.range.startIndex === call.start;

        sites.push(opener ? { ...call, text: call.target } : call);
        entry.groups.set(call.target, sites);
        grouped.set(key, entry);
    }

    return Array.from(grouped.entries())
        .toSorted(([left], [right]) => left - right)
        .map(([, entry]) => {
            const groups = Array.from(entry.groups.values()).map((sites) => ({
                target: sites[0]?.target ?? "",
                sites,
            }));
            const kept = groups.slice(0, MAX_ROWS_PER_SCOPE);

            return {
                scope: entry.scope,
                groups: kept,
                total: groups.reduce((sum, group) => sum + group.sites.length, 0),
            };
        })
        .filter((entry) => entry.groups.length > 0);
}

/**
 * Every call expression in a file, in source order.
 *
 * One parse through the language adapter: `callTargets` says which node type carries a call and which field holds
 * the callee, so this works for `call_expression`, `function_call_expression`, `method_invocation`, and the rest
 * without naming any of them here.
 */
async function callsOf(file: ParsedFile, signal?: AbortSignal): Promise<CallSite[]> {
    const adapter = adapterForLanguage(file.language);

    if (adapter.grammar === undefined) {
        return [];
    }

    const parseBuffer = adapter.preprocess(file.source);
    const { tree, root } = await parseSyntax(adapter.grammar, parseBuffer);
    const fields = new Map(adapter.callTargets.map((spec) => [spec.type, spec.field]));
    const found: CallSite[] = [];

    try {
        const stack = [root];

        while (stack.length > 0) {
            signal?.throwIfAborted();

            const node = stack.pop();

            if (node === undefined) {
                continue;
            }

            const field = fields.get(node.type);

            if (field !== undefined) {
                const callee = node.childForFieldName(field);

                found.push({
                    target:
                        callee === null
                            ? ""
                            : collapse(file.source.slice(callee.startIndex, callee.endIndex)),
                    text: short(
                        collapse(file.source.slice(node.startIndex, node.endIndex)),
                        ROW_CHARS,
                    ),
                    line: node.startPosition.row + 1,
                    start: node.startIndex,
                    end: node.endIndex,
                    calleeStart: callee?.startIndex ?? node.startIndex,
                    calleeEnd: callee?.endIndex ?? node.startIndex,
                });
            }

            for (const child of node.namedChildren) {
                if (child !== null) {
                    stack.push(child);
                }
            }
        }
    } finally {
        tree.delete();
    }

    return found
        .filter(
            (call) =>
                !found.some(
                    (other) =>
                        other !== call &&
                        other.calleeStart <= call.start &&
                        call.end <= other.calleeEnd,
                ),
        )
        .toSorted((left, right) => left.start - right.start);
}

/** Keep the scopes a `query` names. An empty selector list keeps every scope, file scope included. */
function narrow(groups: readonly ScopeCalls[], selectors: readonly SymbolSelector[]): ScopeCalls[] {
    if (selectors.length === 0) {
        return Array.from(groups);
    }

    return groups.filter((group) => {
        const scope = group.scope;

        if (scope === undefined) {
            return false;
        }

        return selectors.some((selector) => selectorMatches(scope, selector));
    });
}

function renderFile(source: CodeSource, file: ParsedFile, groups: readonly ScopeCalls[]): string {
    const calls = groups.reduce((sum, group) => sum + group.total, 0);
    const lines = [
        `${source.displayPath(file.path)}  · ${calls} call site${calls === 1 ? "" : "s"} · ${groups.length} scope${groups.length === 1 ? "" : "s"}`,
    ];

    for (const group of groups) {
        lines.push(`  ${scopeHeading(group.scope)}`);

        for (const row of group.groups) {
            lines.push(`    ${renderRow(row)}`);
        }

        const withheld = group.groups.length < group.total;
        const shownCalls = group.groups.reduce((sum, row) => sum + row.sites.length, 0);

        if (withheld && shownCalls < group.total) {
            lines.push(`    # +${group.total - shownCalls} more call site(s) in this scope`);
        }
    }

    return lines.join("\n");
}

/** One row: the call itself when it happens once, and the callee with its lines when it repeats. */
function renderRow(group: CallGroup): string {
    const first = group.sites[0];

    if (first === undefined) {
        return "";
    }

    if (group.sites.length === 1) {
        return `${first.text}  :${first.line}`;
    }

    const shown = group.sites.slice(0, MAX_LINES_PER_GROUP).map((site) => `:${site.line}`);
    const rest = group.sites.length > shown.length ? ",…" : "";

    return `${group.target}  ×${group.sites.length}  ${shown.join(",")}${rest}`;
}

/** A scope's heading: the call that opened a block, or the declaration's name, with its line range. */
function scopeHeading(scope: Declaration | undefined): string {
    if (scope === undefined) {
        return "file";
    }

    // The qualified name, because a flat list of methods under one class has no indentation to carry the owner.
    const name =
        scope.blockCallee === undefined
            ? scope.qualifiedName
            : `${scope.blockCallee} "${scope.name}"`;

    return `${name}  :${lineRange(scope.range)}`;
}

function header(
    query: string,
    label: string,
    selected: ReadonlyArray<{ scopes: readonly ScopeCalls[] }>,
    languages?: string,
): string {
    // Named only when the caller did not name it: the dot is a default, not a location.
    const scope = query.length === 0 ? scopeLabel(label) : `"${query}" in ${scopeLabel(label)}`;
    const calls = selected.reduce(
        (sum, entry) => sum + entry.scopes.reduce((inner, group) => inner + group.total, 0),
        0,
    );
    const parts = [`# flow ${scope}`];

    if (selected.length > 0) {
        parts.push(`${selected.length} file${selected.length === 1 ? "" : "s"}`);
        parts.push(`${calls} call site${calls === 1 ? "" : "s"}`);
    }

    if (languages !== undefined && languages.length > 0) {
        parts.push(languages);
    }

    return parts.join(" · ");
}

function languagesOf(parsed: readonly ParsedFile[]): string {
    const languages = Array.from(new Set(parsed.map((file) => file.language))).toSorted();

    if (languages.length === 0) {
        return "";
    }

    if (languages.length > 3) {
        return `${languages.length} languages`;
    }

    return languages.join(", ");
}

function collapse(text: string): string {
    return (
        text
            .replace(/\s+/g, " ")
            .replace(/\(\s+/g, "(")
            .replace(/\s+\)/g, ")")
            // A multi-line argument list usually ends with a trailing comma; keeping it would make the row read as a cut.
            .replace(/,\s*\)/g, ")")
            .trim()
    );
}

function short(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
