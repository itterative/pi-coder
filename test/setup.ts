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

// The decision-model config must never come from the developer's real ~/.pi or from a project file above a
// temporary workspace: an endpoint left enabled in either would make permission suites call a live model.
// Suites that exercise it point these at their own files, or set the section inside a temp project config.
process.env.DECISION_MODEL_CONFIG_PATH_GLOBAL ??= "";
process.env.DECISION_MODEL_CONFIG_PATH ??= "";
