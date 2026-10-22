import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
    activeBranch,
    capOutput,
    collectCompactions,
    contextBranch,
    matchEntryRef,
    parseArgs,
    parseSessionFile,
    parseWhen,
    renderCompactionList,
    renderTranscript,
    renderTurnList,
    resolveSessionFile,
    selectWindow,
    toolArgument,
} from "../../../skills/session-review/scripts/session-transcript.mts";
import type {
    ParsedSession,
    SessionEntry,
    TranscriptOptions,
    WindowResult,
} from "../../../skills/session-review/scripts/session-transcript.mts";

/**
 * The session-review transcript script: raw JSONL parsing, the active-branch walk, compaction span
 * anchors, window selection, and the one-line tool rendering.
 */

type EntryLine = Record<string, unknown>;

const CWD = "/tmp/proj";
const FILE = "/tmp/proj/session.jsonl";
const LONG_BASH =
    "npm run test:run -- --reporter=verbose --some=very-long-argument-to-force-truncation --another-long-flag=value";

function header(): EntryLine {
    return {
        type: "session",
        version: 3,
        id: "fixture-session",
        timestamp: "2026-01-01T09:59:00.000Z",
        cwd: CWD,
    };
}

function user(id: string, parentId: string | null, at: string, text: string): EntryLine {
    return {
        type: "message",
        id,
        parentId,
        timestamp: at,
        message: { role: "user", content: text, timestamp: Date.parse(at) },
    };
}

function assistant(id: string, parentId: string | null, at: string, content: unknown[]): EntryLine {
    return {
        type: "message",
        id,
        parentId,
        timestamp: at,
        message: {
            role: "assistant",
            content,
            api: "test",
            provider: "test",
            model: "model-a",
            usage: {},
            stopReason: "stop",
            timestamp: Date.parse(at),
        },
    };
}

function toolResult(
    id: string,
    parentId: string,
    at: string,
    callId: string,
    name: string,
    text: string,
    isError = false,
): EntryLine {
    return {
        type: "message",
        id,
        parentId,
        timestamp: at,
        message: {
            role: "toolResult",
            toolCallId: callId,
            toolName: name,
            content: [{ type: "text", text }],
            isError,
            timestamp: Date.parse(at),
        },
    };
}

function toolCall(
    id: string,
    name: string,
    args: Record<string, unknown>,
): Record<string, unknown> {
    return { type: "toolCall", id, name, arguments: args };
}

