import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { PI_CODER_WORKSPACES_DIR } from "../../../common/constants";
import type { AgentWorkspace, AgentWorkspaceResult } from "../contracts/workspaces";
import {
    openAgentMetadataDatabase as openDatabase,
    type AgentMetadataDatabase,
} from "../storage/metadata";
import { git, gitRaw, hasAncestor } from "./git";
import {
    inspectAgentWorkspaceGitState,
    listAgentWorkspaces,
    workspaceById,
    workspaceForLease,
    workspaceResultById,
    workspaceResultForRun,
    getAgentWorkspaceResult,
    type AgentWorkspaceDirectoryOptions,
    type AgentWorkspaceLeaseOptions,
} from "./store";

const FINAL_RESULT_COMMIT_MESSAGE = "pi-coder: finalize isolated worker result";
const RESULT_REF_PREFIX = "refs/pi-coder/workspace-results";
const RESULT_RESERVATION_TIMEOUT_MS = 5 * 60_000;
const RESULT_RESERVATION_RECOVERY_GRACE_MS = 250;
const activeApplyingResultIds = new Set<string>();

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

async function requireMatchingWorkspaceResult(
    database: AgentMetadataDatabase,
    workspace: AgentWorkspace,
    { leaseRunId, leaseRunInstanceId, resultId }: AgentWorkspaceLeaseOptions,
): Promise<AgentWorkspaceResult> {
    const result = resultId
        ? await workspaceResultById(database, resultId)
        : await workspaceResultForRun(database, workspace.id, leaseRunId, leaseRunInstanceId);
    if (
        !result ||
        result.workspaceId !== workspace.id ||
        result.runId !== leaseRunId ||
        (leaseRunInstanceId !== undefined && result.runInstanceId !== leaseRunInstanceId)
    ) {
        throw new Error(`Workspace ${workspace.id} has no result for run ${leaseRunId}.`);
    }
    return result;
}

async function requirePreparedResult(
    database: AgentMetadataDatabase,
    workspace: AgentWorkspace,
    options: AgentWorkspaceLeaseOptions,
): Promise<AgentWorkspaceResult> {
    const result = await requireMatchingWorkspaceResult(database, workspace, options);
    if (result.status !== "prepared") {
        throw new Error(
            `Workspace ${workspace.id} has no prepared result for run ${options.leaseRunId}.`,
        );
    }
    return result;
}

async function clearResultReservation(
    database: AgentMetadataDatabase,
    resultId: string,
    token: string,
): Promise<void> {
    await database.run(
        `
        UPDATE workspace_results
        SET reservation_token = NULL, reservation_owner_session_id = NULL,
            reservation_run_id = NULL, reservation_run_instance_id = NULL,
            reservation_owner_pid = NULL, reservation_acquired_at = NULL
        WHERE id = ? AND reservation_token = ?
    `,
        resultId,
        token,
    );
}

async function reserveResult(
    database: AgentMetadataDatabase,
    result: AgentWorkspaceResult,
    options: AgentWorkspaceLeaseOptions,
): Promise<string> {
    const token = randomUUID();
    const now = Date.now();
    return await database.transaction(async (transaction) => {
        const existing = (await transaction.get(
            `
            SELECT reservation_token, reservation_owner_pid, reservation_acquired_at
            FROM workspace_results
            WHERE id = ? AND workspace_id = ? AND status = 'prepared'
        `,
            result.id,
            result.workspaceId,
        )) as
            | {
                  reservation_token?: string;
                  reservation_owner_pid?: number;
                  reservation_acquired_at?: number;
              }
            | undefined;
        if (!existing) throw new Error(`Workspace result ${result.id} is no longer prepared.`);
        if (existing.reservation_token) {
            const ownerDead =
                typeof existing.reservation_owner_pid === "number" &&
                !isProcessAlive(existing.reservation_owner_pid);
            const expired =
                typeof existing.reservation_acquired_at === "number" &&
                existing.reservation_acquired_at +
                    RESULT_RESERVATION_TIMEOUT_MS +
                    RESULT_RESERVATION_RECOVERY_GRACE_MS <
                    now &&
                (ownerDead || existing.reservation_owner_pid === undefined);
            if (!expired)
                throw new Error(
                    `Workspace result ${result.id} is already reserved or no longer prepared.`,
                );
            await transaction.run(
                "UPDATE workspace_results SET reservation_token = NULL WHERE id = ? AND reservation_token = ?",
                result.id,
                existing.reservation_token,
            );
        }
        const reservation = await transaction.run(
            `
            UPDATE workspace_results
            SET reservation_token = ?, reservation_owner_session_id = ?, reservation_run_id = ?,
                reservation_run_instance_id = ?, reservation_owner_pid = ?, reservation_acquired_at = ?
            WHERE id = ? AND workspace_id = ? AND status = 'prepared' AND reservation_token IS NULL
        `,
            token,
            options.ownerSessionId,
            options.leaseRunId,
            options.leaseRunInstanceId ?? null,
            process.pid,
            now,
            result.id,
            result.workspaceId,
        );
        if (reservation.changes !== 1)
            throw new Error(
                `Workspace result ${result.id} is already reserved or no longer prepared.`,
            );
        return token;
    }, "IMMEDIATE");
}

