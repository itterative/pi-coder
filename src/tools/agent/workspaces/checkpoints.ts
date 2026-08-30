import { randomUUID } from "node:crypto";

import { PI_CODER_WORKSPACES_DIR } from "../../../common/constants";
import type {
    AgentWorkspace,
    AgentWorkspaceCheckpoint,
    WorkspaceCheckpointKind,
    WorkspaceCheckpointStatus,
} from "../contracts/workspaces";
import type { AgentWorkspaceCheckpointCallback } from "../contracts/runs";
import {
    openAgentMetadataDatabase as openDatabase,
    type AgentMetadataDatabase,
} from "../storage/metadata";
import { git } from "./git";
import {
    inspectAgentWorkspaceGitState,
    workspaceById,
    workspaceForLease,
    type AgentWorkspaceDirectoryOptions,
    type AgentWorkspaceLeaseOptions,
} from "./store";

const CHECKPOINT_REF_PREFIX = "refs/pi-coder/workspace-checkpoints";
const CHECKPOINT_COMMIT_MESSAGE = "pi-coder: workspace checkpoint";

type CheckpointRow = Record<string, unknown>;

export interface CreateAgentWorkspaceCheckpointOptions extends Omit<
    AgentWorkspaceLeaseOptions,
    "leaseRunInstanceId"
> {
    runInstanceId: string;
    kind: WorkspaceCheckpointKind;
    runStatus: WorkspaceCheckpointStatus;
    childSessionFile?: string;
    childSessionLeafId: string | null;
}

function rowToCheckpoint(row: CheckpointRow | undefined): AgentWorkspaceCheckpoint | undefined {
    if (
        !row ||
        typeof row.checkpoint_id !== "string" ||
        typeof row.workspace_id !== "string" ||
        typeof row.run_id !== "string" ||
        typeof row.run_instance_id !== "string" ||
        typeof row.sequence !== "number" ||
        !Number.isSafeInteger(row.sequence) ||
        !["intermediate", "terminal"].includes(row.kind as string) ||
        ![
            "waiting_for_parent",
            "interrupted",
            "completed",
            "failed",
            "aborted",
            "canceled",
        ].includes(row.run_status as string) ||
        typeof row.base_revision !== "string" ||
        typeof row.head_revision !== "string" ||
        typeof row.durable_ref !== "string" ||
        typeof row.created_at !== "number" ||
        !Number.isFinite(row.created_at) ||
        (row.child_session_leaf_id !== null && typeof row.child_session_leaf_id !== "string")
    )
        return undefined;
    return {
        id: row.checkpoint_id,
        workspaceId: row.workspace_id,
        runId: row.run_id,
        runInstanceId: row.run_instance_id,
        sequence: row.sequence,
        kind: row.kind as WorkspaceCheckpointKind,
        runStatus: row.run_status as WorkspaceCheckpointStatus,
        baseRevision: row.base_revision,
        headRevision: row.head_revision,
        durableRef: row.durable_ref,
        ...(typeof row.child_session_file === "string"
            ? { childSessionFile: row.child_session_file }
            : {}),
        childSessionLeafId: row.child_session_leaf_id as string | null,
        createdAt: row.created_at,
    };
}

async function createCommitSnapshot(workspace: AgentWorkspace): Promise<string> {
    const state = await inspectAgentWorkspaceGitState(workspace);
    if (state.kind !== "available" || !state.headRevision) {
        throw new Error(state.error ?? `Workspace ${workspace.id} Git state is unavailable.`);
    }
    if (state.dirty) {
        await git(workspace.worktreePath, ["add", "-A"]);
        await git(workspace.worktreePath, [
            "commit",
            "--no-verify",
            "-m",
            CHECKPOINT_COMMIT_MESSAGE,
        ]);
    }
    return git(workspace.worktreePath, ["rev-parse", "HEAD"]);
}

