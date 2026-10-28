import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
    DEFAULT_POLICY,
    latestSession,
    parseArgs,
    readTurns,
    renderSession,
    resolvePolicy,
} from "../../scripts/window-report.mts";
import {
    WINDOW_POLICY_REMINDER,
    WINDOW_POLICY_TRANSCRIPT,
} from "../../src/modules/decision/window";
import {
    REMINDER_DEBUG_ENTRY_TYPE,
    REMINDER_STATE_TYPE,
} from "../../src/modules/reminders/session-signals";
import {
    assistantEntry,
    branch,
    cleanupBranches,
    sessionInDirectory,
    sessionManager,
    textPart,
    toolCall,
    toolResultEntry,
    userEntry,
} from "../helpers/session-branch";

/**
 * The window report: argument parsing, the per-prompt allocation, and the rendering the CLI prints. The
 * allocator itself is `test/modules/decision/window.test.ts`; these read the report's own wiring.
 */

const policy = WINDOW_POLICY_REMINDER;

/** Directories the caller owns, used where two sessions must share one discovery root. */
const sharedDirectories: string[] = [];

function sharedDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-window-report-"));
    sharedDirectories.push(directory);
    return directory;
}

afterEach(() => {
    cleanupBranches();
    for (const directory of sharedDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("parseArgs", () => {
    it("reads the session files positionally and the flags", () => {
        expect(
            parseArgs([
                "a.jsonl",
                "b.jsonl",
                "--turns",
                "3, 7",
                "--policy",
                "plan",
                "--budget",
                "900",
                "--keep",
                "2",
                "--compact",
            ]),
        ).toEqual({
            files: ["a.jsonl", "b.jsonl"],
            turns: new Set([3, 7]),
            policy: "plan",
            budget: 900,
            keepTurns: 2,
            compact: true,
            midRun: false,
            help: false,
        });
    });

    it("reads the mid-run flag under either spelling", () => {
        expect(parseArgs(["a.jsonl", "--mid-run"]).midRun).toBe(true);
        expect(parseArgs(["a.jsonl", "--midturn"]).midRun).toBe(true);
    });

    it("defaults to the production policy, every turn, and the latest session of the cwd", () => {
        const options = parseArgs([]);

        expect(options.files).toEqual([]);
        expect(options.policy).toBe(DEFAULT_POLICY);
        expect(options.turns.size).toBe(0);
        expect(options.budget).toBeUndefined();
        expect(options.keepTurns).toBeUndefined();
        expect(options.compact).toBe(false);
        expect(options.midRun).toBe(false);
    });

    it("rejects a value that would silently read a different window", () => {
        expect(() => parseArgs(["a.jsonl", "--policy", "nope"])).toThrow(/unknown policy/u);
        expect(() => parseArgs(["a.jsonl", "--budget", "0"])).toThrow(/--budget/u);
        expect(() => parseArgs(["a.jsonl", "--budget", "nope"])).toThrow(/--budget/u);
        expect(() => parseArgs(["a.jsonl", "--keep", "-1"])).toThrow(/--keep/u);
        expect(() => parseArgs(["a.jsonl", "--turns", "0"])).toThrow(/--turns/u);
        expect(() => parseArgs(["a.jsonl", "--turns", "2,x"])).toThrow(/--turns/u);
        expect(() => parseArgs(["a.jsonl", "--turns"])).toThrow(/needs a value/u);
        expect(() => parseArgs(["a.jsonl", "--nope"])).toThrow(/unknown flag/u);
    });

    it("recognizes help without a file", () => {
        expect(parseArgs(["--help"])).toMatchObject({ help: true, files: [] });
    });
});

describe("resolvePolicy", () => {
    it("returns the named policy untouched without overrides", () => {
        expect(resolvePolicy("reminder", undefined, undefined)).toEqual(WINDOW_POLICY_REMINDER);
        expect(resolvePolicy("transcript", undefined, undefined)).toEqual(WINDOW_POLICY_TRANSCRIPT);
    });

    it("applies only the two allocation knobs the flags name", () => {
        const resolved = resolvePolicy("transcript", 1200, 0);

        expect(resolved.budget).toBe(1200);
        expect(resolved.keepTurns).toBe(0);
        expect(resolved.caps).toEqual(WINDOW_POLICY_TRANSCRIPT.caps);
        expect(resolved.markers).toBe(WINDOW_POLICY_TRANSCRIPT.markers);
    });

    it("throws for an unknown policy instead of falling back to a default", () => {
        expect(() => resolvePolicy("nope", undefined, undefined)).toThrow(/unknown policy/u);
    });
});

describe("latestSession", () => {
    it("picks the session pi --continue would resume for the cwd", () => {
        const cwd = "/repo";
        const directory = sharedDirectory();
        const older = sessionInDirectory(cwd, directory);
        older.appendMessage(userEntry("older", 1));
        const newer = sessionInDirectory(cwd, directory);
        newer.appendMessage(userEntry("newer", 2));

        const olderFile = older.getSessionFile();
        const newerFile = newer.getSessionFile();
        expect(olderFile).toBeDefined();
        expect(newerFile).toBeDefined();

        // Discovery orders by mtime; set it explicitly so two writes in one millisecond cannot flake the pick.
        fs.utimesSync(olderFile ?? "", new Date(1_000_000), new Date(1_000_000));
        fs.utimesSync(newerFile ?? "", new Date(2_000_000), new Date(2_000_000));

        const found = latestSession(cwd, directory);

        expect(found?.file).toBe(newerFile);
        expect(found?.session.getCwd()).toBe(cwd);
    });

    it("returns undefined when the directory holds no session", () => {
        expect(latestSession("/repo", sharedDirectory())).toBeUndefined();
    });
});

describe("readTurns", () => {
    const twoTurns = (): ReturnType<typeof branch> =>
        branch([
            userEntry("first request", 1),
            assistantEntry([textPart("working on it")], 2),
            userEntry("second request", 3),
            assistantEntry([textPart("done")], 4),
        ]);

    it("allocates the branch prefix at each prompt with the branch's own turn stamp", () => {
        const windows = readTurns(twoTurns(), policy);

        expect(windows.map((window) => window.turn)).toEqual([1, 2]);
        expect(windows[0]?.selection.lines).toEqual(["User: first request"]);
        expect(windows[1]?.selection.lines).toContain("User: first request");
        expect(windows[1]?.selection.lines).toContain("User: second request");
        expect(windows.every((window) => window.selection.chars <= policy.budget)).toBe(true);
    });

    it("keeps a steered prompt on the turn it joined instead of shifting the numbering", () => {
        const entries = branch([
            userEntry("first request", 1),
            assistantEntry([textPart("reading"), toolCall("read", { path: "a.ts" })], 2),
            userEntry("also check the tests", 3),
            toolResultEntry("ok", 4),
            assistantEntry([textPart("done")], 5),
            userEntry("third request", 6),
        ]);

        expect(readTurns(entries, policy).map(({ turn, steer }) => ({ turn, steer }))).toEqual([
            { turn: 1, steer: false },
            { turn: 1, steer: true },
            { turn: 2, steer: false },
        ]);
    });

    it("filters by the turn stamp", () => {
        expect(readTurns(twoTurns(), policy, new Set([2])).map((window) => window.turn)).toEqual([
            2,
        ]);
        expect(readTurns(twoTurns(), policy, new Set([3]))).toEqual([]);
    });

    it("counts the atoms the allocator priced, clipped included", () => {
        const [first] = readTurns(twoTurns(), policy);

        expect(first?.items).toBe(1);
        expect(first?.selection.kept).toHaveLength(1);
    });

    it("reads a recorded state entry as a marker, as the live consult does", () => {
        const session = sessionManager("/repo");
        session.appendMessage(userEntry("first request", 1));
        session.appendCustomEntry(REMINDER_STATE_TYPE, { phase: "validating" });
        session.appendMessage(assistantEntry([textPart("done")], 2));
        session.appendMessage(userEntry("second request", 3));

        const windows = readTurns(session.getBranch(), policy);

        expect(windows[1]?.selection.lines.some((line) => line.includes("validating"))).toBe(true);
    });

    it("reads a real session file through the session manager", () => {
        const file = path.resolve("test/fixtures/session/hosted-cut-before-checkpoint.jsonl");
        const session = SessionManager.open(file);
        const windows = readTurns(session.getBranch(), policy, new Set([1]));

        expect(windows).toHaveLength(1);
        expect(windows[0]?.turn).toBe(1);
        expect(windows[0]?.selection.lines.length).toBeGreaterThan(0);
    });
});

/** A run with mid-run records: two different states, three records, plus a different trigger. */
function midRunBranch(): { entries: ReturnType<typeof branch>; recordIds: string[] } {
    const session = sessionManager("/repo");
    const recordIds: string[] = [];
    session.appendMessage(userEntry("first request", 1));
    session.appendCustomEntry(REMINDER_DEBUG_ENTRY_TYPE, { trigger: "checkpoint" });
    session.appendMessage(
        assistantEntry([textPart("reading"), toolCall("read", { path: "a.ts" })], 2),
    );
    recordIds.push(session.appendCustomEntry(REMINDER_DEBUG_ENTRY_TYPE, { trigger: "mid-run" }));
    // No item changed: the same state is consulted again, then again after a tool result.
    session.appendCustomEntry(REMINDER_DEBUG_ENTRY_TYPE, { trigger: "mid-run" });
    session.appendMessage(toolResultEntry("ok", 3));
    session.appendCustomEntry(REMINDER_DEBUG_ENTRY_TYPE, { trigger: "mid-run" });
    session.appendMessage(assistantEntry([textPart("done")], 4));
    recordIds.push(session.appendCustomEntry(REMINDER_DEBUG_ENTRY_TYPE, { trigger: "mid-run" }));

    return { entries: session.getBranch(), recordIds };
}

describe("mid-run points", () => {
    it("adds the recorded consults in branch order and collapses repeats of one state", () => {
        const { entries, recordIds } = midRunBranch();

        const points = readTurns(entries, policy, new Set(), true);

        expect(points.map((point) => point.kind)).toEqual(["turn", "mid-run", "mid-run"]);
        expect(points[1]).toMatchObject({
            kind: "mid-run",
            turn: 1,
            entry: recordIds[0],
            records: 3,
        });
        expect(points[1]?.selection.lines.some((line) => line.startsWith("Tool: read"))).toBe(true);
        expect(points[2]).toMatchObject({ kind: "mid-run", turn: 1, records: 1 });
    });

    it("leaves the recorded consults out unless asked", () => {
        const { entries } = midRunBranch();

        expect(readTurns(entries, policy).map((point) => point.kind)).toEqual(["turn"]);
    });

    it("filters mid-run points by the turn they are inside", () => {
        const session = sessionManager("/repo");
        session.appendMessage(userEntry("first request", 1));
        session.appendMessage(userEntry("second request", 2));
        session.appendMessage(
            assistantEntry([textPart("reading"), toolCall("read", { path: "a.ts" })], 3),
        );
        session.appendCustomEntry(REMINDER_DEBUG_ENTRY_TYPE, { trigger: "mid-run" });

        const points = readTurns(session.getBranch(), policy, new Set([2]), true);

        expect(points.map((point) => [point.kind, point.turn])).toEqual([
            ["turn", 2],
            ["mid-run", 2],
        ]);
    });
});

describe("renderSession", () => {
    const report = (): Parameters<typeof renderSession>[0] => ({
        file: "/repo/session.jsonl",
        cwd: "/repo",
        policyName: "reminder",
        policy,
        midRun: false,
        windows: readTurns(
            branch([
                userEntry("first request", 1),
                assistantEntry([textPart("working on it")], 2),
                userEntry("second request", 3),
            ]),
            policy,
        ),
    });

    it("renders the header, each turn's spend, and the allocated lines", () => {
        const text = renderSession(report(), false);

        expect(text).toContain("session: /repo/session.jsonl");
        expect(text).toContain(
            "cwd: /repo   reported: 2 turns   policy: reminder   budget: 2000   keepTurns: 0",
        );
        expect(text).toContain("===== turn 1 =====");
        expect(text).toMatch(/window: \d+\/2000 chars, 1\/1 items, 0 dropped, value /u);
        expect(text).toContain("spread: t1 ");
        expect(text).toContain("User: first request");
    });

    it("renders one line per turn with --compact", () => {
        const text = renderSession(report(), true);

        expect(text).toContain("turn 1  window: ");
        expect(text).toContain("turn 2  window: ");
        expect(text).not.toContain("=====");
        expect(text).not.toContain("User: first request");
    });

    it("labels mid-run points with their entry and collapsed record count", () => {
        const { entries, recordIds } = midRunBranch();
        const points = readTurns(entries, policy, new Set(), true);
        const text = renderSession(
            {
                file: "/repo/session.jsonl",
                cwd: "/repo",
                policyName: "reminder",
                policy,
                midRun: true,
                windows: points,
            },
            true,
        );

        expect(text).toContain("reported: 1 turn + 2 mid-run");
        expect(text).toContain(
            `turn 1 mid-run (entry ${recordIds[0] ?? "?"}, 3 records)  window: `,
        );
        expect(text).toContain(`turn 1 mid-run (entry ${recordIds[1] ?? "?"})  window: `);
    });
});