async function releaseResultReservation(
    database: AgentMetadataDatabase,
    resultId: string,
    token: string,
): Promise<void> {
    await clearResultReservation(database, resultId, token);
}

async function markResultApplying(
    database: AgentMetadataDatabase,
    resultId: string,
    workspaceId: string,
    parentRevision: string,
    reservationToken: string,
): Promise<void> {
    await database.transaction(async (transaction) => {
        const updated = await transaction.run(
            `
            UPDATE workspace_results
            SET status = 'applying', parent_revision = ?, applied_at = NULL
            WHERE id = ? AND workspace_id = ? AND status = 'prepared' AND reservation_token = ?
        `,
            parentRevision,
            resultId,
            workspaceId,
            reservationToken,
        );
        if (updated.changes !== 1)
            throw new Error(`Workspace result ${resultId} changed before application could begin.`);
    }, "IMMEDIATE");
}

async function markResultPrepared(
    database: AgentMetadataDatabase,
    resultId: string,
    reservationToken: string,
): Promise<void> {
    await database.transaction(async (transaction) => {
        const updated = await transaction.run(
            `
            UPDATE workspace_results
            SET status = 'prepared', parent_revision = NULL, applied_at = NULL
            WHERE id = ? AND status = 'applying' AND reservation_token = ?
        `,
            resultId,
            reservationToken,
        );
        if (updated.changes !== 1)
            throw new Error(`Workspace result ${resultId} changed during recovery.`);
        await clearResultReservation(transaction, resultId, reservationToken);
    }, "IMMEDIATE");
}

async function claimApplyingResultRecovery(
    database: AgentMetadataDatabase,
    resultId: string,
    options: AgentWorkspaceLeaseOptions,
): Promise<string> {
    if (activeApplyingResultIds.has(resultId)) {
        throw new Error(`Workspace result ${resultId} is still being applied.`);
    }

    return await database.transaction(async (transaction) => {
        const reservation = (await transaction.get(
            `
            SELECT reservation_token, reservation_owner_session_id, reservation_run_id,
                   reservation_run_instance_id, reservation_owner_pid
            FROM workspace_results WHERE id = ? AND status = 'applying'
        `,
            resultId,
        )) as
            | {
                  reservation_token?: string;
                  reservation_owner_session_id?: string;
                  reservation_run_id?: string;
                  reservation_run_instance_id?: string;
                  reservation_owner_pid?: number;
              }
            | undefined;
        const ownerMatches =
            reservation?.reservation_owner_session_id === options.ownerSessionId &&
            reservation.reservation_run_id === options.leaseRunId &&
            (options.leaseRunInstanceId === undefined ||
                reservation.reservation_run_instance_id === options.leaseRunInstanceId);
        if (!reservation?.reservation_token || !ownerMatches) {
            throw new Error(
                `Workspace result ${resultId} is currently being recovered by another owner.`,
            );
        }
        if (
            typeof reservation.reservation_owner_pid === "number" &&
            reservation.reservation_owner_pid !== process.pid &&
            isProcessAlive(reservation.reservation_owner_pid)
        ) {
            throw new Error(
                `Workspace result ${resultId} is still being applied by a live process.`,
            );
        }

        const recoveryToken = randomUUID();
        const claimed = await transaction.run(
            `
            UPDATE workspace_results
            SET reservation_token = ?, reservation_owner_session_id = ?,
                reservation_run_id = ?, reservation_run_instance_id = ?,
                reservation_owner_pid = ?, reservation_acquired_at = ?
            WHERE id = ? AND status = 'applying' AND reservation_token = ?
        `,
            recoveryToken,
            options.ownerSessionId,
            options.leaseRunId,
            options.leaseRunInstanceId ?? null,
            process.pid,
            Date.now(),
            resultId,
            reservation.reservation_token,
        );
        if (claimed.changes !== 1)
            throw new Error(`Workspace result ${resultId} changed before recovery could begin.`);
        return recoveryToken;
    }, "IMMEDIATE");
}

