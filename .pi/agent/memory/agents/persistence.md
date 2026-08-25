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

## Planned branch-correct redesign

The current branch-keyed SQLite upsert is recognized as insufficient because several child transitions can overwrite one parent leaf before the parent tool result exists. The selected replacement is a small parent-tree custom marker pointing to normalized immutable SQLite run-instance/snapshot rows. Parent marker reachability defines branch state; each physical run receives an internal UUID independent of its branch-local display ID; every resumable snapshot stores an explicit child transcript leaf. A physical run has one session-wide continuation head: only the parent branch whose latest reachable marker equals that head may resume it, while older branch checkpoints remain read-only history marked as continued elsewhere. Restore must branch/reset the child before context construction, repair, resume, or display. Parent marker append is the commit point, the catalog remains a rebuildable projection, and old custom-entry/current experimental state formats require no migration. `/agents` Current and Past should default to runs reachable on the active parent branch; sibling-branch, whole-session, and repository history are explicit archive scopes. See `AGENT-PERSISTENCE-FINDINGS.md` before implementing.

## Browser

`/agents` scans active manager runs and persisted transcripts for the current cwd. Current/Past details show user/custom/assistant messages and compact tool calls while omitting thinking and potentially large tool-result output. Live details reload on agent events and follow new content until the user scrolls up; `End` resumes following. Details are read-only; `r` resumes interrupted current runs and `c` cancels waiting/interrupted runs.
