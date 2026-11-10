import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { ContainerState } from "../../modules/sandbox/container/state";
import { runDigest } from "./digest";
import { DEFAULT_CHAR_LIMIT, MIN_CHAR_LIMIT } from "./languages";
import { runSearch } from "./search";
import { runShow } from "./show";
import { createCodeSource } from "./source";
import type { CodeAction, CodeActionResult, CodeDetail, CodeToolParams, UsageKind } from "./types";
import { runUsages } from "./usages";

/**
 * `outline` — structural navigation without reading whole files.
 *
 * The model-facing surface is deliberately one tool with four questions: `digest` to orient in a module,
 * `search` to find declarations by partial name, `show` to extract a named declaration, and `usages` to find
 * syntactic occurrences. Every filesystem read goes through `CodeSource`, so a container session answers from
 * the same view as `bash` and `read`.
 */
export default function registerCodeTool(pi: ExtensionAPI, container?: ContainerState): void {
    pi.registerTool({
        name: "outline",
        label: "Outline",
        description:
            "Inspect code structure without reading whole files. " +
            'action="digest" maps a file or directory: namespaces, types, signatures, and line ranges. ' +
            'action="search" finds declarations by partial name, falling back to approximate names when there are no literal hits. ' +
            'action="show" returns exact source for named symbols; class/struct/interface targets return member signatures unless detail="full"; when path is a directory it pairs header declarations with source definitions. ' +
            'action="usages" finds syntactic references, calls, and launches; it is name-based, not type-resolved. ' +
            'Symbols accept "ns::Type::member" or "Type.member"; append parameter types to select an overload. ' +
            "Supports C/C++/HIP, JavaScript/TypeScript (JSX/TSX), Java, C#, Go, Rust, Python, PHP, Ruby, and Markdown headings. Paths are relative to the working directory, and output is character-limited. A cut result ends with # next: offset=N; pass offset to continue from there.",
        promptSnippet:
            'Use outline(action="search") to find a declaration by name, outline(action="digest") to map a module, and outline(action="show") to read one declaration before opening whole files. outline(action="usages") is syntactic, not clangd-accurate.',
        promptGuidelines: [
            "Prefer outline digest over reading every file in a directory, and outline show over reading a whole file for one function or class.",
            "Use outline search when you know part of a declaration name but not its exact qualified name; search is name-based and does not search comments or strings.",
            "Outline usages reports syntactic matches only; it does not resolve overloads, generics, macros, or dynamic dispatch.",
            "When outline output ends with # next: offset=N, call it again with the same parameters and that offset to continue.",
        ],
        parameters: Type.Object({
            action: Type.Unsafe<CodeAction>({
                type: "string",
                enum: ["digest", "search", "show", "usages"],
                description:
                    "digest maps a file or directory; search finds declarations by name; show extracts named symbols; usages finds syntactic occurrences",
            }),
            path: Type.Optional(
                Type.String({
                    description:
                        "File or directory to inspect, relative to the working directory. Defaults to the working directory.",
                }),
            ),
            query: Type.Optional(
                Type.String({
                    description:
                        'search only: declaration name or partial name, e.g. "plan" or "CallList::execute"',
                }),
            ),
            symbols: Type.Optional(
                Type.Array(Type.String(), {
                    description:
                        'Symbols for show/usages, e.g. ["net::Socket::connect"] or ["Socket"]; append parameter types to select an overload',
                    minItems: 1,
                }),
            ),
            detail: Type.Optional(
                Type.Unsafe<CodeDetail>({
                    type: "string",
                    enum: ["signatures", "full"],
                    description:
                        "digest/show only: signatures returns declarations only; full returns bodies / all members. Defaults: signatures for digest, full for functions and signatures for containers in show.",
                }),
            ),
            limit: Type.Optional(
                Type.Number({
                    description: "Maximum result size in characters (default 16000)",
                    minimum: MIN_CHAR_LIMIT,
                    maximum: 1_000_000,
                }),
            ),
            kind: Type.Optional(
                Type.Unsafe<UsageKind>({
                    type: "string",
                    enum: ["def", "call", "ref"],
                    description:
                        "usages only: narrow to definitions, calls/launches, or references",
                }),
            ),
            offset: Type.Optional(
                Type.Number({
                    description:
                        "Body-line offset for continuing a result cut by the limit (default 0)",
                    minimum: 0,
                    maximum: 1_000_000,
                }),
            ),
        }),
        renderCall(args, theme, _context) {
            const action = args.action ?? "digest";
            const target = args.path ?? ".";
            let text = theme.fg("toolTitle", theme.bold(`outline ${action} `));
            text += theme.fg("accent", target);

            if (args.query !== undefined && args.query.length > 0) {
                text += theme.fg("accent", ` "${args.query}"`);
            }

            if (args.symbols !== undefined && args.symbols.length > 0) {
                text += theme.fg("muted", ` ${args.symbols.join(", ")}`);
            }

            if ((args.offset ?? 0) > 0) {
                text += theme.fg("muted", ` offset=${args.offset}`);
            }

            return new Text(text, 0, 0);
        },
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const limit = Math.max(MIN_CHAR_LIMIT, params.limit ?? DEFAULT_CHAR_LIMIT);
            const effective: CodeToolParams = {
                action: params.action as CodeAction,
                path: params.path,
                query: params.query,
                symbols: params.symbols,
                detail: params.detail,
                limit,
                offset: Math.max(0, Math.floor(params.offset ?? 0)),
                kind: params.kind,
            };
            const fallbackPath = params.path ?? ".";

            try {
                const source = await createCodeSource(ctx, container);
                const result = await dispatchAction(source, effective, signal);

                return {
                    content: [{ type: "text", text: result.text }],
                    details: result.details,
                } satisfies {
                    content: Array<{ type: "text"; text: string }>;
                    details: CodeActionResult["details"];
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `# outline ${params.action} failed\n${messageOf(error)}`,
                        },
                    ],
                    details: {
                        action: params.action as CodeAction,
                        path: fallbackPath,
                        source: container?.active === true ? "container" : "local",
                        files: 0,
                    } satisfies CodeActionResult["details"],
                };
            }
        },
    });
}

async function dispatchAction(
    source: Awaited<ReturnType<typeof createCodeSource>>,
    params: CodeToolParams,
    signal: AbortSignal | undefined,
): Promise<CodeActionResult> {
    const base = {
        action: params.action,
        path: params.path ?? ".",
        source: source.kind,
    };

    switch (params.action) {
        case "digest": {
            const result = await runDigest(source, params, signal);

            return {
                text: result.text,
                details: {
                    ...base,
                    files: result.files,
                    parseErrors: result.parseErrors,
                    truncated: result.truncated,
                },
            };
        }
        case "search": {
            const result = await runSearch(source, params, signal);

            return {
                text: result.text,
                details: {
                    ...base,
                    files: result.files,
                    matches: result.matches,
                    parseErrors: result.parseErrors,
                    truncated: result.truncated,
                },
            };
        }
        case "show": {
            const result = await runShow(source, params, signal);

            return {
                text: result.text,
                details: {
                    ...base,
                    files: result.files,
                    matches: result.matches,
                    parseErrors: result.parseErrors,
                    truncated: result.truncated,
                },
            };
        }
        case "usages": {
            const result = await runUsages(source, params, signal);

            return {
                text: result.text,
                details: {
                    ...base,
                    files: result.files,
                    matches: result.matches,
                    parseErrors: result.parseErrors,
                    truncated: result.truncated,
                },
            };
        }
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