async function markResultApplied(
    database: AgentMetadataDatabase,
    resultId: string,
    workspaceId: string,
    parentRevision: string,
    reservationToken: string,
): Promise<AgentWorkspaceResult> {
    const appliedAt = Date.now();
    const updated = await database.run(
        `
        UPDATE workspace_results SET status = 'applied', parent_revision = ?, applied_at = ?,
            reservation_token = NULL, reservation_owner_session_id = NULL,
            reservation_run_id = NULL, reservation_run_instance_id = NULL,
            reservation_owner_pid = NULL, reservation_acquired_at = NULL
        WHERE id = ? AND workspace_id = ? AND status = 'applying' AND reservation_token = ?
    `,
        parentRevision,
        appliedAt,
        resultId,
        workspaceId,
        reservationToken,
    );
    if (updated.changes !== 1)
        throw new Error(`Workspace result ${resultId} changed during application recovery.`);
    const result = await workspaceResultById(database, resultId);
    if (!result)
        throw new Error(`Workspace result ${resultId} disappeared during application recovery.`);
    return result;
}

async function canApplyPatch(
    repositoryRoot: string,
    patchPath: string,
    reverse = false,
): Promise<boolean> {
    try {
        await git(repositoryRoot, [
            "apply",
            "--check",
            "--binary",
            ...(reverse ? ["--reverse"] : []),
            patchPath,
        ]);
        return true;
    } catch {
        return false;
    }
}

async function withWorkspaceResultPatch<T>(
    workspace: AgentWorkspace,
    result: AgentWorkspaceResult,
    callback: (patch: string, patchPath: string) => Promise<T>,
): Promise<T> {
    const patch = await gitRaw(workspace.repositoryRoot, [
        "diff",
        "--binary",
        "--no-ext-diff",
        `${result.baseRevision}..${result.workerHead}`,
    ]);
    const patchPath = path.join(os.tmpdir(), `pi-coder-apply-${randomUUID()}.patch`);
    try {
        fs.writeFileSync(patchPath, patch, { mode: 0o600 });
        return await callback(patch, patchPath);
    } finally {
        fs.rmSync(patchPath, { force: true });
    }
}

async function recoverApplyingWorkspaceResult(
    database: AgentMetadataDatabase,
    workspace: AgentWorkspace,
    result: AgentWorkspaceResult,
    options: AgentWorkspaceLeaseOptions,
): Promise<AgentWorkspaceResult> {
    const recoveryToken = await claimApplyingResultRecovery(database, result.id, options);
    if (!result.parentRevision) {
        await clearResultReservation(database, result.id, recoveryToken);
        throw new Error(
            `Workspace result ${result.id} has no recorded parent revision for recovery.`,
        );
    }
    activeApplyingResultIds.add(result.id);
    try {
        const currentParentRevision = await git(workspace.repositoryRoot, ["rev-parse", "HEAD"]);
        if (currentParentRevision !== result.parentRevision) {
            throw new Error(
                `Workspace result ${result.id} cannot be recovered because the parent revision changed.`,
            );
        }

        return await withWorkspaceResultPatch(workspace, result, async (patch, patchPath) => {
            if (!patch) {
                return await markResultApplied(
                    database,
                    result.id,
                    workspace.id,
                    result.parentRevision!,
                    recoveryToken,
                );
            }
            const reverseApplies = await canApplyPatch(workspace.repositoryRoot, patchPath, true);
            const forwardApplies = await canApplyPatch(workspace.repositoryRoot, patchPath);
            if (reverseApplies && !forwardApplies) {
                return await markResultApplied(
                    database,
                    result.id,
                    workspace.id,
                    result.parentRevision!,
                    recoveryToken,
                );
            }
            if (forwardApplies && !reverseApplies) {
                await markResultPrepared(database, result.id, recoveryToken);
                const prepared = await workspaceResultById(database, result.id);
                if (!prepared)
                    throw new Error(`Workspace result ${result.id} disappeared during recovery.`);
                return prepared;
            }
            throw new Error(
                `Workspace result ${result.id} has an uncertain parent checkout state; reconcile it manually before retrying.`,
            );
        });
    } finally {
        activeApplyingResultIds.delete(result.id);
    }
}

