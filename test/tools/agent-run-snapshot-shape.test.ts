import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
    BUILTIN_SCOUT,
    fingerprintAgentDefinition,
} from "../../src/tools/agent/definitions/discovery";
import { validateAgentRunSnapshot } from "../../src/tools/agent/runs/persistence";
import type { PersistedAgentRun } from "../../src/tools/agent/contracts/runs";
import type { AgentRunSnapshotRow } from "../../src/tools/agent/storage/run-snapshots";
import type { AgentRunSnapshotMarker } from "../../src/tools/agent/storage/run-markers";

const OWNER = "session-1";
const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0))
        fs.rmSync(directory, { recursive: true, force: true });
});

function childDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-snapshot-"));
    tempDirs.push(dir);
    return dir;
}

function payload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        version: 1,
        ownerSessionId: OWNER,
        runInstanceId: "leaf-1",
        runId: "scout-1",
        title: "Inspect the repository",
        agent: "scout",
        agentSource: "builtin",
        definitionFingerprint: fingerprintAgentDefinition(BUILTIN_SCOUT),
        task: "Find the entrypoint",
        status: "waiting_for_parent",
        background: true,
        mutating: false,
        startedAt: 10,
        updatedAt: 20,
        progress: { output: "partial", recentActivity: ["read README.md"] },
        ...overrides,
    };
}

function row(
    dir: string,
    payloadValue: Record<string, unknown>,
    overrides: Partial<AgentRunSnapshotRow> = {},
): AgentRunSnapshotRow {
    return {
        snapshotId: "snap-1",
        runInstanceId: String(payloadValue.runInstanceId),
        ownerSessionId: OWNER,
        runId: String(payloadValue.runId),
        payloadVersion: 2,
        status: payloadValue.status as AgentRunSnapshotRow["status"],
        childSessionLeafId: (payloadValue.childSessionLeafId ?? null) as string | null,
        updatedAt: Number(payloadValue.updatedAt),
        payload: payloadValue,
        createdSequence: 1,
        ...overrides,
    };
}

function marker(overrides: Partial<AgentRunSnapshotMarker> = {}): AgentRunSnapshotMarker {
    return {
        version: 2,
        snapshotId: "snap-1",
        runInstanceId: "leaf-1",
        runId: "scout-1",
        ...overrides,
    };
}

function validate(
    payloadValue: Record<string, unknown>,
    rowOverrides: Partial<AgentRunSnapshotRow> = {},
    markerOverrides: Partial<AgentRunSnapshotMarker> = {},
    dir = childDir(),
): PersistedAgentRun | undefined {
    return validateAgentRunSnapshot(
        row(dir, payloadValue, rowOverrides),
        marker(markerOverrides),
        OWNER,
        dir,
    );
}