function sessionContent(lines: EntryLine[]): string {
    return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function buildFixtureLines(): EntryLine[] {
    return [
        header(),
        {
            type: "model_change",
            id: "m1",
            parentId: null,
            timestamp: "2026-01-01T09:59:00.000Z",
            provider: "test",
            modelId: "model-a",
        },
        {
            type: "thinking_level_change",
            id: "t1",
            parentId: "m1",
            timestamp: "2026-01-01T09:59:01.000Z",
            thinkingLevel: "high",
        },
        user(
            "u1",
            "t1",
            "2026-01-01T10:00:00.000Z",
            "first request with a long line\nand a second line",
        ),
        assistant("a1", "u1", "2026-01-01T10:00:05.000Z", [
            { type: "thinking", thinking: "weighing options" },
            { type: "text", text: "working on it" },
            toolCall("call_1", "read", { path: `${CWD}/src/index.ts` }),
        ]),
        toolResult("r1", "a1", "2026-01-01T10:00:06.000Z", "call_1", "read", "file body"),
        user("x1", "r1", "2026-01-01T10:02:00.000Z", "abandoned question"),
        assistant("x2", "x1", "2026-01-01T10:02:10.000Z", [
            { type: "text", text: "abandoned answer" },
        ]),
        user("u2", "r1", "2026-01-01T10:05:00.000Z", "second request"),
        assistant("a2", "u2", "2026-01-01T10:05:10.000Z", [
            { type: "text", text: "trying tests" },
            toolCall("call_2", "bash", { command: LONG_BASH }),
        ]),
        toolResult(
            "r2",
            "a2",
            "2026-01-01T10:05:30.000Z",
            "call_2",
            "bash",
            "FAIL src/x.test.ts\nexpected 1 to be 2",
            true,
        ),
        {
            type: "compaction",
            id: "f01d0001",
            parentId: "r2",
            timestamp: "2026-01-01T10:07:00.000Z",
            summary: "## Goal\n- first fold summary",
            firstKeptEntryId: "u2",
            tokensBefore: 5000,
            details: {
                readFiles: [`${CWD}/a.ts`],
                modifiedFiles: [],
                summarizedMessages: 3,
                route: "two-stage",
            },
        },
        user("u3", "f01d0001", "2026-01-01T10:10:00.000Z", "third request"),
        assistant("a3", "u3", "2026-01-01T10:10:10.000Z", [{ type: "text", text: "third answer" }]),
        {
            type: "compaction",
            id: "f01d0002",
            parentId: "a3",
            timestamp: "2026-01-01T10:12:00.000Z",
            summary: "## Goal\n- second fold summary",
            firstKeptEntryId: "u3",
            tokensBefore: 6000,
            details: { readFiles: [], modifiedFiles: [`${CWD}/b.ts`], summarizedMessages: 4 },
        },
        user("u4", "f01d0002", "2026-01-01T10:13:00.000Z", "fourth request"),
        assistant("a4", "u4", "2026-01-01T10:13:10.000Z", [
            { type: "text", text: "fourth answer" },
        ]),
    ];
}

interface Fixture {
    content: string;
    session: ParsedSession;
    branch: SessionEntry[];
}

function buildFixture(): Fixture {
    const content = sessionContent(buildFixtureLines());
    const session = parseSessionFile(content);
    const branch = activeBranch(session);
    if (branch === null) {
        throw new Error("fixture branch did not resolve");
    }

    return { content, session, branch };
}

const fixture = buildFixture();

function transcriptOptions(overrides: Partial<TranscriptOptions> = {}): TranscriptOptions {
    return {
        context: false,
        tools: "short",
        thinking: false,
        maxChars: 0,
        mode: "transcript",
        help: false,
        ...overrides,
    };
}

function windowFor(overrides: Partial<TranscriptOptions>): WindowResult {
    const selection = selectWindow(fixture.branch, transcriptOptions(overrides));
    expect(selection.error).toBeUndefined();
    if (selection.window === undefined) {
        throw new Error("fixture window did not resolve");
    }

    return selection.window;
}

function renderFixture(overrides: Partial<TranscriptOptions> = {}): string {
    const options = transcriptOptions(overrides);
    const branch = options.context ? contextBranch(fixture.branch) : fixture.branch;
    const selection = selectWindow(branch, options);
    expect(selection.error).toBeUndefined();
    if (selection.window === undefined) {
        throw new Error("fixture window did not resolve");
    }

    return renderTranscript({
        session: fixture.session,
        filePath: FILE,
        branch,
        options,
        window: selection.window,
    });
}

function editBranch(replacement: unknown): SessionEntry[] {
    const session = parseSessionFile(
        sessionContent([
            header(),
            user("u1", null, "2026-01-01T10:00:00.000Z", "hello"),
            assistant("a1", "u1", "2026-01-01T10:00:05.000Z", [
                { type: "text", text: "original answer" },
            ]),
            {
                type: "context_edit",
                id: "e1",
                parentId: "a1",
                timestamp: "2026-01-01T10:00:06.000Z",
                targetId: "a1",
                replacement,
            },
            user("u2", "e1", "2026-01-01T10:01:00.000Z", "more"),
            assistant("a2", "u2", "2026-01-01T10:01:05.000Z", [{ type: "text", text: "reply" }]),
        ]),
    );
    const branch = activeBranch(session);
    if (branch === null) {
        throw new Error("edit fixture branch did not resolve");
    }

    return branch;
}

describe("parseSessionFile", () => {
    it("keeps the header, indexes entries by id, and counts malformed lines", () => {
        const parsed = parseSessionFile(
            `${JSON.stringify(header())}\nnot json\n${JSON.stringify({ type: "message", id: "a1", message: { role: "user", content: "hi" } })}\n`,
        );

        expect(parsed.header?.id).toBe("fixture-session");
        expect(parsed.entries).toHaveLength(1);
        expect(parsed.byId.get("a1")).toBeDefined();
        expect(parsed.malformedLines).toBe(1);
    });
});

describe("activeBranch", () => {
    it("walks the parent chain from the last entry and excludes abandoned branches", () => {
        expect(fixture.branch.map((entry) => entry.id)).toEqual([
            "m1",
            "t1",
            "u1",
            "a1",
            "r1",
            "u2",
            "a2",
            "r2",
            "f01d0001",
            "u3",
            "a3",
            "f01d0002",
            "u4",
            "a4",
        ]);
    });

    it("reads an old branch tip with an explicit leaf", () => {
        const oldTip = activeBranch(fixture.session, "x2");
        expect(oldTip?.map((entry) => entry.id)).toEqual([
            "m1",
            "t1",
            "u1",
            "a1",
            "r1",
            "x1",
            "x2",
        ]);
    });

    it("returns a v1 session without ids as a linear transcript", () => {
        const session = parseSessionFile(
            sessionContent([
                header(),
                { type: "message", message: { role: "user", content: "one" } },
                { type: "message", message: { role: "assistant", content: "two" } },
            ]),
        );

        expect(activeBranch(session)?.map((entry) => entry.type)).toEqual(["message", "message"]);
    });
});

describe("collectCompactions", () => {
    it("anchors each fold to the raw span it dropped", () => {
        const infos = collectCompactions(fixture.branch);

        expect(infos).toHaveLength(2);
        expect(infos[0]).toMatchObject({
            index: 8,
            keptId: "u2",
            spanStartIndex: 0,
            spanEndIndex: 4,
        });
        expect(infos[1]).toMatchObject({
            index: 11,
            keptId: "u3",
            spanStartIndex: 5,
            spanEndIndex: 7,
        });
        expect(infos[1]?.details).toEqual({
            readFiles: [],
            modifiedFiles: [`${CWD}/b.ts`],
            summarizedMessages: 4,
        });
    });

    it("trims a previous fold row off the raw span", () => {
        const infos = collectCompactions(fixture.branch);
        const trimmed = fixture.branch.slice(infos[1]!.spanStartIndex, infos[1]!.spanEndIndex + 1);

        expect(trimmed.map((entry) => entry.id)).toEqual(["u2", "a2", "r2"]);
    });
});

describe("contextBranch", () => {
    it("hoists the newest fold and keeps only its retained tail", () => {
        expect(contextBranch(fixture.branch).map((entry) => entry.id)).toEqual([
            "f01d0002",
            "u3",
            "a3",
            "u4",
            "a4",
        ]);
    });

    it("applies a null context edit by omitting the target", () => {
        expect(contextBranch(editBranch(null)).map((entry) => entry.id)).toEqual([
            "u1",
            "u2",
            "a2",
        ]);
    });

    it("applies a replacement context edit to the target message", () => {
        const branch = contextBranch(editBranch("rewritten answer"));
        const target = branch.find((entry) => entry.id === "a1");
        const message = target?.message as { content: unknown[] } | undefined;

        expect(message?.content).toEqual([{ type: "text", text: "rewritten answer" }]);
    });
});

describe("selectWindow", () => {
    it("selects the last n user turns", () => {
        expect(windowFor({ last: 2 })).toMatchObject({
            startIndex: 9,
            endIndex: 13,
            label: "last 2 turns",
        });
    });

    it("selects a turn range and a single turn", () => {
        expect(windowFor({ turns: { first: 2, last: 3 } })).toMatchObject({
            startIndex: 5,
            endIndex: 11,
        });
        expect(windowFor({ turns: { first: 2, last: 2 } })).toMatchObject({
            startIndex: 5,
            endIndex: 8,
        });
    });

    it("selects by entry ids and combines with --last", () => {
        expect(windowFor({ from: "u2", to: "a3" })).toMatchObject({ startIndex: 5, endIndex: 10 });
        expect(windowFor({ from: "u3", last: 2 })).toMatchObject({ startIndex: 9, endIndex: 13 });
    });

    it("selects by time", () => {
        const since = Date.parse("2026-01-01T10:04:00.000Z");
        const until = Date.parse("2026-01-01T10:05:15.000Z");

        expect(windowFor({ since, until })).toMatchObject({ startIndex: 5, endIndex: 6 });
    });

    it("reports unknown, ambiguous, out-of-range, and empty windows", () => {
        expect(selectWindow(fixture.branch, transcriptOptions({ from: "nope" })).error).toMatch(
            /matches no entry/,
        );
        expect(selectWindow(fixture.branch, transcriptOptions({ from: "u" })).error).toMatch(
            /ambiguous/,
        );
        expect(
            selectWindow(fixture.branch, transcriptOptions({ turns: { first: 9, last: 9 } })).error,
        ).toMatch(/out of range/);
        expect(
            selectWindow(fixture.branch, transcriptOptions({ from: "a4", to: "u4" })).error,
        ).toMatch(/empty/);
    });
});

describe("matchEntryRef", () => {
    it("matches a full id or a unique prefix", () => {
        expect(matchEntryRef(fixture.branch, "u2").entry?.id).toBe("u2");
        expect(matchEntryRef(fixture.branch, "u").matches).toHaveLength(4);
        expect(matchEntryRef(fixture.branch, "zzz").entry).toBeUndefined();
    });
});

describe("renderTranscript", () => {
    it("prints user text, assistant text, short tool calls, and error markers", () => {
        const output = renderFixture();

        expect(output).toContain("# session fixture-session · raw branch · /tmp/proj");
        expect(output).toContain("first request with a long line");
        expect(output).toContain("→ read(src/index.ts)");
        expect(output).toContain("→ bash(npm run test:run");
        expect(output).toContain("[error: FAIL src/x.test.ts expected 1 to be 2]");
        expect(output).toContain("second fold summary");
    });

    it("marks the day once in the header block", () => {
        const date = new Date("2026-01-01T10:00:00.000Z");
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

        expect(renderFixture()).toContain(`── ${day} ──`);
    });

    it("drops tool lines with --tools none and keeps payloads with full", () => {
        const bare = renderFixture({ tools: "none" });
        expect(bare).not.toContain("→ read(");
        expect(bare).not.toContain("→ bash(");
        expect(renderFixture({ tools: "full" })).toContain(`args: {"path":"${CWD}/src/index.ts"}`);
        expect(renderFixture({ tools: "full" })).toContain("error: FAIL src/x.test.ts");
    });

    it("omits an assistant step that only called tools when tool lines are hidden", () => {
        const branch: SessionEntry[] = [
            {
                type: "message",
                id: "u1",
                parentId: null,
                timestamp: "2026-01-01T10:00:00.000Z",
                message: { role: "user", content: "go", timestamp: 1 },
            },
            {
                type: "message",
                id: "a1",
                parentId: "u1",
                timestamp: "2026-01-01T10:00:05.000Z",
                message: {
                    role: "assistant",
                    content: [
                        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
                    ],
                    timestamp: 2,
                },
            },
        ];
        const options = transcriptOptions({ tools: "none" });
        const output = renderTranscript({
            session: fixture.session,
            filePath: FILE,
            branch,
            options,
            window: selectWindow(branch, options).window!,
        });

        expect(output).not.toContain("assistant");
    });

    it("includes thinking only with --thinking", () => {
        expect(renderFixture()).not.toContain("[thinking]");
        expect(renderFixture({ thinking: true })).toContain("[thinking] weighing options");
    });

    it("shows the model context instead of the dropped span with --context", () => {
        const output = renderFixture({ context: true });

        expect(output).toContain("second fold summary");
        expect(output).toContain("third request");
        expect(output).not.toContain("first fold summary");
        expect(output).not.toContain("first request with a long line");
    });

    it("narrows rendering to the selected window", () => {
        const output = renderFixture({ last: 1 });

        expect(output).toContain("fourth request");
        expect(output).not.toContain("third request");
    });

    it("prints a context_edit marker on the raw branch", () => {
        const branch = editBranch(null);
        const options = transcriptOptions();
        const selection = selectWindow(branch, options);
        const output = renderTranscript({
            session: fixture.session,
            filePath: FILE,
            branch,
            options,
            window: selection.window!,
        });

        expect(output).toContain("context edit: entry a1 hidden");
    });
});

describe("renderTurnList", () => {
    it("lists turns with entry ids for later --from/--to use", () => {
        const output = renderTurnList({
            session: fixture.session,
            filePath: FILE,
            branch: fixture.branch,
            options: transcriptOptions(),
        });

        expect(output).toContain("# 14 entries · 4 turns · 2 compaction(s)");
        expect(output).toContain("first request with a long line and a second line");
        expect(output).toContain("u1");
        expect(output).toContain("fourth request");
    });
});

describe("renderCompactionList", () => {
    it("prints folds newest first with pastable span anchors", () => {
        const output = renderCompactionList({
            session: fixture.session,
            filePath: FILE,
            branch: fixture.branch,
            options: transcriptOptions(),
        });

        expect(output.indexOf("second fold summary")).toBeGreaterThan(-1);
        expect(output.indexOf("second fold summary")).toBeLessThan(
            output.indexOf("first fold summary"),
        );
        expect(output).toContain("kept from u3");
        expect(output).toContain("--from u2 --to r2");
        expect(output).toContain("--from m1 --to r1");
    });

    it("filters folds by time", () => {
        const output = renderCompactionList({
            session: fixture.session,
            filePath: FILE,
            branch: fixture.branch,
            options: transcriptOptions({ since: Date.parse("2026-01-01T10:11:00.000Z") }),
        });

        expect(output).toContain("second fold summary");
        expect(output).not.toContain("first fold summary");
    });
});

describe("capOutput", () => {
    it("leaves short output and disabled caps untouched", () => {
        expect(capOutput("short", 100)).toBe("short");
        expect(capOutput("x".repeat(200), 0)).toHaveLength(200);
    });

    it("truncates and names the total length", () => {
        const capped = capOutput(`line1\n${"y".repeat(200)}`, 60);

        expect(capped).toContain("[truncated at 60 of 206 chars");
    });
});

describe("toolArgument", () => {
    it("relativizes file paths under the session cwd", () => {
        expect(toolArgument("read", { path: `${CWD}/src/index.ts` }, CWD)).toBe("src/index.ts");
        expect(toolArgument("read", { path: "/elsewhere/x.ts" }, CWD)).toBe("/elsewhere/x.ts");
    });

    it("truncates long bash commands and formats grep", () => {
        expect(toolArgument("bash", { command: LONG_BASH })).toMatch(/…$/);
        expect(toolArgument("grep", { pattern: "TODO", path: "src/" })).toBe("TODO in src/");
    });

    it("falls back to the first string argument", () => {
        expect(toolArgument("agent", { title: "Check the tests" })).toBe("Check the tests");
        expect(toolArgument("unknown_tool", { query: "find me" })).toBe("find me");
        expect(toolArgument("read", {}, CWD)).toBe("");
    });
});

describe("parseWhen", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);

    it("parses relative windows", () => {
        expect(parseWhen("2h", false, now)).toBe(now - 7_200_000);
        expect(parseWhen("30m", false, now)).toBe(now - 1_800_000);
    });

    it("parses date-only values at the start or end of the local day", () => {
        expect(parseWhen("2026-01-01", false, now)).toBe(new Date(2026, 0, 1).getTime());
        expect(parseWhen("2026-01-01", true, now)).toBe(
            new Date(2026, 0, 1, 23, 59, 59, 999).getTime(),
        );
    });

    it("rejects unparsable values", () => {
        expect(parseWhen("soon", false, now)).toBeUndefined();
    });
});