function matchingLease(workspace: AgentWorkspace, options: AgentWorkspaceLeaseOptions): boolean {
    return (
        workspace.leaseOwnerSessionId === options.ownerSessionId &&
        workspace.leaseRunId === options.leaseRunId &&
        workspace.leaseRunInstanceId === options.leaseRunInstanceId &&
        workspace.leaseKind === "task"
    );
}

async function resetReusableWorkspace(
    workspace: AgentWorkspace,
    targetRevision?: string,
): Promise<string> {
    const revision = targetRevision ?? (await git(workspace.repositoryRoot, ["rev-parse", "HEAD"]));
    await git(workspace.worktreePath, ["reset", "--hard", revision]);
    await git(workspace.worktreePath, ["clean", "-fd"]);
    return revision;
}

/** Finalize the isolated worker tree for an explicit apply request. */
export interface PrepareAgentWorkspaceApplicationOptions extends AgentWorkspaceLeaseOptions {
    baseRevision?: string;
}

export async function prepareAgentWorkspaceApplication(
    workspace: AgentWorkspace,
    options: PrepareAgentWorkspaceApplicationOptions,
): Promise<AgentWorkspaceResult> {
    const { leaseRunId, leaseRunInstanceId, baseRevision: requestedBaseRevision } = options;
    const { database, workspace: current } = await workspaceForLease(workspace.id, options);
    let durableRef: string | undefined;
    try {
        if (current.leaseKind !== "task")
            throw new Error(`Workspace ${workspace.id} does not have a task lease.`);
        if (current.baseRevision !== workspace.baseRevision)
            throw new Error(`Workspace ${workspace.id} base revision changed while it was leased.`);
        const baseRevision = requestedBaseRevision ?? current.baseRevision;
        const state = await inspectAgentWorkspaceGitState(current);
        if (state.kind !== "available")
            throw new Error(state.error ?? "Workspace Git state is unavailable.");
        if (state.dirty) {
            await git(current.worktreePath, ["add", "-A"]);
            await git(current.worktreePath, [
                "commit",
                "--no-verify",
                "-m",
                FINAL_RESULT_COMMIT_MESSAGE,
            ]);
        }
        const workerHead = await git(current.worktreePath, ["rev-parse", "HEAD"]);
        if (!(await hasAncestor(current.worktreePath, baseRevision, workerHead))) {
            throw new Error(
                `Worker revision ${workerHead} is not based on workspace base ${baseRevision}.`,
            );
        }
        const commitsOutput = await git(current.worktreePath, [
            "rev-list",
            "--reverse",
            `${baseRevision}..${workerHead}`,
        ]);
        const commits = commitsOutput ? commitsOutput.split("\n").filter(Boolean) : [];
        const resultId = randomUUID();
        if (workerHead !== current.baseRevision || commits.length > 0) {
            durableRef = `${RESULT_REF_PREFIX}/${current.id}/${resultId}`;
            await git(current.worktreePath, ["update-ref", durableRef, workerHead]);
        }
        const result: AgentWorkspaceResult = {
            id: resultId,
            workspaceId: current.id,
            runId: leaseRunId,
            ...((current.leaseRunInstanceId ?? leaseRunInstanceId)
                ? { runInstanceId: current.leaseRunInstanceId ?? leaseRunInstanceId }
                : {}),
            baseRevision,
            workerHead,
            commitRange: `${baseRevision}..${workerHead}`,
            commits,
            ...(durableRef ? { durableRef } : {}),
            preparedAt: Date.now(),
            status: "prepared",
        };
        await database.run(
            `
            INSERT INTO workspace_results (
                id, workspace_id, run_id, run_instance_id, base_revision, worker_head, commit_range,
                commits_json, durable_ref, prepared_at, status, parent_revision, applied_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `,
            result.id,
            result.workspaceId,
            result.runId,
            result.runInstanceId ?? null,
            result.baseRevision,
            result.workerHead,
            result.commitRange,
            JSON.stringify(result.commits),
            result.durableRef ?? null,
            result.preparedAt,
            result.status,
        );
        return result;
    } catch (error) {
        if (durableRef)
            await git(current.worktreePath, ["update-ref", "-d", durableRef]).catch(() => {});
        throw error;
    } finally {
        await database.close();
    }
}

