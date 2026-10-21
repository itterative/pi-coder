---
name: configuration
description: The compaction config file and its keys, the readConfigFile wiring gotcha, and the dated phase timeline for reading the detail files.
category: architecture
keep_updated: true
---

# Compaction configuration and phases

Detail companion to the `compaction` memory (`../compaction.md`).

## Configuration

`compaction-config.json`, project (`.pi/`, nearest ancestor) over global (`~/.pi/`), env-overridable with
`COMPACTION_CONFIG_PATH` / `COMPACTION_CONFIG_PATH_GLOBAL`, mirroring `src/tools/agent/config.ts`. Malformed or unknown
fields fall back to defaults, because children run this unattended. `enabled: false` returns `undefined`; core's own
`compaction.enabled: false` still wins (the event never fires). `serializedMaxTokens`, `keepThinking`, and the per-block
char caps govern stage 2; `traceEnabled`/`tracePath`/`traceMaxBytes`/`traceGenerations` govern the trace;
`chainTraceEnabled` gates the persisted chain rows that share the same file, separately because they carry no
conversation content — so history keeps accumulating while bodies are off. The verdict itself is still only recorded
while `traceEnabled` is on (`COMPACTION_CHAIN_TRACE=0`). `model` is accepted but unused — the seam for the planned
dedicated compaction model, which wants the serialized route since it has no cache prefix to protect.
`retryMaxRetries` (extra attempts after the first) and `retryBaseDelayMs` (doubling) bound the transient backoff;
`0` turns resends off entirely. Deliberately below core's agent-retry settings: this stall happens inside a turn the
user is waiting on.

**A field is only configurable once `readConfigFile()` reads it.** That function maps keys through validators into an
explicit return object, so a field added to `CompactionConfig`, the interface docs, and the loader still does nothing
unless it is also added there — "unknown fields fall back to defaults" makes the omission silent, not an error.
`retryMaxRetries` was dead for exactly one test run before `test-defaults.json` (a file the suite writes into its own
temp directory — see `test/modules/compaction/handler.test.ts` and `trace.test.ts`) proved it: the suite slept a real second
on a backoff that was supposed to be off. Add the field to `readConfigFile` in the same edit, and let a test observe it:
`nonNegativeNumberField` keeps a `0`, `positiveNumberField` drops one.

## Timeline (for reading the detail files)

`git log -- src/modules/compaction/` gives the full order; the phases matter because later numbers supersede earlier ones.
**2026-09-05** — the two-stage pipeline, tracing, abort handling, `stopReason`, the cause taxonomy, whole-prompt hashing
(`obs=0` resolved the same evening). **2026-09-06** — request parity (`tool_choice` dropped, thinking level forwarded,
sampling params merged), the request chain and its persisted rows, the prefix funnel, `stageOneSpanEntries`, the cut
point, `estimate-skew` repaired. **2026-09-07** — the head ledger, the wire projection in `usage.ts`, the closing
bracket, the per-stage output cap, and the ledger-backed cut walk. Where a number was later shown to be an artifact, the
detail file says so at the number rather than silently replacing it.
