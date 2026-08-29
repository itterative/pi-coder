import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";

import { AgentContinuationLeaseBusyError } from "../../src/tools/agent/contracts/runs";
import { CONTINUATION_LEASE_RECOVERY_GRACE_MS } from "../../src/tools/agent/runs/persistence";
import {
    getSafeBashAssessment,
    getScoutBashAssessment,
    isChildPathAllowed,
    isSafeBashAllowed,
    isScoutBashAllowed,
} from "../../src/tools/agent/child";
import {
    agentAdditionalPaths,
    BUILTIN_ADVISOR,
    BUILTIN_SCOUT,
    BUILTIN_WORKER,
    fingerprintAgentDefinition,
    fingerprintLegacyAgentDefinition,
} from "../../src/tools/agent/definitions/discovery";
import {
    AgentActionError,
    AgentRunManager,
    type AgentRunStatus,
    type AgentRunPersistence,
    type ChildAgentHandle,
    type ParentQuestion,
    type PersistedAgentRun,
} from "../../src/tools/agent/runs/manager";

interface Step {
    output?: string;
    leafId?: string | null;
    question?: ParentQuestion;
    error?: string;
    usage?: Usage;
    waitForAbort?: boolean;
}

class FakeChild implements ChildAgentHandle {
    readonly prompts: string[] = [];
    readonly sessionFile?: string;
    disposed = false;
    abortCount = 0;
    private output = "";
    private question?: ParentQuestion;
    private error?: string;
    private usage = usage();
    private releaseAbort?: () => void;
    private sessionLeafId?: string | null;

    constructor(private readonly steps: Step[], sessionFile?: string) {
        this.sessionFile = sessionFile;
    }

    async prompt(text: string): Promise<void> {
        this.prompts.push(text);
        const step = this.steps.shift();
        if (!step) throw new Error("No scripted child step");
        if (step.waitForAbort) {
            await new Promise<void>((resolve) => {
                this.releaseAbort = resolve;
            });
            return;
        }
        this.output = step.output ?? "";
        this.sessionLeafId = step.leafId;
        this.question = step.question;
        this.error = step.error;
        if (step.usage) this.usage = addUsage(this.usage, step.usage);
    }

    async abort(): Promise<void> {
        this.abortCount++;
        this.releaseAbort?.();
    }

    dispose(): void {
        this.disposed = true;
    }

    takeParentQuestion(): ParentQuestion | undefined {
        const result = this.question;
        this.question = undefined;
        return result;
    }

    getSessionLeafId(): string | null | undefined {
        return this.sessionLeafId;
    }

    getProgress() {
        return { output: this.output, recentActivity: [] };
    }

    getFinalOutput(): string {
        return this.output;
    }

    getError(): string | undefined {
        return this.error;
    }

    getUsage(): Usage {
        return { ...this.usage, cost: { ...this.usage.cost } };
    }
}

function usage(input = 0, output = 0): Usage {
    return {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: {
            input: input / 1_000,
            output: output / 1_000,
            cacheRead: 0,
            cacheWrite: 0,
            total: (input + output) / 1_000,
        },
    };
}

function addUsage(a: Usage, b: Usage): Usage {
    return {
        input: a.input + b.input,
        output: a.output + b.output,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        totalTokens: a.totalTokens + b.totalTokens,
        cost: {
            input: a.cost.input + b.cost.input,
            output: a.cost.output + b.cost.output,
            cacheRead: a.cost.cacheRead + b.cost.cacheRead,
            cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
            total: a.cost.total + b.cost.total,
        },
    };
}

function managerWith(child: FakeChild, limit = 4): AgentRunManager {
    return new AgentRunManager(async () => child, limit);
}

function context() {
    return { cwd: process.cwd(), parentContext: {} };
}

function durableStore(directory: string) {
    const records: PersistedAgentRun[] = [];
    const deletedChildSessions: string[] = [];
    const persistence: AgentRunPersistence = {
        ownerSessionId: "parent-session",
        childSessionDir: directory,
        save: (record) => {
            records.push(structuredClone(record));
            return true;
        },
        deleteChildSession: (file) => deletedChildSessions.push(file),
    };
    return { persistence, records, deletedChildSessions };
}

function latestRecords(records: PersistedAgentRun[]): PersistedAgentRun[] {
    const latest = new Map<string, PersistedAgentRun>();
    for (const record of records) latest.set(record.runId, record);
    return [...latest.values()];
}

async function flushBackground(): Promise<void> {
    for (let index = 0; index < 12; index++) await Promise.resolve();
}

