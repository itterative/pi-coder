import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";

import { isChildPathAllowed } from "../../src/tools/agent/child";
import { BUILTIN_SCOUT, BUILTIN_WORKER } from "../../src/tools/agent/discovery";
import {
    AgentActionError,
    AgentRunManager,
    type ChildAgentHandle,
    type ParentQuestion,
} from "../../src/tools/agent/runtime";

interface Step {
    output?: string;
    question?: ParentQuestion;
    error?: string;
    usage?: Usage;
    waitForAbort?: boolean;
}

class FakeChild implements ChildAgentHandle {
    readonly prompts: string[] = [];
    disposed = false;
    abortCount = 0;
    private output = "";
    private question?: ParentQuestion;
    private error?: string;
    private usage = usage();
    private releaseAbort?: () => void;

    constructor(private readonly steps: Step[]) {}

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
    it("completes a run and disposes its child", async () => {
        const child = new FakeChild([{ output: "Found the answer.", usage: usage(10, 4) }]);
        const manager = managerWith(child);

        const result = await manager.start("scout", "Investigate", context());

        expect(result.details.status).toBe("completed");
        expect(result.content).toBe("Found the answer.");
        expect(result.usage).toMatchObject({ input: 10, output: 4 });
        expect(manager.activeCount).toBe(0);
        expect(child.disposed).toBe(true);
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

        const first = await manager.start("scout", "Investigate", context());
        expect(first.details.status).toBe("waiting_for_parent");
        expect(first.details.runId).toBe("scout-1");
        expect(first.content).toContain("Partial child output:\nPartial findings");
        expect(first.usage).toMatchObject({ input: 10, output: 2 });

        const second = await manager.resume("scout-1", "Inspect implementation A");
        expect(second.details.status).toBe("waiting_for_parent");
        expect(second.usage).toMatchObject({ input: 5, output: 3 });

        const final = await manager.resume("scout-1", "Yes, compare it");
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

    it("cancels only waiting runs", async () => {
        const child = new FakeChild([{ question: { question: "Continue?" } }]);
        const manager = managerWith(child);
        await manager.start("scout", "Investigate", context());

        const result = await manager.cancel("scout-1");

        expect(result.details.status).toBe("canceled");
        expect(manager.activeCount).toBe(0);
        expect(child.disposed).toBe(true);
        await expect(manager.cancel("scout-1")).rejects.toThrow(AgentActionError);
    });

    it("bounds retained runs", async () => {
        const children = Array.from({ length: 3 }, () => (
            new FakeChild([{ question: { question: "Continue?" } }])
        ));
        let index = 0;
        const manager = new AgentRunManager(async () => children[index++]!, 2);

        await manager.start("scout", "First", context());
        await manager.start("scout", "Second", context());

        await expect(manager.start("scout", "Third", context())).rejects.toThrow("run limit reached");
        expect(manager.activeCount).toBe(2);
        await manager.shutdown();
    });

    it("bridges parent cancellation to the child", async () => {
        const child = new FakeChild([{ waitForAbort: true }]);
        const manager = managerWith(child);
        const controller = new AbortController();

        const pending = manager.start("scout", "Investigate", context(), controller.signal);
        await Promise.resolve();
        controller.abort();
        const result = await pending;

        expect(result.details.status).toBe("aborted");
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

        const pending = manager.start("scout", "Investigate", context(), controller.signal);
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

        const pending = manager.start("scout", "Investigate", context());
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
        await manager.start("scout", "First", context());
        await manager.start("scout", "Second", context());

        await manager.shutdown();

        expect(manager.activeCount).toBe(0);
        expect(children.every((child) => child.disposed)).toBe(true);
        await expect(manager.start("scout", "Third", context())).rejects.toThrow("shutting down");
    });

    it("waits for in-progress child setup during shutdown and disposes the result", async () => {
        const child = new FakeChild([{ output: "Should not run" }]);
        let resolveFactory!: (handle: ChildAgentHandle) => void;
        const factory = new Promise<ChildAgentHandle>((resolve) => {
            resolveFactory = resolve;
        });
        const manager = new AgentRunManager(async () => factory);

        const start = manager.start("scout", "Investigate", context());
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

        const first = manager.spawn("scout", "First task", context());
        const second = manager.spawn("scout", "Second task", context());

        expect(first.details).toMatchObject({ runId: "scout-1", status: "starting", background: true });
        expect(first.content).toContain("Do not poll its status");
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
            undefined,
            (details) => notifications.push(details.status),
        );
        await flushBackground();
        expect(manager.listRuns()[0]?.status).toBe("waiting_for_parent");
        expect(notifications).toContain("waiting_for_parent");

        const resumed = await manager.resume("scout-1", "Inspect A");
        expect(resumed.details.status).toBe("running");
        expect(resumed.content).toContain("Do not poll its status");
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

        manager.spawn("scout", "Keep investigating", context());
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

        manager.spawn("scout", "Investigate", context());
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

        manager.spawn("scout", "Wait", context());
        manager.spawn("scout", "Run", context());
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

        manager.spawn("scout", "One", context());
        manager.spawn("scout", "Two", context());
        manager.spawn("scout", "Three", context());
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

        expect((await manager.start("scout", "First", context())).details.runId).toBe("scout-1");
        expect((await manager.start("scout", "Second", context())).details.runId).toBe("scout-2");
    });

    it("allows only one active mutation-capable worker while scouts continue", async () => {
        const children = [
            new FakeChild([{ waitForAbort: true }]),
            new FakeChild([{ output: "Scout result" }]),
        ];
        let index = 0;
        const manager = new AgentRunManager(async () => children[index++]!);

        manager.spawn(BUILTIN_WORKER, "Implement", context());
        expect(() => manager.spawn(BUILTIN_WORKER, "Also implement", context()))
            .toThrow("mutation-capable worker is already active");
        expect(() => manager.spawn(BUILTIN_SCOUT, "Inspect", context())).not.toThrow();

        await flushBackground();
        await manager.cancel("worker-1");
        await manager.shutdown();
    });

    it("adds an authoritative changed-file report to worker outcomes", async () => {
        const child = new FakeChild([{ output: "Implemented the change." }]);
        (child as ChildAgentHandle).getMutationReport = () => ({
            changedFiles: ["src/example.ts", "test/example.test.ts"],
            bashApproved: true,
        });
        const manager = managerWith(child);

        const result = await manager.start(BUILTIN_WORKER, "Implement", context());

        expect(result.details).toMatchObject({ mutating: true, status: "completed" });
        expect(result.content).toContain("src/example.ts");
        expect(result.content).toContain("bash commands may have changed additional files");
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

        manager.spawn(BUILTIN_WORKER, "Implement", context());
        await flushBackground();

        expect(manager.listRuns()[0]).toMatchObject({
            status: "waiting_for_permission",
            mutating: true,
        });
        await manager.cancel("worker-1");
    });

    it("rejects unknown and stale resume IDs", async () => {
        const manager = managerWith(new FakeChild([{ output: "Done" }]));

        await expect(manager.resume("scout-999", "Continue")).rejects.toThrow("Unknown or stale");
        const completed = await manager.start("scout", "Investigate", context());
        await expect(manager.resume(completed.details.runId, "Continue")).rejects.toThrow("Unknown or stale");
    });
});

describe("scout path confinement", () => {
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
});
