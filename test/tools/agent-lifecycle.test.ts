import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";

import {
    BUILTIN_ADVISOR,
    BUILTIN_WORKER,
} from "../../src/tools/agent/definitions/discovery";
import {
    AGENT_EVENT_CHANNEL,
    AGENT_STATUS_EVENT,
} from "../../src/tools/agent/observability/events";
import type { ChildAgentHandle } from "../../src/tools/agent/contracts/runs";
import type { WorkerMutationReport } from "../../src/tools/agent/contracts/mutations";
import { AgentLifecycle } from "../../src/tools/agent/lifecycle";
import { ZERO_USAGE } from "../../src/tools/agent/runs/usage";

class BlockingChild implements ChildAgentHandle {
    private releasePrompt?: () => void;
    private mutationReport: WorkerMutationReport = { changedFiles: [], bashApproved: false };

    setChangedFiles(changedFiles: string[]): void {
        this.mutationReport = { changedFiles: [...changedFiles], bashApproved: false };
    }

    async prompt(): Promise<void> {
        await new Promise<void>((resolve) => {
            this.releasePrompt = resolve;
        });
    }

    async abort(): Promise<void> {
        this.releasePrompt?.();
    }

    release(): void {
        this.releasePrompt?.();
    }

    dispose(): void {}

    takeParentQuestion(): undefined {
        return undefined;
    }

    getProgress() {
        return { output: "", recentActivity: [] };
    }

    getFinalOutput(): string {
        return "Done";
    }

    getError(): undefined {
        return undefined;
    }

    getUsage() {
        return { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
    }

    getMutationReport(): WorkerMutationReport {
        return this.mutationReport;
    }
}

interface LifecycleFixture {
    lifecycle: AgentLifecycle;
    child: BlockingChild;
    changed: (files: string[]) => void;
    messages: ReturnType<typeof vi.fn>;
    root: string;
}

const fixtures: LifecycleFixture[] = [];
const previousGlobalConfigPath = process.env.AGENT_CONFIG_PATH_GLOBAL;
const previousProjectConfigPath = process.env.AGENT_CONFIG_PATH;

async function flushBackground(): Promise<void> {
    for (let index = 0; index < 12; index++) await Promise.resolve();
}

async function fixture(
    notifyBusyWorkerChanges: boolean | undefined,
    parentIdle: boolean,
): Promise<LifecycleFixture> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-lifecycle-"));
    const globalConfigPath = path.join(root, "global.json");
    if (notifyBusyWorkerChanges !== undefined) {
        fs.writeFileSync(globalConfigPath, JSON.stringify({ notifyBusyWorkerChanges }));
    }
    process.env.AGENT_CONFIG_PATH_GLOBAL = globalConfigPath;
    delete process.env.AGENT_CONFIG_PATH;

    const events = createEventBus();
    const messages = vi.fn();
    const pi = {
        events,
        sendMessage: messages,
    } as any;
    const child = new BlockingChild();
    let onFileChanged: ((filePath: string) => void) | undefined;
    const lifecycle = new AgentLifecycle(pi, async (context) => {
        onFileChanged = context.onFileChanged;
        return child;
    });
    const ctx = {
        cwd: root,
        isIdle: () => parentIdle,
        ui: {
            notify: vi.fn(),
            setWidget: vi.fn(),
        },
    } as any;

    await lifecycle.manager.start(
        BUILTIN_WORKER,
        "Make a change",
        { cwd: root, parentContext: ctx },
        {
            signal: undefined,
            onBackgroundUpdate: lifecycle.backgroundUpdate(ctx),
            background: true,
        },
    );
    await flushBackground();
    if (!onFileChanged) throw new Error("Worker file-change callback was not installed.");

    const result: LifecycleFixture = {
        lifecycle,
        child,
        changed: (files) => {
            child.setChangedFiles(files);
            onFileChanged!(files[files.length - 1] ?? "");
        },
        messages,
        root,
    };
    fixtures.push(result);
    return result;
}

afterEach(async () => {
    for (const value of fixtures.splice(0)) {
        await value.lifecycle.manager.cancel("worker-1").catch(() => {});
        await value.lifecycle.manager.shutdown().catch(() => {});
        fs.rmSync(value.root, { recursive: true, force: true });
    }
    if (previousGlobalConfigPath === undefined) delete process.env.AGENT_CONFIG_PATH_GLOBAL;
    else process.env.AGENT_CONFIG_PATH_GLOBAL = previousGlobalConfigPath;
    if (previousProjectConfigPath === undefined) delete process.env.AGENT_CONFIG_PATH;
    else process.env.AGENT_CONFIG_PATH = previousProjectConfigPath;
});

