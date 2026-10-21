import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TranscriptCache } from "../../../src/commands/stats/cache";
import { scanSessions } from "../../../src/commands/stats/scan";
import { localIso } from "./fixtures";

type Json = Record<string, unknown>;

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-coder-stats-"));
    tempRoots.push(root);
    return root;
}

afterEach(async () => {
    const roots = tempRoots.splice(0);
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function writeSession(root: string, relative: string, lines: string[]): Promise<string> {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
    return file;
}

function sessionHeader(id: string, timestamp: string): Json {
    return { type: "session", version: 3, id, timestamp, cwd: "/tmp/project" };
}

function modelChange(timestamp: string, modelId = "test-model"): Json {
    return {
        type: "model_change",
        id: "m1",
        parentId: null,
        timestamp,
        provider: "test",
        modelId,
    };
}

function userMessage(timestamp: string): Json {
    return {
        type: "message",
        id: "u1",
        parentId: "m1",
        timestamp,
        message: { role: "user", content: "hello" },
    };
}

function assistantMessage(
    timestamp: string,
    options: { model?: string; toolCalls?: number; usage?: Json } = {},
): Json {
    const content: Json[] = [{ type: "text", text: "hi" }];
    for (let index = 0; index < (options.toolCalls ?? 0); index++) {
        content.push({ type: "toolCall", id: `t${index}`, name: "read", arguments: {} });
    }

    const message: Json = { role: "assistant", content };
    if (options.model) {
        message.model = options.model;
    }
    if (options.usage) {
        message.usage = options.usage;
    }

    return { type: "message", id: "a1", parentId: "u1", timestamp, message };
}

function toolResultMessage(timestamp: string, usage?: Json): Json {
    const message: Json = {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
    };
    if (usage) {
        message.usage = usage;
    }

    return { type: "message", id: "tr1", parentId: "a1", timestamp, message };
}

function encode(entries: Array<Json | string>): string[] {
    return entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
}

/** Set a precise mtime so cache-stamp assertions are deterministic. */
async function stampFile(file: string, timestamp: string): Promise<void> {
    const when = new Date(timestamp);
    await fs.utimes(file, when, when);
}

/** Same byte length for either model name and usage input digit, so only the stamp can differ. */
function cachedSessionLines(model: string, input: number): string[] {
    return encode([
        sessionHeader("cached-session", localIso(2026, 3, 10, 9, 0)),
        userMessage(localIso(2026, 3, 10, 9, 0, 1)),
        assistantMessage(localIso(2026, 3, 10, 9, 0, 2), {
            model,
            usage: { input, output: 1, cost: { total: 0 } },
        }),
    ]);
}

describe("scanSessions", () => {
    it("aggregates parent and child transcripts across all entry shapes", async () => {
        const parentRoot = await makeTempRoot();
        const childRoot = await makeTempRoot();

        const parentLines = encode([
            sessionHeader("parent-session", localIso(2026, 3, 10, 9, 0)),
            modelChange(localIso(2026, 3, 10, 9, 0)),
            userMessage(localIso(2026, 3, 10, 9, 0, 1)),
            assistantMessage(localIso(2026, 3, 10, 9, 0, 2), {
                model: "test-model",
                toolCalls: 1,
                usage: {
                    input: 100,
                    output: 50,
                    cacheRead: 10,
                    cacheWrite: 5,
                    cost: { total: 0.25 },
                },
            }),
            toolResultMessage(localIso(2026, 3, 10, 9, 0, 3), {
                input: 7,
                output: 3,
                cost: { total: 0.01 },
            }),
            {
                type: "usage",
                id: "us1",
                parentId: "tr1",
                timestamp: localIso(2026, 3, 11, 9, 0),
                kind: "cache_warm",
                provider: "test",
                model: "test-model",
                usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.02 } },
            },
            {
                type: "compaction",
                id: "c1",
                parentId: "us1",
                timestamp: localIso(2026, 3, 12, 9, 0),
                summary: "summary",
                firstKeptEntryId: "u1",
                usage: { input: 9, output: 1, cost: { total: 0.03 } },
            },
            "this is not json",
            { type: "unknown-entry", timestamp: localIso(2026, 3, 12, 9, 0) },
        ]);
        await writeSession(parentRoot, path.join("--tmp-project--", "parent.jsonl"), parentLines);

        const childLines = encode([
            sessionHeader("child-session", localIso(2026, 3, 12, 10, 0)),
            userMessage(localIso(2026, 3, 12, 10, 0, 1)),
            assistantMessage(localIso(2026, 3, 12, 10, 0, 2), {
                model: "child-model",
                usage: { input: 5, output: 5, cost: { total: 0.05 } },
            }),
        ]);
        await writeSession(
            childRoot,
            path.join("--tmp-project--", "run-abc", "child.jsonl"),
            childLines,
        );

        const result = await scanSessions({ parentRoot, childRoot });

        expect(result.totalFiles).toBe(2);
        expect(result.sessions.map((session) => session.source)).toEqual(["parent", "child"]);
        expect(result.sessions[0]).toMatchObject({
            sessionId: "parent-session",
            startDate: "2026-03-10",
            messages: 2,
            toolCalls: 1,
        });
        expect(result.sessions[1]).toMatchObject({
            sessionId: "child-session",
            startDate: "2026-03-12",
            messages: 2,
        });

        const byDate = new Map(result.dailyActivity.map((day) => [day.date, day]));
        expect(byDate.get("2026-03-10")).toMatchObject({
            messages: 2,
            sessions: 1,
            toolCalls: 1,
        });
        expect(byDate.get("2026-03-10")!.hours[9]).toBe(1);
        expect(byDate.get("2026-03-10")!.usageByModel["test-model"]).toEqual({
            input: 107,
            output: 53,
            cacheRead: 10,
            cacheWrite: 5,
            cost: 0.26,
        });
        expect(byDate.get("2026-03-11")!.messages).toBe(0);
        expect(byDate.get("2026-03-11")!.usageByModel["test-model"]).toEqual({
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            cost: 0.02,
        });
        expect(byDate.get("2026-03-12")!.usageBySource.parent).toEqual({
            input: 9,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.03,
        });
        expect(byDate.get("2026-03-12")!.usageBySource.child).toEqual({
            input: 5,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.05,
        });
    });

    it("stops when the signal is already aborted", async () => {
        const parentRoot = await makeTempRoot();
        await writeSession(
            parentRoot,
            path.join("--tmp-project--", "session.jsonl"),
            encode([
                sessionHeader("session-a", localIso(2026, 3, 10, 9, 0)),
                userMessage(localIso(2026, 3, 10, 9, 0, 1)),
            ]),
        );

        const controller = new AbortController();
        controller.abort();

        await expect(
            scanSessions({
                parentRoot,
                childRoot: path.join(parentRoot, "missing"),
                signal: controller.signal,
            }),
        ).rejects.toThrow();
    });

    it("ignores files without user or assistant messages", async () => {
        const parentRoot = await makeTempRoot();
        await writeSession(
            parentRoot,
            path.join("--tmp-project--", "empty.jsonl"),
            encode([sessionHeader("empty-session", localIso(2026, 3, 10, 9, 0))]),
        );

        const result = await scanSessions({
            parentRoot,
            childRoot: path.join(parentRoot, "missing"),
        });

        expect(result.totalFiles).toBe(1);
        expect(result.sessions).toEqual([]);
        expect(result.dailyActivity).toEqual([]);
    });

    it("reuses a cached parse while the file stamp is unchanged", async () => {
        const parentRoot = await makeTempRoot();
        const cache = new TranscriptCache();
        const options = { parentRoot, childRoot: path.join(parentRoot, "missing"), cache };

        const firstLines = cachedSessionLines("first-model", 1);
        const file = await writeSession(
            parentRoot,
            path.join("--tmp-project--", "cached.jsonl"),
            firstLines,
        );
        await stampFile(file, "2026-03-10T08:00:00.000Z");
        const first = await scanSessions(options);
        expect(cache.size).toBe(1);

        const secondLines = cachedSessionLines("other-model", 2);
        expect(Buffer.byteLength(secondLines.join("\n"))).toBe(
            Buffer.byteLength(firstLines.join("\n")),
        );
        await fs.writeFile(file, `${secondLines.join("\n")}\n`, "utf8");
        await stampFile(file, "2026-03-10T08:00:00.000Z");

        const cachedScan = await scanSessions(options);
        expect(cachedScan.dailyActivity).toEqual(first.dailyActivity);

        // A fresh cache proves the rewrite really would have changed the report.
        const fresh = await scanSessions({ ...options, cache: new TranscriptCache() });
        expect(fresh.dailyActivity).not.toEqual(first.dailyActivity);
    });

    it("re-reads a transcript when its stamp changes", async () => {
        const parentRoot = await makeTempRoot();
        const cache = new TranscriptCache();
        const options = { parentRoot, childRoot: path.join(parentRoot, "missing"), cache };

        const file = await writeSession(
            parentRoot,
            path.join("--tmp-project--", "stamped.jsonl"),
            cachedSessionLines("first-model", 1),
        );
        await stampFile(file, "2026-03-10T08:00:00.000Z");
        const first = await scanSessions(options);

        await fs.writeFile(file, `${cachedSessionLines("other-model", 2).join("\n")}\n`, "utf8");
        await stampFile(file, "2026-03-10T09:00:00.000Z");
        const second = await scanSessions(options);

        expect(second.dailyActivity).not.toEqual(first.dailyActivity);
        expect(Object.keys(second.dailyActivity[0]!.usageByModel)).toEqual(["other-model"]);
    });

    it("drops cached entries for transcripts that disappeared", async () => {
        const parentRoot = await makeTempRoot();
        const cache = new TranscriptCache();
        const options = { parentRoot, childRoot: path.join(parentRoot, "missing"), cache };

        const file = await writeSession(
            parentRoot,
            path.join("--tmp-project--", "gone.jsonl"),
            cachedSessionLines("first-model", 1),
        );
        await scanSessions(options);
        expect(cache.size).toBe(1);

        await fs.rm(file);
        const result = await scanSessions(options);
        expect(result.totalFiles).toBe(0);
        expect(cache.size).toBe(0);
    });
});
