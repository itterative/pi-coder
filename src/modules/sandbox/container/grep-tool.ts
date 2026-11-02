import path from "node:path";

import {
    DEFAULT_MAX_BYTES,
    createGrepToolDefinition,
    formatSize,
    truncateHead,
    truncateLine,
    type ExtensionContext,
    type GrepToolDetails,
} from "@earendil-works/pi-coding-agent";

import type { ContainerSession } from "./client";

/**
 * `grep` over the container, because pi's own grep cannot be pointed at one: its `GrepOperations` seam covers
 * the directory check and the context-line reads, while the `rg` process itself is spawned by pi's
 * implementation on the host (`dist/core/tools/grep.js`). Taking over only the seam would list the host's
 * files and read the container's lines, which is worse than leaving the tool alone.
 *
 * So this mirrors pi's algorithm, and the pieces that decide what a model sees — arg construction, JSON event
 * parsing, the `path:line: text` format, context blocks, line truncation, byte truncation, and the notices — are
 * reproduced deliberately. `test/modules/sandbox/container/grep-tool.test.ts` compares this output against
 * pi's own implementation on the shared checkout, so a divergence in pi fails a test instead of drifting.
 *
 * Everything else stays pi's: the schema, description, and renderers come from `createGrepToolDefinition`,
 * since only `execute` is replaced.
 */

/** Same default as pi's grep; a model can raise it per call. */
const DEFAULT_MATCH_LIMIT = 100;
/** Mirrors pi's own constant: it caps one match line and is not exported from the package root. */
const MAX_MATCH_LINE_LENGTH = 500;

export interface ContainerGrepParams {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
}

export function containerGrepTool(
    sessionFor: (ctx: ExtensionContext) => Promise<ContainerSession>,
): ReturnType<typeof createGrepToolDefinition> {
    const prototype = createGrepToolDefinition(process.cwd());

    return {
        ...prototype,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const session = await sessionFor(ctx);

            return await runContainerGrep(session, params as ContainerGrepParams, signal, ctx.cwd);
        },
    };
}

interface GrepMatch {
    filePath: string;
    lineNumber: number;
    lineText?: string;
}

export async function runContainerGrep(
    session: ContainerSession,
    params: ContainerGrepParams,
    signal: AbortSignal | undefined,
    cwd: string,
): Promise<{ content: { type: "text"; text: string }[]; details: GrepToolDetails | undefined }> {
    if (signal?.aborted) {
        throw new Error("Operation aborted");
    }

    const searchPath = resolveSearchPath(params.path ?? ".", cwd);
    const isDirectory = await isDirectoryPath(session, searchPath);
    const contextLines = params.context && params.context > 0 ? params.context : 0;
    const matchLimit = Math.max(1, params.limit ?? DEFAULT_MATCH_LIMIT);
    const matches: GrepMatch[] = [];
    let stderr = "";
    let matchLimitReached = false;
    let linesTruncated = false;

    // The caller's signal and the match-limit kill both need to stop the process, so they meet in one
    // controller; `AbortSignal.any` keeps the caller's reason intact.
    const limitController = new AbortController();
    const combined =
        signal === undefined
            ? limitController.signal
            : AbortSignal.any([signal, limitController.signal]);

    const run = session.spawn({
        file: "rg",
        args: grepArgs(params, searchPath),
        cwd,
        signal: combined,
        onChunk: (stream, chunk) => {
            const text = chunk.toString("utf8");

            if (stream === "stderr") {
                stderr += text;

                return;
            }

            for (const line of text.split("\n")) {
                const match = parseMatchEvent(line);

                if (match === undefined) {
                    continue;
                }

                matches.push(match);

                if (matches.length >= matchLimit) {
                    matchLimitReached = true;
                    limitController.abort();

                    return;
                }
            }
        },
    });

    let result: { exitCode: number | null } = { exitCode: 0 };

    try {
        result = await run;
    } catch (error) {
        if (signal?.aborted) {
            throw new Error("Operation aborted", { cause: error });
        }

        // Killing ripgrep at the match limit surfaces as an abort here, exactly as it does in pi's own
        // implementation, where the child is killed rather than allowed to finish.
        if (!matchLimitReached) {
            throw new Error(`Failed to run ripgrep: ${messageOf(error)}`, { cause: error });
        }
    }

    // Exit 1 is "no matches"; anything else is ripgrep's own complaint, which pi surfaces verbatim too.
    if (!matchLimitReached && result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(stderr.trim() || `ripgrep exited with code ${String(result.exitCode)}`);
    }

    if (matches.length === 0) {
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };
    }

    const outputLines: string[] = [];

    for (const match of matches) {
        if (contextLines === 0 && match.lineText !== undefined) {
            const sanitized = match.lineText
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "")
                .replace(/\n$/, "");
            const truncated = truncateLine(sanitized, MAX_MATCH_LINE_LENGTH);

            linesTruncated ||= truncated.wasTruncated;
            outputLines.push(
                `${formatPath(match.filePath, searchPath, isDirectory)}:${match.lineNumber}: ${truncated.text}`,
            );

            continue;
        }

        const block = await formatContextBlock(
            session,
            match,
            searchPath,
            isDirectory,
            contextLines,
        );

        outputLines.push(...block.lines);
        linesTruncated ||= block.truncated;
    }

    return summarize(outputLines, { matchLimitReached, matchLimit, linesTruncated });
}