describe("agent lifecycle worker-change notifications", () => {
    it("delivers a detached advisor completion through the parent mailbox", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-advisor-mailbox-"));
        const events = createEventBus();
        const messages = vi.fn();
        const child = new BlockingChild();
        const lifecycle = new AgentLifecycle({ events, sendMessage: messages } as any, async () => child);
        const ctx = {
            cwd: root,
            isIdle: () => true,
            ui: { notify: vi.fn(), setWidget: vi.fn() },
        } as any;

        try {
            const pending = lifecycle.manager.start(
                BUILTIN_ADVISOR,
                "Advise on the implementation",
                { cwd: root, parentContext: ctx },
                { onBackgroundUpdate: lifecycle.backgroundUpdate(ctx) },
            );
            await vi.waitFor(() => expect(lifecycle.manager.listRuns()[0]?.status).toBe("running"));
            await flushBackground();

            const moved = lifecycle.manager.moveForegroundToBackground();
            expect(moved).toMatchObject({
                details: { agent: "advisor", background: true, status: "running" },
            });

            child.release();
            await expect(pending).resolves.toMatchObject({
                details: { agent: "advisor", background: true, status: "running" },
            });
            await vi.waitFor(() => expect(
                lifecycle.manager.status("advisor-1").details.status,
            ).toBe("completed"));
            await vi.waitFor(() => expect(messages).toHaveBeenCalledTimes(1));

            expect(messages.mock.calls[0]?.[1]).toEqual({
                deliverAs: "followUp",
                triggerTurn: true,
            });
            await expect(messages.mock.calls[0]?.[0].content).toMatchFileSnapshot(
                "__snapshots__/agent-lifecycle.advisor-mailbox-completion.txt",
            );
        } finally {
            await lifecycle.manager.shutdown();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("publishes status for isolated run events using the parent cwd", async () => {
        const events = createEventBus();
        const statusSnapshots: unknown[] = [];
        events.on(AGENT_STATUS_EVENT, (data) => {
            statusSnapshots.push(data);
        });
        const lifecycle = new AgentLifecycle({ events, sendMessage: vi.fn() } as any);
        (lifecycle as any).activeContext = { cwd: "/repo/project" };

        events.emit(AGENT_EVENT_CHANNEL, {
            type: "run",
            action: "created",
            cwd: "/tmp/worktree",
            parentCwd: "/repo/project",
            timestamp: Date.now(),
            runId: "worker-1",
            agent: "worker",
            background: false,
            status: "starting",
        });

        expect(statusSnapshots).toHaveLength(1);
        await lifecycle.manager.shutdown();
    });

    it("publishes an empty status after clearing setup rows during a tree change", async () => {
        const events = createEventBus();
        const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
        const statusSnapshots: Array<{ runs: unknown[]; hiddenCount: number }> = [];
        events.on(AGENT_STATUS_EVENT, (data) => {
            statusSnapshots.push(data as { runs: unknown[]; hiddenCount: number });
        });
        const pi = {
            events,
            on(event: string, handler: (event: unknown, ctx: any) => unknown) {
                const registered = handlers.get(event) ?? [];
                registered.push(handler);
                handlers.set(event, registered);
            },
            sendMessage: vi.fn(),
        } as any;
        const lifecycle = new AgentLifecycle(pi, async () => new BlockingChild());
        lifecycle.register();
        const ctx = {
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => true,
            ui: { notify: vi.fn(), setWidget: vi.fn() },
        } as any;
        lifecycle.updateSetupRun(ctx, "workspace-setup-1", { id: "workspace-1", slug: "workspace" } as any, {
            status: "completed",
            activity: "Setup complete",
        });
        expect(statusSnapshots.at(-1)?.runs).toHaveLength(1);

        await handlers.get("session_tree")?.[0]?.({}, ctx);

        expect(statusSnapshots.at(-1)).toEqual({ runs: [], hiddenCount: 0 });
        await lifecycle.manager.shutdown();
        events.clear();
    });


    it("notifies a busy parent once per newly changed path", async () => {
        const value = await fixture(true, false);

        value.changed(["src/one.ts"]);
        value.changed(["src/one.ts"]);
        value.changed(["src/one.ts", "src/two.ts"]);

        expect(value.messages).toHaveBeenCalledTimes(2);
        expect(value.messages.mock.calls[0]?.[1]).toEqual({
            deliverAs: "steer",
            triggerTurn: true,
        });
        expect(value.messages.mock.calls[0]?.[0].content).toContain('"src/one.ts"');
        expect(value.messages.mock.calls[1]?.[0].content).toContain('"src/two.ts"');
    });

    it("does not send immediate changes when the setting is disabled", async () => {
        const value = await fixture(false, false);

        value.changed(["src/example.ts"]);

        expect(value.messages).not.toHaveBeenCalled();
    });

    it("defers changes for an idle parent to the terminal notification", async () => {
        const value = await fixture(true, true);

        value.changed(["src/example.ts"]);

        expect(value.messages).not.toHaveBeenCalled();
    });
});
