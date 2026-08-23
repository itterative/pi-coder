import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";

import { isChildPathAllowed } from "../../src/tools/agent/child";
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

        const result = manager.cancel("scout-1");

        expect(result.details.status).toBe("canceled");
        expect(manager.activeCount).toBe(0);
        expect(child.disposed).toBe(true);
        expect(() => manager.cancel("scout-1")).toThrow(AgentActionError);
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
