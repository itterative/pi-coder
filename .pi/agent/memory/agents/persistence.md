---
name: persistence
description: Detailed delegated-agent durable sessions, restoration rules, and browser behavior.
category: architecture
keep_updated: true
---

# Agent persistence

## Storage and ownership

- Persisted parents use SDK `SessionManager.create/open` for child JSONL under `<pi-coder-install>/.state/agent-sessions/--<encoded-cwd>--/<parent-session-id>/`. The install root comes from `import.meta.url`; cwd normalization is centralized; private directories use mode `0700`; `.state/` is gitignored.
- Full parent run-state snapshots are stored in the extension-local SQLite metadata database, keyed by owner parent session, run ID, and active-branch entry. Saves use a session-scoped synchronous `DatabaseSync` transaction for the state and catalog projections; stale timestamps are rejected. Child transcripts do not contain the parent run ID, task/status, pending question, usage checkpoint, or retention state.
- Records are bound to the exact parent session UUID and active branch. Reload/restart and switching away/back restore that session; `/new`, `/fork`, `/clone`, and ephemeral parents do not inherit children. `/tree` navigation is blocked during active streaming or permission waits and rebuilds state at the new branch afterward.

## Restoration rules

- Waiting children reopen paused. Uncollected retained background terminal outcomes restore from bounded parent metadata without reopening the child transcript.
- Starting/running records left by shutdown or crash restore as `interrupted`; they never restart or replay. Resuming is user-driven and adds a safety instruction to inspect the current state first.
- Before continuing a crash-interrupted transcript, unmatched tool calls receive synthetic uncertain-outcome errors. Worker mutations are never automatically replayed.
- Current definitions and fingerprints are revalidated. Legacy fingerprints from before context policies are accepted when all other definition identity fields still match. Persisted metadata cannot grant mutation authority; only the current reserved built-in worker can restore as a mutating task worker.
- Collection, cancellation, and terminal-result eviction append tombstones but retain child files so `/agents` can browse past work. An explicit future prune policy should remove old transcripts and orphan directories.

## Branch-correct persistence (V2)

Delegated run restoration now uses a small `pi-coder:agent-run-snapshot-v2` parent-tree marker pointing to normalized immutable SQLite run-instance/snapshot rows. Parent marker reachability defines branch state; each physical run receives an internal UUID independent of its branch-local display ID; every new resumable snapshot stores an explicit child transcript leaf. A physical run has one session-wide continuation head: only the parent branch whose latest reachable marker equals that head may resume it, while older branch checkpoints are exposed as read-only history marked as continued elsewhere. Restore selects/resets the child leaf before context construction, and interrupted repair runs only after explicit resume. Parent marker append is the commit point, the catalog is a rebuildable projection, and old custom-entry/current experimental state formats remain non-authoritative. `/agents` Past is scoped to the active parent branch when the parent session is available; explicit archive scopes remain a future extension. Workspace leases/results still use display `runId` in several mutation paths and should be upgraded to `runInstanceId` separately. See `AGENT-PERSISTENCE-FINDINGS.md` for invariants and remaining limitations.

## Browser

`/agents` currently scans active manager runs and persisted transcripts for the current cwd with separate Current/Past views. Current/Past details show user/custom/assistant messages and compact tool calls while omitting thinking and potentially large tool-result output. Live details reload on agent events and follow new content until the user scrolls up; `End` resumes following. Details are read-only; `r` resumes interrupted current runs and `c` cancels waiting/interrupted runs. Planned browser work is to merge Current and Past into one list with explicit active/historical status and broader historical scope, while stale checkpoints remain read-only.
