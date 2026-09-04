/**
 * Durable delegated-run state: the writer that commits snapshots, continuation leases and journal
 * heads; the stored-record validation that decides what may be restored; and the loader that rebuilds
 * the persistence facade for a parent session.
 *
 * Import from this module rather than from its files, so the package internals stay private. Types are
 * exported from the file that owns them, and callers reach them through `typeof createAgentRunStateWriter`
 * and friends rather than re-exporting every name here.
 */

export { normalizeCwdForSessionDirectory } from "../../../../common/paths";
export { getAgentCwdSessionDir } from "./session-paths";
export { initializeAgentRunContinuationHeads } from "./journal-heads";
export { ENABLE_PID_LEASE_RECOVERY } from "./lease-ledger";
export { createAgentRunStateWriter } from "./state-writer";
export {
    ENABLE_WORKING_STATE_OVERLAY,
    applyWorkingStateOverlay,
    validateAgentRunSnapshot,
} from "./stored-record";
export { loadAgentRunPersistence } from "./load";
