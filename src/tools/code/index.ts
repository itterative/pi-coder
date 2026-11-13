import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, type AutocompleteItem } from "@earendil-works/pi-tui";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

import type { ContainerState } from "../../modules/sandbox/container/state";
import { contributeToolGuide } from "../../common/prompt-section";
import sandboxConfig from "../../common/config";
import { getUserMemoryDirectory } from "../../common/constants";
import { fileRootsForOperation } from "../../modules/sandbox/file-roots";
import { outlineGuidePrompt } from "./prompt";
import { discoverFiles, parsePathTarget } from "./discovery";
import { runDeps } from "./deps";
import { runDigest } from "./digest";
import { DEFAULT_CHAR_LIMIT, MIN_CHAR_LIMIT } from "./languages";
import { loadParsedFiles } from "./load";
import { renderOutlineCall, renderOutlineResult } from "./render";
import { runSearch } from "./search";
import { artifactBytes, ensureArtifacts, artifactsPresent } from "./semantic/artifacts";
import {
    effectiveSemanticMode,
    MODEL_ID,
    readConsent,
    semanticMode,
    semanticRoot,
    writeConsent,
} from "./semantic/config";
import { buildIndex, countEmbeddings, createSemanticSearch, ensureIndexMetadata } from "./semantic";
import { projectRoots, refreshOnce, scanRoot } from "./semantic/refresh";
import { buildWorkerCount, refreshWorkerCount } from "./semantic/runtime";
import { nativeArtifactBytes } from "./semantic/artifacts";
import { nativeRuntimePresent } from "./semantic/native";
import { readManifest } from "./semantic/store";
import type { SemanticSearch } from "./semantic/types";
import { runShow } from "./show";
import { createCodeSource, type CodeReadRoots } from "./source";
import { CallTiming } from "./timing";
import {
    DECLARATION_KINDS,
    USAGE_KINDS,
    isDeclarationKind,
    isUsageKind,
    type CodeAction,
    type CodeActionResult,
    type CodeDetail,
    type CodeToolParams,
    type KindFilter,
} from "./types";
import { runUsages } from "./usages";

/**
 * `outline` — structural navigation without reading whole files.
 *
 * The model-facing surface is deliberately one tool with five questions: `digest` to orient in a module,
 * `search` to find declarations by partial name, doc comment, or literal body text, `show` to extract a named
 * declaration, `usages` to find syntactic occurrences, and `deps` for one file's imports and dependents. Every
 * filesystem read goes through `CodeSource`, so a container session answers from the same view as `bash` and `read`.
 */
