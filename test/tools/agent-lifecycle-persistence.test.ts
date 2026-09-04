import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createEventBus,
    SessionManager,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const persistenceMock = vi.hoisted(() => ({
    load: vi.fn(),
}));

vi.mock("../../src/tools/agent/runs/persistence", async () => {
    const actual = await vi.importActual<typeof import("../../src/tools/agent/runs/persistence")>(
        "../../src/tools/agent/runs/persistence",
    );
    return { ...actual, loadAgentRunPersistence: persistenceMock.load };
});

import { BUILTIN_SCOUT } from "../../src/tools/agent/definitions/discovery";
import { AgentLifecycle } from "../../src/tools/agent/lifecycle";
import type {
    AgentRunPersistence,
    ChildAgentFactoryContext,
    ChildAgentHandle,
    PersistedAgentRun,
} from "../../src/tools/agent/contracts/runs";
import type { LoadedAgentRunPersistence } from "../../src/tools/agent/runs/persistence/load";
import { ZERO_USAGE } from "../../src/tools/agent/runs/usage";
import {
    collectAgentRunSnapshotMarkers,
    AGENT_RUN_SNAPSHOT_MARKER,
} from "../../src/tools/agent/storage/run-markers";
import { partialPersistence, partialStateWriter } from "../helpers/agent-doubles";
import {
    createPiStub,
    handlerView,
    stubSessionContext,
    stubUi,
    type SessionBackedContext,
} from "../helpers/pi-stub";

const tempDirs: string[] = [];

afterEach(() => {
    persistenceMock.load.mockReset();
    for (const directory of tempDirs.splice(0))
        fs.rmSync(directory, { recursive: true, force: true });
});

function child(sessionFile: string, leafId: string, question?: string): ChildAgentHandle {
    let pendingQuestion = question ? { question } : undefined;
    return {
        sessionFile,
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        takeParentQuestion: () => {
            const result = pendingQuestion;
            pendingQuestion = undefined;
            return result;
        },
        getProgress: () => ({ output: "Partial child output", recentActivity: [] }),
        getFinalOutput: () => "Partial child output",
        getError: () => undefined,
        getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
        getSessionLeafId: () => leafId,
    };
}

describe("delegated-agent session tree persistence", () => {
    it("detaches the old manager before tree restoration and restores the exact waiting checkpoint", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-lifecycle-persistence-"));
        tempDirs.push(root);
        const parent = SessionManager.create(process.cwd(), root);
        parent.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "parent checkpoint" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: 1,
        });
        const baseLeaf = parent.getLeafId();
        const factoryContexts: ChildAgentFactoryContext[] = [];
        let snapshotNumber = 0;
        const recordsBySnapshot = new Map<string, PersistedAgentRun>();
        const persistenceFor = (ctx: SessionBackedContext): AgentRunPersistence =>
            // `save` is async because `AgentRunPersistence.save` returns a promise; every manager call
            // site awaits it, so a checkpoint still gets its snapshot id before the marker is read back.
            partialPersistence({
                ownerSessionId: ctx.sessionManager.getSessionId(),
                usesSnapshotMarkers: true,
                childSessionDir: root,
                save: async (record) => {
                    const snapshotId = `snapshot-${++snapshotNumber}`;
                    recordsBySnapshot.set(snapshotId, structuredClone(record));
                    ctx.sessionManager.appendCustomEntry(AGENT_RUN_SNAPSHOT_MARKER, {
                        version: 2,
                        snapshotId,
                        runInstanceId: record.runInstanceId,
                        runId: record.runId,
                    });
                    return true;
                },
                deleteChildSession: () => {},
            });
        persistenceMock.load.mockImplementation(
            async (ctx: ExtensionContext): Promise<LoadedAgentRunPersistence> => {
                const branchMarkers = collectAgentRunSnapshotMarkers(
                    ctx.sessionManager.getBranch(),
                );
                const latest = new Map<string, PersistedAgentRun>();
                for (const entry of branchMarkers) {
                    const record = recordsBySnapshot.get(entry.marker.snapshotId);
                    if (record?.runInstanceId)
                        latest.set(record.runInstanceId, structuredClone(record));
                }
                // pi hands extensions the concrete `SessionManager` and types it as the read-only view;
                // this test's own context is built by `stubSessionContext(parent)`, so the write-capable
                // session `persistenceFor` needs is a fact of the fixture, not an assumption.
                const persistence = persistenceFor(ctx as SessionBackedContext);

                return {
                    persistence,
                    records: [...latest.values()],
                    // The real loader hands back its state writer here, whose `save` resolves to `{ ok }`
                    // rather than a boolean. It is inert in this suite — nothing in `src/` reads
                    // `LoadedAgentRunPersistence.catalog` — so it gets its own honest double instead of a
                    // persistence object wearing a second contract.
                    catalog: partialStateWriter(),
                };
            },
        );

        const stub = createPiStub({ eventBus: createEventBus() });
        const lifecycle = new AgentLifecycle(stub.pi, async (context) => {
            factoryContexts.push(context);
            return factoryContexts.length === 1
                ? child("child.jsonl", "child-leaf-1", "Need parent guidance")
                : child("child.jsonl", "child-leaf-1");
        });
        lifecycle.register();
        // Snapshot of every handler the lifecycle registered above, in registration order.
        const handlers = handlerView(stub, "session_start", "session_tree");
        const ctx = stubSessionContext(parent, {
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => true,
            ui: stubUi({ notify: vi.fn(), setWidget: vi.fn() }),
        });

        await handlers.session_start[0]?.({}, ctx);
        expect(persistenceMock.load).toHaveBeenCalledOnce();
        const scout = lifecycle
            .discover(ctx)
            .agents.find((agent) => agent.name === BUILTIN_SCOUT.name)!;
        const waiting = await lifecycle.manager.start(
            scout,
            "Investigate the persistence boundary",
            { cwd: process.cwd(), parentContext: ctx },
            {},
        );
        expect(waiting.details.status).toBe("waiting_for_parent");
        const waitingMarker = parent.getLeafId();
        expect(snapshotNumber).toBeGreaterThan(0);
        expect(waitingMarker).not.toBe(baseLeaf);
        const committedSnapshotCount = snapshotNumber;

        parent.branch(baseLeaf!);
        await handlers.session_tree[0]?.({}, ctx);
        expect(lifecycle.manager.listRuns()).toEqual([]);
        expect(snapshotNumber).toBe(committedSnapshotCount);

        parent.branch(waitingMarker!);
        expect(collectAgentRunSnapshotMarkers(parent.getBranch()).length).toBeGreaterThan(0);
        await handlers.session_tree[0]?.({}, ctx);
        expect(lifecycle.manager.listRuns()).toEqual([
            expect.objectContaining({ runId: "scout-1", status: "waiting_for_parent" }),
        ]);
        expect(factoryContexts.at(-1)).toMatchObject({
            childSessionFile: "child.jsonl",
            childSessionLeafId: "child-leaf-1",
            repairInterrupted: false,
        });
    });
});
