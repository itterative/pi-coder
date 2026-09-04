import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { executeAgentAction } from "../../src/tools/agent/action-dispatch";
import type { AgentLifecycle } from "../../src/tools/agent/lifecycle";
import type { AgentParameters } from "../../src/tools/agent/definitions/prompt";
import type { AgentEventSink } from "../../src/tools/agent/observability/events";
import type {
    AgentRunDetails,
    AgentRunOutcome,
    AgentRunStatus,
    AgentRunSummary,
} from "../../src/tools/agent/contracts/runs";
import type {
    AgentWorkspace,
    AgentWorkspaceResult,
} from "../../src/tools/agent/contracts/workspaces";
import { ZERO_USAGE } from "../../src/tools/agent/runs/usage";
import * as workspaceCheckpoints from "../../src/tools/agent/workspaces/checkpoints";
import * as workspaceFinalization from "../../src/tools/agent/workspaces/finalization";
import * as parentActions from "../../src/tools/agent/workspaces/parent-actions";
import * as workspaceResults from "../../src/tools/agent/workspaces/results";
import * as workspaceSetup from "../../src/tools/agent/workspaces/setup";
import * as workspaceStore from "../../src/tools/agent/workspaces/store";

/**
 * Characterization coverage for the parent-facing action dispatcher.
 *
 * These tests pin observable behavior of `executeAgentAction` — rejection wording, workspace-lease
 * bookkeeping, event emission, and callback wiring — so structural change to the dispatcher cannot
 * silently alter any of it. Several were written against paths that no other suite reaches; see
 * `scripts/coverage_report.py src/tools/agent/action-dispatch.ts`.
 */

const DEFINITION = {
    name: "worker",
    source: "builtin",
    description: "Test worker",
    systemPrompt: "Test worker prompt",
    capabilities: ["edit"],
    mutating: true,
};

const WORKSPACE = {
    id: "workspace-1",
    cwd: process.cwd(),
    repositoryRoot: process.cwd(),
    worktreePath: path.join(process.cwd(), ".worktrees", "workspace-1"),
    slug: "workspace-1",
    baseRevision: "base-revision",
    setupState: "ready",
    status: "available",
    createdAt: 1,
    updatedAt: 1,
} as unknown as AgentWorkspace;

const RESERVATION = {
    workspace: WORKSPACE,
    ownerSessionId: "parent-session",
    provisionalLeaseRunId: "provisional-1",
    provisionalLeaseRunInstanceId: "provisional-instance-1",
};

function runOutcome(overrides: Partial<AgentRunDetails> = {}): AgentRunOutcome {
    return {
        content: "run content",
        details: {
            runId: "worker-1",
            runInstanceId: "worker-instance-1",
            title: "Implement fix",
            agent: "worker",
            status: "completed",
            background: false,
            task: "Implement the change",
            recentActivity: [],
            usage: ZERO_USAGE,
            startedAt: 1,
            updatedAt: 2,
            ...overrides,
        },
        usage: ZERO_USAGE,
        isError: false,
    };
}

function workspaceResult(overrides: Partial<AgentWorkspaceResult> = {}): AgentWorkspaceResult {
    return {
        id: "result-1",
        workspaceId: WORKSPACE.id,
        runId: "worker-1",
        runInstanceId: "worker-instance-1",
        baseRevision: "base-revision",
        workerHead: "worker-head",
        commitRange: "base-revision..worker-head",
        commits: ["worker-head"],
        preparedAt: 3,
        status: "prepared",
        ...overrides,
    };
}

interface HarnessOptions {
    /** Definitions returned by `lifecycle.discover`. */
    agents?: Record<string, unknown>[];
    /** Status reported for the run targeted by `continue`, `cancel`, and `collect`. */
    runStatus?: AgentRunStatus;
    /** Details status reported by `manager.status`, which gates collection. */
    pendingStatus?: AgentRunStatus;
}

function harness(options: HarnessOptions = {}) {
    const pending = runOutcome({ status: options.pendingStatus ?? "completed" });
    const sink: AgentEventSink = { emit: vi.fn() };
    const manager = {
        listRuns: vi.fn((): AgentRunSummary[] => []),
        getRunStatus: vi.fn(() => options.runStatus),
        status: vi.fn(() => pending),
        start: vi.fn(async () => pending),
        resume: vi.fn(async () => pending),
        cancel: vi.fn(async () => pending),
        collect: vi.fn(async () => pending),
        setWorkspaceResultId: vi.fn(async () => {}),
        reserveRunIdentity: vi.fn(() => ({
            runId: "worker-1",
            runInstanceId: "worker-instance-1",
        })),
    };
    const lifecycle = {
        manager,
        factory: vi.fn(),
        discover: vi.fn(() => ({
            agents: options.agents ?? [DEFINITION],
            diagnostics: [],
        })),
        backgroundUpdate: vi.fn(() => vi.fn()),
        updateSetupRun: vi.fn(),
        clearCompletedWorkspaceSetup: vi.fn(),
        emitWorkspaceEvent: vi.fn(),
        events: sink,
        eventBus: undefined,
    };
    const notify = vi.fn();
    const ctx = {
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        isIdle: () => true,
        sessionManager: { getSessionId: () => "parent-session" },
        ui: { notify, setWidget: vi.fn() },
    };
    const progress = vi.fn();

    const execute = (params: AgentParameters): Promise<AgentRunOutcome> =>
        executeAgentAction(params, {
            signal: undefined,
            progress,
            ctx: ctx as unknown as ExtensionContext,
            lifecycle: lifecycle as unknown as AgentLifecycle,
        });

    return {
        pending,
        manager,
        lifecycle,
        ctx,
        notify,
        progress,
        sink,
        execute,
    };
}

