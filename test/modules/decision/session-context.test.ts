import { afterEach, describe, expect, it } from "vitest";

import {
    decisionSessionContext,
    SUGGESTION_HISTORY_COUNT,
    decisionSimilarCommands,
    ITEM_CHARS,
    ITEM_MIN,
    planSessionWindow,
    renderSessionWindow,
    REQUEST_CHARS,
    TOOL_ITEMS_KEPT,
    type DecisionRecentMessage,
} from "../../../src/modules/decision";
import {
    assistantEntry,
    branch,
    cleanupBranches,
    sessionManager,
    textPart,
    toolCall,
    toolResultEntry,
    userEntry,
} from "../../helpers/session-branch";

/**
 * The session half of a decision, built from a real branch: the current user request stays its own field and
 * `recent` is the planned window over the turns before the command. Tool output never reaches the model, and
 * a tool call is an item whether it ran bash or edited a file.
 */

afterEach(cleanupBranches);

describe("decisionSessionContext", () => {
    it("carries the last user message as the request and keeps the turns before the command", () => {
        const entries = branch([
            userEntry("inspect the tree", 1),
            assistantEntry([{ type: "text", text: "Looking at the tree." }], 2),
            userEntry("now run the tests", 3),
        ]);

        expect(decisionSessionContext(entries)).toEqual({
            request: "now run the tests",
            recent: [
                { role: "user", text: "inspect the tree" },
                { role: "assistant", text: "Looking at the tree." },
            ],
            // The atoms carry the turn stamps the state transcript selects turns by.
            items: [
                { role: "user", text: "inspect the tree", turn: 1 },
                { role: "assistant", text: "Looking at the tree.", turn: 1 },
                { role: "user", text: "now run the tests", turn: 2 },
            ],
        });
    });

    it("interleaves a recorded state as its own annotation item", () => {
        const manager = sessionManager("/repo");
        manager.appendMessage(userEntry("gate the validation reminder", 1));
        manager.appendMessage(assistantEntry([textPart("Reading it.")], 2));
        manager.appendCustomEntry("test:state", { phase: "implementing" });
        manager.appendMessage(assistantEntry([toolCall("read", { path: "src/a.ts" }, "c1")], 3));

        const context = decisionSessionContext(manager.getBranch(), {
            stateMarker: (entry) =>
                entry.type === "custom" && entry.customType === "test:state"
                    ? `  ── state: ${String((entry.data as { phase?: string }).phase)} ──`
                    : undefined,
        });

        // The marker sits where the state was accepted, in the item stream the model is sent, and it is
        // rendered as the line itself rather than under a role prefix.
        expect(context.recent).toEqual([
            { role: "assistant", text: "Reading it." },
            { role: "state", text: "── state: implementing ──" },
            { role: "tool", text: "read(src/a.ts)" },
        ]);
        expect(renderSessionWindow(context.recent)).toContain("── state: implementing ──");
    });

    it("plans a shorter window when the caller asks for one", () => {
        const messages = [];
        for (let turn = 1; turn <= 4; turn += 1) {
            messages.push(userEntry(`ask ${String(turn)}`, turn * 2 - 1));
            messages.push(
                assistantEntry(
                    [{ type: "text", text: `Answer ${String(turn)}.`.repeat(8) }],
                    turn * 2,
                ),
            );
        }
        const entries = branch(messages);

        const full = decisionSessionContext(entries);
        const short = decisionSessionContext(entries, { windowChars: 200 });

        // The tier-1 window is the same plan inside a smaller budget: it keeps the guarantees and drops the
        // rest, which is where its ~0.27s against ~0.47s comes from.
        expect(short.request).toBe(full.request);
        expect(short.recent.length).toBeLessThan(full.recent.length);
        expect(short.omitted).toBeGreaterThan(full.omitted ?? 0);
        expect(short.recent.map((item) => item.role)).toContain("assistant");
    });

    it("has an empty recent when the branch holds only the request", () => {
        const entries = branch([userEntry("only request", 1)]);

        expect(decisionSessionContext(entries)).toEqual({
            request: "only request",
            recent: [],
            items: [{ role: "user", text: "only request", turn: 1 }],
        });
    });

    it("keeps the current turn's committed items, with the request dropped only from recent", () => {
        const entries = branch([
            userEntry("start", 1),
            assistantEntry(
                [
                    { type: "text", text: "working" },
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "bash",
                        arguments: { command: "git status" },
                    },
                ],
                2,
            ),
            toolResultEntry("clean", 3),
        ]);

        // This is the branch at gate time for a second command in the turn: the first assistant message and
        // its command are committed, the pending message is not.
        expect(decisionSessionContext(entries)).toEqual({
            request: "start",
            recent: [
                { role: "assistant", text: "working" },
                { role: "command", text: "git status" },
            ],
            items: [
                { role: "user", text: "start", turn: 1 },
                { role: "assistant", text: "working", turn: 1 },
                { role: "command", text: "git status", turn: 1 },
            ],
        });
    });

    it("stamps a turn per user prompt, folding a steer into the turn it joined", () => {
        const entries = branch([
            userEntry("start the work", 1),
            assistantEntry(
                [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
                2,
            ),
            toolResultEntry("a.ts", 3),
            // A steer: the user message arrived while the run was still going.
            userEntry("also do the other thing", 4),
            assistantEntry([textPart("on it")], 5),
            userEntry("now the next task", 6),
        ]);

        // The steer shares the first turn, so the transcript's turn selection keeps one turn's tools together
        // instead of reading the interjection as a turn with no work in it. The tool result contributes no item.
        expect(decisionSessionContext(entries).items.map((item) => item.turn)).toEqual([
            1, 1, 1, 1, 2,
        ]);
    });

    it("keeps every item the window budget covers, oldest first", () => {
        const entries = branch([
            userEntry("u1", 1),
            assistantEntry([{ type: "text", text: "a1" }], 2),
            userEntry("u2", 3),
            assistantEntry([{ type: "text", text: "a2" }], 4),
            userEntry("u3", 5),
            assistantEntry([{ type: "text", text: "a3" }], 6),
            userEntry("current", 7),
        ]);

        const { recent } = decisionSessionContext(entries);

        // Six short items fit the window, so nothing is dropped here; the drop behaviour the slice used to
        // have is pinned in the planner cases below.
        expect(recent).toEqual([
            { role: "user", text: "u1" },
            { role: "assistant", text: "a1" },
            { role: "user", text: "u2" },
            { role: "assistant", text: "a2" },
            { role: "user", text: "u3" },
            { role: "assistant", text: "a3" },
        ]);
    });

    it("records assistant prose and each bash call with the command role", () => {
        const entries = branch([
            userEntry("tidy up", 1),
            assistantEntry(
                [
                    { type: "text", text: "I'll inspect" },
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "bash",
                        arguments: { command: "git status" },
                    },
                    {
                        type: "toolCall",
                        id: "call-2",
                        name: "bash",
                        arguments: { command: "ls   -la" },
                    },
                ],
                2,
            ),
            userEntry("carry on", 3),
        ]);

        expect(decisionSessionContext(entries).recent).toEqual([
            { role: "user", text: "tidy up" },
            { role: "assistant", text: "I'll inspect" },
            { role: "command", text: "git status" },
            { role: "command", text: "ls -la" },
        ]);
    });

    it("records a non-bash tool call as a named item, and never a tool result", () => {
        const entries = branch([
            userEntry("run the tests", 1),
            assistantEntry(
                [
                    { type: "text", text: "Reading first." },
                    {
                        type: "toolCall",
                        id: "call-read",
                        name: "read",
                        arguments: { path: "README.md" },
                    },
                ],
                2,
            ),
            toolResultEntry("file contents", 3),
            userEntry("now stop", 4),
        ]);

        const { recent } = decisionSessionContext(entries);

        // The read is the fact the bash-only window dropped, so a turn that only read a file no longer
        // arrives as its own prose.
        expect(recent).toEqual([
            { role: "user", text: "run the tests" },
            { role: "assistant", text: "Reading first." },
            { role: "tool", text: "read(README.md)" },
        ]);
        expect(recent.some((item) => item.role === "command")).toBe(false);
    });

    it("shows the argument that identifies a call, not the one that describes it", () => {
        const entries = branch([
            userEntry("make the change", 1),
            assistantEntry(
                [
                    {
                        type: "toolCall",
                        id: "call-edit",
                        name: "edit",
                        arguments: {
                            path: "src/modules/reminders/index.ts",
                            edits: [{ oldText: "a".repeat(300), newText: "b".repeat(300) }],
                        },
                    },
                    {
                        type: "toolCall",
                        id: "call-ask",
                        name: "ask_user",
                        arguments: { title: "Which sandbox?", options: [{ label: "bwrap" }] },
                    },
                ],
                2,
            ),
            userEntry("go on", 3),
        ]);

        expect(decisionSessionContext(entries).recent).toEqual([
            { role: "user", text: "make the change" },
            { role: "tool", text: "edit(src/modules/reminders/index.ts)" },
            { role: "tool", text: "ask_user(Which sandbox?)" },
        ]);
    });

    it("clips a recent item at ITEM_CHARS after collapsing whitespace", () => {
        const entries = branch([
            assistantEntry([{ type: "text", text: `alpha\n\nbeta ${"x".repeat(400)}` }], 1),
            userEntry("continue", 2),
        ]);

        const [item] = decisionSessionContext(entries).recent;

        expect(item?.text).toHaveLength(ITEM_CHARS);
        expect(item?.text.startsWith("alpha beta ")).toBe(true);
        expect(item?.text.endsWith("…")).toBe(true);
        expect(item?.text).not.toContain("\n");
    });

    it("clips the request at REQUEST_CHARS", () => {
        const entries = branch([userEntry(`start ${"y".repeat(700)}`, 1)]);

        const { request } = decisionSessionContext(entries);

        expect(request).toHaveLength(REQUEST_CHARS);
        expect(request?.startsWith("start y")).toBe(true);
        expect(request?.endsWith("…")).toBe(true);
    });

    it("keeps only the earlier commands that name the same tool, newest last", () => {
        const entries = branch([
            userEntry("keep working", 1),
            assistantEntry(
                [
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "bash",
                        arguments: { command: "npx zorch run test/a.test.ts" },
                    },
                ],
                2,
            ),
            assistantEntry(
                [
                    {
                        type: "toolCall",
                        id: "call-2",
                        name: "bash",
                        arguments: { command: "npx vitest run test/b.test.ts" },
                    },
                ],
                3,
            ),
            assistantEntry(
                [
                    {
                        type: "toolCall",
                        id: "call-3",
                        name: "bash",
                        arguments: { command: "FOO=bar npx zorch run test/c.test.ts" },
                    },
                ],
                4,
            ),
        ]);

        expect(decisionSimilarCommands(entries, ["npx", "zorch", "run", "test/x.test.ts"])).toEqual(
            ["npx zorch run test/a.test.ts", "FOO=bar npx zorch run test/c.test.ts"],
        );
    });

    it("caps the same-tool window at SUGGESTION_HISTORY_COUNT", () => {
        const entries = branch(
            [2, 3, 4, 5].map((timestamp) =>
                assistantEntry(
                    [
                        {
                            type: "toolCall",
                            id: `call-${timestamp}`,
                            name: "bash",
                            arguments: { command: `npx zorch run test/${timestamp}.test.ts` },
                        },
                    ],
                    timestamp,
                ),
            ),
        );

        const commands = decisionSimilarCommands(entries, ["npx", "zorch"]);

        expect(commands).toHaveLength(SUGGESTION_HISTORY_COUNT);
        expect(commands).toEqual([
            "npx zorch run test/3.test.ts",
            "npx zorch run test/4.test.ts",
            "npx zorch run test/5.test.ts",
        ]);
    });

    it("produces no item or request for messages with empty text", () => {
        const entries = branch([
            userEntry("first", 1),
            assistantEntry([{ type: "text", text: "   \n  " }], 2),
            userEntry("   ", 3),
            userEntry("second", 4),
        ]);

        expect(decisionSessionContext(entries)).toEqual({
            request: "second",
            recent: [{ role: "user", text: "first" }],
            items: [
                { role: "user", text: "first", turn: 1 },
                { role: "user", text: "second", turn: 2 },
            ],
        });
    });
});

