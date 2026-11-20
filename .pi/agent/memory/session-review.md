---
name: session-review
description: "Session-review skill: session/child discovery, search, per-turn overview, transcript windows, and compaction span anchors."
category: architecture
priority: 6
keep_updated: true
status: Implemented; the skill and script are the source of truth
---

# Session review skill

`skills/session-review/` is a project skill for reading pi sessions as chat transcripts, mainly to recover what
compaction folded away. It is registered by `package.json` (`pi.skills: ["./skills"]`), so adding it needed no
change in `src/index.ts`.

- `SKILL.md` carries the workflow (discover with `--sessions`, locate with `--search`, digest with
  `--overview`, then `--compactions` → `--context` → raw window).
- `scripts/session-transcript.mts` is dependency-free, reads raw JSONL, and runs with plain `node`
  (pi's engine floor, Node >=22.19, strips types by default). Tests are
  `test/skills/session-review/session-transcript.test.ts` and import the script directly.

## Invariants

- **Raw JSONL is deliberate, not `SessionManager`.** That keeps the script zero-dependency and lets the same
  code read parent sessions and delegated child transcripts under `<agent-dir>/pi-coder/agent-sessions/<encoded-cwd>/<runId>/`.
  `/stats` (see `stats-command.md`) made the same raw-JSONL choice for the same portability reason.
- **Discovery has two roots**: pi's parent-session root (`PI_CODING_AGENT_SESSION_DIR`, else
  `<agent-dir>/sessions`) and pi-coder's child root (`<state-dir>/agent-sessions`). The state dir follows
  `resolveStateDirectory`: `PI_CODER_STATE_DIR` wins, a relative value resolves against the extension checkout,
  else `<agent-dir>/pi-coder`. `--session <id>` and `<runId>` search both roots across all cwd directories,
  newest mtime first, so a run id from a parent transcript is enough.
- **Search and overview honor the same window flags as the transcript.** `--search` scans text/summaries, tool
  calls/results, or both (`--in`); it reports turn, entry id, time, and a snippet, capped by `--limit`. The
  first matching source per entry wins, so one entry yields one row. `--overview` prints one block per turn:
  prompt, last assistant text with any text, tool counts, distinct modified files, first error, and the
  `--from`/`--to` span; fold rows print where they sit. Neither mode reads the context branch unless
  `--context` is passed.
- **List and fold selection**: `--list` includes start/end entry ids, error counts, and a fold marker;
  `--width 0` disables prompt truncation. `--compactions --limit N` caps newest-first folds and
  `--compaction <rank|entryId>` selects one. Ranks are newest-first and stay stable when a list is limited.
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
  `--tools none` drops them (and tool/file lines in `--overview`), and `--thinking` adds thinking blocks capped
  at 2000 chars each.
- **Every transcript mode parses the whole file once** (`parseSessionFile` + `activeBranch`); a 220 MB session
  costs about 2 s and 1 GB RSS even for `--search`. `--sessions` only reads the head of each visible file.
  Prefer one mode per large session and a narrow window over repeating full scans.