import type { Usage } from "@earendil-works/pi-ai";

import {
    BUILTIN_SCOUT,
    fingerprintAgentDefinition,
} from "../../src/tools/agent/definitions/discovery";
import type {
    AgentRunDetails,
    AgentRunPersistence,
    AgentRunSummary,
    ChildProgress,
    PersistedAgentRun,
} from "../../src/tools/agent/contracts/runs";
import type { AgentRunStateWriter } from "../../src/tools/agent/runs/persistence/state-writer";
import type { ChildProgressTracker } from "../../src/tools/agent/child/progress";
import type { AgentRunWorkingStateInput } from "../../src/tools/agent/storage/run-working-state";
import type {
    AgentWorkspace,
    AgentWorkspaceResult,
} from "../../src/tools/agent/contracts/workspaces";
import { cloneUsage, ZERO_USAGE } from "../../src/tools/agent/runs/usage";

/**
 * Deterministic domain objects for tests, built from typed `Partial` overrides.
 *
 * These exist to replace `{ ...fields } as any` literals. A cast silences the compiler about a field
 * that `src` renamed, retyped, or dropped, so the test keeps passing while standing for something
 * production can never produce; a factory with a typed `overrides` argument checks every field a test
 * actually sets and pins the required-field set at the same time.
 *
 * Defaults are deliberately synthetic and stable so they are safe inside file snapshots. Two
 * conventions hold across all of them: paths are synthetic (`/repo`, never `process.cwd()`, which
 * leaked a machine-specific checkout path into `agent-outcomes` snapshots once), and `usage` is always
 * a fresh clone because `Usage.cost` is nested and a shared object would alias mutations across runs.
 */

/** A zeroed `Usage` with an independent `cost` object. */
export function zeroUsage(): Usage {
    return cloneUsage(ZERO_USAGE);
}

export function partialRun(overrides: Partial<AgentRunSummary> = {}): AgentRunSummary {
    return {
        runId: "run-1",
        title: "Test run",
        agent: "worker",
        status: "running",
        background: false,
        task: "Test task",
        startedAt: 10,
        updatedAt: 20,
        usage: zeroUsage(),
        ...overrides,
    };
}

export function partialDetails(overrides: Partial<AgentRunDetails> = {}): AgentRunDetails {
    return {
        runId: "run-1",
        title: "Test run",
        agent: "worker",
        status: "running",
        task: "Test task",
        recentActivity: [],
        startedAt: 10,
        updatedAt: 20,
        usage: zeroUsage(),
        ...overrides,
    };
}

export function partialWorkspaceResult(
    overrides: Partial<AgentWorkspaceResult> = {},
): AgentWorkspaceResult {
    return {
        id: "result-1",
        workspaceId: "workspace-1",
        runId: "run-1",
        baseRevision: "base-revision",
        workerHead: "worker-head",
        commitRange: "base-revision..worker-head",
        commits: ["worker-head"],
        preparedAt: 30,
        status: "prepared",
        ...overrides,
    };
}

/**
 * An isolated workspace row.
 *
 * `worktreePath` is a real directory in tests that exercise the presentation layer, which stats it to
 * distinguish "review this workspace" from "its worktree is missing"; pass an existing path in those
 * cases and normalize it in any snapshot built from it.
 */
export function partialWorkspace(overrides: Partial<AgentWorkspace> = {}): AgentWorkspace {
    return {
        version: 1,
        id: "workspace-1",
        cwd: "/repo",
        repositoryRoot: "/repo",
        worktreePath: "/repo/.worktrees/workspace-1",
        slug: "workspace-1",
        baseRevision: "base-revision",
        setupState: "ready",
        status: "available",
        createdAt: 10,
        updatedAt: 20,
        ...overrides,
    };
}

/** One reported progress frame, in its empty initial state. */
function partialProgress(overrides: Partial<ChildProgress> = {}): ChildProgress {
    return { output: "", recentActivity: [], ...overrides };
}

/**
 * A `ChildProgressTracker` as a child extension first sees it. The set fields are fresh per call on
 * purpose: production mutates them in place, so sharing one would leak state between tests.
 */
export function partialTracker(
    overrides: Partial<ChildProgressTracker> = {},
): ChildProgressTracker {
    return {
        progress: partialProgress(),
        lastUpdateAt: 0,
        changedFiles: new Set<string>(),
        readFiles: new Set<string>(),
        bashApproved: false,
        interrupted: false,
        ...overrides,
    };
}

/**
 * A `PersistedAgentRun` checkpoint record, as the durable layer stores one.
 *
 * The fingerprint is the real builtin-scout fingerprint because `parseRecord` rejects a stored record whose
 * fingerprint is not 64 hex characters, and a synthetic placeholder would make every restore test pass while
 * standing for a row production could never write.
 */
export function partialPersistedRecord(
    overrides: Partial<PersistedAgentRun> = {},
): PersistedAgentRun {
    return {
        version: 1,
        ownerSessionId: "parent-1",
        runId: "scout-1",
        runInstanceId: "instance-1",
        title: "Test run",
        agent: "scout",
        agentSource: "builtin",
        definitionFingerprint: fingerprintAgentDefinition(BUILTIN_SCOUT),
        task: "Test task",
        status: "running",
        background: false,
        mutating: false,
        progress: partialProgress(),
        usageCheckpoint: zeroUsage(),
        usageSnapshot: zeroUsage(),
        startedAt: 10,
        updatedAt: 20,
        parentCwd: "/repo",
        cwd: "/repo",
        childSessionFile: "/agent-sessions/parent-1/child.jsonl",
        childSessionLeafId: "leaf-checkpoint",
        resumable: true,
        ...overrides,
    };
}

/**
 * An `agent_run_working_state` row to write.
 *
 * Typed as the write input rather than the read row on purpose: the read shape carries an unvalidated
 * `unknown` payload, so a test that wants to prove the overlay rejects corrupt storage must write raw SQL
 * instead of reaching for this helper.
 */
export function partialWorkingState(
    overrides: Partial<AgentRunWorkingStateInput> = {},
): AgentRunWorkingStateInput {
    return {
        runInstanceId: "instance-1",
        ownerSessionId: "parent-1",
        runId: "scout-1",
        status: "running",
        childSessionFile: "/agent-sessions/parent-1/child.jsonl",
        childSessionLeafId: "leaf-working",
        progress: partialProgress({ output: "newer progress" }),
        updatedAt: 30,
        ...overrides,
    };
}

/**
 * An `AgentRunPersistence` double. The defaults do nothing but satisfy the contract; a suite overrides
 * `save` to record what was written. `save` is async because that is the contract — two hand-built
 * doubles returned a bare `true`, which typechecking never saw because tests are excluded from
 * `tsconfig.json`.
 */
export function partialPersistence(
    overrides: Partial<AgentRunPersistence> = {},
): AgentRunPersistence {
    return {
        ownerSessionId: "parent-1",
        childSessionDir: "/tmp/agent-sessions",
        save: async () => true,
        deleteChildSession: () => {},
        ...overrides,
    };
}

/**
 * An `AgentRunStateWriter` double, which is the shape `LoadedAgentRunPersistence.catalog` expects. Its
 * `save` result differs from `AgentRunPersistence.save` (`{ ok }` versus `boolean`), so passing a
 * persistence object through `as any` hid a genuine signature mismatch.
 */
export function partialStateWriter(
    overrides: Partial<AgentRunStateWriter> = {},
): AgentRunStateWriter {
    return {
        save: async () => ({ ok: true as const }),
        flush: async () => {},
        close: async () => {},
        ...overrides,
    };
}
