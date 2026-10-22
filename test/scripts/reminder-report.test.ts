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

/** An assistant message that calls a tool, the live mid-run steer's precondition. */
function assistantToolCallEntry(
    text: string,
    timestamp: number,
    usage: ReturnType<typeof zeroUsage> = zeroUsage(),
): AppendedMessage {
    const content: AssistantMessage["content"] = [
        { type: "text", text },
        {
            type: "toolCall",
            id: `call-${timestamp}`,
            name: "read",
            arguments: { path: "src/a.ts" },
        },
    ];

    return {
        role: "assistant",
        content,
        api: "test",
        provider: "test",
        model: "test",
        usage,
        stopReason: "toolUse",
        timestamp,
    };
}

/** A tool result entry, which a steered user message can be delivered after mid-run. */
function toolResultEntry(toolCallId: string, timestamp: number): AppendedMessage {
    return {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
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
    it("reads the file positionally and the flags", () => {
        expect(
            parseArgs([
                "session.jsonl",
                "--turn",
                "3",
                "--turns",
                "5",
                "--compact",
                "--recorded",
                "--json",
            ]),
        ).toEqual({
            file: "session.jsonl",
            turn: 3,
            turns: 5,
            compact: true,
            recorded: true,
            json: true,
            help: false,
        });
    });

    it("ignores a non-positive or non-numeric turn instead of failing", () => {
        expect(parseArgs(["session.jsonl", "--turn", "0"]).turn).toBeUndefined();
        expect(parseArgs(["session.jsonl", "--turns", "nope"]).turns).toBeUndefined();
        expect(parseArgs(["session.jsonl"]).recorded).toBe(false);
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
            // No mutating work in the branch, so memory-hygiene is gated out and the rotation starts at
            // delegation.
            "delegation",
        ]);
    });

    it("models mid-run threshold emissions as steers into the emitting turn", () => {
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first request", 1));
        session.appendMessage(assistantToolCallEntry("done", 2, { ...zeroUsage(), input: 200 }));
        session.appendMessage(toolResultEntry("call-2", 3));
        session.appendMessage(assistantEntry("finished", 4));
        session.appendMessage(userEntry("second request", 5));

        const result = replay(session.getBranch(), cwd);

        // The crossing happened inside the first run, so the emission sits with that turn.
        expect(result.turns[0]?.midRun).toMatchObject([{ schedule: "delegation" }]);
        expect(result.turns[0]?.midRun?.[0]?.reminderText).toContain("scout");
        // The baseline moved mid-run, so the next turn itself emits nothing.
        expect(result.turns[1]?.schedule).toBe("none");
    });

    it("keeps a steered message with the run it joined instead of making it a turn", () => {
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first request", 1));
        session.appendMessage(assistantToolCallEntry("working", 2));
        session.appendMessage(toolResultEntry("call-2", 3));
        session.appendMessage(userEntry("steered request", 4));
        session.appendMessage(assistantEntry("finished", 5));
        session.appendMessage(userEntry("next request", 6));

        const result = replay(session.getBranch(), cwd);

        // The steer never reaches a decision, so `next request` is still the second turn.
        expect(result.userTurns).toBe(2);
        expect(result.turns.map((turn) => turn.turn)).toEqual([1, 2]);
        expect(result.turns[0]?.steers).toMatchObject([{ request: "steered request" }]);
        expect(result.turns[0]?.state.session).toMatchObject({ user_turns: 1 });
        expect(result.turns[1]?.request).toBe("next request");
        expect(result.turns[1]?.state.session).toMatchObject({ user_turns: 2 });
    });

    it("replays a recorded fixture through the real session manager", () => {
        const file = path.resolve("test/fixtures/session/hosted-cut-before-checkpoint.jsonl");
        const session = SessionManager.open(file);

        const result = replay(session.getBranch(), session.getCwd());

        expect(result.userTurns).toBeGreaterThan(1);
        expect(result.turns[0]?.schedule).toBe("memory-read");
        expect(result.turns.every((turn) => typeof turn.state.cwd === "string")).toBe(true);
        // The fixture folds twice: once between turns 2 and 3, once with no turn after it.
        expect(result.compactions).toEqual([
            { entryId: "200c25a3", turn: 3 },
            { entryId: "8d61f3d7", turn: 4 },
        ]);
        // The first post-fold turn arms the compaction reminder instead of continuing the rotation.
        expect(result.turns[2]?.schedule).toBe("compaction");
    });
});

