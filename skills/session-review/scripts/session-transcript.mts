#!/usr/bin/env node
/**
 * Find and read pi sessions: list parent and delegated-child transcripts, search one for a phrase, review
 * its turns, then print a bounded window as a readable transcript.
 *
 * The script exists for post-compaction work. Compaction replaces older messages with a summary in the
 * model's context; the session file still holds every original message. `--compactions` finds the fold
 * boundaries and the raw span each fold summarized, `--context` shows what the model kept, and the raw
 * branch shows what it lost. `--search` locates a span without reading the whole JSONL, and `--overview`
 * digests each turn down to its prompt, conclusion, tools, files, and errors. A window keeps a
 * multi-megabyte JSONL from becoming the whole context.
 *
 * Raw JSONL is read instead of `SessionManager` on purpose: the script stays dependency-free (it runs with
 * plain `node` on pi's supported Node versions) and the same code reads parent and delegated-child
 * transcripts. The branch walk mirrors pi: the leaf is the last entry in the file, parents are followed to
 * the root, and compaction plus `context_edit` semantics follow pi's documented context building.
 *
 * Usage: node session-transcript.mts [options]   (see --help)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Keep the whole output under pi's own bash truncation (last 2000 lines or 50KB), marker included. */
const DEFAULT_MAX_CHARS = 48_000;

/** One-line tool arguments are collapsed and cut here; `--tools full` carries the payload instead. */
const ARG_LIMIT = 90;
const THINKING_LIMIT = 2_000;
const FULL_ARGS_LIMIT = 2_000;
const FULL_RESULT_LIMIT = 4_000;
const ERROR_LINE_LIMIT = 100;
const LIST_TEXT_LIMIT = 70;
const GOAL_TEXT_LIMIT = 90;
const OVERVIEW_TEXT_LIMIT = 400;
const SESSIONS_LIMIT = 15;
const SEARCH_LIMIT = 50;
const SEARCH_SNIPPET_LIMIT = 160;
const SEARCH_RADIUS = 70;
const HEAD_READ_LIMIT = 512 * 1024;
const HEAD_CHUNK = 64 * 1024;

const TOOL_MODES = new Set(["none", "short", "full"]);
const SEARCH_SCOPES = new Set(["text", "tools", "all"]);
const VALUE_FLAGS = new Set([
    "--session",
    "--leaf",
    "--turns",
    "--last",
    "--from",
    "--to",
    "--since",
    "--until",
    "--tools",
    "--max-chars",
    "--search",
    "--in",
    "--limit",
    "--width",
    "--compaction",
]);

export type OutputMode = "transcript" | "list" | "compactions" | "overview" | "search" | "sessions";
export type ToolMode = "none" | "short" | "full";
export type SearchScope = "text" | "tools" | "all";
export type SessionKind = "parent" | "child";

export interface TurnRange {
    first: number;
    last: number;
}

export interface TranscriptOptions {
    session?: string;
    leaf?: string;
    context: boolean;
    last?: number;
    turns?: TurnRange;
    from?: string;
    to?: string;
    since?: number;
    until?: number;
    tools: ToolMode;
    thinking: boolean;
    maxChars: number;
    mode: OutputMode;
    search?: string;
    searchScope: SearchScope;
    regex: boolean;
    caseSensitive: boolean;
    limit?: number;
    width?: number;
    all: boolean;
    compaction?: string;
    help: boolean;
}

export interface ParseArgsResult {
    options: TranscriptOptions;
    error?: string;
}

export interface SessionHeader {
    type: "session";
    version?: number;
    id?: string;
    timestamp?: string;
    cwd?: string;
    parentSession?: string;
}

export interface SessionEntry {
    type: string;
    id?: string;
    parentId?: string | null;
    timestamp?: string;
    [key: string]: unknown;
}

export interface ParsedSession {
    header: SessionHeader | null;
    entries: SessionEntry[];
    byId: Map<string, SessionEntry>;
    malformedLines: number;
}

export interface EntryMatch {
    entry?: SessionEntry;
    matches: SessionEntry[];
}

export interface CompactionDetails {
    readFiles: string[];
    modifiedFiles: string[];
    summarizedMessages?: number;
    route?: string;
}

export interface CompactionInfo {
    entry: SessionEntry;
    index: number;
    /** Index of `firstKeptEntryId` on the branch, or -1 when the id is missing from it. */
    keptIndex: number;
    keptId: string | null;
    /** Inclusive raw-entry span this fold summarized, or -1/-1 when nothing raw was dropped. */
    spanStartIndex: number;
    spanEndIndex: number;
    details: CompactionDetails;
}

export interface WindowResult {
    entries: SessionEntry[];
    startIndex: number;
    endIndex: number;
    label: string;
}

export interface WindowSelection {
    window?: WindowResult;
    error?: string;
}

export interface RenderInput {
    session: ParsedSession;
    filePath: string;
    branch: SessionEntry[];
    options: TranscriptOptions;
}

export interface TranscriptRenderInput extends RenderInput {
    window: WindowResult;
}

export interface SessionFileInfo {
    kind: SessionKind;
    file: string;
    /** The encoded cwd directory that holds the transcript. */
    directory: string;
    /** The parent agent run id for a delegated-child transcript. */
    runId?: string;
    mtimeMs: number;
    size: number;
}

export interface SessionHead {
    header: SessionHeader | null;
    goal?: string;
}

export interface SearchHit {
    entry: SessionEntry;
    index: number;
    turn: number;
    where: string;
    snippet: string;
}

export interface SearchOutcome {
    hits: SearchHit[];
    /** Matching entries found before `--limit`; `hits` may be shorter. */
    total: number;
    windowLabel: string;
    error?: string;
}

export interface CompactionSelection {
    folds: SelectedCompaction[];
    /** Folds before `--limit`/`--compaction`, after the time filter. */
    total: number;
    limited: boolean;
    error?: string;
}

export interface SelectedCompaction {
    info: CompactionInfo;
    /** Newest-first rank, 1-based. */
    rank: number;
}

const USAGE = `usage: node session-transcript.mts [options]

Find and read a pi session. Without --sessions or --session, reads the current session ($PI_SESSION_FILE).

Session:
  --session <path|id|runId>  JSONL path, a session id, or a delegated-child run id
  --leaf <entryId>           read the branch ending at this entry instead of the current leaf
  --context                  show the model's current context: the latest compaction replaces the dropped span

Discover:
  --sessions                 list parent transcripts and delegated-child runs, newest first
  --all                      with --sessions: every cwd directory, not just this one
  --search <pattern>         find entries mentioning a phrase, then read the window around them
  --in <text|tools|all>      what --search scans: prompt/answer/summary text, tool calls/results, or both
  --regex                    treat --search as a regular expression
  --case-sensitive           match --search exactly; the default is case-insensitive
  --limit <n>                cap hits/folds/sessions (defaults: search 50, sessions 15, folds all)

Window (combinable; the intersection is shown):
  --last <n>                 last n user turns (with --sessions: newest n rows)
  --turns <a[:b]>            1-based turn range, inclusive
  --from <entryId>           start at this entry (inclusive)
  --to <entryId>             end at this entry (inclusive)
  --since <when>             entries at or after: ISO 8601, YYYY-MM-DD, or 45m / 2h / 3d ago
  --until <when>             entries at or before (YYYY-MM-DD means end of that local day)

Render:
  --tools <mode>             none (default) | short | full
                             short prints read(path), bash(cmd…), and [error: first line] markers;
                             full adds args and result text, each capped
  --thinking                 include assistant thinking blocks (capped at ${THINKING_LIMIT} chars each)
  --width <n>                text column width for --list/--overview/--sessions (0 = no cap)
  --max-chars <n>            cap output at n chars before printing (default ${DEFAULT_MAX_CHARS}; 0 = no cap)

Modes:
  --list                     list turns with start/end entry ids for use with --from/--to
  --overview                 one digest block per turn: prompt, conclusion, tools, files, errors, span
  --compactions              list compaction folds, newest first, with the raw span each one summarized
  --compaction <n|entryId>   show one fold by newest-first rank or entry id prefix
  -h, --help                 this text

Entry ids accept any unique prefix. Tools that run LLM tool calls print one line each; results appear only
as error markers unless --tools full. The entry id anchors in --compactions and --overview paste directly
into --from/--to. Search and overview honor every window flag, so --turns or --since narrows the scan.
`;

// --------------------------------------------------------------------------------------- arguments

export function parseArgs(argv: string[]): ParseArgsResult {
    const options: TranscriptOptions = {
        context: false,
        tools: "none",
        thinking: false,
        maxChars: DEFAULT_MAX_CHARS,
        mode: "transcript",
        searchScope: "all",
        regex: false,
        caseSensitive: false,
        all: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const raw = argv[index]!;
        const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
        const flag = equals >= 0 ? raw.slice(0, equals) : raw;
        const inline = equals >= 0 ? raw.slice(equals + 1) : undefined;

        let value = inline;
        if (VALUE_FLAGS.has(flag)) {
            value ??= argv[index + 1];
            if (value === undefined) {
                return { options, error: `${flag} needs a value` };
            }
            if (inline === undefined) {
                index += 1;
            }
        }

        const error = applyFlag(options, flag, value);
        if (error !== undefined) {
            return { options, error };
        }
    }

    if (options.last !== undefined && options.turns !== undefined) {
        return { options, error: "use either --last or --turns, not both" };
    }

    return { options };
}

