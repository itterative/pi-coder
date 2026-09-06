// Tests must never append to the real development decision log in this checkout's
// .state directory. Suites that exercise the writer re-enable it with
// SANDBOX_DECISION_LOG plus SANDBOX_DECISION_LOG_PATH pointed at a temporary file.
process.env.SANDBOX_DECISION_LOG ??= "0";

// Same for the compaction trace under .state: it records raw summary text, so a suite only writes it where
// COMPACTION_TRACE_PATH points at its own temporary file.
process.env.COMPACTION_TRACE ??= "0";

// The persisted chain shares that file but has its own switch, and it is on by default - so disabling the
// trace alone does not stop writes. Without this pin, any suite that fires before_provider_request without
// redirecting COMPACTION_TRACE_PATH would read and append this checkout's real development trace.
process.env.COMPACTION_CHAIN_TRACE ??= "0";