/** Apply a prepared worker result to its parent checkout without creating a parent commit. */
export async function applyAgentWorkspaceApplication(
    workspace: AgentWorkspace,
    options: AgentWorkspaceLeaseOptions,
): Promise<AgentWorkspaceResult> {
    const database = await openDatabase(options.workspacesDir);
    let reservationToken: string | undefined;
    let reservedResultId: string | undefined;
    let applying = false;
    try {
        const current = await workspaceById(database, workspace.id);
        if (!current) throw new Error(`Workspace ${workspace.id} was not found.`);
        let result = await requireMatchingWorkspaceResult(database, current, options);
        if (result.status === "applied") return result;
        if (result.status === "applying") {
            result = await recoverApplyingWorkspaceResult(database, current, result, options);
            if (result.status === "applied") return result;
        }
        if (result.status !== "prepared") {
            throw new Error(
                `Workspace ${workspace.id} has no prepared result for run ${options.leaseRunId}.`,
            );
        }
        if (current.leaseRunId === options.leaseRunId && !matchingLease(current, options)) {
            throw new Error(`Workspace ${workspace.id} is currently leased by another owner.`);
        }
        reservationToken = await reserveResult(database, result, options);
        reservedResultId = result.id;
        const workerHead = result.durableRef
            ? await git(current.repositoryRoot, ["rev-parse", result.durableRef])
            : result.workerHead;
        if (workerHead !== result.workerHead) {
            throw new Error("The durable isolated result changed after application preparation.");
        }
        if (!(await hasAncestor(current.repositoryRoot, result.baseRevision, result.workerHead))) {
            throw new Error(
                "The prepared worker revision is no longer based on the workspace base revision.",
            );
        }
        const parentRevision = await git(current.repositoryRoot, ["rev-parse", "HEAD"]);
        if (!(await hasAncestor(current.repositoryRoot, result.baseRevision, parentRevision))) {
            throw new Error(
                `Parent checkout at ${parentRevision} no longer contains workspace base ${result.baseRevision}.`,
            );
        }
        const parentStatus = await git(current.repositoryRoot, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ]);
        if (parentStatus)
            throw new Error(
                "Parent checkout has uncommitted changes; apply requires a clean checkout.",
            );
        return await withWorkspaceResultPatch(current, result, async (patch, patchPath) => {
            if (patch) {
                await git(current.repositoryRoot, ["apply", "--check", "--binary", patchPath]);
            }
            await markResultApplying(
                database,
                result.id,
                current.id,
                parentRevision,
                reservationToken!,
            );
            applying = true;
            activeApplyingResultIds.add(result.id);
            try {
                if (patch) {
                    await git(current.repositoryRoot, ["apply", "--binary", patchPath]);
                }
                const applied = await markResultApplied(
                    database,
                    result.id,
                    current.id,
                    parentRevision,
                    reservationToken!,
                );
                reservationToken = undefined;
                applying = false;
                return applied;
            } finally {
                activeApplyingResultIds.delete(result.id);
            }
        });
    } catch (error) {
        // Once the durable state is `applying`, retain the reservation so a
        // later invocation can reconcile the parent checkout before retrying.
        if (reservationToken && reservedResultId && !applying) {
            await releaseResultReservation(database, reservedResultId, reservationToken);
        }
        throw error;
    } finally {
        await database.close();
    }
}