function applyFlag(
    options: TranscriptOptions,
    flag: string,
    value: string | undefined,
): string | undefined {
    switch (flag) {
        case "-h":
        case "--help":
            options.help = true;
            return undefined;
        case "--context":
            options.context = true;
            return undefined;
        case "--thinking":
            options.thinking = true;
            return undefined;
        case "--list":
            options.mode = "list";
            return undefined;
        case "--overview":
            options.mode = "overview";
            return undefined;
        case "--sessions":
            options.mode = "sessions";
            return undefined;
        case "--search":
            if (value === undefined || value.trim() === "") {
                return "--search needs a non-empty pattern";
            }
            options.mode = "search";
            options.search = value;
            return undefined;
        case "--in":
            return applySearchScope(options, value ?? "");
        case "--regex":
            options.regex = true;
            return undefined;
        case "--case-sensitive":
            options.caseSensitive = true;
            return undefined;
        case "--all":
            options.all = true;
            return undefined;
        case "--compaction":
            options.mode = "compactions";
            options.compaction = value;
            return undefined;
        case "--compactions":
            options.mode = "compactions";
            return undefined;
        case "--session":
            options.session = value;
            return undefined;
        case "--leaf":
            options.leaf = value;
            return undefined;
        case "--from":
            options.from = value;
            return undefined;
        case "--to":
            options.to = value;
            return undefined;
        case "--tools":
            return applyToolMode(options, value ?? "");
        case "--last":
            return applyPositiveInt(options, "last", value ?? "");
        case "--limit":
            return applyPositiveInt(options, "limit", value ?? "");
        case "--width":
            return applyNonNegativeInt(options, "width", value ?? "");
        case "--turns":
            return applyTurns(options, value ?? "");
        case "--since":
            return applyWhen(options, "since", value ?? "", false);
        case "--until":
            return applyWhen(options, "until", value ?? "", true);
        case "--max-chars":
            return applyMaxChars(options, value ?? "");
        default:
            return `unknown option: ${flag}`;
    }
}

function applyToolMode(options: TranscriptOptions, value: string): string | undefined {
    if (!TOOL_MODES.has(value)) {
        return `--tools expects none, short, or full; got "${value}"`;
    }

    options.tools = value as ToolMode;
    return undefined;
}

function applySearchScope(options: TranscriptOptions, value: string): string | undefined {
    if (!SEARCH_SCOPES.has(value)) {
        return `--in expects text, tools, or all; got "${value}"`;
    }

    options.searchScope = value as SearchScope;
    return undefined;
}

function applyPositiveInt(
    options: TranscriptOptions,
    key: "last" | "limit",
    value: string,
): string | undefined {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
        return `--${key} expects a positive integer, got "${value}"`;
    }

    options[key] = parsed;
    return undefined;
}

function applyNonNegativeInt(
    options: TranscriptOptions,
    key: "width",
    value: string,
): string | undefined {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
        return `--${key} expects a non-negative integer, got "${value}"`;
    }

    options[key] = parsed;
    return undefined;
}

function applyTurns(options: TranscriptOptions, value: string): string | undefined {
    const match = /^(\d+)(?::(\d+))?$/.exec(value.trim());
    if (!match) {
        return `--turns expects N or N:M, got "${value}"`;
    }

    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (first < 1 || last < first) {
        return `--turns needs 1 <= first <= last, got "${value}"`;
    }

    options.turns = { first, last };
    return undefined;
}

function applyWhen(
    options: TranscriptOptions,
    key: "since" | "until",
    value: string,
    endOfDay: boolean,
): string | undefined {
    const parsed = parseWhen(value, endOfDay);
    if (parsed === undefined) {
        return `--${key} expects an ISO date/time or a relative window such as 30m, 2h, 3d; got "${value}"`;
    }

    options[key] = parsed;
    return undefined;
}

function applyMaxChars(options: TranscriptOptions, value: string): string | undefined {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
        return `--max-chars expects a non-negative integer, got "${value}"`;
    }

    options.maxChars = parsed;
    return undefined;
}

/** Relative windows count back from now; date-only values resolve in local time. */
export function parseWhen(value: string, endOfDay = false, now = Date.now()): number | undefined {
    const relative = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(value.trim().toLowerCase());
    if (relative) {
        const amount = Number(relative[1]);
        const factor = unitMilliseconds(relative[2]!);
        return now - amount * factor;
    }

    const trimmed = value.trim();
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    const suffix = dateOnly ? (endOfDay ? "T23:59:59.999" : "T00:00:00") : "";
    const parsed = Date.parse(`${trimmed}${suffix}`);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function unitMilliseconds(unit: string): number {
    switch (unit) {
        case "m":
            return 60_000;
        case "h":
            return 3_600_000;
        case "d":
            return 86_400_000;
        case "w":
            return 604_800_000;
        default:
            return 1_000;
    }
}

// ------------------------------------------------------------------------------ session resolution

export function resolveSessionFile(
    reference: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
): string {
    if (reference !== undefined && reference.trim() !== "") {
        const resolved = resolveSessionReference(reference.trim(), env, cwd);
        if (resolved !== undefined) {
            return resolved;
        }

        throw new Error(`no session file matches "${reference}"`);
    }

    const fromEnv = env.PI_SESSION_FILE?.trim();
    if (fromEnv !== undefined && fromEnv !== "" && fs.existsSync(fromEnv)) {
        return fromEnv;
    }

    const latest = latestSessionIn(sessionDirForCwd(cwd, env));
    if (latest !== undefined) {
        return latest;
    }

    throw new Error(
        `no session file: $PI_SESSION_FILE is unset and ${sessionDirForCwd(cwd, env)} holds no transcripts`,
    );
}

function resolveSessionReference(
    reference: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
): string | undefined {
    if (reference.includes("/") || reference.includes("\\") || reference.endsWith(".jsonl")) {
        const resolved = path.resolve(cwd, reference);
        return fs.existsSync(resolved) ? resolved : undefined;
    }

    return findSessionById(reference, env, cwd);
}

function findSessionById(id: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
    const matches = discoverSessionFiles(env, cwd, true).filter((info) => {
        return path.basename(info.file).includes(id) || (info.runId?.includes(id) ?? false);
    });

    return matches[0]?.file;
}

function sessionRoot(env: NodeJS.ProcessEnv): string {
    const override = env.PI_CODING_AGENT_SESSION_DIR?.trim();
    if (override !== undefined && override !== "") {
        return override;
    }

    return path.join(agentDirFromEnvironment(env), "sessions");
}

/** pi's `getAgentDir()`: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`, with a leading `~` expanded. */
function agentDirFromEnvironment(env: NodeJS.ProcessEnv): string {
    const configured = env.PI_CODING_AGENT_DIR?.trim();
    if (configured !== undefined && configured !== "") {
        return expandTilde(configured, env);
    }

    return path.join(expandTilde("~", env), ".pi", "agent");
}

/**
 * pi-coder's delegated-child sessions root. Mirrors `resolveStateDirectory`: a relative
 * `PI_CODER_STATE_DIR` resolves against the extension checkout, not the caller's cwd.
 */
function childSessionsRoot(env: NodeJS.ProcessEnv): string {
    const override = env.PI_CODER_AGENT_SESSIONS_DIR?.trim();
    if (override !== undefined && override !== "") {
        return override;
    }

    const stateOverride = env.PI_CODER_STATE_DIR?.trim();
    if (stateOverride !== undefined && stateOverride !== "") {
        return path.join(
            path.resolve(extensionRoot(), expandTilde(stateOverride, env)),
            "agent-sessions",
        );
    }

    return path.join(agentDirFromEnvironment(env), "pi-coder", "agent-sessions");
}

function extensionRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function expandTilde(value: string, env: NodeJS.ProcessEnv): string {
    if (value !== "~" && !value.startsWith("~/") && !value.startsWith("~\\")) {
        return value;
    }

    const home = env.HOME?.trim();
    const base = home !== undefined && home !== "" ? home : os.homedir();
    if (value === "~") {
        return base;
    }

    return path.join(base, value.slice(2));
}

function sessionDirForCwd(cwd: string, env: NodeJS.ProcessEnv): string {
    // pi strips the leading path separator before replacing, so `/tmp/proj` becomes `--tmp-proj--`.
    const encoded = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
    return path.join(sessionRoot(env), `--${encoded}--`);
}

function childSessionDirForCwd(cwd: string, env: NodeJS.ProcessEnv): string {
    const encoded = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
    return path.join(childSessionsRoot(env), `--${encoded}--`);
}

function listSessionDirectories(env: NodeJS.ProcessEnv): string[] {
    return listDirectories(sessionRoot(env));
}

function listChildSessionDirectories(env: NodeJS.ProcessEnv): string[] {
    return listDirectories(childSessionsRoot(env));
}

function listDirectories(root: string): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }

    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name));
}

/** Every transcript pi or pi-coder wrote, newest mtime first. */
export function discoverSessionFiles(
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
    all = false,
): SessionFileInfo[] {
    const parentDirectories = all ? listSessionDirectories(env) : [sessionDirForCwd(cwd, env)];
    const childDirectories = all
        ? listChildSessionDirectories(env)
        : [childSessionDirForCwd(cwd, env)];

    const infos: SessionFileInfo[] = [];
    for (const directory of parentDirectories) {
        for (const file of jsonlFilesIn(directory)) {
            infos.push(sessionFileInfo("parent", file, directory));
        }
    }

    for (const directory of childDirectories) {
        for (const entry of readDirectoryEntries(directory)) {
            if (entry.isDirectory()) {
                const runDirectory = path.join(directory, entry.name);
                for (const file of jsonlFilesIn(runDirectory)) {
                    infos.push(sessionFileInfo("child", file, directory, entry.name));
                }
                continue;
            }

            if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                infos.push(sessionFileInfo("child", path.join(directory, entry.name), directory));
            }
        }
    }

    return infos.toSorted((left, right) => right.mtimeMs - left.mtimeMs);
}

function sessionFileInfo(
    kind: SessionKind,
    file: string,
    directory: string,
    runId?: string,
): SessionFileInfo {
    return {
        kind,
        file,
        directory,
        runId,
        mtimeMs: mtimeOf(file),
        size: sizeOf(file),
    };
}

function readDirectoryEntries(directory: string): fs.Dirent[] {
    try {
        return fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }
}

function jsonlFilesIn(directory: string): string[] {
    return readDirectoryEntries(directory)
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => path.join(directory, entry.name));
}

function latestSessionIn(directory: string): string | undefined {
    const files = jsonlFilesIn(directory);
    if (files.length === 0) {
        return undefined;
    }

    return files.reduce((latest, file) => (mtimeOf(file) > mtimeOf(latest) ? file : latest));
}

function mtimeOf(file: string): number {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return 0;
    }
}

function sizeOf(file: string): number {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

// -------------------------------------------------------------------------------- session parsing

export function parseSessionFile(content: string): ParsedSession {
    const entries: SessionEntry[] = [];
    const byId = new Map<string, SessionEntry>();
    let header: SessionHeader | null = null;
    let malformedLines = 0;

    for (const line of content.split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            malformedLines += 1;
            continue;
        }

        const record = asRecord(parsed);
        if (record === null || typeof record.type !== "string") {
            malformedLines += 1;
            continue;
        }

        if (record.type === "session" && header === null) {
            header = record as unknown as SessionHeader;
            continue;
        }

        const entry = record as SessionEntry;
        entries.push(entry);
        if (typeof entry.id === "string") {
            byId.set(entry.id, entry);
        }
    }

    return { header, entries, byId, malformedLines };
}

