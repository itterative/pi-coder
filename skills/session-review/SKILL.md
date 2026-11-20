---
name: session-review
description: Review a pi session transcript, including the current one, and recover context lost to compaction. Use when checking what happened earlier in a session, finding prior decisions or file changes, or reading a delegated child session.
---

# Session Review

Read what actually happened in a pi session: find the session or delegated-child run, search it for a phrase,
review its turns, then print bounded transcript windows. The main use is post-compaction recovery. Compaction
replaces older messages with a summary in the model's context, but the session file still holds every original
message; this skill's script locates and prints only the span that matters.

## Locate the session

- **What exists**: `--sessions` lists the newest parent transcripts and delegated-child runs for the current
  cwd. Add `--all` for every cwd directory, `--last N` or `--limit N` to widen the list, and `--since 2h` to
  filter by modification time. Each row shows the session id, child run id, size, and the first user prompt.
- **Current session**: `$PI_SESSION_FILE` is set for every command run through the `bash` tool, and the script
  defaults to it (falling back to the newest transcript for the working directory).
- **Parent sessions**: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<session-id>.jsonl`. `--session <id>`
  searches every cwd directory by id.
- **Delegated child sessions**: the same format under `<agent-dir>/pi-coder/agent-sessions/<encoded-cwd>/<runId>/`,
  or `<PI_CODER_STATE_DIR>/agent-sessions/...` when the state directory is relocated. `--session <runId>` also
  searches those run directories, so the run id from a parent transcript is enough.
- `--session <path>` reads any file directly when you already know it.

## The script

Commands below are relative to this skill's directory; run them from there, or prefix with the skill path pi
reported when loading this skill.

```bash
node scripts/session-transcript.mts [options]
```

Start with reconnaissance. Never `cat` or `jq` a session into context: files reach tens of megabytes, and the
whole point is to spend tokens only on the span that matters.

| You want                                                              | Command                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Which sessions and child runs exist                                   | `node scripts/session-transcript.mts --sessions` (add `--all`, `--since 2h`, `--limit 30`)  |
| Where a phrase, file, or command appears                              | `node scripts/session-transcript.mts --search "KEEP_SANDBOX_IMAGES"`                        |
| A file name only in tool calls or results                             | `... --search "image-retention.ts" --in tools`                                              |
| A regex, or a case-sensitive match                                    | `... --search "P[1-4] " --regex` / `... --search "REVIEW.md" --case-sensitive`              |
| A per-turn digest instead of the whole transcript                     | `node scripts/session-transcript.mts --overview`                                            |
| What was compacted, newest first, with the raw span each fold dropped | `node scripts/session-transcript.mts --compactions`                                         |
| One fold only, by newest-first rank or entry id                       | `... --compaction 2` or `... --compaction a883a8f5`                                         |
| What the model still has now (latest summary + retained tail)         | `node scripts/session-transcript.mts --context`                                             |
| Turn index with start/end entry ids, tool and error counts            | `node scripts/session-transcript.mts --list`                                                |
| A chat window                                                         | `node scripts/session-transcript.mts --last 5`                                              |
| A time window                                                         | `node scripts/session-transcript.mts --since 2h` or `--since 2026-10-22 --until 2026-10-22` |
| A span between two entries                                            | `node scripts/session-transcript.mts --from <id> --to <id>`                                 |
| Arguments/results the one-line call cannot carry                      | add `--tools full`                                                                          |

## Review loop

1. **Find the session.** `--sessions` shows this cwd's parents and child runs with their first prompt. Use
   `--session <id>` for a parent, `--session <runId>` for a delegated run, or `--all` when the session is from
   another checkout.
2. **Locate the span.** `--search <pattern>` returns matching entries with a turn number, entry id, timestamp,
   and snippet. `--in tools` searches tool arguments and results; the default searches text, summaries, tool
   calls, and results. Every window flag works with search, so `--turns 3 --search …` scans one turn.
3. **See the shape.** `--overview` prints one block per turn: prompt, final assistant text, tool counts,
   modified files, first error, and a pasteable `--from/--to` span. Folds are printed where they sit.
4. **Read the evidence.** Extract the turn (`--turns N`) or span (`--from <id> --to <id>`) from the raw branch.
   Use `--tools full` only on that narrow window when a call's arguments or result are the payload.
5. **Reconcile compaction.** `--compactions` lists what each fold dropped; `--context` shows what survived. The
   summary is a lead, not a source: when raw messages disagree, report the messages.

## Post-compaction procedure

1. Run `--compactions`. Each fold shows its summary, `tokensBefore`, `keptFrom`, and a ready-to-paste
   `--from <id> --to <id>` for the raw span that fold summarized. Use `--compaction <n|id>` when there are many
   folds and you only need one; `--limit N` keeps the list short.
2. Run `--context` to see what survived: the hoisted summary plus entries from `firstKeptEntryId` to the leaf,
   with `context_edit` replacements applied. If the answer is not there, it is in the dropped span.
3. Find the dropped evidence with `--search` inside the span, or start from the `--compactions` anchors and trim
   with `--last N` / `--turns A:B`.
4. Recover details the summary compressed: exact commands, file paths, decisions, and failures. Use
   `--tools full` on a narrow window when a call's arguments or result are the payload.
5. Treat the summary as a lead, not a source: it is model-generated and can omit or distort. When raw messages
   disagree with it, report what the messages show.

## Options that matter

- `--tools none|short|full` (default `short`): short prints `read(path)`, `bash(command…)`,
  `grep(pattern in path)` and `[error: first line]` markers; full adds args and result text, each capped;
  none is pure user/assistant text (and hides tool/file lines in `--overview`).
- `--thinking` includes assistant thinking blocks, capped at 2000 characters each, and adds thinking to
  `--search` text.
- `--max-chars N` caps output (default 48000; `0` lifts it). pi's bash tool truncates its own output near 50KB
  and saves the rest to a temp file — narrow the window instead of reading the temp file.
- `--limit N` caps search hits, folds, or session rows; the header says when results were truncated.
- `--width N` widens or removes the prompt/text columns in `--list`, `--overview`, and `--sessions`; `0` means no
  cap.
- `--search` is literal and case-insensitive by default; add `--regex` or `--case-sensitive` to change that.
  `--in text|tools|all` selects text/summaries, tool calls/results, or both.
- Entry ids accept any unique prefix. `--list`, `--compactions`, `--search`, `--overview`, and every transcript
  header print ids.
- Raw branch and `--context` answer different questions: context is the model's view, the raw branch is the
  file's history. Read both when reconciling a fold.

## Notes

- The script reads raw JSONL and walks the parent chain from the last entry, so abandoned branches are excluded
  and `--leaf <id>` reads an old branch tip on purpose.
- `rg` over the session file is fine for locating a string quickly, but extract the surrounding window with the
  script before quoting it: a matching JSONL line can be megabytes long. Prefer `--search`, which returns the
  turn and entry id without loading the line into context.
- A very large session still costs one full parse per invocation (~2 s and ~1 GB RSS for a 220 MB file). Narrow
  the window or use `--search`; do not run several modes over the same giant file when one will answer.
- Transcripts contain prompts, file contents, command output, and possibly secrets. Do not copy them into
  memories or shared artifacts without checking.