/** Retain a changed prepared result for later review without applying it. */
export async function retainAgentWorkspaceResult(
    workspaceId: string,
    options: AgentWorkspaceLeaseOptions,
): Promise<void> {
    const database = await openDatabase(options.workspacesDir);
    let reservationToken: string | undefined;
    let reservedResultId: string | undefined;
    try {
        const workspace = await workspaceById(database, workspaceId);
        if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
        const result = await requirePreparedResult(database, workspace, options);
        if (result.commits.length === 0) {
            throw new Error(`Workspace ${workspaceId} has no changed prepared result to retain.`);
        }
        if (
            workspace.leaseRunId &&
            workspace.leaseRunId === options.leaseRunId &&
            !matchingLease(workspace, options)
        ) {
            throw new Error(`Workspace ${workspaceId} is currently leased by another owner.`);
        }
        if (matchingLease(workspace, options)) {
            const state = await inspectAgentWorkspaceGitState(workspace);
            const head = state.kind === "available" ? state.headRevision : undefined;
            if (state.kind !== "available" || state.dirty || head !== result.workerHead) {
                throw new Error(`Workspace ${workspaceId} changed after its result was prepared.`);
            }
        }
        reservationToken = await reserveResult(database, result, options);
        reservedResultId = result.id;
        await database.transaction(async (transaction) => {
            const updated = await transaction.run(
                `
                UPDATE workspace_results
                SET reservation_token = NULL, reservation_owner_session_id = NULL,
                    reservation_run_id = NULL, reservation_run_instance_id = NULL,
                    reservation_owner_pid = NULL, reservation_acquired_at = NULL
                WHERE id = ? AND status = 'prepared' AND reservation_token = ?
            `,
                result.id,
                reservationToken,
            );
            if (updated.changes !== 1)
                throw new Error(`Workspace result ${result.id} changed during retention.`);
            if (matchingLease(workspace, options)) {
                await transaction.run(
                    `
                    UPDATE workspaces SET workspace_status = 'review_required', lease_owner_session_id = NULL,
                        lease_run_id = NULL, lease_run_instance_id = NULL, lease_kind = NULL, lease_acquired_at = NULL, updated_at = ?
                    WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
                      AND (? IS NULL OR lease_run_instance_id = ?) AND lease_kind = 'task'
                `,
                    Date.now(),
                    workspaceId,
                    options.ownerSessionId,
                    options.leaseRunId,
                    options.leaseRunInstanceId ?? null,
                    options.leaseRunInstanceId ?? null,
                );
            }
        }, "IMMEDIATE");
        reservationToken = undefined;
    } catch (error) {
        if (reservationToken && reservedResultId)
            await releaseResultReservation(database, reservedResultId, reservationToken);
        throw error;
    } finally {
        await database.close();
    }
}

/** Discard one prepared result without disturbing another worker's worktree. */
export async function discardAgentWorkspaceResult(
    workspaceId: string,
    options: AgentWorkspaceLeaseOptions,
): Promise<void> {
    const database = await openDatabase(options.workspacesDir);
    let reservationToken: string | undefined;
    let reservedResultId: string | undefined;
    try {
        const workspace = await workspaceById(database, workspaceId);
        if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
        const result = await requirePreparedResult(database, workspace, options);
        const ownsLease = matchingLease(workspace, options);
        if (workspace.leaseRunId && workspace.leaseRunId === options.leaseRunId && !ownsLease) {
            throw new Error(`Workspace ${workspaceId} is currently leased by another owner.`);
        }
        if (ownsLease && workspace.latestResult?.id !== result.id) {
            throw new Error(`Workspace ${workspaceId} has a newer result for its current lease.`);
        }
        if (ownsLease) {
            const state = await inspectAgentWorkspaceGitState(workspace);
            if (
                state.kind !== "available" ||
                state.dirty ||
                state.headRevision !== result.workerHead
            ) {
                throw new Error(
                    `Workspace ${workspaceId} changed after its result was prepared; inspect it before discarding.`,
                );
            }
        }
        reservationToken = await reserveResult(database, result, options);
        reservedResultId = result.id;
        if (result.durableRef) {
            await git(workspace.repositoryRoot, ["update-ref", "-d", result.durableRef]);
        }
        const updated = await database.run(
            `
            UPDATE workspace_results
            SET status = 'discarded', durable_ref = NULL, reservation_token = NULL,
                reservation_owner_session_id = NULL, reservation_run_id = NULL,
                reservation_run_instance_id = NULL, reservation_owner_pid = NULL,
                reservation_acquired_at = NULL
            WHERE id = ? AND workspace_id = ? AND status = 'prepared' AND reservation_token = ?
        `,
            result.id,
            workspaceId,
            reservationToken,
        );
        if (updated.changes !== 1)
            throw new Error(`Workspace result ${result.id} changed during discard.`);
        reservationToken = undefined;
        if (ownsLease) {
            // Rebase the reusable worktree to the current parent HEAD only when
            // this result still owns the lease. Historical results never touch
            // the worktree currently assigned to another worker.
            const targetRevision = await resetReusableWorkspace(workspace);
            await database.run(
                `
                UPDATE workspaces SET workspace_status = 'available', base_revision = ?,
                    lease_owner_session_id = NULL, lease_run_id = NULL, lease_run_instance_id = NULL, lease_kind = NULL,
                    lease_acquired_at = NULL, updated_at = ?
                WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
                  AND (? IS NULL OR lease_run_instance_id = ?) AND lease_kind = 'task'
            `,
                targetRevision,
                Date.now(),
                workspaceId,
                options.ownerSessionId,
                options.leaseRunId,
                options.leaseRunInstanceId ?? null,
                options.leaseRunInstanceId ?? null,
            );
        }
    } catch (error) {
        if (reservationToken && reservedResultId)
            await releaseResultReservation(database, reservedResultId, reservationToken);
        throw error;
    } finally {
        await database.close();
    }
}