/** Read just enough of a transcript for discovery: the header and the first real user prompt. */
export function readSessionHead(file: string, maxBytes = HEAD_READ_LIMIT): SessionHead {
    let descriptor: number | undefined;
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(HEAD_CHUNK);
    let pending = "";
    let header: SessionHeader | null = null;
    let read = 0;

    try {
        descriptor = fs.openSync(file, "r");
        while (read < maxBytes) {
            const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
            if (count === 0) {
                break;
            }
            read += count;
            pending += decoder.write(chunk.subarray(0, count));

            let newline = pending.indexOf("\n");
            while (newline >= 0) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                const found = inspectHeadLine(line, header);
                header = found.header;
                if (found.goal !== undefined) {
                    return { header, goal: found.goal };
                }
                newline = pending.indexOf("\n");
            }
        }

        if (pending.trim() !== "") {
            const found = inspectHeadLine(pending, header);
            header = found.header;
            if (found.goal !== undefined) {
                return { header, goal: found.goal };
            }
        }
    } catch {
        return { header };
    } finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }

    return { header };
}

function inspectHeadLine(line: string, header: SessionHeader | null): SessionHead {
    if (line.trim() === "") {
        return { header };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return { header };
    }

    const record = asRecord(parsed);
    if (record === null || typeof record.type !== "string") {
        return { header };
    }

    if (record.type === "session") {
        return { header: record as unknown as SessionHeader };
    }

    const message = record.type === "message" ? asRecord(record.message) : null;
    if (message?.role !== "user") {
        return { header };
    }

    const goal = collapseWhitespace(messageText(message.content));
    return goal === "" ? { header } : { header, goal };
}

/**
 * The active branch, root first. The leaf is the last entry in file order, which is the entry pi wrote last;
 * entries that do not sit on its parent chain belong to abandoned branches and are excluded. A v1 session
 * without ids is linear, so it is returned whole.
 */
export function activeBranch(session: ParsedSession, leafId?: string): SessionEntry[] | null {
    const entries = session.entries;
    if (entries.length === 0) {
        return [];
    }
    if (!entries.some((entry) => typeof entry.id === "string")) {
        return [...entries];
    }

    let leaf: SessionEntry | undefined;
    if (leafId !== undefined) {
        leaf = session.byId.get(leafId);
        if (leaf === undefined) {
            return null;
        }
    } else {
        leaf = entries.findLast((entry) => typeof entry.id === "string");
    }
    if (leaf === undefined) {
        return [...entries];
    }

    const branch: SessionEntry[] = [];
    const seen = new Set<string>();
    let current: SessionEntry | undefined = leaf;

    while (current !== undefined) {
        const id = current.id;
        if (id === undefined || seen.has(id)) {
            branch.push(current);
            break;
        }

        branch.push(current);
        seen.add(id);
        current =
            typeof current.parentId === "string" ? session.byId.get(current.parentId) : undefined;
    }

    return branch.toReversed();
}

/** Match a full entry id or any unique prefix of one. */
export function matchEntryRef(entries: readonly SessionEntry[], reference: string): EntryMatch {
    const exact = entries.find((entry) => entry.id === reference);
    if (exact !== undefined) {
        return { entry: exact, matches: [exact] };
    }

    const matches = entries.filter(
        (entry) => typeof entry.id === "string" && entry.id.startsWith(reference),
    );
    if (matches.length === 1) {
        return { entry: matches[0], matches };
    }

    return { matches };
}

function describeRefMiss(flag: string, reference: string, matches: SessionEntry[]): string {
    if (matches.length === 0) {
        return `${flag} "${reference}" matches no entry on this branch (see --list for entry ids)`;
    }

    const ids = matches.map((entry) => entry.id).join(", ");
    return `${flag} "${reference}" is ambiguous: ${ids}`;
}

// ------------------------------------------------------------------------------------ compaction

/** Folds on the branch, oldest first, each with the raw span it replaced. */
export function collectCompactions(branch: readonly SessionEntry[]): CompactionInfo[] {
    const compactions: CompactionInfo[] = [];
    let contextStart = 0;

    for (let index = 0; index < branch.length; index += 1) {
        const entry = branch[index]!;
        if (entry.type !== "compaction") {
            continue;
        }

        const keptId = typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : null;
        const keptIndex =
            keptId === null ? -1 : branch.findIndex((candidate) => candidate.id === keptId);
        const retainedTailStart = keptIndex >= 0 && keptIndex < index ? keptIndex : index + 1;

        const spanStart = contextStart;
        let spanEnd = (keptIndex >= 0 && keptIndex < index ? keptIndex : index) - 1;
        // A previous fold row rides at the end of its own retained tail; it is a summary, not a raw
        // message, and the listing shows its text separately, so trim it off the raw-span anchors.
        while (spanStart <= spanEnd && branch[spanEnd]!.type === "compaction") {
            spanEnd -= 1;
        }
        const empty = spanStart > spanEnd;

        compactions.push({
            entry,
            index,
            keptIndex,
            keptId,
            spanStartIndex: empty ? -1 : spanStart,
            spanEndIndex: empty ? -1 : spanEnd,
            details: readCompactionDetails(entry),
        });

        contextStart = retainedTailStart;
    }

    return compactions;
}

function readCompactionDetails(entry: SessionEntry): CompactionDetails {
    const details = asRecord(entry.details);
    if (details === null) {
        return { readFiles: [], modifiedFiles: [] };
    }

    return {
        readFiles: stringArray(details.readFiles),
        modifiedFiles: stringArray(details.modifiedFiles),
        summarizedMessages: asNumber(details.summarizedMessages),
        route: asString(details.route),
    };
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((item): item is string => typeof item === "string");
}

/**
 * The model's current context, per pi's `buildContextEntries`: the newest fold hoists first, the entries it
 * kept from before the fold stay (minus system messages, which the fold's checkpoint replaces), and
 * everything after the fold follows. `context_edit` entries are applied rather than shown.
 */
export function contextBranch(branch: readonly SessionEntry[]): SessionEntry[] {
    const foldIndex = branch.findLastIndex((entry) => entry.type === "compaction");
    if (foldIndex < 0) {
        return applyContextEdits([...branch]);
    }

    const fold = branch[foldIndex]!;
    const keptIndex = keptEntryIndex(branch, fold, foldIndex);
    const kept = keptIndex >= 0 ? branch.slice(keptIndex, foldIndex) : [];

    return applyContextEdits([
        fold,
        ...kept.filter((entry) => !isSystemMessage(entry)),
        ...branch.slice(foldIndex + 1),
    ]);
}

function keptEntryIndex(
    branch: readonly SessionEntry[],
    fold: SessionEntry,
    foldIndex: number,
): number {
    const keptId = typeof fold.firstKeptEntryId === "string" ? fold.firstKeptEntryId : undefined;
    if (keptId === undefined) {
        return -1;
    }

    // Retain-none folds store their own id, which names no earlier entry to keep.
    const index = branch.findIndex((entry) => entry.id === keptId);
    return index >= 0 && index < foldIndex ? index : -1;
}

function applyContextEdits(entries: SessionEntry[]): SessionEntry[] {
    const edits = new Map<string, SessionEntry>();
    for (const entry of entries) {
        if (entry.type !== "context_edit") {
            continue;
        }

        const targetId = asString(entry.targetId);
        if (targetId !== undefined) {
            edits.set(targetId, entry);
        }
    }

    const result: SessionEntry[] = [];
    for (const entry of entries) {
        if (entry.type === "context_edit") {
            continue;
        }

        const edit = typeof entry.id === "string" ? edits.get(entry.id) : undefined;
        if (edit === undefined) {
            result.push(entry);
            continue;
        }

        const replacement = edit.replacement;
        if (replacement === null) {
            continue;
        }
        if (entry.type === "custom_message") {
            result.push({ ...entry, content: replacement });
            continue;
        }
        if (entry.type !== "message") {
            result.push(entry);
            continue;
        }

        result.push({ ...entry, message: replaceMessageContent(entry.message, replacement) });
    }

    return result;
}

function replaceMessageContent(message: unknown, replacement: unknown): unknown {
    const record = asRecord(message);
    if (record === null) {
        return message;
    }

    if (typeof replacement === "string") {
        const role = asString(record.role);
        const content =
            role === "assistant" || role === "toolResult"
                ? [{ type: "text", text: replacement }]
                : replacement;
        return { ...record, content };
    }

    return { ...record, content: replacement };
}

function isSystemMessage(entry: SessionEntry): boolean {
    const message = entryMessage(entry);
    return message?.role === "system";
}

// --------------------------------------------------------------------------------------- windows

