---
name: session-review
description: Review a pi session transcript, including the current one, and recover context lost to compaction. Use when checking what happened earlier in a session, finding prior decisions or file changes, or reading a delegated child session.
---

# Session Review

Read what actually happened in a pi session: user and assistant messages with tool calls collapsed to one line
each. The main use is post-compaction recovery. Compaction replaces older messages with a summary in the
model's context, but the session file still holds every original message; this skill's script prints bounded
windows of it, so restoring one span does not cost the whole session.

## Locate the session

- **Current session**: `$PI_SESSION_FILE` is set for every command run through the `bash` tool, and the script
  defaults to it (falling back to the newest transcript for the working directory).
- **Parent sessions**: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<session-id>.jsonl`. `--session <id>`
  searches them by id; `--session <path>` reads any file directly.
- **Delegated child sessions**: the same format under `.state/agent-sessions/<encoded-cwd>/<runId>/`. Pass one
  with `--session <path>` when a parent transcript shows a child run whose work matters.

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
| What was compacted, newest first, with the raw span each fold dropped | `node scripts/session-transcript.mts --compactions`                                         |
| What the model still has now (latest summary + retained tail)         | `node scripts/session-transcript.mts --context`                                             |
| Turn index with entry ids                                             | `node scripts/session-transcript.mts --list`                                                |
| A chat window                                                         | `node scripts/session-transcript.mts --last 5`                                              |
| A time window                                                         | `node scripts/session-transcript.mts --since 2h` or `--since 2026-10-22 --until 2026-10-22` |
| A span between two entries                                            | `node scripts/session-transcript.mts --from <id> --to <id>`                                 |
| Arguments/results the one-line call cannot carry                      | add `--tools full`                                                                          |

## Post-compaction procedure

1. Run `--compactions`. Each fold shows its summary, `tokensBefore`, `keptFrom`, and a ready-to-paste
   `--from <id> --to <id>` for the raw span that fold summarized. The newest fold defines the current context.
2. Run `--context` to see what survived: the hoisted summary plus entries from `firstKeptEntryId` to the leaf,
   with `context_edit` replacements applied. If the answer is not there, it is in the dropped span.
3. Extract from the raw branch (the default). Start from the `--compactions` anchors or `--since`/`--until`
   around the fold time, then trim with `--last N` or `--turns A:B` if still long.
4. Recover details the summary compressed: exact commands, file paths, decisions, and failures. Use
   `--tools full` on a narrow window when a call's arguments or result are the payload.
5. Treat the summary as a lead, not a source: it is model-generated and can omit or distort. When raw messages
   disagree with it, report what the messages show.

## Options that matter

- `--tools none|short|full` (default `short`): short prints `read(path)`, `bash(command…)`,
  `grep(pattern in path)` and `[error: first line]` markers; full adds args and result text, each capped;
  none is pure user/assistant text.
- `--thinking` includes assistant thinking blocks, capped at 2000 characters each.
- `--max-chars N` caps output (default 48000; `0` lifts it). pi's bash tool truncates its own output near 50KB
  and saves the rest to a temp file — narrow the window instead of reading the temp file.
- Entry ids accept any unique prefix. `--list`, `--compactions`, and every transcript header print ids.
- Raw branch and `--context` answer different questions: context is the model's view, the raw branch is the
  file's history. Read both when reconciling a fold.

## Notes

- The script reads raw JSONL and walks the parent chain from the last entry, so abandoned branches are excluded
  and `--leaf <id>` reads an old branch tip on purpose.
- `rg` over the session file is fine for locating a string quickly, but extract the surrounding window with the
  script before quoting it: a matching JSONL line can be megabytes long.
- Transcripts contain prompts, file contents, command output, and possibly secrets. Do not copy them into
  memories or shared artifacts without checking.