function grepArgs(params: ContainerGrepParams, searchPath: string): string[] {
    const args = ["--json", "--line-number", "--color=never", "--hidden"];

    if (params.ignoreCase) {
        args.push("--ignore-case");
    }

    if (params.literal) {
        args.push("--fixed-strings");
    }

    if (params.glob) {
        args.push("--glob", params.glob);
    }

    args.push("--", params.pattern, searchPath);

    return args;
}

function parseMatchEvent(line: string): GrepMatch | undefined {
    if (!line.trim()) {
        return undefined;
    }

    let event: unknown;

    try {
        event = JSON.parse(line);
    } catch {
        return undefined;
    }

    if (!isRecord(event) || event.type !== "match") {
        return undefined;
    }

    const data = isRecord(event.data) ? event.data : undefined;
    const filePath = textOf(data?.path);
    const lineNumber = data?.line_number;

    if (filePath === undefined || typeof lineNumber !== "number") {
        return undefined;
    }

    return { filePath, lineNumber, lineText: textOf(data?.lines) };
}

/** The match plus its context lines, numbered the way grep prints them (`-` instead of `:` off the match). */
async function formatContextBlock(
    session: ContainerSession,
    match: GrepMatch,
    searchPath: string,
    isDirectory: boolean,
    contextLines: number,
): Promise<{ lines: string[]; truncated: boolean }> {
    const relativePath = formatPath(match.filePath, searchPath, isDirectory);
    const lines = await fileLines(session, match.filePath);

    if (lines.length === 0) {
        return {
            lines: [`${relativePath}:${match.lineNumber}: (unable to read file)`],
            truncated: false,
        };
    }

    const start =
        contextLines > 0 ? Math.max(1, match.lineNumber - contextLines) : match.lineNumber;
    const end =
        contextLines > 0
            ? Math.min(lines.length, match.lineNumber + contextLines)
            : match.lineNumber;
    const block: string[] = [];
    let anyTruncated = false;

    for (let current = start; current <= end; current++) {
        const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
        const truncated = truncateLine(sanitized, MAX_MATCH_LINE_LENGTH);

        anyTruncated ||= truncated.wasTruncated;
        block.push(
            current === match.lineNumber
                ? `${relativePath}:${current}: ${truncated.text}`
                : `${relativePath}-${current}- ${truncated.text}`,
        );
    }

    return { lines: block, truncated: anyTruncated };
}

function summarize(
    outputLines: string[],
    state: { matchLimitReached: boolean; matchLimit: number; linesTruncated: boolean },
): { content: { type: "text"; text: string }[]; details: GrepToolDetails | undefined } {
    const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    const details: GrepToolDetails = {};
    const notices: string[] = [];

    if (state.matchLimitReached) {
        notices.push(
            `${state.matchLimit} matches limit reached. Use limit=${state.matchLimit * 2} for more, or refine pattern`,
        );
        details.matchLimitReached = state.matchLimit;
    }

    if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
    }

    if (state.linesTruncated) {
        notices.push(
            `Some lines truncated to ${MAX_MATCH_LINE_LENGTH} chars. Use read tool to see full lines`,
        );
        details.linesTruncated = true;
    }

    const output =
        notices.length > 0
            ? `${truncation.content}\n\n[${notices.join(". ")}]`
            : truncation.content;

    return {
        content: [{ type: "text", text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
    };
}

async function fileLines(session: ContainerSession, filePath: string): Promise<string[]> {
    try {
        const result = await session.fs({ op: "readFile", path: filePath });

        return Buffer.from(result.data, "base64")
            .toString("utf8")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split("\n");
    } catch {
        return [];
    }
}

async function isDirectoryPath(session: ContainerSession, searchPath: string): Promise<boolean> {
    try {
        const result = await session.fs({ op: "stat", path: searchPath });

        return result.isDirectory;
    } catch {
        throw new Error(`Path not found: ${searchPath}`);
    }
}

function formatPath(filePath: string, searchPath: string, isDirectory: boolean): string {
    if (isDirectory) {
        const relative = path.relative(searchPath, filePath);

        if (relative && !relative.startsWith("..")) {
            return relative.replaceAll("\\", "/");
        }
    }

    return path.basename(filePath);
}

/** `~` and relative paths resolve against the cwd, the way every other file tool resolves them. */
function resolveSearchPath(requested: string, cwd: string): string {
    if (requested === "~") {
        return process.env.HOME ?? cwd;
    }

    if (requested.startsWith("~/")) {
        return path.join(process.env.HOME ?? cwd, requested.slice(2));
    }

    return path.resolve(cwd, requested);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function textOf(value: unknown): string | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    return typeof value.text === "string" ? value.text : undefined;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