export function selectWindow(
    branch: readonly SessionEntry[],
    options: TranscriptOptions,
): WindowSelection {
    const count = branch.length;
    if (count === 0) {
        return { window: { entries: [], startIndex: 0, endIndex: -1, label: "empty branch" } };
    }

    const labels: string[] = [];
    let start = 0;
    let end = count - 1;

    if (options.from !== undefined) {
        const match = matchEntryRef(branch, options.from);
        if (match.entry === undefined) {
            return { error: describeRefMiss("--from", options.from, match.matches) };
        }
        start = Math.max(start, branch.indexOf(match.entry));
        labels.push(`from ${match.entry.id}`);
    }

    if (options.to !== undefined) {
        const match = matchEntryRef(branch, options.to);
        if (match.entry === undefined) {
            return { error: describeRefMiss("--to", options.to, match.matches) };
        }
        end = Math.min(end, branch.indexOf(match.entry));
        labels.push(`to ${match.entry.id}`);
    }

    const turnStarts = turnStartIndices(branch);
    if (options.turns !== undefined) {
        const selected = applyTurnRange(turnStarts, options.turns, count);
        if (selected.error !== undefined) {
            return { error: selected.error };
        }
        start = Math.max(start, selected.start);
        end = Math.min(end, selected.end);
        labels.push(
            options.turns.first === selected.lastTurn
                ? `turn ${options.turns.first}`
                : `turns ${options.turns.first}–${selected.lastTurn}`,
        );
    }

    if (options.last !== undefined) {
        if (turnStarts.length === 0) {
            return { error: "--last needs at least one user turn on this branch" };
        }
        const first = Math.max(1, turnStarts.length - options.last + 1);
        start = Math.max(start, turnStarts[first - 1]!);
        const shown = turnStarts.length - first + 1;
        labels.push(shown === 1 ? "last turn" : `last ${shown} turns`);
    }

    if (options.since !== undefined) {
        const index = firstIndexAtOrAfter(branch, options.since);
        if (index < 0) {
            return { error: `no entries at or after ${formatDateTime(options.since)}` };
        }
        start = Math.max(start, index);
        labels.push(`since ${formatDateTime(options.since)}`);
    }

    if (options.until !== undefined) {
        const index = lastIndexAtOrBefore(branch, options.until);
        if (index < 0) {
            return { error: `no entries at or before ${formatDateTime(options.until)}` };
        }
        end = Math.min(end, index);
        labels.push(`until ${formatDateTime(options.until)}`);
    }

    if (start > end) {
        const reason = labels.length > 0 ? labels.join(" · ") : "no filters";
        return { error: `the selected window is empty (${reason})` };
    }

    return {
        window: {
            entries: branch.slice(start, end + 1),
            startIndex: start,
            endIndex: end,
            label: labels.length === 0 ? "full branch" : labels.join(" · "),
        },
    };
}

function applyTurnRange(
    turnStarts: number[],
    range: TurnRange,
    count: number,
): { start: number; end: number; lastTurn: number; error?: string } {
    if (turnStarts.length === 0 || range.first > turnStarts.length) {
        return {
            start: 0,
            end: count - 1,
            lastTurn: range.last,
            error: `turn ${range.first} is out of range (${turnStarts.length} turns)`,
        };
    }

    const lastTurn = Math.min(range.last, turnStarts.length);
    const start = turnStarts[range.first - 1]!;
    const end = lastTurn < turnStarts.length ? turnStarts[lastTurn]! - 1 : count - 1;
    return { start, end, lastTurn };
}

function turnStartIndices(branch: readonly SessionEntry[]): number[] {
    const starts: number[] = [];
    for (let index = 0; index < branch.length; index += 1) {
        const message = entryMessage(branch[index]!);
        if (message?.role === "user") {
            starts.push(index);
        }
    }
    return starts;
}

function firstIndexAtOrAfter(branch: readonly SessionEntry[], since: number): number {
    for (let index = 0; index < branch.length; index += 1) {
        const timestamp = entryTimestamp(branch[index]!);
        if (timestamp !== undefined && timestamp >= since) {
            return index;
        }
    }
    return -1;
}

function lastIndexAtOrBefore(branch: readonly SessionEntry[], until: number): number {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const timestamp = entryTimestamp(branch[index]!);
        if (timestamp !== undefined && timestamp <= until) {
            return index;
        }
    }
    return -1;
}

// -------------------------------------------------------------------------------------- rendering

export function renderTranscript(input: TranscriptRenderInput): string {
    const { session, branch, options, window } = input;

    const state: RenderState = {
        options,
        cwd: session.header?.cwd,
        toolResults: toolResultsById(branch),
        printedCalls: new Set(),
        lastDay: undefined,
    };

    const blocks: string[] = [];
    for (const entry of window.entries) {
        const block = renderEntry(entry, state);
        if (block.length > 0) {
            blocks.push(block.join("\n"));
        }
    }

    return [renderHeader(input, window), ...blocks].join("\n\n");
}

interface RenderState {
    options: TranscriptOptions;
    cwd?: string;
    toolResults: Map<string, SessionEntry>;
    printedCalls: Set<string>;
    lastDay?: string;
}

function renderHeader(input: RenderInput, window: WindowResult): string {
    const { session, filePath, branch, options } = input;
    const id = session.header?.id ?? path.basename(filePath, ".jsonl");
    const lines = [
        `# session ${id} · ${options.context ? "context view" : "raw branch"}${session.header?.cwd ? ` · ${session.header.cwd}` : ""}`,
        `# file ${filePath}`,
    ];

    const firstTimestamp = entryTimestamp(window.entries[0]!);
    const lastTimestamp = entryTimestamp(window.entries.at(-1)!);
    if (firstTimestamp !== undefined && lastTimestamp !== undefined) {
        lines.push(
            `# entries ${window.startIndex + 1}–${window.endIndex + 1} of ${branch.length} · ${window.label} · ${formatRange(firstTimestamp, lastTimestamp)}`,
        );
    } else {
        lines.push(`# entries 0 of ${branch.length} · ${window.label}`);
    }

    const model = latestField(
        branch,
        "model_change",
        (entry) => `${entry.provider}/${entry.modelId}`,
    );
    const thinking = latestField(branch, "thinking_level_change", (entry) =>
        asString(entry.thinkingLevel),
    );
    if (model !== undefined) {
        lines.push(`# model ${model}${thinking !== undefined ? ` · thinking ${thinking}` : ""}`);
    }

    const compactions = collectCompactions(branch);
    if (compactions.length > 0) {
        const latest = compactions.at(-1)!;
        const when = formatDateTime(entryTimestamp(latest.entry) ?? 0);
        const tokens = asNumber(latest.entry.tokensBefore);
        const kept = latest.keptId ?? "none";
        lines.push(
            `# compactions ${compactions.length} · latest ${when}${tokens !== undefined ? ` · ${tokens} tokens before` : ""} · kept from ${kept}`,
        );
    }

    return lines.join("\n");
}

function renderEntry(entry: SessionEntry, state: RenderState): string[] {
    const day = dayMarker(entry, state);
    const body = renderEntryBody(entry, state);
    if (body.length === 0) {
        return day === undefined ? [] : [day];
    }

    return day === undefined ? body : [day, ...body];
}

function renderEntryBody(entry: SessionEntry, state: RenderState): string[] {
    if (entry.type === "message") {
        return renderMessageEntry(entry, state);
    }

    switch (entry.type) {
        case "compaction":
            return renderCompactionEntry(entry);
        case "branch_summary":
            return renderSummaryEntry(entry, "branch summary", asString(entry.summary) ?? "");
        // case "model_change":
        //     return [
        //         richHeading(
        //             entry,
        //             `model → ${asString(entry.provider) ?? "?"}/${asString(entry.modelId) ?? "?"}`,
        //         ),
        //     ];
        // case "thinking_level_change":
        //     return [richHeading(entry, `thinking → ${asString(entry.thinkingLevel) ?? "?"}`)];
        case "label":
            return [
                richHeading(
                    entry,
                    `label ${entry.label === undefined ? "cleared" : `"${asString(entry.label) ?? ""}"`}`,
                ),
            ];
        case "session_info":
            return [richHeading(entry, `session name "${asString(entry.name) ?? ""}"`)];
        case "context_edit":
            return [
                richHeading(
                    entry,
                    `context edit: entry ${asString(entry.targetId) ?? "?"} ${entry.replacement === null ? "hidden" : "replaced"}`,
                ),
            ];
        default:
            return [];
    }
}

function renderMessageEntry(entry: SessionEntry, state: RenderState): string[] {
    const message = entryMessage(entry);
    if (message === null) {
        return [];
    }

    switch (message.role) {
        case "user":
            return renderTextMessage(entry, "user", messageText(message.content));
        case "assistant":
            return renderAssistantEntry(entry, message, state);
        case "toolResult":
            return renderToolResultEntry(entry, message, state);
        case "bashExecution":
            return renderBashExecutionEntry(entry, message, state);
        case "custom":
            return renderTextMessage(
                entry,
                `context · ${asString(message.customType) ?? "custom"}`,
                messageText(message.content),
            );
        default:
            return [];
    }
}

function renderTextMessage(entry: SessionEntry, label: string, text: string): string[] {
    if (text.trim() === "") {
        return [richHeading(entry, label)];
    }

    return [richHeading(entry, label), text];
}

function renderAssistantEntry(
    entry: SessionEntry,
    message: Record<string, unknown>,
    state: RenderState,
): string[] {
    const stopNote = stopNoteFor(message);
    const lines = [richHeading(entry, `assistant${stopNote}`)];
    const content = Array.isArray(message.content) ? message.content : [];

    for (const block of content) {
        const record = asRecord(block);
        if (record === null) {
            continue;
        }

        if (
            record.type === "text" &&
            typeof record.text === "string" &&
            record.text.trim() !== ""
        ) {
            lines.push(record.text);
            continue;
        }

        if (
            record.type === "thinking" &&
            state.options.thinking &&
            typeof record.thinking === "string"
        ) {
            lines.push(...thinkingLines(record.thinking));
            continue;
        }

        if (record.type === "toolCall") {
            lines.push(...renderToolCall(record, state));
        }
    }

    // A model step that produced only tool calls carries its signal in those lines; without them the
    // heading alone is noise, so an empty block is dropped rather than printed.
    return lines.length === 1 ? [] : lines;
}

function renderToolCall(call: Record<string, unknown>, state: RenderState): string[] {
    if (state.options.tools === "none") {
        return [];
    }

    const name = asString(call.name) ?? "tool";
    const id = asString(call.id);
    const args = asRecord(call.arguments) ?? {};
    const line = `  → ${name}(${toolArgument(name, args, state.cwd)})`;

    if (id !== undefined) {
        state.printedCalls.add(id);
    }

    if (state.options.tools === "short") {
        const result = id === undefined ? undefined : state.toolResults.get(id);
        return [line + shortResultMarker(result)];
    }

    const lines = [line, `    args: ${truncate(JSON.stringify(args), FULL_ARGS_LIMIT)}`];
    const result = id === undefined ? undefined : state.toolResults.get(id);
    if (result !== undefined) {
        lines.push(...fullResultLines(result));
    }

    return lines;
}

function shortResultMarker(entry: SessionEntry | undefined): string {
    if (entry === undefined) {
        return "";
    }

    const message = entryMessage(entry);
    if (message?.isError !== true) {
        return "";
    }

    const text = collapseWhitespace(messageText(message.content));
    if (text === "") {
        return " [error]";
    }

    return ` [error: ${truncate(text, ERROR_LINE_LIMIT)}]`;
}