/** Release a task lease only after its prepared result was applied successfully. */
export async function releaseAgentWorkspaceAfterApplication(
    workspaceId: string,
    options: AgentWorkspaceLeaseOptions,
): Promise<void> {
    const {
        ownerSessionId,
        leaseRunId,
        workspacesDir = PI_CODER_WORKSPACES_DIR,
        leaseRunInstanceId,
    } = options;
    const database = await openDatabase(workspacesDir);
    try {
        const workspace = await workspaceById(database, workspaceId);
        if (
            workspace?.leaseOwnerSessionId !== ownerSessionId ||
            workspace.leaseRunId !== leaseRunId ||
            (workspace.leaseRunInstanceId !== undefined &&
                workspace.leaseRunInstanceId !== leaseRunInstanceId)
        ) {
            throw new Error(`Workspace ${workspaceId} is not leased by ${leaseRunId}.`);
        }
        const result = await requireMatchingWorkspaceResult(database, workspace, options);
        if (workspace.leaseKind !== "task" || result.status !== "applied") {
            throw new Error(
                `Workspace ${workspaceId} can be released only after successful application.`,
            );
        }
        await database.run(
            `
            UPDATE workspaces SET workspace_status = 'review_required', lease_owner_session_id = NULL,
                lease_run_id = NULL, lease_run_instance_id = NULL, lease_kind = NULL, lease_acquired_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
              AND (? IS NULL OR lease_run_instance_id = ?)
        `,
            Date.now(),
            workspaceId,
            ownerSessionId,
            leaseRunId,
            leaseRunInstanceId ?? null,
            leaseRunInstanceId ?? null,
        );
    } finally {
        await database.close();
    }
}