describe("parseArgs", () => {
    it("accepts inline and separate values", () => {
        const { options, error } = parseArgs([
            "--tools=full",
            "--last",
            "3",
            "--since",
            "2h",
            "--max-chars",
            "0",
        ]);

        expect(error).toBeUndefined();
        expect(options.tools).toBe("full");
        expect(options.last).toBe(3);
        expect(options.maxChars).toBe(0);
        expect(options.since).toBeGreaterThan(0);
    });

    it("reports conflicting and invalid values", () => {
        expect(parseArgs(["--last", "2", "--turns", "1"]).error).toMatch(
            /either --last or --turns/,
        );
        expect(parseArgs(["--last", "zero"]).error).toMatch(/positive integer/);
        expect(parseArgs(["--turns", "3:1"]).error).toMatch(/1 <= first <= last/);
        expect(parseArgs(["--tools", "loud"]).error).toMatch(/none, short, or full/);
        expect(parseArgs(["--wat"]).error).toMatch(/unknown option/);
        expect(parseArgs(["--session"]).error).toMatch(/needs a value/);
    });

    it("recognizes --help", () => {
        expect(parseArgs(["--help"]).options.help).toBe(true);
    });
});

describe("resolveSessionFile", () => {
    const temporaryDirectories: string[] = [];

    function temporaryDirectory(): string {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-review-"));
        temporaryDirectories.push(directory);
        return directory;
    }

    afterEach(() => {
        for (const directory of temporaryDirectories.splice(0)) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it("reads an explicit path", () => {
        const directory = temporaryDirectory();
        const file = path.join(directory, "s.jsonl");
        fs.writeFileSync(file, sessionContent([header()]));

        expect(resolveSessionFile(file)).toBe(file);
    });

    it("uses PI_SESSION_FILE when no reference is given", () => {
        const directory = temporaryDirectory();
        const file = path.join(directory, "s.jsonl");
        fs.writeFileSync(file, sessionContent([header()]));

        expect(resolveSessionFile(undefined, { PI_SESSION_FILE: file })).toBe(file);
    });

    it("falls back to the newest transcript for the cwd", () => {
        const root = temporaryDirectory();
        const directory = path.join(root, "--tmp-proj--");
        fs.mkdirSync(directory, { recursive: true });
        const older = path.join(directory, "older.jsonl");
        const newer = path.join(directory, "newer.jsonl");
        fs.writeFileSync(older, "");
        fs.writeFileSync(newer, "");
        fs.utimesSync(older, new Date(0), new Date(0));
        fs.utimesSync(newer, new Date(), new Date());

        expect(
            resolveSessionFile(undefined, { PI_CODING_AGENT_SESSION_DIR: root }, "/tmp/proj"),
        ).toBe(newer);
    });

    it("finds a session by id under the sessions root", () => {
        const root = temporaryDirectory();
        const directory = path.join(root, "--tmp-proj--");
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, "2026-01-01T00-00-00-000Z_abcd1234.jsonl");
        fs.writeFileSync(file, "");

        expect(resolveSessionFile("abcd", { PI_CODING_AGENT_SESSION_DIR: root }, "/tmp/proj")).toBe(
            file,
        );
    });

    it("throws when nothing matches", () => {
        const root = temporaryDirectory();

        expect(() =>
            resolveSessionFile("missing", { PI_CODING_AGENT_SESSION_DIR: root }, "/tmp/proj"),
        ).toThrow(/no session file/);
    });
});