function fullResultLines(entry: SessionEntry): string[] {
    const message = entryMessage(entry);
    if (message === null) {
        return [];
    }

    const text = messageText(message.content).trim();
    const label = message.isError === true ? "error" : "result";
    if (text === "") {
        return [`    ${label}: (no text)`];
    }

    return [`    ${label}: ${truncate(text, FULL_RESULT_LIMIT)}`];
}

function renderToolResultEntry(
    entry: SessionEntry,
    message: Record<string, unknown>,
    state: RenderState,
): string[] {
    if (state.options.tools === "none") {
        return [];
    }

    const id = asString(message.toolCallId);
    if (id !== undefined && state.printedCalls.has(id)) {
        return [];
    }

    const name = asString(message.toolName) ?? "tool";
    return [`  → ${name}(result)${shortResultMarker(entry)}`];
}

function renderBashExecutionEntry(
    entry: SessionEntry,
    message: Record<string, unknown>,
    state: RenderState,
): string[] {
    const exit = asNumber(message.exitCode);
    const label = `bash${exit !== undefined ? ` (exit ${exit})` : ""}${message.cancelled === true ? " (cancelled)" : ""}`;
    const command = asString(message.command) ?? "";
    const lines = [richHeading(entry, label), `$ ${truncate(command, ARG_LIMIT)}`];

    if (state.options.tools === "full") {
        const output = messageText(message.output).trim();
        lines.push(
            output === ""
                ? "    output: (empty)"
                : `    output: ${truncate(output, FULL_RESULT_LIMIT)}`,
        );
    }

    return lines;
}

function renderCompactionEntry(entry: SessionEntry): string[] {
    const tokens = asNumber(entry.tokensBefore);
    const kept = asString(entry.firstKeptEntryId);
    const note = `${tokens !== undefined ? ` · ${tokens} tokens before` : ""}${kept !== undefined ? ` · kept from ${kept}` : ""}`;
    return renderSummaryEntry(entry, `compaction${note}`, asString(entry.summary) ?? "");
}

function renderSummaryEntry(entry: SessionEntry, label: string, summary: string): string[] {
    const lines = [richHeading(entry, label)];
    if (summary.trim() !== "") {
        lines.push(summary);
    }

    return lines;
}

function thinkingLines(thinking: string): string[] {
    const body = truncate(thinking.trim(), THINKING_LIMIT);
    const lines = [`  [thinking] ${body.split("\n")[0] ?? ""}`];
    for (const line of body.split("\n").slice(1)) {
        lines.push(`  ${line}`);
    }
    return lines;
}

function stopNoteFor(message: Record<string, unknown>): string {
    const reason = asString(message.stopReason);
    if (reason === "aborted") {
        return " (aborted)";
    }
    if (reason === "error") {
        const detail = asString(message.errorMessage);
        return ` (error${detail !== undefined ? `: ${truncate(detail, ERROR_LINE_LIMIT)}` : ""})`;
    }
    return "";
}

function dayMarker(entry: SessionEntry, state: RenderState): string | undefined {
    const day = localDate(entry.timestamp);
    if (day === undefined || day === state.lastDay) {
        return undefined;
    }

    state.lastDay = day;
    return `── ${day} ──`;
}

function richHeading(entry: SessionEntry, label: string): string {
    const when = localTime(entry.timestamp);
    return when === undefined ? label : `[${when}] ${label}`;
}

// ----------------------------------------------------------------------------- sessions rendering

interface SessionRow {
    info: SessionFileInfo;
    head: SessionHead;
}

interface SessionGroup {
    kind: SessionKind;
    directory: string;
    rows: SessionRow[];
    total: number;
}

/**
 * List the parent transcripts and delegated-child runs a reviewer can open. Defaults to the current cwd
 * (the directory the bash tool runs in); `--all` groups every cwd directory and caps each one.
 */
export function renderSessionList(
    options: TranscriptOptions,
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
): string {
    const infos = discoverSessionFiles(env, cwd, options.all).filter((info) => {
        if (options.since !== undefined && info.mtimeMs < options.since) {
            return false;
        }
        return !(options.until !== undefined && info.mtimeMs > options.until);
    });
    const limit = options.limit ?? options.last ?? SESSIONS_LIMIT;
    const groups = groupSessionFiles(infos, limit, options.all);
    const shown = groups.reduce((total, group) => total + group.rows.length, 0);
    const parentCount = infos.filter((info) => info.kind === "parent").length;
    const childCount = infos.length - parentCount;

    const lines = [
        `# sessions · ${options.all ? `${limit} newest per directory` : `${limit} newest per kind`} · ${parentCount} parent, ${childCount} child · ${options.all ? "all directories" : cwd}`,
        `# parent root ${sessionRoot(env)}`,
        `# child root ${childSessionsRoot(env)}`,
        "# pass --session <id|runId>; a child run id selects its newest transcript",
    ];

    if (shown === 0) {
        lines.push("", "(no sessions)");
        return lines.join("\n");
    }

    for (const group of groups) {
        lines.push("", `## ${groupLabel(group)}`);
        lines.push(...renderSessionTable(group, options.width ?? GOAL_TEXT_LIMIT));
        if (group.total > group.rows.length) {
            const scope = options.all
                ? "in this directory"
                : `${group.kind} transcripts in this cwd`;
            lines.push(
                `# ${group.total - group.rows.length} more ${scope}; pass --limit ${group.total}`,
            );
        }
    }

    return lines.join("\n");
}

function groupSessionFiles(
    infos: readonly SessionFileInfo[],
    limit: number,
    all: boolean,
): SessionGroup[] {
    if (!all) {
        const groups: SessionGroup[] = [];
        for (const kind of ["parent", "child"] as const) {
            const files = infos.filter((info) => info.kind === kind);
            if (files.length === 0) {
                continue;
            }
            const rows = files
                .slice(0, limit)
                .map((info) => ({ info, head: readSessionHead(info.file) }));
            groups.push({ kind, directory: files[0]!.directory, rows, total: files.length });
        }
        return groups;
    }

    const byDirectory = new Map<string, SessionFileInfo[]>();
    for (const info of infos) {
        const key = `${info.kind}\u0000${info.directory}`;
        const group = byDirectory.get(key);
        if (group === undefined) {
            byDirectory.set(key, [info]);
            continue;
        }
        group.push(info);
    }

    const groups: SessionGroup[] = [];
    for (const files of byDirectory.values()) {
        const rows = files
            .slice(0, limit)
            .map((info) => ({ info, head: readSessionHead(info.file) }));
        groups.push({
            kind: files[0]!.kind,
            directory: files[0]!.directory,
            rows,
            total: files.length,
        });
    }

    return groups;
}

function groupLabel(group: SessionGroup): string {
    const cwd = group.rows.find((row) => row.head.header?.cwd !== undefined)?.head.header?.cwd;
    const where = cwd ?? path.basename(group.directory);
    return group.kind === "parent" ? `parent · ${where}` : `child · ${where}`;
}

function renderSessionTable(group: SessionGroup, width: number): string[] {
    const lines = ["  when              kind    id        run       size   goal"];

    for (const row of group.rows) {
        const id = shortId(row.head.header?.id ?? sessionIdFromFileName(row.info.file));
        const run = row.info.runId === undefined ? "—" : shortId(row.info.runId);
        const goal = truncate(
            row.head.goal ?? "(no user message)",
            width === 0 ? Number.POSITIVE_INFINITY : width,
        );
        lines.push(
            `  ${formatDateTime(row.info.mtimeMs).padEnd(17)} ${row.info.kind.padEnd(6)}  ${id.padEnd(8)}  ${run.padEnd(8)}  ${formatBytes(row.info.size).padEnd(5)}  ${goal}`,
        );
    }

    return lines;
}

function sessionIdFromFileName(file: string): string {
    const base = path.basename(file, ".jsonl");
    const separator = base.lastIndexOf("_");
    return separator >= 0 ? base.slice(separator + 1) : base;
}

function shortId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes}B`;
    }

    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = units[0]!;
    for (const candidate of units.slice(1)) {
        if (value < 1024) {
            break;
        }
        value /= 1024;
        unit = candidate;
    }

    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}${unit}`;
}

// -------------------------------------------------------------------------------- list rendering

export function renderTurnList(input: RenderInput): string {
    const { session, filePath, branch, options } = input;
    const turnStarts = turnStartIndices(branch);
    const id = session.header?.id ?? path.basename(filePath, ".jsonl");
    const compactions = collectCompactions(branch);
    const lines = [
        `# session ${id} · ${options.context ? "context view" : "raw branch"}${session.header?.cwd ? ` · ${session.header.cwd}` : ""}`,
        `# file ${filePath}`,
        `# ${branch.length} entries · ${turnStarts.length} turns${compactions.length > 0 ? ` · ${compactions.length} compaction(s)` : ""}`,
        "# from/to entry ids paste directly into --from/--to; --width 0 keeps full prompts",
        "",
    ];

    if (turnStarts.length === 0) {
        lines.push("(no user turns on this branch)");
        return lines.join("\n");
    }

    const rows = turnStarts.map((start, index) => describeTurn(branch, start, index + 1));
    const entriesWidth = Math.max(...rows.map((row) => row.entries.length));
    lines.push(
        `  #   time      ${"entries".padEnd(entriesWidth)}  tools  err  from      to        note  user`,
    );

    const width = options.width ?? LIST_TEXT_LIMIT;
    for (const row of rows) {
        const user = truncate(
            collapseWhitespace(row.user),
            width === 0 ? Number.POSITIVE_INFINITY : width,
        );
        lines.push(
            `  ${String(row.turn).padEnd(3)} ${row.time.padEnd(9)} ${row.entries.padEnd(entriesWidth)}  ${String(row.tools).padEnd(5)}  ${String(row.errors).padEnd(3)}  ${(row.entryId ?? "?").padEnd(8)}  ${(row.endEntryId ?? "?").padEnd(8)}  ${(row.fold ? "fold" : "").padEnd(4)}  ${user}`,
        );
    }

    return lines.join("\n");
}

interface TurnDescription {
    turn: number;
    time: string;
    entries: string;
    tools: number;
    errors: number;
    fold: boolean;
    entryId?: string;
    endEntryId?: string;
    user: string;
}

