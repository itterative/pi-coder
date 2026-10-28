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
        expect(result.turns[0]?.state).toEqual({ conversation: "User: first request" });
        expect(result.turns[0]?.signals).toMatchObject({
            cwd,
            session: { user_turns: 1, context_tokens: 0 },
        });
        // Five turns between rotation triggers, and this is only the second turn.
        expect(result.turns[1]).toMatchObject({ turn: 2, schedule: "none" });
        expect(result.turns[1]?.reminderText).toBeUndefined();
        // The tier-2 state is the conversation itself: the branch's items and this turn's request, rendered as
        // one string. The previous user message is an item of that conversation rather than a dropped edge.
        expect(result.turns[1]?.state).toEqual({
            conversation: "User: first request\nAssistant: working\nUser: second request",
        });
    });

    it("respects the environment's cadence", () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "1");
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first request", 1));
        // A read, and a text-only assistant message closing the run: the state of the next turn is
        // `exploring`, which offers delegation.
        session.appendMessage(assistantToolCallEntry("reading", 2));
        session.appendMessage(toolResultEntry("call-2", 3));
        session.appendMessage(assistantEntry("done", 4));
        session.appendMessage(userEntry("second request", 5));

        const result = replay(session.getBranch(), cwd);

        expect(result.turns.map((turn) => turn.schedule)).toEqual([
            "memory-read",
            // The turn has only read, so the state is `exploring`: memory-hygiene is not in that state's pool
            // and the rotation starts at delegation.
            "delegation",
        ]);
    });

    it("models mid-run threshold emissions as steers into the emitting turn", () => {
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first request", 1));
        // A read earlier in the turn, so the mid-run state is `exploring` and offers delegation: the mid-run
        // check reads the committed prefix, never the streaming message that carries the read itself.
        session.appendMessage(assistantToolCallEntry("reading", 2, { ...zeroUsage(), input: 100 }));
        session.appendMessage(toolResultEntry("call-2", 3));
        session.appendMessage(assistantToolCallEntry("done", 4, { ...zeroUsage(), input: 250 }));
        session.appendMessage(toolResultEntry("call-4", 5));
        session.appendMessage(assistantEntry("finished", 6));
        session.appendMessage(userEntry("second request", 7));

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
        expect(result.turns[0]?.signals.session).toMatchObject({ user_turns: 1 });
        expect(result.turns[1]?.request).toBe("next request");
        expect(result.turns[1]?.signals.session).toMatchObject({ user_turns: 2 });
    });

    it("replays a recorded fixture through the real session manager", () => {
        const file = path.resolve("test/fixtures/session/hosted-cut-before-checkpoint.jsonl");
        const session = SessionManager.open(file);

        const result = replay(session.getBranch(), session.getCwd());

        expect(result.userTurns).toBeGreaterThan(1);
        expect(result.turns[0]?.schedule).toBe("memory-read");
        expect(result.turns.every((turn) => typeof turn.signals.cwd === "string")).toBe(true);
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
        // A read, so the state offers delegation instead of reading `discussing`, whose pool is the list only.
        session.appendMessage(
            assistantToolCallEntry("reading", 2, { ...zeroUsage(), input: 5000 }),
        );
        session.appendMessage(toolResultEntry("call-2", 2.5));
        session.appendMessage(assistantEntry("one", 2.75));
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
        expect(result.turns[2]?.signals.session).toMatchObject({ user_turns: 1 });
        expect(result.turns[3]?.signals.session).toMatchObject({ user_turns: 2 });
        // The fold resets the growth estimate, so no pre-fold context size leaks into its first turn.
        expect(result.turns[2]?.contextTokens).toBe(0);
        // `shown` was cleared, so the pre-fold emission no longer rides in the post-fold signals.
        expect(result.turns[2]?.signals.reminders_shown).toBeUndefined();
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
            // Tier 1's own half: the phase it named, its confidence, and what the ask cost.
            statePhase: "implementing",
            stateConfidence: 0.42,
            stateLatencyMs: 288,
        });
        session.appendMessage(userEntry("second", 3));
        // A checkpoint is judged after a tool-using response, so it is recorded during turn 2's run.
        session.appendMessage(assistantEntry("two", 4));
        session.appendCustomEntry("pi-coder-reminder:debug", {
            trigger: "checkpoint",
            reminder: null,
            labels: { phase: "implementing" },
            stateConfidence: 0.4,
            escalated: true,
            state: { cwd, session: { user_turns: 2 } },
        });
        session.appendMessage(userEntry("third", 5));

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

    it("prints tier 1's own answer, confidence, and latency", () => {
        const cwd = "/repo";
        const result = replay(recordedSession(cwd).getBranch(), cwd);
        const text = renderText(
            result,
            selectTurns(result, parseArgs([])),
            parseArgs(["--recorded"]),
        );

        // The raw answer is printed beside the accepted labels the same line carries, so a held phase can be
        // told from a confirmed one without reading the JSON.
        expect(text).toContain("state-conf=0.42 state-phase=implementing state-latency=288ms");
    });

    it("records a checkpoint under the run it was judged in, not as the next prompt's decision", () => {
        const cwd = "/repo";
        const result = replay(recordedSession(cwd).getBranch(), cwd);

        expect(result.turns[1]?.recorded.checkpoints).toMatchObject([
            {
                trigger: "checkpoint",
                reminder: null,
                labels: { phase: "implementing" },
                stateConfidence: 0.4,
                escalated: true,
            },
        ]);
        // A checkpoint decides no reminder, so it must not become the turn decision of the prompt after it.
        expect(result.turns[2]?.recorded.decision).toBeUndefined();
    });

    /**
     * A turn whose judgement was deferred: the entry is recorded *after* the prompt it was made for, because
     * the boundary hands the consult to the background instead of holding the user's message behind it.
     */
    function deferredTurnSession(cwd: string, recordedTurn: number): SessionManager {
        const session = sessionAt(cwd);
        session.appendCustomEntry("pi-coder-reminder:debug", {
            trigger: "session",
            reminder: "memory-read",
            scheduler: { userTurns: 0, sessionArmed: true },
        });
        session.appendMessage(userEntry("first", 1));
        session.appendMessage(assistantEntry("one", 2));
        // The rotation turn's prompt goes out first; the judgement lands once the consult answers, inside that
        // turn's run.
        session.appendMessage(userEntry("second", 3));
        session.appendCustomEntry("pi-coder-reminder:debug", {
            trigger: "turn",
            deferred: true,
            reminder: "delegation",
            modelChoice: "delegation",
            scheduler: { userTurns: recordedTurn },
        });

        return session;
    }

    it("attributes a deferred turn decision to the prompt it was judged for", () => {
        const cwd = "/repo";
        const result = replay(deferredTurnSession(cwd, 2).getBranch(), cwd);

        // The deferred entry belongs to the turn whose prompt preceded it, and its own count is that turn
        // rather than the one before it, so the replay agrees with the session.
        expect(result.turns[1]?.recorded.decision).toMatchObject({
            trigger: "turn",
            deferred: true,
            reminder: "delegation",
        });
        expect(result.recordedNotes).toEqual([]);

        const text = renderText(
            result,
            selectTurns(result, parseArgs([])),
            parseArgs(["--recorded"]),
        );
        // The flag is rendered too: a deferred turn decided after the prompt, which the trigger alone cannot say.
        expect(text).toContain(
            "recorded decision: trigger=turn pick=delegation model=delegation deferred",
        );
    });

    it("reads a deferred decision's turn off its own snapshot", () => {
        const cwd = "/repo";
        const result = replay(deferredTurnSession(cwd, 5).getBranch(), cwd);
        const text = renderText(
            result,
            selectTurns(result, parseArgs([])),
            parseArgs(["--recorded"]),
        );

        // No `+ 1`: a deferred entry is stamped with the turn it judged, unlike one recorded before the prompt.
        expect(text).toContain(
            "recorded turn mismatch: the session counted module turn 5, the replay 2",
        );
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

    it("renders the recorded window beside the replay's own", () => {
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendCustomEntry("pi-coder-reminder:debug", {
            trigger: "turn",
            reminder: null,
            consult: { status: "answered", latencyMs: 12 },
            state: { cwd, session: { user_turns: 1 } },
            window: {
                items: [
                    { role: "user", text: "first" },
                    { role: "command", text: "rg -n step src" },
                ],
                omitted: 3,
            },
        });
        session.appendMessage(userEntry("first", 1));
        session.appendMessage(assistantToolCallEntry("reading", 2));
        session.appendMessage(toolResultEntry("call-2", 3));
        // A plain assistant answer closes the run, so the next prompt starts a turn instead of steering.
        session.appendMessage(assistantEntry("done", 4));
        session.appendMessage(userEntry("second", 5));

        const result = replay(session.getBranch(), cwd);
        const text = renderText(
            result,
            selectTurns(result, parseArgs([])),
            parseArgs(["session.jsonl", "--recorded"]),
        );

        expect(text).toContain("recorded window (2 items, 3 dropped):");
        expect(text).toContain("User: first");
        expect(text).toContain("Tool: bash(rg -n step src)");
        // The replay renders its own window from the branch prefix plus the turn's request, so the two read as
        // transcripts and a difference between what was sent and what would be sent now is visible line by line.
        expect(text).toContain("window (5 items, 0 dropped):");
        expect(text).toContain("Assistant: reading");
        expect(text).toContain("Tool: read(src/a.ts)");
        expect(text).toContain("User: second");
    });

    it("says when a recorded consult kept no window", () => {
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendCustomEntry("pi-coder-reminder:debug", {
            trigger: "turn",
            reminder: null,
            consult: { status: "answered", latencyMs: 12 },
            state: { cwd, session: { user_turns: 1 } },
        });
        session.appendMessage(userEntry("first", 1));
        session.appendMessage(assistantEntry("one", 2));
        // A consult the config disabled never built a window, so it is not an old record.
        session.appendCustomEntry("pi-coder-reminder:debug", {
            trigger: "turn",
            reminder: null,
            consult: { status: "disabled", latencyMs: 0 },
            state: { cwd, session: { user_turns: 2 } },
        });
        session.appendMessage(userEntry("second", 3));

        const result = replay(session.getBranch(), cwd);
        const text = renderText(
            result,
            selectTurns(result, parseArgs([])),
            parseArgs(["--recorded"]),
        );

        expect(text.match(/predates the window record/gu)).toHaveLength(1);
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
        expect(text).toContain('request: "first"');
        // The window is rendered as a transcript, and the tier-2 state *is* that transcript, so the print says
        // so rather than repeating the text; the signals are what the pool was scoped by.
        expect(text).toContain("window (1 item, 0 dropped):\nUser: first");
        expect(text).toContain("state: {conversation} - the 11 chars of window above");
        expect(text).toContain("signals:");
    });

    it("says when there is no conversation to send", () => {
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("", 1));

        const result = replay(session.getBranch(), cwd);
        const text = renderText(result, selectTurns(result, parseArgs([])), parseArgs([]));

        // A message with no text carries no request item, so the state is empty rather than an empty string:
        // the live consult sends `{}` for the same case rather than `conversation: ""`.
        expect(result.turns[0]?.state).toEqual({});
        expect(text).toContain("state: {} - no window, so nothing to send");
    });

    it("prints mid-run emissions with the turn whose run emitted them", () => {
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const cwd = "/repo";
        const session = sessionAt(cwd);
        session.appendMessage(userEntry("first", 1));
        session.appendMessage(assistantToolCallEntry("reading", 2, { ...zeroUsage(), input: 100 }));
        session.appendMessage(toolResultEntry("call-2", 3));
        session.appendMessage(assistantToolCallEntry("done", 4, { ...zeroUsage(), input: 250 }));
        session.appendMessage(toolResultEntry("call-4", 5));
        session.appendMessage(assistantEntry("finished", 6));
        session.appendMessage(userEntry("second", 7));
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
        // The conversation carries the turn's own request, so even the first turn has a window of one item.
        expect(compact).toContain("window=1");
        expect(compact).not.toContain('"request":');

        const parsed = JSON.parse(renderJson(result, selected)) as {
            turns: Record<string, unknown>[];
        };
        expect(parsed.turns).toHaveLength(3);
        // A turn with no recorded data keeps the report shape from before the mode existed.
        expect(parsed.turns[0]).not.toHaveProperty("recorded");
        // The window rides in the machine-readable turns too, drop count included, so `--json` reports the
        // same items the conversation shows without re-reading the branch.
        expect(parsed.turns[2]?.window).toEqual({
            items: [
                { role: "user", text: "first" },
                { role: "user", text: "second" },
                { role: "user", text: "third" },
            ],
            omitted: 0,
        });
    });
});