describe("planSessionWindow", () => {
    function item(role: string, text: string): DecisionRecentMessage {
        return { role, text };
    }

    it("keeps the newest tool items and drops the older ones however small the budget", () => {
        const items = [
            item("tool", "read(old.ts)"),
            item("tool", "edit(older.ts)"),
            item("tool", "write(newest.ts)"),
            item("user", "the request"),
            item("assistant", "the answer"),
        ];

        const window = planSessionWindow(items, 200);

        expect(window.items.map((kept) => kept.text)).toEqual([
            "edit(older.ts)",
            "write(newest.ts)",
            "the request",
            "the answer",
        ]);
        expect(window.omitted).toBe(1);
        expect(window.items.filter((kept) => kept.role === "tool")).toHaveLength(TOOL_ITEMS_KEPT);
    });

    it("charges a state marker its own length, not the shared item floor", () => {
        const marker: DecisionRecentMessage = { role: "state", text: "── state: verifying ──" };
        const head: DecisionRecentMessage[] = [
            { role: "user", text: "start" },
            { role: "assistant", text: "working" },
        ];
        const roles = (budget: number) =>
            planSessionWindow([...head, marker], budget).items.map((item) => item.role);

        // Two guaranteed items plus exactly the marker's own length: the marker is kept even though its
        // remainder is far below ITEM_MIN, which is what a marker floor of ITEM_MIN could not do.
        expect(marker.text.length).toBeLessThan(ITEM_MIN);
        expect(roles(ITEM_MIN * 2 + marker.text.length)).toEqual(["user", "assistant", "state"]);
        // One character less and it is the budget that drops it, not a role rule.
        expect(roles(ITEM_MIN * 2 + marker.text.length - 1)).toEqual(["user", "assistant"]);
    });

    it("drops the oldest items and counts them", () => {
        const items = [
            item("user", "old request"),
            item("assistant", "old answer"),
            item("user", "new request"),
            item("assistant", "new answer"),
        ];

        const window = planSessionWindow(items, 300);

        expect(window.items.map((kept) => kept.text)).toEqual(["new request", "new answer"]);
        expect(window.omitted).toBe(2);
    });

    it("gives the newest item the longest share and trims the oldest first", () => {
        const items = [
            item("assistant", "a".repeat(ITEM_CHARS)),
            item("user", "u".repeat(ITEM_CHARS)),
            item("assistant", "b".repeat(ITEM_CHARS)),
        ];

        const window = planSessionWindow(items, 500);

        // Five hundred characters over three items: the newest keeps its whole item, and what is left is
        // handed to the older ones in order, so the oldest is trimmed hardest rather than dropped.
        expect(window.items.map((kept) => kept.text.length)).toEqual([120, 140, 240]);
        expect(window.omitted).toBe(0);
    });

    it("caps one long item before the budget is measured", () => {
        const items = [item("command", "x".repeat(4000)), item("assistant", "done")];

        const window = planSessionWindow(items, 600);

        expect(window.items[0]?.text).toHaveLength(ITEM_CHARS);
        expect(window.items[1]?.text).toBe("done");
    });
});
