---
name: session-review
description: "Session-review skill: transcript script, raw-JSONL branch walk, compaction span anchors, and window flags for recovering a session."
category: architecture
priority: 6
keep_updated: true
status: Implemented; the skill and script are the source of truth
---

# Session review skill

`skills/session-review/` is a project skill for reading pi sessions as chat transcripts, mainly to recover what
compaction folded away. It is registered by `package.json` (`pi.skills: ["./skills"]`), so adding it needed no
change in `src/index.ts`.

- `SKILL.md` carries the workflow (recon first, then `--compactions` → `--context` → raw window).
- `scripts/session-transcript.mts` is dependency-free, reads raw JSONL, and runs with plain `node`
  (pi's engine floor, Node >=22.19, strips types by default). Tests are
  `test/skills/session-review/session-transcript.test.ts` and import the script directly.

## Invariants

- **Raw JSONL is deliberate, not `SessionManager`.** That keeps the script zero-dependency and lets the same
  code read parent sessions and delegated child transcripts under `.state/agent-sessions/<encoded-cwd>/<runId>/`.
  `/stats` (see `stats-command.md`) made the same raw-JSONL choice for the same portability reason.
- **Session directory encoding strips the leading separator first**: `--` + cwd with `/`, `\`, `:` replaced by
  `-` + `--` (`/tmp/proj` → `--tmp-proj--`). Omitting the strip produced `---tmp-proj--` and silently broke the
  cwd fallback; only the all-directories id search masked it.
- **Branch walk**: the leaf is the last entry in file order (what pi wrote last); parents are followed through an
  id map, so abandoned branches are excluded. A v1 session without ids is treated as linear, and `--leaf <id>`
  intentionally reads an old branch tip.
- **`--context` mirrors pi's `buildContextEntries`**: the newest fold hoists first, its retained tail runs from
  `firstKeptEntryId` (minus system messages, which the checkpoint replaces), later entries follow, and
  `context_edit` entries are applied (latest edit per target wins; `null` omits the target).
- **Compaction span anchors**: for a fold, the raw span starts at the previous fold's retained-tail start (or
  the branch root) and ends at the entry before this fold's `firstKeptEntryId` (or before the fold for
  retain-none); trailing fold rows are trimmed because their summaries are listed separately. `--compactions`
  prints the span as pastable `--from`/`--to` ids, newest fold first.
- **Window constraints intersect**: `--last`, `--turns a:b`, `--from`/`--to` (unique id prefixes), and
  `--since`/`--until` (relative `45m`/`2h`/`3d`, ISO, or `YYYY-MM-DD`; until treats a date as local end of day).
  Entry-id anchors are exclusive of nothing — both bounds are inclusive.
- **Output is capped at 48000 chars by default** so the model stays under pi's bash truncation (last 2000 lines
  or 50KB); `--max-chars 0` lifts it. Tool calls render as `read(path)`, `bash(command…)`,
  `grep(pattern in path)`, with `[error: first line]` markers; `--tools full` adds capped args and result text,
  `--tools none` drops them, and `--thinking` adds thinking blocks capped at 2000 chars each.