describe("compaction folds", () => {
    it("restarts the rotation and arms the compaction reminder at a fold", () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "1");
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first", 1));
        session.appendMessage(assistantEntry("one", 2, { ...zeroUsage(), input: 5000 }));
        session.appendMessage(userEntry("second", 3));
        session.appendMessage(assistantEntry("two", 4, { ...zeroUsage(), input: 6000 }));
        const foldId = session.appendCompaction("folded", null, 6000);
        session.appendMessage(userEntry("third", 5));
        session.appendMessage(assistantEntry("three", 6, { ...zeroUsage(), input: 1000 }));
        session.appendMessage(userEntry("fourth", 7));

        const result = replay(session.getBranch(), cwd);

        expect(result.turns.map((turn) => turn.schedule)).toEqual([
            "memory-read",
            "delegation",
            "compaction",
            "delegation",
        ]);
        expect(result.compactions).toEqual([{ entryId: foldId, turn: 3 }]);
        // The module's own counter restarts at the fold, even though the report numbers turns globally.
        expect(result.turns[2]?.state.session).toMatchObject({ user_turns: 1 });
        expect(result.turns[3]?.state.session).toMatchObject({ user_turns: 2 });
        // The fold resets the growth estimate, so no pre-fold context size leaks into its first turn.
        expect(result.turns[2]?.contextTokens).toBe(0);
        // `shown` was cleared, so the pre-fold emission no longer rides in the post-fold state.
        expect(result.turns[2]?.state.reminders_shown).toBeUndefined();
    });
});