/** Release a task lease when the worker produced no changes, making the clean workspace reusable. */
export async function releaseAgentWorkspaceAfterNoChanges(
    workspaceId: string,
    options: AgentWorkspaceLeaseOptions,
): Promise<void> {
    const {
        ownerSessionId,
        leaseRunId,
        workspacesDir = PI_CODER_WORKSPACES_DIR,
        leaseRunInstanceId,
    } = options;
    const database = await openDatabase(workspacesDir);
    let reservationToken: string | undefined;
    let reservedResultId: string | undefined;
    try {
        const workspace = await workspaceById(database, workspaceId);
        if (
            workspace?.leaseOwnerSessionId !== ownerSessionId ||
            workspace.leaseRunId !== leaseRunId ||
            (workspace.leaseRunInstanceId !== undefined &&
                workspace.leaseRunInstanceId !== leaseRunInstanceId)
        ) {
            throw new Error(`Workspace ${workspaceId} is not leased by ${leaseRunId}.`);
        }
        const result = await requireMatchingWorkspaceResult(database, workspace, options);
        if (
            workspace.leaseKind !== "task" ||
            result.status !== "prepared" ||
            result.baseRevision !== result.workerHead ||
            result.commits.length > 0
        ) {
            throw new Error(
                `Workspace ${workspaceId} can be released without application only when its prepared result has no changes.`,
            );
        }
        const state = await inspectAgentWorkspaceGitState(workspace);
        if (
            state.kind !== "available" ||
            state.dirty ||
            state.headRevision !== result.baseRevision
        ) {
            throw new Error(
                `Workspace ${workspaceId} changed after its no-change result was prepared.`,
            );
        }
        reservationToken = await reserveResult(database, result, options);
        reservedResultId = result.id;
        const targetRevision = await resetReusableWorkspace(workspace);
        if (result.durableRef) {
            await git(workspace.worktreePath, ["update-ref", "-d", result.durableRef]);
        }
        const updated = await database.run(
            `
            UPDATE workspace_results
            SET status = 'discarded', durable_ref = NULL, reservation_token = NULL,
                reservation_owner_session_id = NULL, reservation_run_id = NULL,
                reservation_run_instance_id = NULL, reservation_owner_pid = NULL,
                reservation_acquired_at = NULL
            WHERE id = ? AND workspace_id = ? AND status = 'prepared' AND reservation_token = ?
        `,
            result.id,
            workspaceId,
            reservationToken,
        );
        if (updated.changes !== 1)
            throw new Error(`Workspace result ${result.id} changed during no-change release.`);
        reservationToken = undefined;
        await database.run(
            `
            UPDATE workspaces SET workspace_status = 'available', base_revision = ?,
                lease_owner_session_id = NULL, lease_run_id = NULL, lease_run_instance_id = NULL, lease_kind = NULL,
                lease_acquired_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
              AND (? IS NULL OR lease_run_instance_id = ?)
        `,
            targetRevision,
            Date.now(),
            workspaceId,
            ownerSessionId,
            leaseRunId,
            leaseRunInstanceId ?? null,
            leaseRunInstanceId ?? null,
        );
    } catch (error) {
        if (reservationToken && reservedResultId)
            await releaseResultReservation(database, reservedResultId, reservationToken);
        throw error;
    } finally {
        await database.close();
    }
}

/** Inspect a prepared workspace result without reading the mutable worktree. */
export async function inspectAgentWorkspaceResult(
    workspace: AgentWorkspace,
    requestedResult?: AgentWorkspaceResult,
): Promise<string> {
    const result = requestedResult ?? workspace.latestResult;
    if (!result || result.status === "discarded")
        return "No saved worker result is available for this workspace.";
    if (result.baseRevision === result.workerHead)
        return "No changes: the worker revision matches the workspace base revision.";
    const head = result.durableRef
        ? await git(workspace.repositoryRoot, ["rev-parse", result.durableRef])
        : result.workerHead;
    if (head !== result.workerHead)
        throw new Error(`Workspace result ${result.id} no longer points to its recorded commit.`);
    const stat = await git(workspace.repositoryRoot, [
        "diff",
        "--stat",
        "--no-ext-diff",
        `${result.baseRevision}..${result.workerHead}`,
    ]);
    const commits = result.commits.length > 0 ? result.commits.join(", ") : "none";
    return [
        `Workspace: ${workspace.slug}`,
        `Base revision: ${result.baseRevision}`,
        `Worker revision: ${result.workerHead}`,
        `Commit range: ${result.commitRange}`,
        `Commits: ${commits}`,
        `Durable ref: ${result.durableRef ?? "none"}`,
        "",
        "Changed files:",
        stat || "(none)",
    ].join("\n");
}

/** Reconcile previously collected no-change results from before automatic release existed. */
export async function reconcileNoChangeAgentWorkspaceLeases(
    cwd: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<number> {
    const workspaces = await listAgentWorkspaces(cwd, { workspacesDir });
    let released = 0;
    for (const workspace of workspaces) {
        if (
            workspace.leaseKind !== "task" ||
            !workspace.leaseOwnerSessionId ||
            !workspace.leaseRunId
        )
            continue;
        const result = await getAgentWorkspaceResult(
            workspace.id,
            workspace.leaseRunId,
            workspace.leaseRunInstanceId,
            { workspacesDir },
        );
        if (
            !result ||
            result.status !== "prepared" ||
            result.baseRevision !== result.workerHead ||
            result.commits.length > 0
        )
            continue;
        try {
            await releaseAgentWorkspaceAfterNoChanges(workspace.id, {
                ownerSessionId: workspace.leaseOwnerSessionId,
                leaseRunId: workspace.leaseRunId,
                workspacesDir,
                leaseRunInstanceId: workspace.leaseRunInstanceId,
                resultId: result.id,
            });
            released++;
        } catch {
            // Leave a changed or otherwise unsafe workspace leased for explicit recovery.
        }
    }
    return released;
}