type Harness = ReturnType<typeof harness>;

function startParams(overrides: Partial<AgentParameters> = {}): AgentParameters {
    return {
        action: "start",
        agent: "worker",
        task: "Implement the change",
        ...overrides,
    };
}

beforeEach(() => {
    vi.spyOn(workspaceCheckpoints, "createAgentWorkspaceCheckpointCallback").mockReturnValue(
        async () => {},
    );
    vi.spyOn(workspaceStore, "listAgentWorkspaces").mockResolvedValue([]);
    vi.spyOn(workspaceStore, "transferAgentWorkspaceLease").mockResolvedValue();
    vi.spyOn(workspaceStore, "releaseAgentWorkspaceLease").mockResolvedValue();
    vi.spyOn(workspaceResults, "releaseAgentWorkspaceAfterNoChanges").mockResolvedValue();
    vi.spyOn(workspaceFinalization, "prepareForegroundWorkspaceResult").mockImplementation(
        async (outcome) => outcome,
    );
    vi.spyOn(workspaceFinalization, "prepareCollectedWorkspaceResult").mockResolvedValue(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("agent action dispatch", () => {
    it("keeps a workspace catalog failure as a warning on the list outcome", async () => {
        const h = harness();
        vi.mocked(workspaceStore.listAgentWorkspaces).mockRejectedValue(
            new Error("catalog is unreadable"),
        );

        const outcome = await h.execute({ action: "list" });

        expect(outcome.content).toContain(
            "Warning: Could not read isolated workspace catalog: catalog is unreadable",
        );
        expect(h.notify).toHaveBeenCalledWith(
            expect.stringContaining("catalog is unreadable"),
            "warning",
        );
        expect(outcome.isError).toBe(false);
    });

    it.each([
        ["an unavailable agent", [], "worker", "Unknown agent: worker"],
        [
            "an advisor with no model configured",
            [{ ...DEFINITION, name: "advisor", model: undefined }],
            "advisor",
            "The advisor is enabled but has no model configured.",
        ],
    ])("rejects %s before claiming any workspace", async (_label, agents, agent, expected) => {
        const h = harness({ agents: agents as Record<string, unknown>[] });
        const reserve = vi.spyOn(workspaceSetup, "prepareIsolatedWorkspace");

        const outcome = await h.execute(startParams({ agent, isolation: "worktree" }));

        expect(outcome.content).toContain(expected);
        expect(outcome.details.status).toBe("failed");
        expect(outcome.isError).toBe(true);
        // A rejected start must not leave a workspace or lease behind.
        expect(reserve).not.toHaveBeenCalled();
        expect(h.manager.start).not.toHaveBeenCalled();
    });

    it("routes workspace setup progress through the lifecycle summary updater", async () => {
        const h = harness();
        const update = { status: "running" } as unknown as AgentRunSummary;
        vi.spyOn(workspaceSetup, "prepareIsolatedWorkspace").mockImplementation(
            async (_cwd, options) => {
                options.onUiUpdate?.("setup-1", WORKSPACE, update);
                return RESERVATION;
            },
        );

        await h.execute(startParams({ isolation: "worktree", background: true }));

        expect(h.lifecycle.updateSetupRun).toHaveBeenCalledWith(
            h.ctx,
            "setup-1",
            WORKSPACE,
            update,
        );
    });

    it("continues an active run with the workspace checkpoint callback attached", async () => {
        const h = harness({ runStatus: "running" });

        const outcome = await h.execute({
            action: "continue",
            runId: "worker-1",
            guidance: "More",
        });

        expect(h.manager.resume).toHaveBeenCalledWith(
            "worker-1",
            expect.objectContaining({ guidance: "More", onProgress: h.progress }),
        );
        expect(vi.mocked(h.manager.resume).mock.calls[0]?.[1]).toHaveProperty(
            "onWorkspaceCheckpoint",
        );
        expect(workspaceFinalization.prepareForegroundWorkspaceResult).toHaveBeenCalled();
        expect(h.lifecycle.clearCompletedWorkspaceSetup).toHaveBeenCalled();
        expect(outcome.details.status).toBe("completed");
    });

    it("routes an untracked run to the parent workspace actions", async () => {
        const h = harness({ runStatus: undefined });
        const parentAction = vi
            .spyOn(parentActions, "executeParentWorkspaceAction")
            .mockResolvedValue(runOutcome({ status: "completed", agent: "worker" }));

        const outcome = await h.execute({
            action: "continue",
            runId: "workspace-1",
            guidance: "Apply feedback",
        });

        expect(parentAction).toHaveBeenCalledWith(
            { action: "continue", runId: "workspace-1", guidance: "Apply feedback" },
            expect.objectContaining({ manager: h.manager, progress: h.progress }),
        );
        expect(h.manager.resume).not.toHaveBeenCalled();
        expect(outcome.details.status).toBe("completed");
    });

    it("cancels a run and prepares its foreground workspace result", async () => {
        const h = harness();

        const outcome = await h.execute({ action: "cancel", runId: "worker-1" });

        expect(h.manager.cancel).toHaveBeenCalledWith("worker-1", {
            onWorkspaceCheckpoint: expect.any(Function),
        });
        expect(workspaceFinalization.prepareForegroundWorkspaceResult).toHaveBeenCalled();
        expect(outcome.details.status).toBe("completed");
    });

    it("refuses to collect a run without a terminal checkpoint", async () => {
        const h = harness({ pendingStatus: "waiting_for_parent" });

        const outcome = await h.execute({ action: "collect", runId: "worker-1" });

        expect(outcome.content).toContain(
            "Agent run worker-1 is waiting_for_parent; wait for its terminal checkpoint before collecting.",
        );
        expect(h.manager.collect).not.toHaveBeenCalled();
    });

    it.each([
        ["no worker commits", workspaceResult({ workerHead: "base-revision", commits: [] }), true],
        ["worker commits", workspaceResult(), false],
    ] as const)(
        "releases a collected workspace lease only for %s",
        async (_label, result, expectsRelease) => {
            const h = harness({ pendingStatus: "completed" });
            vi.spyOn(workspaceFinalization, "prepareCollectedWorkspaceResult").mockResolvedValue(
                result,
            );

            const outcome = await h.execute({ action: "collect", runId: "worker-1" });

            // A retained result must stay leased so a rejected collect can be retried safely.
            if (expectsRelease) {
                expect(workspaceResults.releaseAgentWorkspaceAfterNoChanges).toHaveBeenCalledWith(
                    WORKSPACE.id,
                    {
                        ownerSessionId: "parent-session",
                        leaseRunId: "worker-1",
                        leaseRunInstanceId: "worker-instance-1",
                    },
                );
            } else {
                expect(workspaceResults.releaseAgentWorkspaceAfterNoChanges).not.toHaveBeenCalled();
            }
            expect(releasedNoChangesEvents(h)).toHaveLength(expectsRelease ? 1 : 0);
            expect(outcome.details.workspaceResult).toBe(result);
            expect(h.manager.setWorkspaceResultId).toHaveBeenCalledWith("worker-1", result.id);
        },
    );

    it("releases the provisional lease when the workspace lease transfer fails", async () => {
        const h = harness();
        vi.spyOn(workspaceSetup, "prepareIsolatedWorkspace").mockResolvedValue(RESERVATION);
        const transfer = vi
            .spyOn(workspaceStore, "transferAgentWorkspaceLease")
            .mockRejectedValue(new Error("transfer refused"));

        const outcome = await h.execute(startParams({ isolation: "worktree", background: true }));

        expect(transfer).toHaveBeenCalledTimes(1);
        expect(h.manager.start).not.toHaveBeenCalled();
        expect(workspaceStore.releaseAgentWorkspaceLease).toHaveBeenCalledWith(WORKSPACE.id, {
            ownerSessionId: RESERVATION.ownerSessionId,
            leaseRunId: RESERVATION.provisionalLeaseRunId,
            leaseRunInstanceId: RESERVATION.provisionalLeaseRunInstanceId,
        });
        expect(outcome.details.status).toBe("failed");
        expect(outcome.content).toContain("transfer refused");
    });

    it("keeps the failure outcome when rolling a transferred lease back also fails", async () => {
        const h = harness();
        vi.spyOn(workspaceSetup, "prepareIsolatedWorkspace").mockResolvedValue(RESERVATION);
        vi.spyOn(workspaceStore, "transferAgentWorkspaceLease").mockImplementation(
            async (_workspaceId, options) => {
                if (options.toLeaseRunId === "worker-1") return;
                throw new Error("rollback refused");
            },
        );
        vi.mocked(h.manager.start).mockRejectedValue(new Error("manager startup failed"));

        const outcome = await h.execute(startParams({ isolation: "worktree", background: true }));

        expect(workspaceStore.transferAgentWorkspaceLease).toHaveBeenCalledTimes(2);
        // A failed rollback is swallowed so it cannot mask the original startup failure.
        expect(workspaceStore.releaseAgentWorkspaceLease).not.toHaveBeenCalled();
        expect(outcome.content).toContain("manager startup failed");
    });
});

function sinkEvents(h: Harness): unknown[] {
    const emit = h.sink.emit as ReturnType<typeof vi.fn>;
    return emit.mock.calls.map(([event]) => event);
}

function releasedNoChangesEvents(h: Harness): unknown[] {
    return sinkEvents(h).filter(
        (event) => (event as { reason?: string } | undefined)?.reason === "released_no_changes",
    );
}