function describeTurn(
    branch: readonly SessionEntry[],
    start: number,
    turn: number,
): TurnDescription {
    const message = entryMessage(branch[start]!);
    const end = turnEndIndex(branch, start);
    const stats = turnStats(branch, start, end);

    const entries = start === end ? String(start + 1) : `${start + 1}–${end + 1}`;
    return {
        turn,
        time: localTime(branch[start]!.timestamp) ?? "",
        entries,
        tools: stats.tools,
        errors: stats.errors,
        fold: stats.fold,
        entryId: branch[start]!.id,
        endEntryId: branch[end]!.id,
        user: messageText(message?.content),
    };
}

function turnEndIndex(branch: readonly SessionEntry[], start: number): number {
    for (let index = start + 1; index < branch.length; index += 1) {
        if (entryMessage(branch[index]!)?.role === "user") {
            return index - 1;
        }
    }

    return branch.length - 1;
}

interface TurnStats {
    tools: number;
    errors: number;
    fold: boolean;
    firstError?: string;
}

function turnStats(branch: readonly SessionEntry[], start: number, end: number): TurnStats {
    let tools = 0;
    let errors = 0;
    let fold = false;
    let firstError: string | undefined;

    for (let index = start; index <= end; index += 1) {
        const entry = branch[index]!;
        if (entry.type === "compaction") {
            fold = true;
        }

        const message = entryMessage(entry);
        if (message === null) {
            continue;
        }

        if (message.role === "assistant") {
            tools += countToolCalls(entry);
            if (message.stopReason === "error" && firstError === undefined) {
                firstError = asString(message.errorMessage) ?? "assistant error";
                errors += 1;
            }
            continue;
        }

        if (message.role === "toolResult" && message.isError === true) {
            errors += 1;
            if (firstError === undefined) {
                firstError = collapseWhitespace(messageText(message.content)) || "tool error";
            }
            continue;
        }

        if (message.role === "bashExecution") {
            const exit = asNumber(message.exitCode);
            const failed = message.cancelled === true || (exit !== undefined && exit !== 0);
            if (failed) {
                errors += 1;
                if (firstError === undefined) {
                    firstError =
                        message.cancelled === true ? "command cancelled" : `exit ${exit ?? "?"}`;
                }
            }
        }
    }

    return { tools, errors, fold, firstError };
}

function countToolCalls(entry: SessionEntry): number {
    const message = entryMessage(entry);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
        return 0;
    }

    return message.content.filter((block) => asRecord(block)?.type === "toolCall").length;
}

// --------------------------------------------------------------------------- compaction rendering

export function selectCompactionFolds(
    branch: readonly SessionEntry[],
    options: TranscriptOptions,
): CompactionSelection {
    let folds = collectCompactions(branch);

    if (options.since !== undefined || options.until !== undefined) {
        folds = folds.filter((info) => {
            const timestamp = entryTimestamp(info.entry);
            if (timestamp === undefined) {
                return false;
            }
            if (options.since !== undefined && timestamp < options.since) {
                return false;
            }
            return !(options.until !== undefined && timestamp > options.until);
        });
    }

    const total = folds.length;
    const ranked = [...folds]
        .toReversed()
        .map((info, index): SelectedCompaction => ({ info, rank: index + 1 }));

    if (options.compaction !== undefined) {
        const selected = selectCompactionByReference(ranked, options.compaction);
        if (typeof selected === "string") {
            return { folds: [], total, limited: false, error: selected };
        }

        return { folds: [selected], total, limited: false };
    }

    const limited = options.limit !== undefined && ranked.length > options.limit;
    return {
        folds: limited ? ranked.slice(0, options.limit) : ranked,
        total,
        limited,
    };
}

function selectCompactionByReference(
    folds: readonly SelectedCompaction[],
    reference: string,
): SelectedCompaction | string {
    if (/^\d+$/.test(reference)) {
        const rank = Number(reference);
        const fold = folds[rank - 1];
        if (fold === undefined) {
            return `--compaction ${reference} is out of range (${folds.length} folds, newest first)`;
        }
        return fold;
    }

    const exact = folds.filter((fold) => fold.info.entry.id === reference);
    if (exact.length === 1) {
        return exact[0]!;
    }

    const matches = folds.filter((fold) => fold.info.entry.id?.startsWith(reference));
    if (matches.length === 0) {
        return `--compaction "${reference}" matches no fold entry id`;
    }
    if (matches.length > 1) {
        const ids = matches.map((fold) => fold.info.entry.id).join(", ");
        return `--compaction "${reference}" is ambiguous: ${ids}`;
    }

    return matches[0]!;
}

export function renderCompactionList(input: RenderInput): string {
    const { session, filePath, branch, options } = input;
    const id = session.header?.id ?? path.basename(filePath, ".jsonl");
    const selection = selectCompactionFolds(branch, options);

    const lines = [
        `# session ${id} · ${selection.total} compaction(s) on the raw branch, newest first`,
        `# file ${filePath}`,
    ];

    if (selection.error !== undefined) {
        lines.push("", `(${selection.error})`);
        return lines.join("\n");
    }

    if (selection.total === 0) {
        lines.push("", "(no compactions on this branch)");
        return lines.join("\n");
    }

    if (options.compaction !== undefined) {
        lines.push(`# selected fold ${options.compaction}`);
    }
    if (selection.limited) {
        lines.push(
            `# showing newest ${selection.folds.length} of ${selection.total}; pass --limit ${selection.total} for all`,
        );
    }

    const sections = selection.folds.map((fold) =>
        renderCompactionBlock(fold.info, fold.rank, branch),
    );
    return [lines.join("\n"), ...sections].join("\n\n");
}

function renderCompactionBlock(
    info: CompactionInfo,
    rank: number,
    branch: readonly SessionEntry[],
): string {
    const when = formatDateTime(entryTimestamp(info.entry) ?? 0);
    const tokens = asNumber(info.entry.tokensBefore);
    const parts = [
        `[${rank}] ${when}`,
        `entry ${info.entry.id ?? "?"}`,
        tokens !== undefined ? `${tokens} tokens before` : undefined,
        `kept from ${info.keptId ?? "none"}`,
    ].filter((part): part is string => part !== undefined);

    const lines = [`${parts.join(" · ")}`];
    lines.push(`    summary: ${detailSummary(info)}`);

    if (info.spanStartIndex >= 0) {
        const from = branch[info.spanStartIndex]!.id ?? "?";
        const to = branch[info.spanEndIndex]!.id ?? "?";
        lines.push(
            `    dropped raw span: entries ${info.spanStartIndex + 1}–${info.spanEndIndex + 1} · --from ${from} --to ${to}`,
        );
    } else {
        lines.push("    dropped raw span: none (all preceding entries were already folded)");
    }

    const summary = asString(info.entry.summary) ?? "";
    if (summary.trim() !== "") {
        lines.push("", summary.trim());
    }

    return lines.join("\n");
}

function detailSummary(info: CompactionInfo): string {
    const parts: string[] = [];
    if (info.details.summarizedMessages !== undefined) {
        parts.push(`${info.details.summarizedMessages} messages`);
    }
    parts.push(`read ${info.details.readFiles.length} file(s)`);
    parts.push(`modified ${info.details.modifiedFiles.length} file(s)`);
    if (info.details.route !== undefined) {
        parts.push(`route ${info.details.route}`);
    }
    return parts.join(" · ");
}

// ------------------------------------------------------------------------------------ search

interface SearchSource {
    where: string;
    text: string;
}

/**
 * Find entries mentioning a pattern without printing the transcript. Hits carry the turn, the entry id,
 * and a snippet, so the next call can be `--turns N` or `--from <id>`.
 */
