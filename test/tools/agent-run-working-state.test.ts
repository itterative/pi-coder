import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
    AgentDroppedProgressWrite,
    AgentRunCheckpointIntent,
    ChildAgentHandle,
} from "../../src/tools/agent/contracts/runs";
import { BUILTIN_SCOUT } from "../../src/tools/agent/definitions/discovery";
import {
    ENABLE_WORKING_STATE_OVERLAY,
    applyWorkingStateOverlay,
    createAgentRunStateWriter,
} from "../../src/tools/agent/runs/persistence";
import { AgentRunManager, ZERO_USAGE } from "../../src/tools/agent/runs/manager";
import { openAgentMetadataDatabase } from "../../src/tools/agent/storage/metadata";
import {
    insertAgentRunSnapshotInDatabase,
    listAgentRunSnapshotsInDatabase,
    listRunInstanceIdsWithSnapshotsInDatabase,
} from "../../src/tools/agent/storage/run-snapshots";
import {
    clearAgentRunWorkingStateInDatabase,
    readAgentRunWorkingStateInDatabase,
    upsertAgentRunWorkingStateInDatabase,
} from "../../src/tools/agent/storage/run-working-state";
import {
    partialPersistence,
    partialPersistedRecord,
    partialWorkingState,
} from "../helpers/agent-doubles";

const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0))
        fs.rmSync(directory, { recursive: true, force: true });
});

type AgentDatabase = Awaited<ReturnType<typeof openAgentMetadataDatabase>>;