const tempDirs: string[] = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("AgentRunManager", () => {
    it("preserves no-options behavior for every run entry point", async () => {
        const started = await managerWith(new FakeChild([{ output: "Started" }]))
            .start("scout", "Investigate", context());
        expect(started.details.status).toBe("completed");

        const continuation = await managerWith(new FakeChild([{ output: "Continued" }]))
            .startContinuation("scout", "Investigate", "Continue", context());
        expect(continuation.details.status).toBe("completed");

        const spawnedManager = managerWith(new FakeChild([{ output: "Spawned" }]));
        spawnedManager.spawn("scout", "Investigate", context());
        await flushBackground();
        expect(spawnedManager.collect("scout-1").content).toBe("Spawned");

        const waitingManager = managerWith(new FakeChild([{ question: { question: "Which path?" } }]));
        await waitingManager.start("scout", "Investigate", context());
        await expect(waitingManager.resume("scout-1")).rejects.toThrow("require parent guidance");
        await waitingManager.shutdown();
    });

    it("moves a running foreground start to the background", async () => {
        let promptStarted = false;
        let releasePrompt: (() => void) | undefined;
        let output = "";
        let abortCount = 0;
        const backgroundUpdates: AgentRunSummary[] = [];
        const child: ChildAgentHandle = {
            prompt: async () => {
                promptStarted = true;
                await new Promise<void>((resolve) => {
                    releasePrompt = resolve;
                });
                output = "Finished in the background.";
            },
            abort: async () => {
                abortCount++;
                releasePrompt?.();
            },
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => ({ output, recentActivity: [] }),
            getFinalOutput: () => output,
            getError: () => undefined,
            getUsage: () => usage(),
        };
        const manager = managerWith(child);
        const controller = new AbortController();
        const start = manager.start("scout", "Investigate", context(), {
            signal: controller.signal,
            onBackgroundUpdate: (details) => backgroundUpdates.push(details as AgentRunSummary),
        });

        await vi.waitFor(() => expect(promptStarted).toBe(true));
        const moved = manager.moveForegroundToBackground();
        expect(moved).toMatchObject({
            content: expect.stringContaining("manually moved to the background by the user"),
            details: { background: true, status: "running" },
        });
        await expect(start).resolves.toMatchObject({
            details: { background: true, status: "running" },
        });

        controller.abort();
        releasePrompt?.();
        await vi.waitFor(() => expect(manager.status("scout-1").details.status).toBe("completed"));
        expect(abortCount).toBe(0);
        expect(backgroundUpdates.some((details) => details.background === true)).toBe(true);
        expect(manager.collect("scout-1").content).toBe("Finished in the background.");
    });

    it("assigns a durable human-readable title to each run", async () => {
        const child = new FakeChild([{ output: "Found it." }]);
        const manager = managerWith(child);

        const result = await manager.start(
            "scout",
            "Inspect the persistence layer\nand report risks",
            context(),
            {
                signal: undefined,
                onProgress: undefined,
                title: "Persistence audit",
                identity: { runId: "scout-custom", runInstanceId: "instance-custom" },
            },
        );

        expect(result.details).toMatchObject({
            title: "Persistence audit",
            runId: "scout-custom",
            runInstanceId: "instance-custom",
        });
    });

    it("keeps the full initial task in run details", async () => {
        const child = new FakeChild([{ output: "Found it." }]);
        const taskLimit = 120;
        const manager = new AgentRunManager(
            async () => child,
            4,
            undefined,
            20,
            undefined,
            taskLimit,
        );
        const task = "x".repeat(taskLimit);

        const result = await manager.start("scout", task, context(), {});

        expect(result.details.task).toBe(task);
    });

    it("derives a title when none is supplied", async () => {
        const child = new FakeChild([{ output: "Found it." }]);
        const manager = managerWith(child);

        const result = await manager.start("scout", "Inspect the persistence layer\nand report risks", context(), {});

        expect(result.details.title).toBe("Inspect the persistence layer");
    });

    it("renders policy-selected runtime context into the initial task", async () => {
        const child = new FakeChild([{ output: "The approach is sound." }]);
        const manager = managerWith(child);

        await manager.start(BUILTIN_ADVISOR, "Review the approach.", {
            ...context(),
            agentContext: {
                sections: [
                    {
                        id: "parent_summary",
                        title: "Parent summary",
                        content: "The parent has implemented the first version.",
                        source: "parent",
                    },
                    {
                        id: "not_requested",
                        title: "Unrequested context",
                        content: "This must not be rendered.",
                        source: "repository",
                    },
                ],
            },
        }, {});

        await expect(child.prompts[0]).toMatchFileSnapshot("__snapshots__/agent-manager.advisor-initial-task.txt");
    });

    it("persists the final child leaf after the prompt settles", async () => {
        const child = new FakeChild([{ output: "Found the answer.", leafId: "leaf-final" }], "/tmp/child.jsonl");
        const manager = managerWith(child);
        const store = durableStore("/tmp");
        manager.setPersistence(store.persistence);

        await manager.start("scout", "Investigate", context(), {});

        expect(latestRecords(store.records)[0]).toMatchObject({
            childSessionLeafId: "leaf-final",
        });
        expect(manager.getPersistedRun("scout-1")).toMatchObject({
            status: "removed",
            childSessionLeafId: "leaf-final",
        });
    });

    it("completes a run and disposes its child", async () => {
        const child = new FakeChild([{ output: "Found the answer.", usage: usage(10, 4) }]);
        const manager = managerWith(child);

        const result = await manager.start("scout", "Investigate", context(), {});

        expect(result.details.status).toBe("completed");
        expect(result.hasResponse).toBe(true);
        expect(result.content).toBe("Found the answer.");
        expect(result.usage).toMatchObject({ input: 10, output: 4 });
        expect(manager.activeCount).toBe(0);
        expect(child.disposed).toBe(true);
    });

    it("continues a persisted terminal child session with only the revision message", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-sessions-"));
        tempDirs.push(directory);
        const childFile = path.join(directory, "child.jsonl");
        const firstChild = new FakeChild(
            [{ output: "Initial findings", leafId: "leaf-final" }],
            childFile,
        );
        const continuedChild = new FakeChild([{ output: "Revised findings" }], childFile);
        const children = [firstChild, continuedChild];
        const factoryContexts: unknown[] = [];
        const manager = new AgentRunManager(async (factoryContext) => {
            factoryContexts.push(factoryContext);
            return children.shift()!;
        });
        const store = durableStore(directory);
        manager.setPersistence(store.persistence);

        await manager.start("scout", "Investigate", context(), {});
        const revised = await manager.startContinuation(
            "scout",
            "Investigate",
            "Please revise the findings.",
            {
                ...context(),
                childSessionFile: childFile,
                childSessionLeafId: "leaf-final",
            },
            {},
        );

        expect(firstChild.disposed).toBe(true);
        expect(continuedChild.prompts).toEqual(["Please revise the findings."]);
        expect(factoryContexts[1]).toMatchObject({
            childSessionFile: childFile,
            childSessionLeafId: "leaf-final",
        });
        expect(revised.details.task).toBe("Investigate");
        expect(revised.details.runId).toBe("scout-2");
    });

    it("preserves the continuation checkpoint when child setup fails so a stable ID can retry", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-revise-retry-"));
        tempDirs.push(directory);
        const childFile = path.join(directory, "child.jsonl");
        const store = durableStore(directory);
        const factoryContexts: unknown[] = [];
        let attempts = 0;
        const manager = new AgentRunManager(async (factoryContext) => {
            factoryContexts.push(factoryContext);
            attempts++;
            if (attempts === 1) throw new Error("child session could not be reopened");
            return new FakeChild([{ output: "Retried findings" }], childFile);
        });
        manager.setPersistence(store.persistence);

        const continuationContext = {
            ...context(),
            childSessionFile: childFile,
            childSessionLeafId: "leaf-before-retry",
        };
        const identity = { runId: "reviewer-1", runInstanceId: "reviewer-instance-1" };
        const firstFailure = await manager.startContinuation(
            "reviewer",
            "Review the changes",
            "Please retry the review.",
            continuationContext,
            { identity },
        );
        expect(firstFailure.details.status).toBe("failed");
        expect(firstFailure.content).toContain("Failed to create child session");

        expect(latestRecords(store.records).at(-1)).toMatchObject({
            runId: identity.runId,
            runInstanceId: identity.runInstanceId,
            status: "removed",
            childSessionFile: childFile,
            childSessionLeafId: "leaf-before-retry",
        });

        const retried = await manager.startContinuation(
            "reviewer",
            "Review the changes",
            "Please retry the review.",
            continuationContext,
            { identity },
        );

        expect(retried.details.runId).toBe(identity.runId);
        expect(retried.details.runInstanceId).toBe(identity.runInstanceId);
        expect(factoryContexts[1]).toMatchObject({
            childSessionFile: childFile,
            childSessionLeafId: "leaf-before-retry",
        });
    });

    it("retains context across repeated parent-guidance cycles and reports usage deltas", async () => {
        const child = new FakeChild([
            {
                question: { question: "Which implementation should I inspect?", recommendation: "Inspect A" },
                output: "Partial findings",
                usage: usage(10, 2),
            },
            {
                question: { question: "Should I compare the fallback too?" },
                output: "More findings",
                usage: usage(5, 3),
            },
            { output: "Final findings", usage: usage(7, 4) },
        ]);
        const manager = managerWith(child);

        const first = await manager.start("scout", "Investigate", context(), {});
        expect(first.details.status).toBe("waiting_for_parent");
        expect(first.details.runId).toBe("scout-1");
        expect(first.content).toContain("Partial child output:\nPartial findings");
        expect(first.usage).toMatchObject({ input: 10, output: 2 });

        const second = await manager.resume("scout-1", { guidance: "Inspect implementation A" });
        expect(second.details.status).toBe("waiting_for_parent");
        expect(second.usage).toMatchObject({ input: 5, output: 3 });

        const final = await manager.resume("scout-1", { guidance: "Yes, compare it" });
        expect(final.details.status).toBe("completed");
        expect(final.usage).toMatchObject({ input: 7, output: 4 });
        expect(final.details.usage).toMatchObject({ input: 22, output: 9 });
        expect(child.prompts).toEqual([
            "Investigate",
            "Parent guidance:\nInspect implementation A",
            "Parent guidance:\nYes, compare it",
        ]);
        expect(child.disposed).toBe(true);
    });

    it("cancels a waiting run", async () => {
        const child = new FakeChild([{ question: { question: "Continue?" } }]);
        const manager = managerWith(child);
        await manager.start("scout", "Investigate", context(), {});

        const result = await manager.cancel("scout-1");

        expect(result.details.status).toBe("canceled");
        expect(manager.activeCount).toBe(0);
        expect(child.disposed).toBe(true);
        await expect(manager.cancel("scout-1")).rejects.toThrow(AgentActionError);
    });

    it("cancels a running foreground child", async () => {
        const child = new FakeChild([{ waitForAbort: true }]);
        const manager = managerWith(child);
        const pending = manager.start("scout", "Investigate", context(), {});
        await Promise.resolve();

        const canceled = await manager.cancel("scout-1");
        const settled = await pending;

        expect(canceled.details.status).toBe("canceled");
        expect(settled.details.status).toBe("canceled");
        expect(child.abortCount).toBeGreaterThan(0);
        expect(child.disposed).toBe(true);
        expect(manager.activeCount).toBe(0);
    });

    it("interrupts an active run when continuation ownership is lost", async () => {
        const child = new FakeChild([{ waitForAbort: true }]);
        let onLost: (() => void) | undefined;
        const manager = managerWith(child);
        manager.setPersistence({
            ownerSessionId: "parent-session",
            usesSnapshotMarkers: true,
            childSessionDir: process.cwd(),
            save: () => true,
            acquireContinuationLease: (_runInstanceId, callback) => {
                onLost = callback;
                return { release() {} };
            },
            deleteChildSession() {},
        });

        const pending = manager.start("scout", "Investigate", context(), {});
        await flushBackground();
        expect(onLost).toBeDefined();

        onLost!();
        const result = await pending;

        expect(result.details.status).toBe("interrupted");
        expect(result.hasResponse).toBeUndefined();
        expect(result.isError).toBe(true);
        expect(child.abortCount).toBe(1);
        expect(manager.listRuns()[0]).toMatchObject({ status: "interrupted" });
    });

    it("bounds retained runs", async () => {
        const children = Array.from({ length: 3 }, () => (
            new FakeChild([{ question: { question: "Continue?" } }])
        ));
        let index = 0;
        const manager = new AgentRunManager(async () => children[index++]!, 2);

        await manager.start("scout", "First", context(), {});
        await manager.start("scout", "Second", context(), {});

        await expect(manager.start("scout", "Third", context(), {})).rejects.toThrow("run limit reached");
        expect(manager.activeCount).toBe(2);
        await manager.shutdown();
    });

    it("bridges parent cancellation to the child", async () => {
        const child = new FakeChild([{ waitForAbort: true }]);
        const manager = managerWith(child);
        const controller = new AbortController();

        const pending = manager.start("scout", "Investigate", context(), { signal: controller.signal });
        await Promise.resolve();
        controller.abort();
        const result = await pending;

        expect(result.details.status).toBe("aborted");
        expect(result.hasResponse).toBeUndefined();
        expect(result.isError).toBe(true);
        expect(child.abortCount).toBeGreaterThan(0);
        expect(child.disposed).toBe(true);
    });

    it("disposes a child that finishes setup after parent cancellation", async () => {
        const child = new FakeChild([{ output: "Should not run" }]);
        let resolveFactory!: (handle: ChildAgentHandle) => void;
        const factory = new Promise<ChildAgentHandle>((resolve) => {
            resolveFactory = resolve;
        });
        const manager = new AgentRunManager(async () => factory);
        const controller = new AbortController();

        const pending = manager.start("scout", "Investigate", context(), { signal: controller.signal });
        controller.abort();
        resolveFactory(child);
        const result = await pending;

        expect(result.details.status).toBe("aborted");
        expect(child.prompts).toEqual([]);
        expect(child.disposed).toBe(true);
        expect(manager.activeCount).toBe(0);
    });

    it("aborts an in-progress child on shutdown", async () => {
        const child = new FakeChild([{ waitForAbort: true }]);
        const manager = managerWith(child);

        const pending = manager.start("scout", "Investigate", context(), {});
        await Promise.resolve();
        await manager.shutdown();
        const result = await pending;

        expect(result.details.status).toBe("aborted");
        expect(child.abortCount).toBeGreaterThan(0);
        expect(child.disposed).toBe(true);
        expect(manager.activeCount).toBe(0);
    });

    it("disposes all waiting children on shutdown", async () => {
        const children = [
            new FakeChild([{ question: { question: "One?" } }]),
            new FakeChild([{ question: { question: "Two?" } }]),
        ];
        let index = 0;
        const manager = new AgentRunManager(async () => children[index++]!);
        await manager.start("scout", "First", context(), {});
        await manager.start("scout", "Second", context(), {});

        await manager.shutdown();

        expect(manager.activeCount).toBe(0);
        expect(children.every((child) => child.disposed)).toBe(true);
        await expect(manager.start("scout", "Third", context(), {})).rejects.toThrow("shutting down");
    });

    it("waits for in-progress child setup during shutdown and disposes the result", async () => {
        const child = new FakeChild([{ output: "Should not run" }]);
        let resolveFactory!: (handle: ChildAgentHandle) => void;
        const factory = new Promise<ChildAgentHandle>((resolve) => {
            resolveFactory = resolve;
        });
        const manager = new AgentRunManager(async () => factory);

        const start = manager.start("scout", "Investigate", context(), {});
        await Promise.resolve();
        const shutdown = manager.shutdown();
        resolveFactory(child);

        const result = await start;
        await shutdown;
        expect(result.details.status).toBe("aborted");
        expect(child.prompts).toEqual([]);
        expect(child.disposed).toBe(true);
        expect(manager.activeCount).toBe(0);
    });

    it("spawns and collects concurrent background results", async () => {
        const children = [
            new FakeChild([{ output: "First result", usage: usage(10, 2) }]),
            new FakeChild([{ output: "Second result", usage: usage(20, 4) }]),
        ];
        const contexts: boolean[] = [];
        let index = 0;
        const manager = new AgentRunManager(async (childContext) => {
            contexts.push(childContext.background === true);
            return children[index++]!;
        });

        const first = manager.spawn("scout", "First task", context(), {});
        const second = manager.spawn("scout", "Second task", context(), {});

        expect(first.details).toMatchObject({ runId: "scout-1", status: "starting", background: true });
        expect(first.content).toContain("Do not sleep or poll");
        expect(first.content).toContain("automatic notification");
        expect(second.details).toMatchObject({ runId: "scout-2", status: "starting", background: true });
        expect(manager.activeCount).toBe(2);
        await flushBackground();
        expect(manager.listRuns().map((run) => run.status)).toEqual(["completed", "completed"]);
        expect(manager.activeCount).toBe(0);
        expect(contexts).toEqual([true, true]);

        const collected = manager.collect("scout-1");
        expect(collected.content).toBe("First result");
        expect(collected.usage).toMatchObject({ input: 10, output: 2 });
        expect(() => manager.collect("scout-1")).toThrow("Unknown or stale");

        const status = manager.status("scout-2");
        expect(status.usage).toMatchObject({ input: 20, output: 4 });
        const secondCollected = manager.collect("scout-2");
        expect(secondCollected.content).toBe("Second result");
        expect(secondCollected.usage).toMatchObject({ input: 0, output: 0 });
        await manager.shutdown();
    });

    it("resumes a waiting background run without blocking and preserves usage deltas", async () => {
        const child = new FakeChild([
            {
                output: "Partial",
                question: { question: "Which implementation?" },
                usage: usage(12, 3),
            },
            { output: "Final answer", usage: usage(5, 2) },
        ]);
        const manager = managerWith(child);
        const notifications: AgentRunStatus[] = [];

        manager.spawn(
            "scout",
            "Investigate",
            context(),
            {
                signal: undefined,
                onBackgroundUpdate: (details) => notifications.push(details.status),
            },
        );
        await flushBackground();
        expect(manager.listRuns()[0]?.status).toBe("waiting_for_parent");
        expect(notifications).toContain("waiting_for_parent");
        await expect(manager.resume("scout-1", {})).rejects.toThrow("require parent guidance");

        const resumed = await manager.resume("scout-1", { guidance: "Inspect A" });
        expect(resumed.details.status).toBe("running");
        expect(resumed.content).toContain("Do not sleep or poll");
        expect(resumed.content).toContain("automatic notification");
        expect(resumed.usage).toMatchObject({ input: 12, output: 3 });
        await flushBackground();
        expect(notifications[notifications.length - 1]).toBe("completed");

        const collected = manager.collect("scout-1");
        expect(collected.details.status).toBe("completed");
        expect(collected.content).toBe("Final answer");
        expect(collected.usage).toMatchObject({ input: 5, output: 2 });
    });

    it("cancels a running background child", async () => {
        const child = new FakeChild([{ waitForAbort: true }]);
        const manager = managerWith(child);

        manager.spawn("scout", "Keep investigating", context(), {});
        await flushBackground();
        expect(manager.listRuns()[0]?.status).toBe("running");

        const canceled = await manager.cancel("scout-1");

        expect(canceled.details.status).toBe("canceled");
        expect(child.abortCount).toBeGreaterThan(0);
        expect(child.disposed).toBe(true);
        expect(manager.activeCount).toBe(0);
        expect(() => manager.status("scout-1")).toThrow("Unknown or stale");
    });

    it("retains background setup failures for collection", async () => {
        const manager = new AgentRunManager(async () => {
            throw new Error("provider unavailable");
        });

        manager.spawn("scout", "Investigate", context(), {});
        await flushBackground();

        expect(manager.listRuns()[0]?.status).toBe("failed");
        const collected = manager.collect("scout-1");
        expect(collected.isError).toBe(true);
        expect(collected.content).toContain("provider unavailable");
        expect(manager.listRuns()).toEqual([]);
    });

    it("shuts down waiting and running background children", async () => {
        const children = [
            new FakeChild([{ question: { question: "Need guidance?" } }]),
            new FakeChild([{ waitForAbort: true }]),
        ];
        let index = 0;
        const manager = new AgentRunManager(async () => children[index++]!);

        manager.spawn("scout", "Wait", context(), {});
        manager.spawn("scout", "Run", context(), {});
        await flushBackground();
        expect(manager.listRuns().map((run) => run.status)).toEqual([
            "waiting_for_parent",
            "running",
        ]);

        await manager.shutdown();

        expect(children.every((child) => child.disposed)).toBe(true);
        expect(children[1]!.abortCount).toBeGreaterThan(0);
        expect(manager.listRuns()).toEqual([]);
    });

    it("bounds retained background results independently of active runs", async () => {
        const children = Array.from(
            { length: 3 },
            (_, index) => new FakeChild([{ output: `Result ${index + 1}` }]),
        );
        let index = 0;
        const manager = new AgentRunManager(
            async () => children[index++]!,
            4,
            undefined,
            2,
        );

        manager.spawn("scout", "One", context(), {});
        manager.spawn("scout", "Two", context(), {});
        manager.spawn("scout", "Three", context(), {});
        await flushBackground();

        expect(manager.listRuns().map((run) => run.runId)).toEqual(["scout-2", "scout-3"]);
        expect(() => manager.collect("scout-1")).toThrow("Unknown or stale");
        expect(manager.activeCount).toBe(0);
    });

    it("uses a fresh monotonic run ID after terminal cleanup", async () => {
        const children = [
            new FakeChild([{ output: "Done" }]),
            new FakeChild([{ question: { question: "Continue?" } }]),
        ];
        let index = 0;
        const manager = new AgentRunManager(async () => children[index++]!);

        expect((await manager.start("scout", "First", context(), {})).details.runId).toBe("scout-1");
        expect((await manager.start("scout", "Second", context(), {})).details.runId).toBe("scout-2");
    });

    it("allows only one active mutation-capable worker while scouts continue", async () => {
        const children = [
            new FakeChild([{ waitForAbort: true }]),
            new FakeChild([{ output: "Scout result" }]),
        ];
        let index = 0;
        const manager = new AgentRunManager(async () => children[index++]!);

        manager.spawn(BUILTIN_WORKER, "Implement", context(), {});
        expect(() => manager.spawn(BUILTIN_WORKER, "Also implement", context(), {}))
            .toThrow("same-checkout mutation-capable worker is already active");
        expect(() => manager.spawn(BUILTIN_SCOUT, "Inspect", context(), {})).not.toThrow();

        await flushBackground();
        await manager.cancel("worker-1");
        await manager.shutdown();
    });

    it("allows mutation-capable workers in distinct isolated worktrees to run concurrently", async () => {
        const children = [
            new FakeChild([{ waitForAbort: true }]),
            new FakeChild([{ waitForAbort: true }]),
        ];
        let index = 0;
        const manager = new AgentRunManager(async () => children[index++]!);

        manager.spawn(BUILTIN_WORKER, "Implement one", {
            ...context(),
            workspaceId: "workspace-one",
        }, {});
        manager.spawn(BUILTIN_WORKER, "Implement two", {
            ...context(),
            workspaceId: "workspace-two",
        }, {});

        await flushBackground();
        await manager.cancel("worker-1");
        await manager.cancel("worker-2");
        await manager.shutdown();
    });

    it("adds an authoritative changed-file report to worker outcomes", async () => {
        const child = new FakeChild([{ output: "Implemented the change." }]);
        (child as ChildAgentHandle).getMutationReport = () => ({
            changedFiles: ["src/example.ts", "test/example.test.ts"],
            bashApproved: true,
        });
        const manager = managerWith(child);

        const result = await manager.start(BUILTIN_WORKER, "Implement", context(), {});

        expect(result.details).toMatchObject({
            mutating: true,
            status: "completed",
            mutationReport: {
                changedFiles: ["src/example.ts", "test/example.test.ts"],
                bashApproved: true,
            },
        });
        expect(result.content).toBe("Implemented the change.");
    });

    it("exposes permission-waiting progress without consuming another run state", async () => {
        const child = new FakeChild([{ waitForAbort: true }]);
        const manager = new AgentRunManager(async (childContext) => {
            queueMicrotask(() => childContext.onProgress({
                output: "",
                recentActivity: ["Waiting for permission to edit src/example.ts"],
                permissionPending: true,
            }));
            return child;
        });

        manager.spawn(BUILTIN_WORKER, "Implement", context(), {});
        await flushBackground();

        expect(manager.listRuns()[0]).toMatchObject({
            status: "waiting_for_permission",
            mutating: true,
        });
        await manager.cancel("worker-1");
    });

    it("retains completed child transcripts after collection for past-session browsing", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-sessions-"));
        tempDirs.push(dir);
        const store = durableStore(dir);
        const child = new FakeChild([{ output: "Persisted result" }], path.join(dir, "child.jsonl"));
        const manager = new AgentRunManager(async () => child);
        manager.setPersistence(store.persistence);

        manager.spawn(BUILTIN_SCOUT, "Inspect", context(), {});
        await flushBackground();
        manager.collect("scout-1");

        expect(store.deletedChildSessions).toEqual([]);
    });

    it("restores a durable waiting run and resumes the same child transcript", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-sessions-"));
        tempDirs.push(dir);
        const store = durableStore(dir);
        const childFile = path.join(dir, "child.jsonl");
        const firstChild = new FakeChild([{
            question: { question: "Which approach?" },
            output: "Investigated",
            usage: usage(8, 2),
        }], childFile);
        const firstManager = new AgentRunManager(async () => firstChild);
        firstManager.setPersistence(store.persistence);

        const waiting = await firstManager.start(BUILTIN_SCOUT, "Investigate", context(), {});
        expect(waiting.details.status).toBe("waiting_for_parent");
        await firstManager.shutdown();
        expect(store.records.at(-1)).toMatchObject({
            runId: "scout-1",
            status: "waiting_for_parent",
            childSessionFile: childFile,
        });
        store.records.at(-1)!.definitionFingerprint = fingerprintLegacyAgentDefinition(BUILTIN_SCOUT);

        const restoredChild = new FakeChild([{ output: "Finished", usage: usage(3, 1) }], childFile);
        let restoredContext: any;
        const secondManager = new AgentRunManager(async (factoryContext) => {
            restoredContext = factoryContext;
            return restoredChild;
        });
        secondManager.setPersistence(store.persistence);
        const restoration = await secondManager.restore(
            latestRecords(store.records),
            [BUILTIN_SCOUT, BUILTIN_WORKER],
            context(),
        );

        expect(restoration).toEqual({ restored: 1, diagnostics: [] });
        expect(secondManager.listRuns()[0]).toMatchObject({ runId: "scout-1", status: "waiting_for_parent" });
        expect(restoredContext).toMatchObject({ childSessionFile: childFile, repairInterrupted: false });
        const completed = await secondManager.resume("scout-1", { guidance: "Use the simpler approach" });
        expect(completed.details.status).toBe("completed");
        await expect(restoredChild.prompts[0]).toMatchFileSnapshot("__snapshots__/agent-manager.resume-guidance.txt");
    });

    it("fails fast when a resumable snapshot has no definition snapshot", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-missing-definition-snapshot-"));
        tempDirs.push(dir);
        const store = durableStore(dir);
        const childFile = path.join(dir, "child.jsonl");
        const firstManager = new AgentRunManager(async () => new FakeChild([
            { question: { question: "Continue?" } },
        ], childFile));
        firstManager.setPersistence(store.persistence);
        await firstManager.start(BUILTIN_SCOUT, "Inspect", context(), {});
        await firstManager.shutdown();
        const missingSnapshot = { ...latestRecords(store.records)[0]! };
        delete missingSnapshot.definitionSnapshot;

        let created = false;
        const secondManager = new AgentRunManager(async () => {
            created = true;
            return new FakeChild([]);
        });
        secondManager.setPersistence(store.persistence);
        const restoration = await secondManager.restore([missingSnapshot], [BUILTIN_SCOUT], context());

        expect(restoration).toEqual({
            restored: 0,
            diagnostics: ["Could not restore scout-1: its persisted agent definition snapshot is unavailable; start a new run."],
        });
        expect(created).toBe(false);
    });

    it("continues using the persisted definition when the current definition changes", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-definition-drift-"));
        tempDirs.push(dir);
        const store = durableStore(dir);
        const childFile = path.join(dir, "child.jsonl");
        const firstManager = new AgentRunManager(async () => new FakeChild([
            { question: { question: "Continue?" } },
        ], childFile));
        firstManager.setPersistence(store.persistence);
        await firstManager.start(BUILTIN_SCOUT, "Inspect", context(), {});
        await firstManager.shutdown();
        const changedDefinition = { ...BUILTIN_SCOUT, systemPrompt: "Updated role instructions" };
        let restoredDefinition: unknown;
        const secondManager = new AgentRunManager(async (factoryContext) => {
            restoredDefinition = factoryContext.definition;
            return new FakeChild([], childFile);
        });
        secondManager.setPersistence(store.persistence);
        const restoration = await secondManager.restore(
            latestRecords(store.records),
            [changedDefinition],
            context(),
        );

        expect(restoration.restored).toBe(1);
        expect(restoration.diagnostics).toEqual([
            "Restored scout-1 using its persisted agent definition snapshot; the current definition has changed.",
        ]);
        expect(restoredDefinition).toEqual(BUILTIN_SCOUT);
    });

    it("restores an uncollected terminal result without requiring the old definition", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-sessions-"));
        tempDirs.push(dir);
        const store = durableStore(dir);
        const child = new FakeChild([{ output: "Persisted result", usage: usage(6, 2) }], path.join(dir, "child.jsonl"));
        const firstManager = new AgentRunManager(async () => child);
        firstManager.setPersistence(store.persistence);
        firstManager.spawn(BUILTIN_SCOUT, "Inspect", context(), {});
        await flushBackground();
        expect(firstManager.listRuns()[0]?.status).toBe("completed");

        const secondManager = new AgentRunManager(async () => {
            throw new Error("terminal restoration must not create a child");
        });
        secondManager.setPersistence(store.persistence);
        const restoration = await secondManager.restore(latestRecords(store.records), [], context());
        expect(restoration).toEqual({ restored: 1, diagnostics: [] });
        const collected = secondManager.collect("scout-1");
        expect(collected.content).toBe("Persisted result");
        expect(collected.usage).toMatchObject({ input: 6, output: 2 });
    });

    it("keeps durable state recoverable when reopening the child fails", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-sessions-"));
        tempDirs.push(dir);
        const store = durableStore(dir);
        const childFile = path.join(dir, "child.jsonl");
        const child = new FakeChild([{ question: { question: "Continue?" } }], childFile);
        const firstManager = new AgentRunManager(async () => child);
        firstManager.setPersistence(store.persistence);
        await firstManager.start(BUILTIN_SCOUT, "Inspect", context(), {});
        await firstManager.shutdown();
        const saved = latestRecords(store.records);

        const secondManager = new AgentRunManager(async () => {
            throw new Error("provider auth is temporarily unavailable");
        });
        secondManager.setPersistence(store.persistence);
        const restoration = await secondManager.restore(saved, [BUILTIN_SCOUT], context());

        expect(restoration.restored).toBe(0);
        expect(restoration.diagnostics[0]).toContain("temporarily unavailable");
        expect(secondManager.listRuns()).toEqual([]);
        expect(latestRecords(store.records)[0]).toMatchObject({
            status: "waiting_for_parent",
            childSessionFile: childFile,
        });
    });

    it("does not let persisted metadata remove the worker mutation capability", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-sessions-"));
        tempDirs.push(dir);
        const store = durableStore(dir);
        const childFile = path.join(dir, "child.jsonl");
        const child = new FakeChild([{ question: { question: "Continue?" } }], childFile);
        const firstManager = new AgentRunManager(async () => child);
        firstManager.setPersistence(store.persistence);
        await firstManager.start(BUILTIN_WORKER, "Implement", context(), {});
        await firstManager.shutdown();
        const forged = { ...latestRecords(store.records)[0]!, mutating: false };

        let created = false;
        const secondManager = new AgentRunManager(async () => {
            created = true;
            return new FakeChild([]);
        });
        secondManager.setPersistence(store.persistence);
        const restoration = await secondManager.restore([forged], [BUILTIN_WORKER], context());
        expect(restoration.restored).toBe(0);
        expect(restoration.diagnostics[0]).toContain("cannot alter mutation capability");
        expect(created).toBe(false);
    });

    it("restores a running durable child as interrupted without replaying it", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-sessions-"));
        tempDirs.push(dir);
        const store = durableStore(dir);
        const childFile = path.join(dir, "child.jsonl");
        const runningChild = new FakeChild([{ waitForAbort: true }], childFile);
        const firstManager = new AgentRunManager(async () => runningChild);
        firstManager.setPersistence(store.persistence);
        firstManager.spawn(BUILTIN_WORKER, "Implement", context(), {});
        await flushBackground();
        await firstManager.shutdown();
        expect(store.records.at(-1)).toMatchObject({ status: "interrupted" });

        const restoredChild = new FakeChild([{ output: "Safely continued" }], childFile);
        let restoredContext: any;
        const secondManager = new AgentRunManager(async (factoryContext) => {
            restoredContext = factoryContext;
            return restoredChild;
        });
        secondManager.setPersistence(store.persistence);
        await secondManager.restore(latestRecords(store.records), [BUILTIN_SCOUT, BUILTIN_WORKER], context());

        expect(secondManager.listRuns()[0]).toMatchObject({ status: "interrupted", mutating: true });
        expect(restoredChild.prompts).toEqual([]);
        expect(restoredContext.repairInterrupted).toBe(true);
        const resumed = await secondManager.resume("worker-1", {});
        expect(resumed.details.status).toBe("running");
        await flushBackground();
        expect(secondManager.listRuns()[0]?.status).toBe("completed");
    });

    it("waits for a crashed continuation lease to expire while restoring", async () => {
        const childFile = path.join(os.tmpdir(), "pi-agent-crashed-child.jsonl");
        const record: PersistedAgentRun = {
            version: 1,
            ownerSessionId: "parent-session",
            runId: "scout-1",
            runInstanceId: "crashed-instance",
            title: "Crashed run",
            agent: "scout",
            agentSource: "builtin",
            definitionFingerprint: fingerprintAgentDefinition(BUILTIN_SCOUT),
            definitionSnapshot: BUILTIN_SCOUT,
            task: "Inspect",
            status: "interrupted",
            background: false,
            mutating: false,
            progress: { output: "", recentActivity: [] },
            usageCheckpoint: usage(),
            usageSnapshot: usage(),
            startedAt: 1,
            updatedAt: 2,
            childSessionFile: childFile,
        };
        let attempts = 0;
        const persistence: AgentRunPersistence = {
            ownerSessionId: "parent-session",
            usesSnapshotMarkers: true,
            childSessionDir: os.tmpdir(),
            save: () => true,
            acquireContinuationLease: () => {
                attempts++;
                if (attempts === 1) {
                    throw new AgentContinuationLeaseBusyError(Date.now() + CONTINUATION_LEASE_RECOVERY_GRACE_MS);
                }
                return { release() {} };
            },
            deleteChildSession: () => {},
        };
        const manager = new AgentRunManager(async () => new FakeChild([], childFile));
        manager.setPersistence(persistence);

        vi.useFakeTimers();
        try {
            const restoration = manager.restore([record], [BUILTIN_SCOUT], context());
            await vi.runAllTimersAsync();
            await expect(restoration).resolves.toEqual({ restored: 1, diagnostics: [] });
        } finally {
            vi.useRealTimers();
        }
        expect(attempts).toBe(2);
        expect(manager.listRuns()[0]).toMatchObject({ runId: "scout-1", status: "interrupted" });
    });

    it("cancels continuation-lease recovery during shutdown", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-restore-cancel-"));
        tempDirs.push(directory);
        const store = durableStore(directory);
        const childFile = path.join(directory, "child.jsonl");
        const firstManager = new AgentRunManager(async () => new FakeChild([
            { question: { question: "Continue?" } },
        ], childFile));
        firstManager.setPersistence(store.persistence);
        await firstManager.start(BUILTIN_SCOUT, "Inspect", context(), {});
        await firstManager.shutdown();
        store.records.at(-1)!.childSessionLeafId = "leaf-1";
        store.records.at(-1)!.resumable = true;

        const persistence: AgentRunPersistence = {
            ...store.persistence,
            usesSnapshotMarkers: true,
            acquireContinuationLease: () => {
                throw new AgentContinuationLeaseBusyError(Date.now() + 60_000);
            },
        };
        const manager = new AgentRunManager(async () => new FakeChild([], childFile));
        manager.setPersistence(persistence);
        const restoration = manager.restore(latestRecords(store.records), [BUILTIN_SCOUT], context());

        await manager.shutdown();
        await expect(restoration).resolves.toEqual({ restored: 0, diagnostics: [] });
    });

    it("aborts a resume while waiting for continuation ownership", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-resume-cancel-"));
        tempDirs.push(directory);
        const store = durableStore(directory);
        const childFile = path.join(directory, "child.jsonl");
        const firstManager = new AgentRunManager(async () => new FakeChild([
            { question: { question: "Continue?" } },
        ], childFile));
        firstManager.setPersistence(store.persistence);
        await firstManager.start(BUILTIN_SCOUT, "Inspect", context(), {});
        await firstManager.shutdown();
        store.records.at(-1)!.childSessionLeafId = "leaf-1";
        store.records.at(-1)!.resumable = true;

        let attempts = 0;
        const persistence: AgentRunPersistence = {
            ...store.persistence,
            usesSnapshotMarkers: true,
            acquireContinuationLease: () => {
                attempts++;
                if (attempts === 1) return { release() {} };
                throw new AgentContinuationLeaseBusyError(Date.now() + 60_000);
            },
        };
        const manager = new AgentRunManager(async () => new FakeChild([], childFile));
        manager.setPersistence(persistence);
        await manager.restore(latestRecords(store.records), [BUILTIN_SCOUT], context());

        const controller = new AbortController();
        const resume = manager.resume("scout-1", { guidance: "Continue", signal: controller.signal });
        await Promise.resolve();
        controller.abort();
        await expect(resume).rejects.toThrow("aborted before acquiring the continuation lease");
        expect(attempts).toBe(2);
        await manager.shutdown();
    });

    it("restores the prior waiting state when a V2 resume checkpoint cannot be persisted", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-resume-failure-"));
        tempDirs.push(directory);
        const records: PersistedAgentRun[] = [];
        let failSaves = false;
        let releaseCount = 0;
        const persistence: AgentRunPersistence = {
            ownerSessionId: "parent-session",
            usesSnapshotMarkers: true,
            childSessionDir: directory,
            save: (record) => {
                if (failSaves) return false;
                records.push(structuredClone(record));
                return true;
            },
            acquireContinuationLease: () => ({ release: () => { releaseCount++; } }),
            deleteChildSession: () => {},
        };
        const firstManager = new AgentRunManager(async () => new FakeChild(
            [{ question: { question: "Continue?" }, leafId: "leaf-1" }],
            path.join(directory, "child.jsonl"),
        ));
        firstManager.setPersistence(persistence);
        const waiting = await firstManager.start(BUILTIN_SCOUT, "Inspect", context(), {});
        expect(waiting.details.status).toBe("waiting_for_parent");

        const resumedChild = new FakeChild([], path.join(directory, "child.jsonl"));
        const secondManager = new AgentRunManager(async () => resumedChild);
        secondManager.setPersistence(persistence);
        const restoration = await secondManager.restore(latestRecords(records), [BUILTIN_SCOUT], context());
        expect(restoration.restored).toBe(1);
        failSaves = true;
        await expect(secondManager.resume("scout-1", { guidance: "Continue" })).rejects.toThrow("Could not persist");
        expect(secondManager.listRuns()[0]).toMatchObject({ status: "waiting_for_parent" });
        expect(resumedChild.prompts).toEqual([]);
        expect(releaseCount).toBeGreaterThanOrEqual(2);
    });

    it("rejects unknown and stale resume IDs", async () => {
        const manager = managerWith(new FakeChild([{ output: "Done" }]));

        await expect(manager.resume("scout-999", { guidance: "Continue" })).rejects.toThrow("Unknown or stale");
        const completed = await manager.start("scout", "Investigate", context(), {});
        await expect(
            manager.resume(completed.details.runId, { guidance: "Continue" }),
        ).rejects.toThrow("Unknown or stale");
    });
});

