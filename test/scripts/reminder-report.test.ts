import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
    parseArgs,
    replay,
    renderJson,
    renderText,
    selectTurns,
} from "../../scripts/reminder-report.mts";
import { zeroUsage } from "../helpers/agent-doubles";

/**
 * The reminder replay report: argument parsing, the turn-by-turn simulation with the real deterministic
 * scheduler, and the rendering the CLI prints.
 */

type AppendedMessage = Parameters<SessionManager["appendMessage"]>[0];

const temporaryDirectories: string[] = [];

function sessionAt(cwd: string): SessionManager {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reminder-report-"));
    temporaryDirectories.push(directory);
    return SessionManager.create(cwd, directory);
}

function userEntry(text: string, timestamp: number): AppendedMessage {
    return { role: "user", content: text, timestamp };
}

function assistantEntry(
    text: string,
    timestamp: number,
    usage: ReturnType<typeof zeroUsage> = zeroUsage(),
): AppendedMessage {
    const content: AssistantMessage["content"] = [{ type: "text", text }];

    return {
        role: "assistant",
        content,
        api: "test",
        provider: "test",
        model: "test",
        usage,
        stopReason: "stop",
        timestamp,
    };
}

beforeEach(() => {
    vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "5");
    vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "30000");
});

afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("parseArgs", () => {
    it("reads the file positionally and the numeric flags", () => {
        expect(
            parseArgs(["session.jsonl", "--turn", "3", "--turns", "5", "--compact", "--json"]),
        ).toEqual({
            file: "session.jsonl",
            turn: 3,
            turns: 5,
            compact: true,
            json: true,
            help: false,
        });
    });

    it("ignores a non-positive or non-numeric turn instead of failing", () => {
        expect(parseArgs(["session.jsonl", "--turn", "0"]).turn).toBeUndefined();
        expect(parseArgs(["session.jsonl", "--turns", "nope"]).turns).toBeUndefined();
        expect(parseArgs(["--unknown", "session.jsonl"]).file).toBe("session.jsonl");
    });

    it("recognizes help without a file", () => {
        expect(parseArgs(["--help"])).toMatchObject({ help: true, file: undefined });
    });
});

describe("replay", () => {
    it("simulates the deterministic schedule turn by turn and builds the state", () => {
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first request", 1));
        session.appendMessage(assistantEntry("working", 2));
        session.appendMessage(userEntry("second request", 3));

        const result = replay(session.getBranch(), cwd);

        expect(result.userTurns).toBe(2);
        expect(result.turns[0]).toMatchObject({
            turn: 1,
            request: "first request",
            schedule: "memory-read",
        });
        // The report prints the reminder content, not just its id.
        expect(result.turns[0]?.reminderText).toContain("memory_system");
        expect(result.turns[0]?.state).toMatchObject({
            request: "first request",
            cwd,
            session: { user_turns: 1, context_tokens: 0 },
        });
        // Five turns between rotation triggers, and this is only the second turn.
        expect(result.turns[1]).toMatchObject({ turn: 2, schedule: "none" });
        expect(result.turns[1]?.reminderText).toBeUndefined();
        // The previous user message is the request item and is dropped from the window by design.
        expect(result.turns[1]?.state.recent_messages).toEqual([
            { role: "assistant", text: "working" },
        ]);
    });

    it("respects the environment's cadence", () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "1");
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first request", 1));
        session.appendMessage(userEntry("second request", 2));

        const result = replay(session.getBranch(), cwd);

        expect(result.turns.map((turn) => turn.schedule)).toEqual([
            "memory-read",
            "memory-hygiene",
        ]);
    });

    it("models mid-run threshold emissions as steers into the run", () => {
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first request", 1));
        session.appendMessage(assistantEntry("done", 2, { ...zeroUsage(), input: 200 }));
        session.appendMessage(userEntry("second request", 3));

        const result = replay(session.getBranch(), cwd);

        expect(result.turns[1]?.midRun).toMatchObject([{ schedule: "memory-hygiene" }]);
        expect(result.turns[1]?.midRun?.[0]?.reminderText).toContain("memory-audit");
        // The baseline moved mid-run, so the user turn itself emits nothing.
        expect(result.turns[1]?.schedule).toBe("none");
    });

    it("replays a recorded fixture through the real session manager", () => {
        const file = path.resolve("test/fixtures/session/hosted-cut-before-checkpoint.jsonl");
        const session = SessionManager.open(file);

        const result = replay(session.getBranch(), session.getCwd());

        expect(result.userTurns).toBeGreaterThan(1);
        expect(result.turns[0]?.schedule).toBe("memory-read");
        expect(result.turns.every((turn) => typeof turn.state.cwd === "string")).toBe(true);
    });
});

describe("selectTurns and rendering", () => {
    function sampleResult() {
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first", 1));
        session.appendMessage(userEntry("second", 2));
        session.appendMessage(userEntry("third", 3));
        return replay(session.getBranch(), cwd);
    }

    it("selects one turn or a prefix", () => {
        const result = sampleResult();
        const base = parseArgs([]);

        expect(selectTurns(result, { ...base, turn: 2 }).map((turn) => turn.turn)).toEqual([2]);
        expect(selectTurns(result, { ...base, turns: 2 }).map((turn) => turn.turn)).toEqual([1, 2]);
    });

    it("renders a header, the schedule, and the state", () => {
        const result = sampleResult();
        const text = renderText(result, selectTurns(result, parseArgs([])), parseArgs([]));

        expect(text).toContain("user-turns=3");
        expect(text).toContain("model: not consulted");
        expect(text).toContain("===== turn 1");
        expect(text).toContain("schedule: memory-read");
        expect(text).toContain("reminder: memory-read");
        expect(text).toContain("<pi_coder_reminder>");
        expect(text).toContain("read them if so");
        expect(text).toContain('"request": "first"');
    });

    it("prints mid-run emissions above the turn's own schedule", () => {
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first", 1));
        session.appendMessage(assistantEntry("done", 2, { ...zeroUsage(), input: 200 }));
        session.appendMessage(userEntry("second", 3));
        const result = replay(session.getBranch(), cwd);
        const selected = selectTurns(result, parseArgs(["--turn", "2"]));

        const text = renderText(result, selected, parseArgs([]));

        expect(text).toContain("mid-run: memory-hygiene");
        expect(text).toContain("schedule: none");
    });

    it("renders compact lines and machine-readable JSON", () => {
        const result = sampleResult();
        const selected = selectTurns(result, parseArgs([]));
        const compact = renderText(result, selected, parseArgs(["--compact"]));

        expect(compact).toContain("schedule=memory-read");
        expect(compact).toContain("shows=");
        expect(compact).not.toContain('"request":');

        const parsed = JSON.parse(renderJson(result, selected)) as { turns: unknown[] };
        expect(parsed.turns).toHaveLength(3);
    });
});