describe("delegated-agent snapshot validation", () => {
    it("accepts a matching marker, row, and payload", () => {
        const validated = validate(payload());

        expect(validated).toBeDefined();
        expect(validated?.runId).toBe("scout-1");
        expect(validated?.runInstanceId).toBe("leaf-1");
        // Usage is reconstructed even when the payload omits it, so later accounting never sees a gap.
        expect(validated?.usageCheckpoint).toBeDefined();
        expect(validated?.usageSnapshot).toBeDefined();
    });

    it.each([
        ["payload version", { row: { payloadVersion: 1 } }],
        ["owner session", { row: { ownerSessionId: "other" } }],
        ["status column", { row: { status: "completed" } }],
        ["updatedAt column", { row: { updatedAt: 21 } }],
        [
            "child session file the payload does not name",
            { row: { childSessionFile: "/tmp/child.jsonl" } },
        ],
        ["child session leaf id column", { row: { childSessionLeafId: "leaf-9" } }],
        [
            "child session leaf id in the payload",
            { row: { childSessionLeafId: null }, payload: { childSessionLeafId: "leaf-9" } },
        ],
    ])(
        "rejects a snapshot row that disagrees with its marker or payload: %s",
        (_name, testCase) => {
            expect(validate(payload(testCase.payload), testCase.row)).toBeUndefined();
        },
    );

    it("rejects a payload that carries no run instance id, because a marker must name one", () => {
        expect(validate(payload({ runInstanceId: undefined }))).toBeUndefined();
    });

    it("rejects a marker that names a different run instance or run", () => {
        expect(validate(payload(), {}, { runInstanceId: "leaf-2" })).toBeUndefined();
        expect(validate(payload(), {}, { runId: "scout-2" })).toBeUndefined();
    });

    it.each([
        ["record version", { version: 2 }],
        ["owner session in the payload", { ownerSessionId: "other" }],
        ["run id shape", { runId: "Scout-1" }],
        ["run id that does not start with the agent name", { runId: "worker-1" }],
        ["definition fingerprint", { definitionFingerprint: "not-a-hash" }],
        ["status that is not restorable", { status: "waiting_for_user" }],
        ["non-finite timestamps", { startedAt: Number.NaN }],
        ["negative timestamps", { updatedAt: -1 }],
        ["missing background flag", { background: "true" }],
    ])("rejects a payload record that fails shape validation: %s", (_name, field) => {
        expect(validate(payload(field))).toBeUndefined();
    });

    it("restores defaults instead of failing for absent descriptive fields", () => {
        const validated = validate(
            payload({
                title: undefined,
                task: undefined,
                agentFilePath: undefined,
                workspaceId: undefined,
                progress: "not-an-object",
                terminalStatus: "bogus",
                resumable: "yes",
                setupFailed: "yes",
                readOnlyReason: undefined,
            }),
        );

        expect(validated?.title).toBeUndefined();
        expect(validated?.task).toBe("Restored delegated task");
        expect(validated?.progress).toEqual({ output: "", recentActivity: [] });
        expect(validated?.terminalStatus).toBeUndefined();
        expect(validated?.resumable).toBeUndefined();
        expect(validated?.setupFailed).toBeUndefined();
    });

    it("bounds progress activity to the most recent entries and caps their length", () => {
        const activity = Array.from(
            { length: 12 },
            (_value, index) => `${index}${"x".repeat(600)}`,
        );
        activity.push(42 as unknown as string);

        const validated = validate(
            payload({ progress: { recentActivity: activity, phase: "p".repeat(200) } }),
        );

        expect(validated?.progress.recentActivity).toHaveLength(8);
        expect(validated?.progress.recentActivity[0]?.length).toBe(500);
        expect(validated?.progress.recentActivity[7]?.startsWith("11")).toBe(true);
        expect(validated?.progress.phase).toBe("p".repeat(120));
    });

    it.each([
        ["a fraction", 1.5],
        ["a negative count", -1],
        ["a string", "3"],
    ])("drops %s as the failed-tool count but keeps the rest of the progress", (_name, value) => {
        const validated = validate(
            payload({
                progress: { output: "out", recentActivity: [], failedToolCalls: value },
            }),
        );

        expect(validated?.progress.output).toBe("out");
        expect(validated?.progress.failedToolCalls).toBeUndefined();
    });

    it("keeps a mutation report only as a bounded, defaulted shape", () => {
        const validated = validate(
            payload({
                mutationReport: {
                    changedFiles: ["a.ts", 7, "b".repeat(5000)],
                    readFiles: [],
                },
            }),
        );

        expect(validated?.mutationReport?.changedFiles).toEqual(["a.ts", "b".repeat(4096)]);
        expect(validated?.mutationReport?.readFiles).toBeUndefined();
        expect(validated?.mutationReport?.bashApproved).toBe(false);
        expect(validated?.mutationReport?.interrupted).toBe(false);
    });

    it("keeps an explicit null leaf id and an existing confined child session file", () => {
        const dir = childDir();
        const childFile = path.join(dir, "child.jsonl");
        fs.writeFileSync(childFile, "{}");

        const validated = validate(
            payload({ childSessionFile: childFile, childSessionLeafId: null }),
            { childSessionFile: childFile },
            {},
            dir,
        );

        expect(validated?.childSessionLeafId).toBeNull();
        expect(validated?.childSessionFile).toBe(fs.realpathSync(childFile));
    });

    it("refuses a child session file that is not a confined regular file", () => {
        const dir = childDir();
        const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.jsonl`);
        fs.writeFileSync(outside, "{}");
        const linked = path.join(dir, "link.jsonl");
        fs.symlinkSync(outside, linked);
        const missing = path.join(dir, "missing.jsonl");

        for (const candidate of [outside, linked, missing]) {
            // The row carries no child session file, so only the payload view is under test.
            const validated = validate(payload({ childSessionFile: candidate }), {}, {}, dir);

            expect(validated?.childSessionFile).toBeUndefined();
            expect(validated).toBeDefined();
        }

        fs.rmSync(outside, { force: true });
    });

    it("marks a record resumed on another branch only through its persisted fields", () => {
        const validated = validate(
            payload({
                resumable: false,
                readOnlyReason: `continued on another branch${"!".repeat(600)}`,
            }),
        );

        expect(validated?.resumable).toBe(false);
        expect(validated?.readOnlyReason?.length).toBe(500);
        expect(validated?.readOnlyReason?.startsWith("continued on another branch")).toBe(true);
    });
});