export default function registerCodeTool(pi: ExtensionAPI, container?: ContainerState): void {
    pi.registerTool({
        name: "outline",
        label: "Outline",
        description:
            "Inspect code structure without reading whole files. Supports C/C++/HIP, JavaScript/TypeScript " +
            "(JSX/TSX), Java, C#, Go, Rust, Python, PHP, Ruby, and Markdown headings; other file types are " +
            "skipped. Output is character-limited, and a cut result ends with # next: offset=N and the lines it " +
            "left. For a body over ~40 lines the span is cheaper: every header carries path:start-end, so digest " +
            "or show locates it and one read offset=start limit=n fetches it. `search` also matches literal text " +
            "inside declaration bodies ([body] rows, one row per containing declaration); line-level hits, " +
            "regex, and counts stay with rg. `deps` reports one file's imports and the files that import it.",
        promptSnippet:
            "Read code by declaration: digest a file, search names/docs/body text, show a body, find usages. " +
            "Prefer over rg/read.",
        parameters: Type.Object({
            action: Type.Unsafe<CodeAction>({
                type: "string",
                enum: ["digest", "search", "show", "usages", "deps"],
                description:
                    "digest maps a file or directory; search finds declarations by name, doc text, or literal body text, with a typo fallback; show extracts named symbols and pairs headers with definitions; usages lists syntactic occurrences; deps lists one file's imports and the files that import it",
            }),
            path: Type.Optional(
                Type.String({
                    description:
                        "File, directory, or rg-style glob pattern to inspect, relative to the working directory " +
                        "(defaults to the working directory). A pattern with `/` is anchored (`*` is one level, " +
                        "`**` crosses directories); without `/` it matches the file name at any depth. deps takes " +
                        "a literal file.",
                }),
            ),
            query: Type.Optional(
                Type.String({
                    description:
                        'search: the phrase, e.g. "plan" or "CallList::execute". Multiple words match doc text ' +
                        'and frontmatter in any order; quote them ("page table") to require adjacency. show/usages: ' +
                        'one or more symbols separated by top-level commas, e.g. "net::Socket::connect, Socket"; ' +
                        "append parameter types to select an overload.",
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
                    description:
                        `Maximum result size in characters (default ${DEFAULT_CHAR_LIMIT}); ` +
                        `at least ${MIN_CHAR_LIMIT}, which is enough for one signature`,
                    minimum: MIN_CHAR_LIMIT,
                    maximum: 1_000_000,
                }),
            ),
            kind: Type.Optional(
                Type.Unsafe<KindFilter>({
                    type: "string",
                    enum: [...DECLARATION_KINDS, ...USAGE_KINDS],
                    description:
                        "usages: def, call, or ref. digest/search: a declaration kind such as function, class, " +
                        "method, heading, or frontmatter.",
                }),
            ),
            within: Type.Optional(
                Type.String({
                    description:
                        'search/usages only: limit the scan to one file\'s direct imports (`within="src/x.ts"`) or its direct importers (`within="dependents:src/x.ts"`). The anchor is relative to the literal prefix of `path`; it is always included, and the pattern still bounds the tree.',
                }),
            ),
            offset: Type.Optional(
                Type.Number({
                    description:
                        "Body-line offset for continuing a result cut by the limit (default 0); the previous page names it in # next",
                    minimum: 0,
                    maximum: 1_000_000,
                }),
            ),
        }),
        renderCall: renderOutlineCall,
        renderResult: renderOutlineResult,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const limit = Math.max(MIN_CHAR_LIMIT, params.limit ?? DEFAULT_CHAR_LIMIT);
            const effective: CodeToolParams = {
                action: params.action as CodeAction,
                path: params.path,
                query: params.query,
                detail: params.detail,
                limit,
                offset: Math.max(0, Math.floor(params.offset ?? 0)),
                kind: params.kind,
                within: params.within,
            };
            const fallbackPath = params.path ?? ".";

            try {
                const timing = new CallTiming();
                const source = await timing.measure("source", () =>
                    createCodeSource(ctx, container, codeReadRoots),
                );
                const semantic =
                    params.action === "search"
                        ? await timing.measure("semantic", () => prepareSemantic(ctx))
                        : undefined;
                const result = await dispatchAction(source, effective, signal, semantic, timing);

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
                            text: failureText(params, error),
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

    pi.on("before_agent_start", (event) => {
        contributeToolGuide(event.systemPromptOptions, "outline", outlineGuidePrompt());
    });

    // An idle refresh, so drift is caught while nothing waits on it: at session start (immediately, so the first
    // search of the session is warm) and five minutes after the agent settles. Activity cancels the armed timer.
    const refresh = idleRefresh((ctx) => createCodeSource(ctx, container, codeReadRoots));

    pi.on("session_start", (_event, ctx) => {
        void refresh.run(ctx);
    });
    pi.on("agent_settled", (_event, ctx) => {
        refresh.arm(ctx);
    });
    pi.on("agent_start", () => {
        refresh.cancel();
    });
    pi.on("message_start", () => {
        refresh.cancel();
    });
    pi.on("session_shutdown", () => {
        refresh.cancel();
    });

    pi.registerCommand("outline", {
        description: "Outline search: semantic status, opt-in, index build, and purge",
        getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
            completeOutlineArguments(prefix),
        handler: (args, ctx) => handleOutlineCommand(args, ctx, container),
    });
}

/**
 * Background refresh driven by the session rather than by a search.
 *
 * A search only notices drift under the path it happened to look at, and only when it was asked — so a refactor could
 * leave the index stale for a whole session. This arms a scan when the agent goes idle and runs one at session start.
 *
 * It never prompts, never downloads, and never runs when the mode is not `hybrid`: the consent dialog belongs to a
 * turn, and an idle timer must not spend bandwidth. One scan at a time, and a build that is already running (from a
 * search) simply means there is nothing for this to do.
 */
function idleRefresh(
    sourceFor: (ctx: ExtensionContext) => Promise<Awaited<ReturnType<typeof createCodeSource>>>,
): { run(ctx: ExtensionContext): Promise<void>; arm(ctx: ExtensionContext): void; cancel(): void } {
    let timer: NodeJS.Timeout | undefined;
    let running = false;
    let latest: ExtensionContext | undefined;

    const cancel = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    const run = async (ctx: ExtensionContext): Promise<void> => {
        if (running) {
            return;
        }

        latest = ctx;
        const root = semanticRoot();

        if (effectiveSemanticMode(process.env, readConsent(root)).mode !== "hybrid") {
            return;
        }

        if (!artifactsPresent(root)) {
            return;
        }

        running = true;

        try {
            const source = await sourceFor(ctx);
            let announced = false;
            const outcome = await refreshOnce({
                roots: projectRoots({ modelDir: root, cwd: ctx.cwd, sourceKind: source.kind }),
                scan: (indexed) => scanRoot({ source, root: indexed.root, modelDir: root }),
                build: async (indexed, files) => {
                    if (!announced) {
                        announced = true;
                        ctx.ui.setStatus(
                            OUTLINE_STATUS_KEY,
                            "outline: refreshing in the background",
                        );
                    }

                    const built = await buildIndex({
                        sourceKind: source.kind,
                        root: indexed.root,
                        modelDir: root,
                        files,
                        // Only the changed files were parsed: pruning against them would delete the rest of the index.
                        prune: false,
                        maxWorkers: refreshWorkerCount(),
                    }).catch(() => ({ embedded: 0 }));

                    return built.embedded;
                },
            });

            if (outcome.overBudget) {
                ctx.ui.notify(
                    `outline semantic: ${outcome.missing} vector${outcome.missing === 1 ? "" : "s"} not indexed; /outline build <path>`,
                    "info",
                );

                return;
            }

            if (outcome.rebuilt > 0) {
                ctx.ui.notify(
                    `outline semantic: refreshed ${outcome.embedded} vector${outcome.embedded === 1 ? "" : "s"} in the background`,
                    "info",
                );
            }
        } finally {
            running = false;
            ctx.ui.setStatus(OUTLINE_STATUS_KEY, undefined);
        }
    };

    const arm = (ctx: ExtensionContext): void => {
        cancel();
        latest = ctx;
        timer = setTimeout(() => {
            timer = undefined;

            if (latest !== undefined) {
                void run(latest);
            }
        }, IDLE_REFRESH_DELAY_MS);
        // A pending refresh must not keep pi alive after the last turn.
        timer.unref?.();
    };

    return { run, arm, cancel };
}

async function dispatchAction(
    source: Awaited<ReturnType<typeof createCodeSource>>,
    params: CodeToolParams,
    signal: AbortSignal | undefined,
    semantic: SemanticSearch | undefined,
    timing: CallTiming,
): Promise<CodeActionResult> {
    const result = await runAction(source, params, signal, semantic, timing);

    // Taken here so the timings cover the action itself; assembling the details costs microseconds.
    return { text: result.text, details: { ...result.details, timing: timing.snapshot() } };
}

async function runAction(
    source: Awaited<ReturnType<typeof createCodeSource>>,
    params: CodeToolParams,
    signal: AbortSignal | undefined,
    semantic: SemanticSearch | undefined,
    timing: CallTiming,
): Promise<CodeActionResult> {
    const base = {
        action: params.action,
        path: params.path ?? ".",
        source: source.kind,
    };

    if (params.within !== undefined && params.action !== "search" && params.action !== "usages") {
        return {
            text: `# within applies to search and usages, not ${params.action}`,
            details: { ...base, files: 0 },
        };
    }

    const kindProblem = kindMismatch(params.action, params.kind);

    if (kindProblem !== undefined) {
        return { text: kindProblem, details: { ...base, files: 0 } };
    }

    switch (params.action) {
        case "digest": {
            const result = await runDigest(source, params, signal, timing);

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
            const result = await runSearch(source, params, signal, semantic, timing);

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
            const result = await runShow(source, params, signal, timing);

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
            const result = await runUsages(source, params, signal, timing);

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
        case "deps": {
            const result = await runDeps(source, params, signal, timing);

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

/** A `kind` value must match the action's axis: the two value sets do not overlap. */
function kindMismatch(action: CodeAction, kind: KindFilter | undefined): string | undefined {
    if (kind === undefined) {
        return undefined;
    }

    if (action === "usages") {
        return isUsageKind(kind)
            ? undefined
            : `# kind=${kind} is a declaration kind; usages takes def, call, or ref`;
    }

    if (action === "digest" || action === "search") {
        return isDeclarationKind(kind)
            ? undefined
            : `# kind=${kind} is a usage kind; ${action} takes declaration kinds like function or heading`;
    }

    return `# kind applies to digest, search, and usages, not ${action}`;
}

/**
 * Where `outline` may read, beyond the working directory.
 *
 * Exactly what `read`, `grep`, and `find` are allowed to open: the user memory directory (which the memory system
 * tells the agent to load), the roots the user declared in `files.readRoots`, and the runtime resource roots. A
 * declared root that worked for `read` failing here with "path is outside the working directory" was the tool
 * disagreeing with the session about its own files; a memory tree at `.pi/agent/memory` is also the one tree an
 * agent is expected to search. Read at call time, so a config edit or reload is picked up mid-session.
 */
const codeReadRoots: CodeReadRoots = () => [
    getUserMemoryDirectory(),
    ...fileRootsForOperation(sandboxConfig.current, "read"),
];

const SEMANTIC_HINT = "# semantic: /outline on downloads a ~211 MB model once and ranks by meaning";
/** Footer status entry shared by background downloads and refreshes; one line, cleared when idle. */
const OUTLINE_STATUS_KEY = "outline";

/** How long the session may sit idle before an automatic scan; long enough not to race a follow-up question. */
const IDLE_REFRESH_DELAY_MS = 5 * 60_000;

/** One consent prompt per session at most: "not now" is per session, "never" persists. */
let askedThisSession = false;
let downloading: Promise<void> | undefined;
/** A failed or oversized refresh would otherwise repeat the same notice on every search. */
let staleNoticedAt = 0;

/** Which semantic channel this call may use, after config and consent are read. */
async function prepareSemantic(ctx: ExtensionContext): Promise<SemanticSearch | undefined> {
    const root = semanticRoot();

    await maybeAskSemantics(ctx, root);

    const state = readConsent(root);
    const { mode } = effectiveSemanticMode(process.env, state);

    if (mode === "off") {
        return undefined;
    }

    return createSemanticSearch({
        mode,
        modelDir: root,
        hint: mode === "hybrid" || state.consent === "never" ? undefined : SEMANTIC_HINT,
        onStale: ({ missing, refreshing, initial }) => {
            const count = `${missing} vector${missing === 1 ? "" : "s"}`;

            if (refreshing) {
                ctx.ui.setStatus(
                    OUTLINE_STATUS_KEY,
                    initial === true
                        ? `outline: indexing ${count}`
                        : `outline: refreshing ${count}`,
                );
            }

            if (Date.now() - staleNoticedAt < 60_000) {
                return;
            }

            staleNoticedAt = Date.now();
            ctx.ui.notify(
                refreshing
                    ? initial === true
                        ? `outline semantic: indexing ${count} for this path in the background`
                        : `outline semantic: refreshing ${count} in the background`
                    : `outline semantic: ${count} are not indexed; /outline build <path>`,
                "info",
            );
        },
        onRefreshDone: () => {
            ctx.ui.setStatus(OUTLINE_STATUS_KEY, undefined);
        },
    });
}

/**
 * Offer the embedding channel once, at the first search of a session.
 *
 * It is a real dialog rather than a line in the tool output because enabling it spends ~211 MB of the user's
 * bandwidth and disk; a silent offer would make that decision for them. A "not now" answer is session-local
 * and asked again next session, while "don't ask again" is written to the state file.
 */
async function maybeAskSemantics(ctx: ExtensionContext, root: string): Promise<void> {
    if (ctx.hasUI !== true || askedThisSession) {
        return;
    }

    if ((process.env.PI_CODER_OUTLINE_SEMANTIC ?? "").trim().length > 0) {
        return;
    }

    if (readConsent(root).consent !== "unset" || semanticMode() === "off") {
        return;
    }

    askedThisSession = true;

    const megabytes = Math.round(artifactBytes() / 1_048_576);
    let choice: string | undefined;

    try {
        choice = await ctx.ui.select("Semantic search", [
            `Enable (≈${megabytes} MB, CPU)`,
            "Not now",
            "Don't ask again",
        ]);
    } catch {
        return;
    }

    if (choice?.startsWith("Enable")) {
        writeConsent({ consent: "enabled", modelId: MODEL_ID }, root);
        startArtifactDownload(ctx, root);

        return;
    }

    if (choice === "Don't ask again") {
        writeConsent({ consent: "never", modelId: MODEL_ID }, root);
    }
}

/** Download the runtime and model in the background; lexical search keeps working meanwhile. */
function startArtifactDownload(ctx: ExtensionContext, root: string): void {
    if (downloading !== undefined) {
        return;
    }

    const megabytes = Math.round(artifactBytes() / 1_048_576);
    ctx.ui.notify(
        `outline semantic: downloading ~${megabytes} MB in the background; /outline build <path> when it finishes`,
        "info",
    );
    ctx.ui.setStatus(OUTLINE_STATUS_KEY, "outline: downloading the model");
    downloading = ensureArtifacts({
        dir: root,
        onProgress: (message) => ctx.ui.setStatus(OUTLINE_STATUS_KEY, `outline: ${message}`),
    })
        .then(() => {
            ctx.ui.notify("outline semantic: model ready", "info");
        })
        .catch((error: unknown) => {
            ctx.ui.notify(`outline semantic: ${messageOf(error)}`, "error");
        })
        .finally(() => {
            downloading = undefined;
            ctx.ui.setStatus(OUTLINE_STATUS_KEY, undefined);
        });
}

async function handleOutlineCommand(
    args: string,
    ctx: ExtensionContext,
    container: ContainerState | undefined,
): Promise<void> {
    const { sub, target } = parseOutlineArgs(args);
    const root = semanticRoot();

    if (sub === "on" || sub === "enable") {
        writeConsent({ consent: "enabled", modelId: MODEL_ID }, root);
        startArtifactDownload(ctx, root);

        return;
    }

    if (sub === "off" || sub === "disable") {
        writeConsent({ consent: "never", modelId: MODEL_ID }, root);
        ctx.ui.notify("outline semantic: disabled", "info");

        return;
    }

    if (sub === "purge") {
        fs.rmSync(path.join(root, "index"), { recursive: true, force: true });
        ctx.ui.notify("outline semantic: vector index purged", "info");

        return;
    }

    if (sub === "build") {
        await buildSemanticIndex(ctx, container, target ?? ".", root);

        return;
    }

    if (sub !== "status") {
        ctx.ui.notify(
            `outline: unknown subcommand "${sub}" (status|on|off|build|purge)`,
            "warning",
        );

        return;
    }

    const state = readConsent(root);
    const { mode, source } = effectiveSemanticMode(process.env, state);
    const megabytes = Math.round(artifactBytes() / 1_048_576);
    const sourceKind = container?.active === true ? "container" : "local";

    ctx.ui.notify(
        [
            `outline semantic: mode=${mode} (${source}) · consent=${state.consent}`,
            `artifacts: ${artifactsPresent(root) ? "ready" : `not downloaded (≈${megabytes} MB)`}`,
            nativeStatusLine(root),
            ...indexStatusLines(root, ctx.cwd, sourceKind),
            `build workers: ${buildWorkerCount()}`,
            `state: ${root}`,
        ].join("\n"),
        "info",
    );
}

/**
 * Whether the native runtime is installed, because its absence is invisible and expensive.
 *
 * The worker falls back to wasm without a word, and wasm's session start alone measured ~2.6 s per cold search here
 * against ~0.2 s native (query embedding 670 ms warm against 27 ms). An install that predates the native artifacts
 * never downloads them — `ensureArtifacts` tops up the native pair only when it runs, which `/outline on` does and an
 * ordinary build does not — so the only way to notice was to read a timing footer.
 */
function nativeStatusLine(root: string): string {
    if (nativeRuntimePresent(root)) {
        return "native runtime: installed";
    }

    const megabytes = Math.round(nativeArtifactBytes() / 1_048_576);

    return `native runtime: not installed — wasm fallback (slower queries); /outline on installs it (≈${megabytes} MB)`;
}

interface IndexedNamespace {
    sourceKind?: string;
    root?: string;
    vectors: number;
    builtAt?: string;
}

/**
 * What each namespace covers, and whether this session's own root is among them.
 *
 * `index namespaces: 2` cannot be acted on: a namespace is keyed by *root and source kind*, so an index built for
 * this checkout from a container session is invisible to a local one, and a root with no namespace silently ranks by
 * BM25 alone. Naming the root and the count turns "is hybrid actually on for the tree I am searching?" into a
 * question the status output answers.
 */
function indexStatusLines(root: string, cwd: string, sourceKind: string): string[] {
    const indexRoot = path.join(root, "index");
    const namespaces = fs.existsSync(indexRoot) ? fs.readdirSync(indexRoot) : [];
    const indexed: IndexedNamespace[] = namespaces.flatMap((name) => {
        const manifest = readManifest(path.join(indexRoot, name));

        if (manifest === undefined) {
            return [];
        }

        return [
            {
                sourceKind: manifest.sourceKind,
                root: manifest.root,
                vectors: Object.keys(manifest.entries).length,
                builtAt: manifest.builtAt,
            },
        ];
    });
    const built = indexed
        .flatMap((entry) => (entry.builtAt === undefined ? [] : [entry.builtAt]))
        .toSorted()
        .at(-1);
    const here = path.resolve(cwd);
    const own = indexed.find((entry) => entry.root === here && entry.sourceKind === sourceKind);
    const others = indexed.filter((entry) => entry !== own);
    const lines = [
        `index: ${indexed.length} namespace(s)${built === undefined ? "" : ` · last build ${built}`}`,
    ];

    if (own === undefined) {
        lines.push(
            `  this session: no ${sourceKind} index for ${displayRoot(here, here)} — the first search builds one, or /outline build .`,
        );
    } else {
        lines.push(
            `  this session: ${sourceKind} ${displayRoot(own.root ?? here, here)} · ${countLabel(own.vectors)} vectors`,
        );
    }

    for (const entry of others.slice(0, 3)) {
        lines.push(
            `  ${entry.sourceKind ?? "unrecorded"} ${displayRoot(entry.root ?? "", here)} · ${countLabel(entry.vectors)} vectors`,
        );
    }

    if (others.length > 3) {
        lines.push(`  +${others.length - 3} more namespace(s)`);
    }

    return lines;
}

/** A root as a path the caller recognizes: relative when it is under the cwd, absolute when it is not. */
function displayRoot(root: string, cwd: string): string {
    if (root.length === 0) {
        return "<unrecorded>";
    }

    const relative = path.relative(cwd, root);

    return relative.length === 0 ? "." : relative.startsWith("..") ? root : relative;
}

function countLabel(count: number): string {
    return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);
}

const OUTLINE_SUBCOMMANDS: ReadonlyArray<{
    name: string;
    description: string;
    takesPath: boolean;
}> = [
    { name: "status", description: "Mode, consent, artifacts, and index state", takesPath: false },
    {
        name: "on",
        description: "Enable semantic search and download the model (~211 MB)",
        takesPath: false,
    },
    { name: "off", description: "Disable semantic search", takesPath: false },
    { name: "build", description: "Embed a directory into the vector index", takesPath: true },
    { name: "purge", description: "Delete the vector index", takesPath: false },
];

/**
 * Argument completions for `/outline`. Items are whole argument strings, like the sandbox command's.
 *
 * A leading `semantic` is accepted (older notes used it) but not suggested: the canonical form is
 * `/outline build <path>`.
 */
export function completeOutlineArguments(prefix: string): AutocompleteItem[] {
    const text = prefix.trimStart();
    const trailingSpace = text.length > 0 && /\s$/.test(text);
    const trimmed = trailingSpace ? text.trimEnd() : text;
    const words = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
    const path = trailingSpace ? words : words.slice(0, -1);
    const partial = trailingSpace ? "" : (words.at(-1) ?? "");
    const normalized = path[0] === "semantic" ? path.slice(1) : path;

    if (normalized.length === 0) {
        return OUTLINE_SUBCOMMANDS.filter((candidate) => candidate.name.startsWith(partial)).map(
            (candidate) => {
                const completed = [...path, candidate.name].join(" ");

                return {
                    value: candidate.takesPath ? `${completed} ` : completed,
                    label: candidate.name,
                    description: candidate.description,
                };
            },
        );
    }

    if (normalized[0] === "build" && normalized.length === 1) {
        return [
            {
                value: [...path, "."].join(" "),
                label: ".",
                description: "Current directory; large builds ask for confirmation first",
            },
        ];
    }

    return [];
}

function parseOutlineArgs(args: string): { sub: string; target?: string } {
    const words = args
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 0);

    if (words[0] === "semantic" || words[0] === "embeddings" || words[0] === "embed") {
        words.shift();
    }

    return { sub: words[0] ?? "status", target: words[1] };
}

/**
 * A failure the tool can explain, in the tool's own words.
 *
 * `stat … ENOENT …` is a Node error, not an answer: an agent reads it as the tool being broken rather than as a path
 * it spelled wrong, and the same call with a directory that exists costs one line. Everything else still reports the
 * raw message, because an unexpected failure must not be dressed up as a normal result.
 */
function failureText(params: { action: string; path?: string }, error: unknown): string {
    const message = messageOf(error);
    const code = (error as { code?: unknown }).code;
    // A local `fs` error carries `code: "ENOENT"`. The container protocol sends only the message, with the code inside
    // it (`stat /x: ENOENT: no such file or directory, stat '/x'`), so both shapes have to be recognized — otherwise
    // the friendly answer appears on a host checkout and the raw one appears in every container session.
    const missing = code === "ENOENT" || message.includes("ENOENT");

    if (missing) {
        // The pattern's literal prefix is what actually failed to resolve, so name that rather than the pattern.
        const requested = parsePathTarget(params.path).base;

        return `# no such path: ${requested} · check the spelling, or outline(action="digest", path=<its parent>)`;
    }

    return `# outline ${params.action} failed\n${message}`;
}

/** Above this many missing vectors, the build asks before spending minutes of CPU. */
const BUILD_CONFIRM_THRESHOLD = 200;
/** Measured on the container CPU: single-threaded wasm embeds one vector (head or chunk) in ≈1.1 s. */
const SECONDS_PER_EMBEDDING = 1.1;

/** Rough wall clock for `vectors` left at the measured rate, split across `workers`. */
function formatEstimate(vectors: number, workers: number): string {
    const seconds = (vectors * SECONDS_PER_EMBEDDING) / workers;

    if (seconds < 3600) {
        return `~${Math.max(1, Math.ceil(seconds / 60))} min`;
    }

    return `~${(seconds / 3600).toFixed(1)} h`;
}

function formatCount(value: number): string {
    return value.toLocaleString("en-US");
}

function plural(value: number, noun: string): string {
    return `${formatCount(value)} ${noun}${value === 1 ? "" : "s"}`;
}

/**
 * Price the build before starting it, then embed whatever the index is missing.
 *
 * Parsing is cheap and needs no model, so the plan is computed first: it tells the user how many vectors
 * would be embedded, how long that takes, and whether a download is still needed. A build that would take
 * minutes, or that has to fetch 211 MB, is confirmed explicitly; only a small incremental build against a warm
 * index proceeds without a dialog.
 */
async function buildSemanticIndex(
    ctx: ExtensionContext,
    container: ContainerState | undefined,
    target: string,
    root: string,
): Promise<void> {
    try {
        const source = await createCodeSource(ctx, container, codeReadRoots);
        const resolved = source.resolvePath(target);
        const discovery = await discoverFiles(source, resolved);
        const batch = await loadParsedFiles(source, discovery.files);

        if (batch.parsed.length === 0) {
            ctx.ui.notify(`outline semantic: no supported declarations under ${target}`, "warning");

            return;
        }

        const plan = countEmbeddings({
            sourceKind: source.kind,
            root: resolved,
            modelDir: root,
            files: batch.parsed,
        });

        if (plan.missing === 0) {
            // An index from before the header recorded its root works via the legacy fallback, but only a
            // stamped root enables staleness reporting and subdirectory refreshes. No embedding happens here.
            ensureIndexMetadata({ sourceKind: source.kind, root: resolved, modelDir: root });
            ctx.ui.notify(`outline semantic: index is current (${plan.live} vectors)`, "info");

            return;
        }

        if (!(await confirmBuild(ctx, root, plan.missing))) {
            return;
        }

        const controller = new AbortController();
        const workers = Math.max(
            1,
            Math.min(buildWorkerCount(), batch.parsed.length, Math.ceil(plan.missing / 8)),
        );
        let loader: CancellableLoader | undefined;
        let filesLeft = plan.files;
        let vectorsLeft = plan.missing;
        const compose = (): string =>
            `Building embeddings for ${plural(plan.files, "file")} (${plural(filesLeft, "file")} left; estimate ${formatEstimate(vectorsLeft, workers)})`;
        let message = compose();

        // Track the latest message even before the loader exists: a download starts synchronously.
        const progress = (next: string): void => {
            message = next;
            loader?.setMessage(`${next} (esc cancels)`);
        };
        const render = (): void => progress(compose());

        const work = (async () => {
            if (!artifactsPresent(root)) {
                const megabytes = Math.round(artifactBytes() / 1_048_576);

                progress(`downloading the model (~${megabytes} MB)`);
                ctx.ui.notify(`outline semantic: downloading ~${megabytes} MB first`, "info");
                await ensureArtifacts({
                    dir: root,
                    onProgress: (message) => progress(message),
                });
            }

            writeConsent({ consent: "enabled", modelId: MODEL_ID }, root);

            const step = Math.max(1, Math.ceil(plan.missing / 50));
            let reported = 0;

            return buildIndex({
                sourceKind: source.kind,
                root: resolved,
                modelDir: root,
                files: batch.parsed,
                signal: controller.signal,
                onProgress: (done, total) => {
                    vectorsLeft = Math.max(0, total - done);

                    if (done === total) {
                        progress(
                            `Building embeddings for ${plural(plan.files, "file")} (finishing)`,
                        );

                        return;
                    }

                    if (done - reported >= step) {
                        reported = done;
                        render();
                    }
                },
                onFile: (done, total) => {
                    filesLeft = Math.max(0, total - done);
                    render();
                },
            });
        })();

        // The loader attaches its own handlers; this keeps an early rejection from going unhandled.
        void work.catch(() => undefined);

        if (ctx.mode === "tui") {
            try {
                await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
                    loader = new CancellableLoader(
                        tui,
                        (text) => theme.fg("accent", text),
                        (text) => theme.fg("muted", text),
                        `${message} (esc cancels)`,
                    );
                    loader.onAbort = () => {
                        progress("cancelling");
                        controller.abort();
                    };

                    const finish = (): void => {
                        loader = undefined;
                        done();
                    };

                    void work.then(finish, finish);
                    loader.start();

                    return loader;
                });
            } catch {
                // A closed interactive area must not cancel the build; it keeps running and reports itself.
            }
        }

        let result: Awaited<typeof work>;

        try {
            result = await work;
        } catch (error) {
            if (controller.signal.aborted) {
                ctx.ui.notify(
                    "outline semantic: build cancelled; finished shards stay indexed",
                    "info",
                );

                return;
            }

            throw error;
        }

        ctx.ui.notify(
            `outline semantic: ${result.embedded} embedded, ${result.live} vectors indexed`,
            "info",
        );
    } catch (error) {
        ctx.ui.notify(`outline semantic: ${messageOf(error)}`, "error");
    }
}

async function confirmBuild(
    ctx: ExtensionContext,
    root: string,
    missing: number,
): Promise<boolean> {
    const cached = artifactsPresent(root);
    const consent = readConsent(root).consent;

    if (cached && consent === "enabled" && missing <= BUILD_CONFIRM_THRESHOLD) {
        return true;
    }

    if (ctx.hasUI !== true) {
        ctx.ui.notify("outline: run /outline on first, then /outline build <path>", "warning");

        return false;
    }

    const workers = buildWorkerCount();
    const minutes = Math.max(1, Math.ceil((missing * SECONDS_PER_EMBEDDING) / workers / 60));
    const megabytes = cached ? 0 : Math.round(artifactBytes() / 1_048_576);
    const download = megabytes > 0 ? `, ≈${megabytes} MB download` : "";
    let choice: string | undefined;

    try {
        choice = await ctx.ui.select(`Embed ${missing} vectors`, [
            `Build now (~${minutes} min on ${workers} worker${workers === 1 ? "" : "s"}${download})`,
            "Cancel",
        ]);
    } catch {
        return false;
    }

    return choice?.startsWith("Build now") === true;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
