---
name: stats-command
description: "How /stats scans parent and child transcripts, aggregates ranges in memory, and why it never mtime-filters or uses common/async sleep."
category: architecture
priority: 6
---

# `/stats` command (`src/commands/stats`)

`/stats` reports usage, activity, and cost across pi's parent sessions and pi-coder's child sessions. It is registered from `src/index.ts` via `registerStatsCommand`. Implementation split: `range.ts` (argument grammar and local-date helpers), `scan.ts` (async JSONL scan), `aggregate.ts` (pure range projection), `render.ts` (styled report lines), `view.ts` (`CancellableLoader` progress phase plus a `PagerComponent` report with `r` range cycling), `usage.ts` (additive usage helpers), `types.ts`.

## Invariants

- **Every scan is complete.** After discovery there is deliberately no mtime prefilter: a bounded lookback that skipped old files would make the always-shown all-time heatmap and the `r` "All time" range silently incomplete. A full scan over ~1200 local transcripts takes ~6–7s, which the loader exists to absorb. Do not reintroduce a `since` filter without also rescanning when the range widens.
- **Parent root is derived.** `parentSessionsRoot(ctx)` uses the grandparent of the current session file so `--session-dir` and custom agent directories keep working, falling back to `getAgentDir()/sessions`. Child root is `PI_CODER_AGENT_SESSIONS_DIR` (`.state/agent-sessions`, nested `<cwd>/<runId>/*.jsonl`).
- **Yield with a referenced timer.** `scan.ts` uses its local `yieldToEventLoop`, not `common/async.ts`'s `sleep`: that helper `unref()`s its timer, so a non-interactive scan run can exit mid-scan once no other handle keeps the event loop alive. The referenced `setTimeout` also lets the spinner repaint between files.
- **Raw JSONL, not `SessionManager`.** Usage on abandoned branches was real spend, so the scanner sums every `message`/`usage`/`compaction`/`branch_summary` entry (assistant and toolResult usage, matching the status footer's definition) instead of walking a single leaf branch.
- **Arguments select the initial range only.** `""` = 30 days, `7d`/`30`/`90d`, `all`, `YYYY-MM-DD` (since), two dates (inclusive). The dialog aggregates the other presets from the same scan; `r` never re-reads disk.

Tests live in `test/commands/stats/` (`range`, `scan`, `aggregate`, `view` file snapshots), with shared builders in `test/commands/stats/fixtures.ts`.