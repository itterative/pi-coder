import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
    ENABLE_WORKING_STATE_OVERLAY,
    applyWorkingStateOverlay,
    createAgentRunStateWriter,
} from "../../src/tools/agent/runs/persistence";
import { openAgentMetadataDatabase } from "../../src/tools/agent/storage/metadata";
import {
    insertAgentRunSnapshotInDatabase,
    listAgentRunSnapshotsInDatabase,
} from "../../src/tools/agent/storage/run-snapshots";
import {
    clearAgentRunWorkingStateInDatabase,
    readAgentRunWorkingStateInDatabase,
    upsertAgentRunWorkingStateInDatabase,
} from "../../src/tools/agent/storage/run-working-state";
import { partialPersistedRecord, partialWorkingState } from "../helpers/agent-doubles";

const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0))
        fs.rmSync(directory, { recursive: true, force: true });
});

async function openDatabase(label: string) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-agent-${label}-`));
    tempDirs.push(stateDir);
    return openAgentMetadataDatabase(path.join(stateDir, "workspaces"));
}

async function workingRowCount(
    database: Awaited<ReturnType<typeof openDatabase>>,
): Promise<number> {
    const row = (await database.get(`SELECT COUNT(*) AS rows FROM agent_run_working_state`)) as {
        rows: number;
    };
    return row.rows;
}

describe("delegated-agent working state", () => {
    it("keeps one working row per physical run, replaced in place", async () => {
        const database = await openDatabase("working-single-row");
        try {
            await upsertAgentRunWorkingStateInDatabase(
                database,
                partialWorkingState({ childSessionLeafId: "leaf-1", updatedAt: 100 }),
            );
            await upsertAgentRunWorkingStateInDatabase(
                database,
                partialWorkingState({
                    progress: { output: "second frame", recentActivity: ["read src/index.ts"] },
                    childSessionLeafId: "leaf-2",
                    updatedAt: 200,
                }),
            );

            expect(await workingRowCount(database)).toBe(1);
            expect(await readAgentRunWorkingStateInDatabase(database, "instance-1")).toMatchObject({
                childSessionLeafId: "leaf-2",
                updatedAt: 200,
            });

            await clearAgentRunWorkingStateInDatabase(database, "instance-1");
            expect(await workingRowCount(database)).toBe(0);
            expect(
                await readAgentRunWorkingStateInDatabase(database, "instance-1"),
            ).toBeUndefined();
        } finally {
            await database.close();
        }
    });

    /** The table's own constraint is the write-side guard, since the typed input cannot carry a bad status. */
    it("cannot store a checkpoint-boundary status past the storage guard", async () => {
        const database = await openDatabase("working-constraint");
        try {
            await expect(
                database.run(
                    `INSERT INTO agent_run_working_state (
                        run_instance_id, owner_session_id, run_id, status,
                        child_session_file, child_session_leaf_id, progress_json, updated_at
                    ) VALUES ('i', 'p', 'scout-1', 'completed', NULL, NULL, '{}', 1)`,
                ),
            ).rejects.toThrow(/CHECK constraint/i);
        } finally {
            await database.close();
        }
    });

    /**
     * A row written by another build is untrusted data. Only the readable corruptions are exercised: the
     * table's `CHECK` makes a bad status unreachable through it, so the reader's status re-check is
     * defense-in-depth against a foreign build rather than a path a test can pin.
     */
    it("ignores a working row whose progress cannot be read", async () => {
        const database = await openDatabase("working-corrupt");
        try {
            await database.run(
                `INSERT INTO agent_run_working_state (
                    run_instance_id, owner_session_id, run_id, status,
                    child_session_file, child_session_leaf_id, progress_json, updated_at
                ) VALUES ('instance-bad-json', 'p', 'scout-1', 'running', NULL, 'leaf', 'not json', 1)`,
            );
            expect(
                await readAgentRunWorkingStateInDatabase(database, "instance-bad-json"),
            ).toBeUndefined();
        } finally {
            await database.close();
        }
    });

    /**
     * Migration 17 must add the table to an existing database, not only to a fresh one: every developer
     * checkout has a v16 file on disk.
     */
    it("adds the table when upgrading an existing database", async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-working-upgrade-"));
        tempDirs.push(stateDir);
        const workspacesDir = path.join(stateDir, "workspaces");

        const created = await openAgentMetadataDatabase(workspacesDir);
        await created.exec(`DROP TABLE agent_run_working_state; PRAGMA user_version = 16;`);
        await created.close();

        const upgraded = await openAgentMetadataDatabase(workspacesDir);
        try {
            expect(await workingRowCount(upgraded)).toBe(0);
            expect(await upgraded.get(`PRAGMA user_version`)).toMatchObject({ user_version: 17 });
        } finally {
            await upgraded.close();
        }
    });

    /**
     * Step 2 ships the read side inert: nothing may write a working row until the writer learns to tell an
     * intermediate save from a checkpoint, and the overlay stays off until then.
     */
    it("writes no working row and stays disabled while saves are all checkpoints", async () => {
        const database = await openDatabase("working-inert");
        const writer = createAgentRunStateWriter(
            process.cwd(),
            database,
            (marker) => `marker-${marker.runInstanceId}`,
        );
        try {
            expect((await writer.save(partialPersistedRecord())).ok).toBe(true);
            expect(await workingRowCount(database)).toBe(0);
        } finally {
            await writer.close();
        }
        expect(ENABLE_WORKING_STATE_OVERLAY).toBe(false);
    });
});

describe("working-state overlay", () => {
    const openLeaves = new Set(["leaf-missing"]);
    const context = {
        leaseIsHeld: false,
        leafExists: (leafId: string) => !openLeaves.has(leafId),
    };

    it("moves an interrupted run to its newer working leaf", () => {
        const record = partialPersistedRecord({ status: "running", updatedAt: 20 });
        const overlaid = applyWorkingStateOverlay(
            record,
            partialWorkingState({ updatedAt: 30 }),
            context,
        );

        expect(overlaid).not.toBe(record);
        expect(overlaid.childSessionLeafId).toBe("leaf-working");
        expect(overlaid.updatedAt).toBe(20);
        expect(overlaid.status).toBe("running");
    });

    it("carries the working progress and drops the volatile TODO", () => {
        const overlaid = applyWorkingStateOverlay(
            partialPersistedRecord(),
            partialWorkingState({
                progress: {
                    output: "x".repeat(40_000),
                    recentActivity: Array.from({ length: 20 }, (_, index) => `step ${index}`),
                    todo: { completed: 1, total: 3 },
                },
            }),
            context,
        );

        expect(overlaid.progress.output).toHaveLength(32_000);
        expect(overlaid.progress.recentActivity).toHaveLength(8);
        expect(overlaid.progress.recentActivity[0]).toBe("step 12");
        expect(overlaid.progress.todo).toBeUndefined();
    });

    it("leaves a parked or terminal checkpoint exactly as its marker describes it", () => {
        for (const status of [
            "waiting_for_parent",
            "interrupted",
            "completed",
            "failed",
            "canceled",
            "removed",
        ] as const) {
            const record = partialPersistedRecord({ status });
            expect(
                applyWorkingStateOverlay(record, partialWorkingState(), context),
                `status ${status}`,
            ).toBe(record);
        }
    });

    /** Sibling-branch history must restore the leaf that branch actually reached. */
    it("refuses a run that is read-only on this branch", () => {
        const record = partialPersistedRecord({
            resumable: false,
            readOnlyReason: "continued on another branch",
        });
        expect(applyWorkingStateOverlay(record, partialWorkingState(), context)).toBe(record);
    });

    it("refuses while another process still holds the continuation lease", () => {
        const record = partialPersistedRecord();
        expect(
            applyWorkingStateOverlay(record, partialWorkingState(), {
                leaseIsHeld: true,
                leafExists: () => true,
            }),
        ).toBe(record);
    });

    it("refuses a working row that is not newer than the checkpoint", () => {
        const record = partialPersistedRecord({ updatedAt: 50 });
        expect(
            applyWorkingStateOverlay(record, partialWorkingState({ updatedAt: 50 }), context),
        ).toBe(record);
        expect(
            applyWorkingStateOverlay(record, partialWorkingState({ updatedAt: 49 }), context),
        ).toBe(record);
    });

    /** A row for a different run, parent, or transcript can never move this one. */
    it("refuses any identity mismatch", () => {
        const record = partialPersistedRecord();
        for (const working of [
            partialWorkingState({ runInstanceId: "instance-other" }),
            partialWorkingState({ runId: "scout-2" }),
            partialWorkingState({ ownerSessionId: "parent-2" }),
            partialWorkingState({ childSessionFile: "/agent-sessions/parent-1/other-child.jsonl" }),
            partialWorkingState({ childSessionFile: undefined }),
        ]) {
            expect(applyWorkingStateOverlay(record, working, context)).toBe(record);
        }
    });

    it("refuses a leaf that the child transcript does not hold", () => {
        const record = partialPersistedRecord();
        expect(
            applyWorkingStateOverlay(
                record,
                partialWorkingState({ childSessionLeafId: "leaf-missing" }),
                context,
            ),
        ).toBe(record);
        expect(
            applyWorkingStateOverlay(
                record,
                partialWorkingState({ childSessionLeafId: "" }),
                context,
            ),
        ).toBe(record);
        expect(
            applyWorkingStateOverlay(
                record,
                partialWorkingState({ childSessionLeafId: null }),
                context,
            ),
        ).toBe(record);
    });

    it("keeps a checkpoint with no child transcript untouched", () => {
        const record = partialPersistedRecord({
            childSessionFile: undefined,
            childSessionLeafId: undefined,
        });
        expect(
            applyWorkingStateOverlay(
                record,
                partialWorkingState({ childSessionFile: undefined }),
                context,
            ),
        ).toBe(record);
    });

    it("does nothing at all without a working row", () => {
        const record = partialPersistedRecord();
        expect(applyWorkingStateOverlay(record, undefined, context)).toBe(record);
    });
});

describe("chunked snapshot fetch", () => {
    /**
     * The id list is one entry per parent marker, which a long session cannot bound, so the fetch must
     * survive more placeholders than a statement may carry while still reporting the ids it did not find.
     */
    it("reads snapshots across chunk boundaries and tolerates missing ids", async () => {
        const database = await openDatabase("snapshot-chunks");
        try {
            const found: string[] = [];
            for (const runId of ["scout-1", "scout-2", "scout-3"]) {
                const snapshot = await insertAgentRunSnapshotInDatabase(
                    database,
                    partialPersistedRecord({ runId, runInstanceId: `instance-${runId}` }),
                );
                found.push(snapshot.snapshotId);
            }

            const missing = Array.from({ length: 600 }, (_value, index) => `missing-${index}`);
            const snapshots = await listAgentRunSnapshotsInDatabase(database, [
                ...found,
                ...missing,
            ]);

            expect(snapshots).toHaveLength(found.length);
            expect(snapshots.map((snapshot) => snapshot.runId).sort()).toEqual([
                "scout-1",
                "scout-2",
                "scout-3",
            ]);
            expect(await listAgentRunSnapshotsInDatabase(database, [])).toEqual([]);
            expect(
                await listAgentRunSnapshotsInDatabase(database, [found[0], found[0], found[0]]),
            ).toHaveLength(1);
        } finally {
            await database.close();
        }
    });
});