async function openDatabase(label: string): Promise<AgentDatabase> {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-agent-${label}-`));
    tempDirs.push(stateDir);
    return openAgentMetadataDatabase(path.join(stateDir, "workspaces"));
}

/** Counts every parent marker the writer appended, which is the number this change exists to reduce. */
function countingMarkers() {
    const appended: string[] = [];
    return {
        appended,
        appendMarker: (marker: { snapshotId: string }) => {
            appended.push(marker.snapshotId);
            return `marker-${marker.snapshotId}`;
        },
    };
}

async function rowCount(database: AgentDatabase, table: string): Promise<number> {
    const row = (await database.get(`SELECT COUNT(*) AS rows FROM ${table}`)) as { rows: number };
    return row.rows;
}

async function snapshotRowCount(database: AgentDatabase, runInstanceId: string): Promise<number> {
    const row = (await database.get(
        `SELECT COUNT(*) AS rows FROM agent_run_snapshots WHERE run_instance_id = ?`,
        runInstanceId,
    )) as { rows: number };
    return row.rows;
}

async function headRow(database: AgentDatabase, runInstanceId: string) {
    return (await database.get(
        `SELECT snapshot_id, pending, created_sequence FROM agent_run_continuation_heads
         WHERE run_instance_id = ?`,
        runInstanceId,
    )) as { snapshot_id: string; pending: number; created_sequence: number } | undefined;
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

            expect(await rowCount(database, "agent_run_working_state")).toBe(1);
            expect(await readAgentRunWorkingStateInDatabase(database, "instance-1")).toMatchObject({
                childSessionLeafId: "leaf-2",
                updatedAt: 200,
            });

            await clearAgentRunWorkingStateInDatabase(database, "instance-1");
            expect(await rowCount(database, "agent_run_working_state")).toBe(0);
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
     * A row written by another build is untrusted data. Only the reachable corruptions are exercised: the
     * `CHECK` makes a bad status unreachable through the table, so the reader's status re-check is
     * defense-in-depth rather than a path a test can pin.
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
            expect(await rowCount(upgraded, "agent_run_working_state")).toBe(0);
            expect(await upgraded.get(`PRAGMA user_version`)).toMatchObject({ user_version: 17 });
        } finally {
            await upgraded.close();
        }
    });

    /**
     * A checkpoint save is the whole story: it writes its snapshot and clears any working row, so no
     * progress frame is left behind to sharpen the checkpoint that just absorbed it.
     */
    it("clears rather than fills the working row on a checkpoint save", async () => {
        const database = await openDatabase("working-checkpoint-clears");
        const markers = countingMarkers();
        const writer = createAgentRunStateWriter(process.cwd(), database, markers.appendMarker);
        const runInstanceId = "instance-checkpoint-clears";
        try {
            await upsertAgentRunWorkingStateInDatabase(
                database,
                partialWorkingState({ runInstanceId }),
            );
            expect(await rowCount(database, "agent_run_working_state")).toBe(1);

            expect((await writer.save(partialPersistedRecord({ runInstanceId }))).ok).toBe(true);
            expect(await rowCount(database, "agent_run_working_state")).toBe(0);
            expect(await snapshotRowCount(database, runInstanceId)).toBe(1);
            expect(markers.appended).toHaveLength(1);
        } finally {
            await writer.close();
        }
    });

    /**
     * The seam itself, which the writer tests above cannot see: a leaf advance and a file change must each
     * ask for exactly one progress frame, while the callback that establishes the transcript and every
     * lifecycle boundary stay checkpoints — a run with no durable checkpoint at all cannot be restored by
     * anyone, and a frame must never append a marker.
     */
    it("sends child progress as frames and lifecycle boundaries as checkpoints", async () => {
        const intents: AgentRunCheckpointIntent[] = [];
        const persistence = partialPersistence({
            usesSnapshotMarkers: true,
            save: async (_record, intent = "checkpoint") => {
                intents.push(intent);
                return true;
            },
        });
        const frames = () => intents.filter((intent) => intent === "intermediate").length;
        const settle = () => new Promise((resolve) => setImmediate(resolve));
        const perCallback: number[] = [];
        let reportActivity: (() => Promise<void>) | undefined;
        let leafSequence = 1;
        const child: ChildAgentHandle = {
            prompt: async () => {
                await reportActivity?.();
            },
            abort: async () => {},
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => ({ output: "thinking", recentActivity: [] }),
            getFinalOutput: () => "done",
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
            getSessionLeafId: () => `leaf-${leafSequence}`,
        };
        const manager = new AgentRunManager(async (context) => {
            context.onSessionCreated?.("/tmp/agent-sessions/child.jsonl", "leaf-1");
            reportActivity = async () => {
                leafSequence = 2;
                context.onProgress?.({ output: "thinking", recentActivity: [] });
                await settle();
                perCallback.push(frames());

                context.onFileChanged?.("src/index.ts");
                await settle();
                perCallback.push(frames());
            };
            return child;
        }, 4);
        manager.setPersistence(persistence);

        const outcome = await manager.start(
            BUILTIN_SCOUT,
            "Investigate the seam",
            { cwd: process.cwd(), parentContext: {} },
            {},
        );
        await manager.shutdown();

        expect(outcome.details.status).toBe("completed");
        // One frame for the leaf advance, then exactly one more for the file change.
        expect(perCallback).toEqual([1, 2]);
        expect(intents[0]).toBe("checkpoint");
        expect(intents[intents.length - 1]).toBe("checkpoint");
    });

    /**
     * §7.1: a progress frame touches neither the checkpoint journal nor the parent transcript. The head row
     * staying absent is the point — a frame that advanced it would strand a reservation the next checkpoint
     * could not settle.
     */
    it("stores a progress frame without touching the checkpoint journal", async () => {
        const database = await openDatabase("working-frame");
        const markers = countingMarkers();
        const writer = createAgentRunStateWriter(process.cwd(), database, markers.appendMarker);
        const runInstanceId = "instance-frame";
        try {
            const lease = await writer.acquireContinuationLease!(runInstanceId);
            expect(
                (await writer.save(partialPersistedRecord({ runInstanceId }), "intermediate")).ok,
            ).toBe(true);

            expect(await headRow(database, runInstanceId)).toBeUndefined();
            expect(await snapshotRowCount(database, runInstanceId)).toBe(0);
            expect(markers.appended).toHaveLength(0);
            expect(
                await database.get(
                    `SELECT child_session_leaf_id, status, latest_snapshot_id
                     FROM agent_runs WHERE run_instance_id = ?`,
                    runInstanceId,
                ),
            ).toMatchObject({ child_session_leaf_id: "leaf-checkpoint", status: "running" });

            // A second frame replaces the first instead of appending.
            expect(
                (
                    await writer.save(
                        partialPersistedRecord({
                            runInstanceId,
                            childSessionLeafId: "leaf-third",
                            updatedAt: 40,
                        }),
                        "intermediate",
                    )
                ).ok,
            ).toBe(true);
            expect(await rowCount(database, "agent_run_working_state")).toBe(1);
            expect(await readAgentRunWorkingStateInDatabase(database, runInstanceId)).toMatchObject(
                { childSessionLeafId: "leaf-third", updatedAt: 40 },
            );

            // §7.2: the next checkpoint absorbs the frames and takes the working row away.
            expect((await writer.save(partialPersistedRecord({ runInstanceId }))).ok).toBe(true);
            expect(await rowCount(database, "agent_run_working_state")).toBe(0);
            expect(await snapshotRowCount(database, runInstanceId)).toBe(1);
            expect(markers.appended).toHaveLength(1);
            expect(await headRow(database, runInstanceId)).toMatchObject({ pending: 0 });

            await lease.release();
        } finally {
            await writer.close();
        }
    });

    /**
     * §7.3: without a lease this process owns, another parent continues the transcript, so a frame is
     * dropped rather than written over them. Dropping is never a failure for the child, and it is reported
     * on its own channel instead of the refusal one, which is budgeted to one user warning per session.
     */
    it("drops a progress frame with no lease held here", async () => {
        const database = await openDatabase("working-no-lease");
        const drops: AgentDroppedProgressWrite[] = [];
        const writer = createAgentRunStateWriter(process.cwd(), database, () => "marker", {
            onDroppedProgress: (drop) => drops.push(drop),
        });
        const runInstanceId = "instance-no-lease";
        try {
            expect(
                (await writer.save(partialPersistedRecord({ runInstanceId }), "intermediate")).ok,
            ).toBe(true);

            expect(await rowCount(database, "agent_run_working_state")).toBe(0);
            expect(drops).toHaveLength(1);
            expect(drops[0]?.runId).toBe("scout-1");
            expect(drops[0]?.message).toMatch(/no continuation lease/);
        } finally {
            await writer.close();
        }
    });

    /**
     * A frame that reports a boundary status is not upgraded into a checkpoint either: every status
     * transition already writes its own checkpoint, so upgrading a late frame would append a marker after
     * the run's real terminal one.
     */
    it("drops a boundary-status frame instead of writing a late marker", async () => {
        const database = await openDatabase("working-late-frame");
        const markers = countingMarkers();
        const writer = createAgentRunStateWriter(process.cwd(), database, markers.appendMarker);
        const runInstanceId = "instance-late-frame";
        try {
            const lease = await writer.acquireContinuationLease!(runInstanceId);
            expect(
                (
                    await writer.save(
                        partialPersistedRecord({ runInstanceId, status: "completed" }),
                        "intermediate",
                    )
                ).ok,
            ).toBe(true);

            expect(await rowCount(database, "agent_run_working_state")).toBe(0);
            expect(await snapshotRowCount(database, runInstanceId)).toBe(0);
            expect(markers.appended).toHaveLength(0);
            await lease.release();
        } finally {
            await writer.close();
        }
    });

    /**
     * §7.7: the whole point of the change. Twenty child frames must cost one working row, one snapshot row
     * for the checkpoint that opened the run, and one marker — not twenty-one of each.
     */
    it("keeps twenty progress frames at one row and one marker per checkpoint", async () => {
        const database = await openDatabase("working-amplification");
        const markers = countingMarkers();
        const writer = createAgentRunStateWriter(process.cwd(), database, markers.appendMarker);
        const runInstanceId = "instance-amplification";
        try {
            const lease = await writer.acquireContinuationLease!(runInstanceId);
            expect((await writer.save(partialPersistedRecord({ runInstanceId }))).ok).toBe(true);

            for (let turn = 0; turn < 20; turn += 1) {
                expect(
                    (
                        await writer.save(
                            partialPersistedRecord({
                                runInstanceId,
                                updatedAt: 1_000 + turn,
                                childSessionLeafId: `leaf-${turn}`,
                                progress: { output: `frame ${turn}`, recentActivity: [] },
                            }),
                            "intermediate",
                        )
                    ).ok,
                ).toBe(true);
            }

            expect(await snapshotRowCount(database, runInstanceId)).toBe(1);
            expect(markers.appended).toHaveLength(1);
            expect(await rowCount(database, "agent_run_working_state")).toBe(1);
            expect(await readAgentRunWorkingStateInDatabase(database, runInstanceId)).toMatchObject(
                { childSessionLeafId: "leaf-19" },
            );
            await lease.release();
        } finally {
            await writer.close();
        }
    });
});

describe("working-state overlay", () => {
    const missingLeaves = new Set(["leaf-missing"]);
    const context = {
        leaseIsHeld: false,
        leafExists: (leafId: string) => !missingLeaves.has(leafId),
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
                    recentActivity: Array.from({ length: 20 }, (_value, index) => `step ${index}`),
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

    /** The knob that reverts the whole leaf-resolution change; step 3 turned it on. */
    it("is enabled", () => {
        expect(ENABLE_WORKING_STATE_OVERLAY).toBe(true);
    });
});

describe("chunked snapshot fetch", () => {
    /** Reads across chunk boundaries, dedupes, and tolerates ids that no longer exist. */
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
            expect(
                snapshots
                    .map((snapshot) => snapshot.runId)
                    .sort()
                    .join(","),
            ).toBe("scout-1,scout-2,scout-3");
            expect(await listAgentRunSnapshotsInDatabase(database, [])).toEqual([]);
            expect(
                await listAgentRunSnapshotsInDatabase(database, [found[0], found[0]]),
            ).toHaveLength(1);
        } finally {
            await database.close();
        }
    });

    /**
     * The reclaimed-vs-wiped question, answered in one batched query rather than one per dangling marker.
     * A deduplicated id list must not turn into a duplicate-laden `IN (...)` on a session with thousands of
     * markers for the same run.
     */
    it("reports which physical runs still have a surviving snapshot", async () => {
        const database = await openDatabase("snapshot-survivors");
        try {
            await insertAgentRunSnapshotInDatabase(
                database,
                partialPersistedRecord({ runInstanceId: "instance-alive" }),
            );

            const surviving = await listRunInstanceIdsWithSnapshotsInDatabase(database, [
                "instance-alive",
                "instance-alive",
                "instance-gone",
                ...Array.from({ length: 600 }, (_value, index) => `padded-${index}`),
            ]);

            expect([...surviving]).toEqual(["instance-alive"]);
            expect(
                await listRunInstanceIdsWithSnapshotsInDatabase(database, ["instance-gone"]),
            ).toEqual(new Set());
            expect(await listRunInstanceIdsWithSnapshotsInDatabase(database, [])).toEqual(
                new Set(),
            );
        } finally {
            await database.close();
        }
    });
});