export function searchBranch(
    branch: readonly SessionEntry[],
    options: TranscriptOptions,
): SearchOutcome {
    const pattern = options.search ?? "";
    if (pattern === "") {
        return { hits: [], total: 0, windowLabel: "", error: "--search needs a pattern" };
    }

    let regex: RegExp;
    try {
        regex = new RegExp(
            options.regex ? pattern : escapeRegExp(pattern),
            options.caseSensitive ? "g" : "gi",
        );
    } catch (error) {
        return {
            hits: [],
            total: 0,
            windowLabel: "",
            error: `invalid --regex: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    let start = 0;
    let end = branch.length - 1;
    let windowLabel = "full branch";
    if (hasWindowOptions(options)) {
        const selection = selectWindow(branch, options);
        if (selection.window === undefined) {
            return {
                hits: [],
                total: 0,
                windowLabel: "",
                error: selection.error ?? "the selected window is empty",
            };
        }
        start = selection.window.startIndex;
        end = selection.window.endIndex;
        windowLabel = selection.window.label;
    }

    const turnNumbers = turnNumbersByIndex(branch);
    const limit = options.limit ?? SEARCH_LIMIT;
    const hits: SearchHit[] = [];
    let total = 0;

    for (let index = start; index <= end; index += 1) {
        const entry = branch[index]!;
        const hit = firstSearchHit(entry, options, regex);
        if (hit === undefined) {
            continue;
        }

        total += 1;
        if (hits.length < limit) {
            hits.push({
                entry,
                index,
                turn: turnNumbers[index] ?? 0,
                where: hit.where,
                snippet: hit.snippet,
            });
        }
    }

    return { hits, total, windowLabel };
}

function hasWindowOptions(options: TranscriptOptions): boolean {
    return (
        options.from !== undefined ||
        options.to !== undefined ||
        options.turns !== undefined ||
        options.last !== undefined ||
        options.since !== undefined ||
        options.until !== undefined
    );
}

function firstSearchHit(
    entry: SessionEntry,
    options: TranscriptOptions,
    regex: RegExp,
): { where: string; snippet: string } | undefined {
    for (const source of searchSources(entry, options)) {
        const match = matchOnce(regex, source.text);
        if (match === undefined) {
            continue;
        }

        return { where: source.where, snippet: searchSnippet(source.text, match) };
    }

    return undefined;
}

function searchSources(entry: SessionEntry, options: TranscriptOptions): SearchSource[] {
    const textScope = options.searchScope !== "tools";
    const toolScope = options.searchScope !== "text";

    if (entry.type === "compaction") {
        return textScope ? source("compaction", asString(entry.summary) ?? "") : [];
    }
    if (entry.type === "branch_summary") {
        return textScope ? source("branch summary", asString(entry.summary) ?? "") : [];
    }

    const message = entryMessage(entry);
    if (message === null) {
        return [];
    }

    switch (message.role) {
        case "user":
            return textScope ? source("user", messageText(message.content)) : [];
        case "assistant": {
            const sources: SearchSource[] = [];
            const content = Array.isArray(message.content) ? message.content : [];
            for (const block of content) {
                const record = asRecord(block);
                if (record === null) {
                    continue;
                }

                if (record.type === "text" && textScope && typeof record.text === "string") {
                    sources.push(...source("assistant", record.text));
                    continue;
                }

                if (
                    record.type === "thinking" &&
                    textScope &&
                    options.thinking &&
                    typeof record.thinking === "string"
                ) {
                    sources.push(...source("thinking", record.thinking));
                    continue;
                }

                if (record.type === "toolCall" && toolScope) {
                    const name = asString(record.name) ?? "tool";
                    const args = asRecord(record.arguments) ?? {};
                    sources.push(...source(`tool ${name}`, `${name} ${safeJson(args)}`));
                }
            }
            return sources;
        }
        case "toolResult": {
            if (!toolScope) {
                return [];
            }
            const name = asString(message.toolName) ?? "tool";
            return source(`result ${name}`, messageText(message.content));
        }
        case "bashExecution": {
            if (!toolScope) {
                return [];
            }
            const command = asString(message.command) ?? "";
            const output = messageText(message.output);
            return source("bash", `${command}\n${output}`);
        }
        default:
            return [];
    }
}

function source(where: string, text: string): SearchSource[] {
    return text.trim() === "" ? [] : [{ where, text }];
}

function matchOnce(regex: RegExp, text: string): RegExpExecArray | undefined {
    regex.lastIndex = 0;
    return regex.exec(text) ?? undefined;
}

function searchSnippet(text: string, match: RegExpExecArray): string {
    const from = Math.max(0, match.index - SEARCH_RADIUS);
    const to = Math.min(text.length, match.index + match[0].length + SEARCH_RADIUS);
    const body = collapseWhitespace(text.slice(from, to)).replace(/\\n/g, " ").replace(/\\t/g, " ");
    const prefix = from > 0 ? "…" : "";
    const suffix = to < text.length ? "…" : "";
    return truncate(`${prefix}${body}${suffix}`, SEARCH_SNIPPET_LIMIT);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function turnNumbersByIndex(branch: readonly SessionEntry[]): number[] {
    const numbers: number[] = [];
    let turn = 0;

    for (const entry of branch) {
        if (entryMessage(entry)?.role === "user") {
            turn += 1;
        }
        numbers.push(turn);
    }

    return numbers;
}

export function renderSearch(input: RenderInput, outcome: SearchOutcome): string {
    const { session, filePath, branch, options } = input;
    const id = session.header?.id ?? path.basename(filePath, ".jsonl");
    const scope = options.searchScope === "all" ? "text+tools" : options.searchScope;
    const mode = options.regex ? "regex" : "substring";
    const caseness = options.caseSensitive ? "case-sensitive" : "case-insensitive";

    const lines = [
        `# search ${JSON.stringify(options.search ?? "")} · ${outcome.total} matching entries of ${branch.length} · ${options.context ? "context view" : "raw branch"} · ${scope} · ${mode}, ${caseness}`,
        `# session ${id}${session.header?.cwd ? ` · ${session.header.cwd}` : ""}`,
        `# file ${filePath}`,
        `# window ${outcome.windowLabel}; hits report the turn and entry id to pass to --turns/--from`,
    ];

    if (outcome.error !== undefined) {
        lines.push("", `(${outcome.error})`);
        return lines.join("\n");
    }

    if (outcome.hits.length === 0) {
        lines.push("", "(no matches)");
        return lines.join("\n");
    }

    if (outcome.total > outcome.hits.length) {
        lines.push(
            `# showing first ${outcome.hits.length} of ${outcome.total}; pass --limit ${outcome.total} for all`,
        );
    }

    const whereWidth = Math.max("where".length, ...outcome.hits.map((hit) => hit.where.length));
    lines.push("", `  turn  time      entry     ${"where".padEnd(whereWidth)}  match`);
    for (const hit of outcome.hits) {
        lines.push(
            `  ${String(hit.turn).padEnd(4)}  ${(localTime(hit.entry.timestamp) ?? "").padEnd(9)} ${(hit.entry.id ?? "?").padEnd(8)}  ${hit.where.padEnd(whereWidth)}  ${hit.snippet}`,
        );
    }

    return lines.join("\n");
}

// ----------------------------------------------------------------------------------- overview

/**
 * One digest block per turn: the prompt, the final assistant text, tool counts, modified files, errors,
 * and the entry-id span. Compaction folds between turns are printed where they sit on the branch.
 */
export function renderOverview(input: RenderInput): string {
    const { session, filePath, branch, options } = input;
    const id = session.header?.id ?? path.basename(filePath, ".jsonl");
    const turnStarts = turnStartIndices(branch);
    const compactions = collectCompactions(branch);
    const foldsById = new Map(
        compactions
            .filter((info) => info.entry.id !== undefined)
            .map((info) => [info.entry.id!, info] as const),
    );
    const width = options.width ?? OVERVIEW_TEXT_LIMIT;
    const selection = hasWindowOptions(options) ? selectWindow(branch, options) : undefined;
    const startIndex = selection?.window?.startIndex ?? 0;
    const endIndex = selection?.window?.endIndex ?? branch.length - 1;

    const lines = [
        `# session ${id} · ${options.context ? "context view" : "raw branch"}${session.header?.cwd ? ` · ${session.header.cwd}` : ""}`,
        `# file ${filePath}`,
        `# ${branch.length} entries · ${turnStarts.length} turns · ${compactions.length} compaction(s)`,
        "# span ids paste into --from/--to; use --width 0 for full text",
    ];

    if (selection?.error !== undefined) {
        lines.push("", `(${selection.error})`);
        return lines.join("\n");
    }

    if (selection?.window !== undefined) {
        lines.push(
            `# window ${selection.window.label} · entries ${startIndex + 1}–${endIndex + 1} of ${branch.length}`,
        );
    }

    if (branch.length === 0) {
        lines.push("", "(no entries on this branch)");
        return lines.join("\n");
    }

    let cursor = startIndex;
    let rendered = 0;
    for (let turn = 0; turn < turnStarts.length; turn += 1) {
        const start = turnStarts[turn]!;
        const end = turnEndIndex(branch, start);
        if (end < startIndex || start > endIndex) {
            continue;
        }

        const turnStart = Math.max(start, startIndex);
        const turnEnd = Math.min(end, endIndex);
        while (cursor < turnStart) {
            const extra = renderOverviewExtra(branch[cursor]!, foldsById, width, branch);
            if (extra !== undefined) {
                lines.push(extra);
            }
            cursor += 1;
        }

        lines.push(
            "",
            ...renderOverviewTurn(
                branch,
                turnStart,
                turnEnd,
                turn + 1,
                options,
                width,
                session.header?.cwd,
                start,
            ),
        );
        for (let index = turnStart; index <= turnEnd; index += 1) {
            const extra = renderOverviewExtra(branch[index]!, foldsById, width, branch);
            if (extra !== undefined) {
                lines.push(extra);
            }
        }
        cursor = turnEnd + 1;
        rendered += 1;
    }

    while (cursor <= endIndex) {
        const extra = renderOverviewExtra(branch[cursor]!, foldsById, width, branch);
        if (extra !== undefined) {
            lines.push(extra);
        }
        cursor += 1;
    }

    if (rendered === 0) {
        lines.push("", "(no user turns in the selected window)");
    }

    return lines.join("\n");
}

function renderOverviewExtra(
    entry: SessionEntry,
    foldsById: ReadonlyMap<string, CompactionInfo>,
    width: number,
    branch: readonly SessionEntry[],
): string | undefined {
    if (entry.type === "branch_summary") {
        const summary = truncate(collapseWhitespace(asString(entry.summary) ?? ""), width);
        return `  branch summary ${entry.id ?? "?"}: ${summary}`;
    }

    if (entry.type !== "compaction") {
        return undefined;
    }

    const info = entry.id === undefined ? undefined : foldsById.get(entry.id);
    const tokens = asNumber(entry.tokensBefore);
    const kept = asString(entry.firstKeptEntryId);
    const parts = [`fold ${entry.id ?? "?"}`];
    if (tokens !== undefined) {
        parts.push(`${tokens} tokens before`);
    }
    parts.push(`kept from ${kept ?? "none"}`);
    if (info !== undefined && info.spanStartIndex >= 0) {
        const from = branch[info.spanStartIndex]?.id ?? "?";
        const to = branch[info.spanEndIndex]?.id ?? "?";
        parts.push(`span --from ${from} --to ${to}`);
    } else {
        parts.push("span none");
    }

    return `  ${parts.join(" · ")}`;
}

function renderOverviewTurn(
    branch: readonly SessionEntry[],
    start: number,
    end: number,
    turn: number,
    options: TranscriptOptions,
    width: number,
    cwd: string | undefined,
    promptIndex = start,
): string[] {
    const stats = turnStats(branch, start, end);
    const first = localTime(branch[start]!.timestamp) ?? "";
    const last = localTime(branch[end]!.timestamp) ?? first;
    const when = first === last ? first : `${first}→${last}`;
    const lines = [
        `[${turn}] ${when} · entries ${start + 1}–${end + 1} · ${stats.tools} tools${stats.errors > 0 ? ` · ${stats.errors} error(s)` : ""}${stats.fold ? " · fold" : ""}`,
    ];

    const user = overviewText(entryMessage(branch[promptIndex]!), width);
    lines.push(`    user: ${user === "" ? "(empty)" : user}`);

    const assistant = lastAssistantText(branch, start, end, width);
    if (assistant !== undefined) {
        lines.push(`    assistant: ${assistant === "" ? "(no text)" : assistant}`);
    }

    if (options.tools !== "none") {
        const details = collectTurnDetails(branch, start, end, cwd);
        lines.push(`    tools: ${formatToolCounts(details.tools)}`);

        const files = formatTurnFiles(details, options.width);
        if (files !== "") {
            lines.push(`    files: ${files}`);
        }
    }

    if (stats.firstError !== undefined) {
        const error = truncate(collapseWhitespace(stats.firstError), ERROR_LINE_LIMIT);
        lines.push(`    error: ${error}${stats.errors > 1 ? ` (+${stats.errors - 1} more)` : ""}`);
    }

    lines.push(`    span: --from ${branch[start]!.id ?? "?"} --to ${branch[end]!.id ?? "?"}`);

    return lines;
}

function overviewText(message: Record<string, unknown> | null, width: number): string {
    if (message === null) {
        return "";
    }

    return truncate(
        collapseWhitespace(messageText(message.content)),
        width === 0 ? Number.POSITIVE_INFINITY : width,
    );
}

function lastAssistantText(
    branch: readonly SessionEntry[],
    start: number,
    end: number,
    width: number,
): string | undefined {
    let found = false;

    for (let index = end; index >= start; index -= 1) {
        const message = entryMessage(branch[index]!);
        if (message?.role !== "assistant") {
            continue;
        }
        found = true;

        const text = messageText(message.content).trim();
        if (text !== "") {
            return truncate(
                collapseWhitespace(text),
                width === 0 ? Number.POSITIVE_INFINITY : width,
            );
        }
    }

    return found ? "" : undefined;
}

interface TurnDetails {
    tools: Map<string, number>;
    modified: Set<string>;
    read: Set<string>;
}

function collectTurnDetails(
    branch: readonly SessionEntry[],
    start: number,
    end: number,
    cwd: string | undefined,
): TurnDetails {
    const tools = new Map<string, number>();
    const modified = new Set<string>();
    const read = new Set<string>();

    for (let index = start; index <= end; index += 1) {
        const message = entryMessage(branch[index]!);
        if (message?.role !== "assistant" || !Array.isArray(message.content)) {
            continue;
        }

        for (const block of message.content) {
            const record = asRecord(block);
            if (record?.type !== "toolCall") {
                continue;
            }

            const name = asString(record.name) ?? "tool";
            const args = asRecord(record.arguments) ?? {};
            tools.set(name, (tools.get(name) ?? 0) + 1);

            const file = pathArgument(args);
            if (file === undefined) {
                continue;
            }

            if (MODIFY_TOOLS.has(name)) {
                modified.add(displayPath(file, cwd));
            }
            if (name === "read") {
                read.add(displayPath(file, cwd));
            }
        }
    }

    return { tools, modified, read };
}

const MODIFY_TOOLS = new Set([
    "apply",
    "apply_patch",
    "edit",
    "multi_edit",
    "notebook_edit",
    "write",
]);

function formatToolCounts(tools: ReadonlyMap<string, number>): string {
    if (tools.size === 0) {
        return "none";
    }

    return [...tools.entries()]
        .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([name, count]) => (count === 1 ? name : `${name}×${count}`))
        .join(", ");
}