describe("recorded data", () => {
    function recordedSession(cwd: string): SessionManager {
        const session = sessionAt(cwd);
        session.appendCustomEntry("pi-coder-reminder:debug", {
            trigger: "session",
            reminder: "memory-read",
            scheduler: { userTurns: 0, sessionArmed: true },
        });
        session.appendMessage(userEntry("first", 1));
        session.appendCustomMessageEntry(
            "pi-coder-reminder",
            "<pi_coder_reminder>\nAutomated reminder (not from the user) - ignore if not relevant.\nread them if so\n</pi_coder_reminder>",
            false,
            { id: "memory-read", turn: 1 },
        );
        session.appendMessage(assistantEntry("one", 2));
        session.appendCustomEntry("pi-coder-reminder:debug", {
            trigger: "turn",
            reminder: null,
            modelChoice: "none",
            scores: { delegation: 0.3 },
            options: ["delegation"],
            available: ["delegation"],
            labels: { phase: "exploring" },
            state: { cwd, session: { user_turns: 1 } },
        });
        session.appendMessage(userEntry("second", 3));

        return session;
    }

    it("attaches the recorded decision and delivered message to the turn", () => {
        const cwd = "/repo";
        const result = replay(recordedSession(cwd).getBranch(), cwd);

        expect(result.recordedNotes).toEqual([]);
        expect(result.turns[0]?.recorded.decision).toMatchObject({
            trigger: "session",
            reminder: "memory-read",
        });
        expect(result.turns[0]?.recorded.delivered).toMatchObject([
            { id: "memory-read", turn: 1, hasDetails: true },
        ]);
        // The decision entry precedes the user message it decides, so it lands on this turn.
        expect(result.turns[1]?.recorded.decision).toMatchObject({
            trigger: "turn",
            reminder: null,
            modelChoice: "none",
            scores: { delegation: 0.3 },
        });
        expect(result.turns[1]?.recorded.midRun).toEqual([]);
        expect(result.turns[1]?.recorded.decision?.state).toMatchObject({ cwd });
    });

    it("warns when the session has no recorded decisions or message details", () => {
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first", 1));
        session.appendCustomMessageEntry("pi-coder-reminder", "reminder without a stamp", false);

        const result = replay(session.getBranch(), cwd);

        expect(result.recordedNotes).toHaveLength(2);
        expect(result.recordedNotes[0]).toContain("no pi-coder-reminder:debug entries");
        expect(result.recordedNotes[1]).toContain("no id/turn details");
    });

    it("renders the recorded block only with --recorded", () => {
        const cwd = "/repo";
        const result = replay(recordedSession(cwd).getBranch(), cwd);
        const selected = selectTurns(result, parseArgs([]));

        const recorded = renderText(result, selected, parseArgs(["session.jsonl", "--recorded"]));
        expect(recorded).toContain("recorded decision: trigger=session pick=memory-read");
        expect(recorded).toContain("recorded decision: trigger=turn pick=none model=none");
        expect(recorded).toContain("recorded delivered: memory-read (turn 1)");
        expect(recorded).toContain("recorded state (signals the live module judged)");
        expect(recorded).toContain("replay:");

        const plain = renderText(result, selected, parseArgs(["session.jsonl"]));
        expect(plain).not.toContain("recorded decision");
        expect(plain).not.toContain("replay:");

        const compact = renderText(
            result,
            selected,
            parseArgs(["session.jsonl", "--compact", "--recorded"]),
        );
        expect(compact).toContain("recorded=none");
        expect(compact).toContain("delivered=memory-read");
    });

    it("flags a recorded decision whose module turn disagrees with the replay", () => {
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendCustomEntry("pi-coder-reminder:debug", {
            trigger: "session",
            reminder: "memory-read",
            scheduler: { userTurns: 0 },
        });
        session.appendMessage(userEntry("first", 1));
        session.appendMessage(assistantEntry("one", 2));
        session.appendCustomEntry("pi-coder-reminder:debug", {
            trigger: "turn",
            reminder: null,
            scheduler: { userTurns: 5 },
        });
        session.appendMessage(userEntry("second", 3));

        const result = replay(session.getBranch(), cwd);
        const text = renderText(
            result,
            selectTurns(result, parseArgs([])),
            parseArgs(["--recorded"]),
        );

        expect(text).toContain(
            "recorded turn mismatch: the session counted module turn 6, the replay 2",
        );
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

    it("prints mid-run emissions with the turn whose run emitted them", () => {
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first", 1));
        session.appendMessage(assistantToolCallEntry("done", 2, { ...zeroUsage(), input: 200 }));
        session.appendMessage(toolResultEntry("call-2", 3));
        session.appendMessage(assistantEntry("finished", 4));
        session.appendMessage(userEntry("second", 5));
        const result = replay(session.getBranch(), cwd);
        const selected = selectTurns(result, parseArgs(["--turn", "1"]));

        const text = renderText(result, selected, parseArgs([]));

        expect(text).toContain("mid-run: delegation");
        expect(text).toContain("schedule: memory-read");
    });

    it("renders compact lines and machine-readable JSON", () => {
        const result = sampleResult();
        const selected = selectTurns(result, parseArgs([]));
        const compact = renderText(result, selected, parseArgs(["--compact"]));

        expect(compact).toContain("schedule=memory-read");
        expect(compact).toContain("shows=");
        expect(compact).not.toContain('"request":');

        const parsed = JSON.parse(renderJson(result, selected)) as {
            turns: Record<string, unknown>[];
        };
        expect(parsed.turns).toHaveLength(3);
        // A turn with no recorded data keeps the report shape from before the mode existed.
        expect(parsed.turns[0]).not.toHaveProperty("recorded");
    });
});