describe("scout confinement", () => {
    it("allows cwd paths and blocks outside and sensitive paths", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-agent-"));
        tempDirs.push(cwd);
        fs.writeFileSync(path.join(cwd, "safe.txt"), "safe");
        fs.writeFileSync(path.join(cwd, ".env"), "secret");

        expect(isChildPathAllowed(undefined, cwd)).toBe(true);
        expect(isChildPathAllowed("safe.txt", cwd)).toBe(true);
        expect(isChildPathAllowed(path.join(cwd, "safe.txt"), cwd)).toBe(true);
        expect(isChildPathAllowed(path.join(cwd, ".env"), cwd)).toBe(false);
        expect(isChildPathAllowed(path.join("..", "outside.txt"), cwd)).toBe(false);
        expect(isChildPathAllowed(path.dirname(cwd), cwd)).toBe(false);

        const additional = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-agent-additional-"));
        tempDirs.push(additional);
        expect(isChildPathAllowed(path.join(additional, "notes.md"), cwd)).toBe(false);
        expect(isChildPathAllowed(path.join(additional, "notes.md"), cwd, {
            additionalRoots: [additional],
        })).toBe(true);
        expect(agentAdditionalPaths(BUILTIN_SCOUT)).toContain(
            path.join(os.homedir(), ".pi", "agent", "memory"),
        );
    });

    it("passes named additional roots to child path and Bash confinement", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-agent-"));
        const additional = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-agent-additional-"));
        tempDirs.push(cwd, additional);
        const safePath = path.join(additional, "safe.txt");
        const sensitivePath = path.join(additional, ".env");
        fs.writeFileSync(safePath, "safe");
        fs.writeFileSync(sensitivePath, "secret");

        const options = {
            additionalRoots: [additional],
            sensitiveAdditionalRoots: [additional],
        };
        expect(isChildPathAllowed(safePath, cwd, options)).toBe(true);
        expect(isChildPathAllowed(sensitivePath, cwd, {
            additionalRoots: [additional],
        })).toBe(false);
        expect(isChildPathAllowed(sensitivePath, cwd, options)).toBe(true);
        expect(isSafeBashAllowed(`cat ${sensitivePath}`, cwd, {
            additionalRoots: [additional],
            sensitiveAdditionalRoots: [],
        })).toBe(false);
        expect(isSafeBashAllowed(`cat ${sensitivePath}`, cwd, options)).toBe(true);
        expect(getSafeBashAssessment(`cat ${safePath}`, cwd, options)).toMatchObject({
            classification: "SAFE_READONLY",
        });

        expect(isSafeBashAllowed("ast-outline digest safe.txt", cwd, {
            safeBashCommands: ["ast-outline digest *"],
        })).toBe(true);
    });

    it("blocks symlinks that escape cwd", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-agent-"));
        tempDirs.push(cwd);
        fs.symlinkSync(os.tmpdir(), path.join(cwd, "outside"));
        fs.symlinkSync(
            path.join(path.dirname(cwd), `missing-${path.basename(cwd)}`),
            path.join(cwd, "broken-outside"),
        );

        expect(isChildPathAllowed(path.join(cwd, "outside"), cwd)).toBe(false);
        expect(isChildPathAllowed(path.join(cwd, "outside", "nested.txt"), cwd)).toBe(false);
        expect(isChildPathAllowed(path.join(cwd, "broken-outside"), cwd)).toBe(false);
    });

    it("allows only heuristic-classified read-only bash commands", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-agent-"));
        tempDirs.push(cwd);
        fs.writeFileSync(path.join(cwd, "safe.txt"), "safe");

        expect(isScoutBashAllowed("cat safe.txt", cwd)).toBe(true);
        expect(isScoutBashAllowed("echo changed > safe.txt", cwd)).toBe(false);
        expect(isScoutBashAllowed("cat /etc/passwd", cwd)).toBe(false);
        expect(isScoutBashAllowed("unrecognized-command", cwd)).toBe(false);
        expect(getScoutBashAssessment("cat /etc/passwd", cwd)).toMatchObject({
            classification: "UNSAFE",
            reasons: ["OUTSIDE_CWD"],
        });
    });
});