function formatTurnFiles(details: TurnDetails, width: number | undefined): string {
    const parts: string[] = [];
    const limit = width === 0 ? Number.POSITIVE_INFINITY : 6;

    if (details.modified.size > 0) {
        const files = [...details.modified].slice(0, limit);
        const more = details.modified.size - files.length;
        parts.push(`modified ${files.join(", ")}${more > 0 ? ` (+${more})` : ""}`);
    }
    if (details.read.size > 0) {
        parts.push(`read ${details.read.size}`);
    }

    return parts.join(" · ");
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return "[unserializable]";
    }
}

// -------------------------------------------------------------------------------------- utilities

export function capOutput(text: string, maxChars: number): string {
    if (maxChars <= 0 || text.length <= maxChars) {
        return text;
    }

    const newline = text.lastIndexOf("\n", maxChars);
    const end = newline >= maxChars * 0.5 ? newline : maxChars;
    return `${text.slice(0, end)}\n\n# [truncated at ${end} of ${text.length} chars: narrow the window or pass --max-chars 0]\n`;
}

/** `read(src/x.ts)`, `bash(npm test …)`, `grep(pattern in src/)` — one argument, collapsed and capped. */
export function toolArgument(name: string, args: Record<string, unknown>, cwd?: string): string {
    const value = toolArgumentValue(name, args, cwd);
    return truncate(collapseWhitespace(value), ARG_LIMIT);
}

function toolArgumentValue(name: string, args: Record<string, unknown>, cwd?: string): string {
    if (name === "bash") {
        return asString(args.command) ?? "";
    }

    if (name === "read" || name === "edit" || name === "write" || name === "ls") {
        return displayPath(pathArgument(args) ?? "", cwd);
    }

    if (name === "grep") {
        const pattern = asString(args.pattern) ?? "";
        const where = asString(args.path) ?? asString(args.glob) ?? "";
        return where === "" ? pattern : `${pattern} in ${where}`;
    }

    if (name === "glob") {
        return asString(args.pattern) ?? "";
    }

    if (name === "agent") {
        return asString(args.title) ?? firstStringArgument(args) ?? "";
    }

    if (name === "ask_user") {
        return asString(args.title) ?? asString(args.question) ?? firstStringArgument(args) ?? "";
    }

    if (name === "todolist") {
        return asString(args.action) ?? "";
    }

    return firstStringArgument(args) ?? "";
}

function pathArgument(args: Record<string, unknown>): string | undefined {
    return asString(args.path) ?? asString(args.file_path) ?? asString(args.filePath);
}

function displayPath(value: string, cwd?: string): string {
    if (value === "" || cwd === undefined || !path.isAbsolute(value)) {
        return value;
    }

    const relative = path.relative(cwd, value);
    if (relative === "" || relative.startsWith("..")) {
        return value;
    }

    return relative;
}

function firstStringArgument(args: Record<string, unknown>): string | undefined {
    for (const value of Object.values(args)) {
        if (typeof value === "string" && value.trim() !== "") {
            return value;
        }
    }
    return undefined;
}

function toolResultsById(branch: readonly SessionEntry[]): Map<string, SessionEntry> {
    const results = new Map<string, SessionEntry>();
    for (const entry of branch) {
        const message = entryMessage(entry);
        if (message?.role !== "toolResult") {
            continue;
        }

        const id = asString(message.toolCallId);
        if (id !== undefined) {
            results.set(id, entry);
        }
    }
    return results;
}

function messageText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }

    const parts: string[] = [];
    for (const block of content) {
        const record = asRecord(block);
        if (record === null) {
            continue;
        }

        if (record.type === "text" && typeof record.text === "string") {
            parts.push(record.text);
            continue;
        }

        if (record.type === "image") {
            parts.push(`[image ${asString(record.mimeType) ?? "unknown"}]`);
        }
    }
    return parts.join("\n");
}

function latestField(
    branch: readonly SessionEntry[],
    type: string,
    project: (entry: SessionEntry) => string | undefined,
): string | undefined {
    const entry = branch.findLast((candidate) => candidate.type === type);
    return entry === undefined ? undefined : project(entry);
}

function entryMessage(entry: SessionEntry): Record<string, unknown> | null {
    if (entry.type !== "message") {
        return null;
    }
    return asRecord(entry.message);
}

function entryTimestamp(entry: SessionEntry): number | undefined {
    return timestampMs(entry.timestamp);
}

function timestampMs(iso: string | undefined): number | undefined {
    if (iso === undefined) {
        return undefined;
    }

    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function localTime(value?: string | number): string | undefined {
    const date = parseDate(value);
    if (date === undefined) {
        return undefined;
    }
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function localDate(value?: string | number): string | undefined {
    const date = parseDate(value);
    if (date === undefined) {
        return undefined;
    }
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTime(milliseconds: number): string {
    const date = new Date(milliseconds);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRange(firstMs: number, lastMs: number): string {
    if (localDate(firstMs) === localDate(lastMs)) {
        return `${formatDateTime(firstMs)} → ${localTime(lastMs) ?? ""}`;
    }

    return `${formatDateTime(firstMs)} → ${formatDateTime(lastMs)}`;
}

function parseDate(value?: string | number): Date | undefined {
    if (value === undefined) {
        return undefined;
    }

    const milliseconds = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(milliseconds) ? new Date(milliseconds) : undefined;
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, limit: number): string {
    if (value.length <= limit) {
        return value;
    }
    return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// -------------------------------------------------------------------------------------------- main

function main(argv: string[]): void {
    const parsed = parseArgs(argv);
    if (parsed.error !== undefined) {
        console.error(`session-transcript: ${parsed.error}\n\n${USAGE}`);
        process.exitCode = 1;
        return;
    }
    if (parsed.options.help) {
        console.log(USAGE);
        return;
    }

    const options = parsed.options;

    if (options.mode === "sessions") {
        console.log(capOutput(renderSessionList(options), options.maxChars));
        return;
    }

    let filePath: string;
    let session: ParsedSession;
    let rawBranch: SessionEntry[] | null;
    try {
        filePath = resolveSessionFile(options.session);
        session = parseSessionFile(fs.readFileSync(filePath, "utf8"));
        rawBranch = activeBranch(session, options.leaf);
    } catch (error) {
        console.error(
            `session-transcript: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
        return;
    }

    if (rawBranch === null) {
        console.error(`session-transcript: no entry matches --leaf "${options.leaf}"`);
        process.exitCode = 1;
        return;
    }

    const branch = options.context ? contextBranch(rawBranch) : rawBranch;
    const input: RenderInput = { session, filePath, branch, options };

    if (options.mode === "list") {
        console.log(capOutput(renderTurnList(input), options.maxChars));
        return;
    }

    if (options.mode === "overview") {
        console.log(capOutput(renderOverview(input), options.maxChars));
        return;
    }

    if (options.mode === "search") {
        const outcome = searchBranch(branch, options);
        if (outcome.error !== undefined) {
            console.error(`session-transcript: ${outcome.error}`);
            process.exitCode = 1;
            return;
        }

        console.log(capOutput(renderSearch(input, outcome), options.maxChars));
        return;
    }

    if (options.mode === "compactions") {
        const selection = selectCompactionFolds(rawBranch, options);
        if (selection.error !== undefined) {
            console.error(`session-transcript: ${selection.error}`);
            process.exitCode = 1;
            return;
        }

        console.log(
            capOutput(renderCompactionList({ ...input, branch: rawBranch }), options.maxChars),
        );
        return;
    }

    const selection = selectWindow(branch, options);
    if (selection.window === undefined) {
        console.error(`session-transcript: ${selection.error ?? "the selected window is empty"}`);
        process.exitCode = 1;
        return;
    }

    console.log(
        capOutput(renderTranscript({ ...input, window: selection.window }), options.maxChars),
    );
}

const isDirectRun =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
    main(process.argv.slice(2));
}