/** Capture the current settled state of a leased workspace without losing it. */
export async function createAgentWorkspaceCheckpoint(
    workspaceId: string,
    {
        ownerSessionId,
        leaseRunId,
        workspacesDir = PI_CODER_WORKSPACES_DIR,
        runInstanceId,
        kind,
        runStatus,
        childSessionFile,
        childSessionLeafId,
    }: CreateAgentWorkspaceCheckpointOptions,
): Promise<AgentWorkspaceCheckpoint> {
    const { database, workspace } = await workspaceForLease(workspaceId, {
        ownerSessionId,
        leaseRunId,
        leaseRunInstanceId: runInstanceId,
        workspacesDir,
    });
    const checkpointId = randomUUID();
    const durableRef = `${CHECKPOINT_REF_PREFIX}/${workspace.id}/${checkpointId}`;
    let refCreated = false;
    try {
        if (workspace.leaseKind !== "task") {
            throw new Error(`Workspace ${workspaceId} does not have a task lease.`);
        }
        const headRevision = await createCommitSnapshot(workspace);
        await git(workspace.repositoryRoot, ["update-ref", durableRef, headRevision]);
        refCreated = true;

        const createdAt = Date.now();
        const sequence = await database.transaction(async (transaction) => {
            const sequenceRow = (await transaction.get(
                `
                SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
                FROM workspace_checkpoints
                WHERE workspace_id = ?
            `,
                workspace.id,
            )) as CheckpointRow;
            const nextSequence = Number(sequenceRow.sequence);
            if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) {
                throw new Error(`Workspace ${workspaceId} checkpoint sequence is invalid.`);
            }
            await transaction.run(
                `
                INSERT INTO workspace_checkpoints (
                    checkpoint_id, workspace_id, run_id, run_instance_id, sequence,
                    kind, run_status, base_revision, head_revision, durable_ref,
                    child_session_file, child_session_leaf_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
                checkpointId,
                workspace.id,
                leaseRunId,
                runInstanceId,
                nextSequence,
                kind,
                runStatus,
                workspace.baseRevision,
                headRevision,
                durableRef,
                childSessionFile ?? null,
                childSessionLeafId,
                createdAt,
            );
            return nextSequence;
        }, "IMMEDIATE");
        return {
            id: checkpointId,
            workspaceId: workspace.id,
            runId: leaseRunId,
            runInstanceId,
            sequence,
            kind,
            runStatus,
            baseRevision: workspace.baseRevision,
            headRevision,
            durableRef,
            ...(childSessionFile ? { childSessionFile } : {}),
            childSessionLeafId,
            createdAt,
        };
    } catch (error) {
        if (refCreated) {
            await git(workspace.repositoryRoot, ["update-ref", "-d", durableRef]).catch(() => {});
        }
        throw error;
    } finally {
        await database.close();
    }
}

/** Create the lifecycle callback used to checkpoint one parent-owned workspace run. */
export function createAgentWorkspaceCheckpointCallback(
    ownerSessionId: string,
    workspacesDir?: string,
): AgentWorkspaceCheckpointCallback {
    return async (request) => {
        await createAgentWorkspaceCheckpoint(request.workspaceId, {
            ownerSessionId,
            leaseRunId: request.runId,
            runInstanceId: request.runInstanceId,
            kind: request.kind,
            runStatus: request.runStatus,
            childSessionFile: request.childSessionFile,
            childSessionLeafId: request.childSessionLeafId,
            ...(workspacesDir ? { workspacesDir } : {}),
        });
    };
}

/** Return one exact workspace checkpoint by its durable identity. */
export async function getAgentWorkspaceCheckpoint(
    checkpointId: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspaceCheckpoint | undefined> {
    const database = await openDatabase(workspacesDir);
    try {
        const row = (await database.get(
            `
            SELECT checkpoint_id, workspace_id, run_id, run_instance_id, sequence,
                   kind, run_status, base_revision, head_revision, durable_ref,
                   child_session_file, child_session_leaf_id, created_at
            FROM workspace_checkpoints
            WHERE checkpoint_id = ?
        `,
            checkpointId,
        )) as CheckpointRow | undefined;
        return rowToCheckpoint(row);
    } finally {
        await database.close();
    }
}

/** Return the newest checkpoint for one exact logical worker in one workspace. */
export async function latestAgentWorkspaceCheckpoint(
    workspaceId: string,
    runInstanceId: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspaceCheckpoint | undefined> {
    const database = await openDatabase(workspacesDir);
    try {
        const row = (await database.get(
            `
            SELECT checkpoint_id, workspace_id, run_id, run_instance_id, sequence,
                   kind, run_status, base_revision, head_revision, durable_ref,
                   child_session_file, child_session_leaf_id, created_at
            FROM workspace_checkpoints
            WHERE workspace_id = ? AND run_instance_id = ?
            ORDER BY sequence DESC
            LIMIT 1
        `,
            workspaceId,
            runInstanceId,
        )) as CheckpointRow | undefined;
        return rowToCheckpoint(row);
    } finally {
        await database.close();
    }
}

/** List immutable checkpoints in capture order for one physical workspace. */
export async function listAgentWorkspaceCheckpoints(
    workspaceId: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspaceCheckpoint[]> {
    const database = await openDatabase(workspacesDir);
    try {
        const rows = (await database.all(
            `
            SELECT checkpoint_id, workspace_id, run_id, run_instance_id, sequence,
                   kind, run_status, base_revision, head_revision, durable_ref,
                   child_session_file, child_session_leaf_id, created_at
            FROM workspace_checkpoints
            WHERE workspace_id = ?
            ORDER BY sequence ASC
        `,
            workspaceId,
        )) as CheckpointRow[];
        return rows
            .map((row) => rowToCheckpoint(row))
            .filter((row): row is AgentWorkspaceCheckpoint => row !== undefined);
    } finally {
        await database.close();
    }
}

/**
 * Restore a checkpoint into its original workspace after the caller has
 * obtained its physical task lease.
 */
export async function restoreAgentWorkspaceCheckpoint(
    workspace: AgentWorkspace,
    checkpoint: AgentWorkspaceCheckpoint,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<void> {
    if (workspace.id !== checkpoint.workspaceId) {
        throw new Error(
            `Checkpoint ${checkpoint.id} belongs to workspace ${checkpoint.workspaceId}, not ${workspace.id}.`,
        );
    }
    const database = await openDatabase(workspacesDir);
    try {
        await database.transaction(async (transaction) => {
            const current = await workspaceById(transaction, workspace.id);
            if (
                !current ||
                current.status === "recycling" ||
                current.leaseOwnerSessionId !== workspace.leaseOwnerSessionId ||
                current.leaseRunId !== workspace.leaseRunId ||
                current.leaseRunInstanceId !== workspace.leaseRunInstanceId ||
                current.leaseKind !== workspace.leaseKind
            ) {
                throw new Error(
                    `Workspace ${workspace.id} changed before checkpoint ${checkpoint.id} could be restored.`,
                );
            }
            const currentRef = await git(workspace.repositoryRoot, [
                "rev-parse",
                checkpoint.durableRef,
            ]);
            if (currentRef !== checkpoint.headRevision) {
                throw new Error(
                    `Checkpoint ${checkpoint.id} no longer points to its recorded commit.`,
                );
            }
            await git(workspace.worktreePath, ["reset", "--hard", checkpoint.headRevision]);
            await git(workspace.worktreePath, ["clean", "-fd"]);
        }, "IMMEDIATE");
    } finally {
        await database.close();
    }
}
