---
name: bash-decision-log
description: Bash permission decision log — what is recorded, where, and how it is mined for heuristic or rule candidates.
category: workflow
---

# Bash permission decision log

Development tooling: every bash permission decision is appended to a durable JSONL log so approval patterns can be mined offline and turned into heuristics or curated rules. Writer `src/modules/sandbox/decision-log.ts`, reader `scripts/permission-report.mjs` (`npm run permission-report`), prose in [docs/bash-decision-log.md](../../../docs/bash-decision-log.md).

## Recording

- Written at the two `resolvePermissionDetails()` call sites only: the parent hook (`src/tools/bash/index.ts`) and the delegated command gate (`src/tools/agent/child/command-permissions.ts`). The `resolution` field is what the resolver itself decided, so a consumer never re-derives policy answers from shell text; `prompt`, `decision`, `sandboxed`, and `blocked` are layered on top. `blocked` distinguishes an approval that could not run (no bwrap) from one that ran.
- Not recorded: the read-only child confinement gate (`src/tools/agent/child/gates/confinement.ts`), which classifies below the `command` rung without the resolver and never prompts, nor file-access or agent-gate approvals.
- Each record carries the per-segment breakdown from `resolvePermissionDetails()`: `source` (`policy`/`heuristic`/`unresolved`), the matched rule `pattern` (`null` when the `**` default decided), `permission` when resolved, `coveredBy` (`segment`/`whole-line` for a rule match, otherwise `null`), and unwrapped `tokens` — the same single unwrap transform suggestions use, so a logged segment and a remembered rule name the same command.
- Writing is best-effort: `logBashDecision()` swallows every failure, because a logging problem must never change whether a command runs. One `appendFileSync` line per decision, file mode `0600`.
- Location `.state/bash-log.jsonl` by default (`BASH_DECISION_LOG_PATH`, extension-local gitignored runtime state, so an isolated worker worktree records into its own copy). Precedence is environment over config: `SANDBOX_DECISION_LOG` (`0`/`false`/`no`/`off`) and `SANDBOX_DECISION_LOG_PATH` beat `decisionLog.enabled` / `.path`; blank env values count as unset. Past `decisionLog.maxBytes` (default 8 MiB) the file rotates to a single `.1` generation, so history is bounded.

## Mining

`npm run permission-report -- --since 7d [--prompted] [--surface parent|child] [--group-depth n] [--all-gaps] [--json]`. Records group by command *shape* (paths, filenames, numbers, hashes, `key=value` collapse to placeholders). A prompted row keys on **every** uncovered segment of the record joined by `" + "` (capped at three, `(+N)` for the rest), never just the first: mining showed ~2.4 uncovered segments per prompt, so keying on the first hid most of the real demand (a formatter after a heredoc vanished behind it). `--all-gaps` explodes to one row per uncovered segment, which is the ranking to trust when choosing a rule — counts then exceed record counts. Shell control-flow words are normalized away (`do`/`then`/`else`/`time` prefix stripped, segments of only `done`/`fi`/`esac`/`}` dropped) because `for`/`done` rows name no command. Sections separate APPROVED AFTER PROMPT (candidates), REFUSED AT PROMPT (anti-patterns, with user notes), AUTO-ALLOWED BY HEURISTIC (current silent coverage), UNCOVERED WITHOUT A PROMPT (a command-runner child that needed a rule but could not ask), and RULE HITS. Approval frequency is evidence, not proof — curation still picks the narrowest correct mechanism (`CommandSpec`, a `suggestions.ts` row, or an explicit config rule) and adds tests seeded from the logged shape, including the arguments that were not approved. Re-running the report is the regression check that a shape moved from prompted to auto-allowed.

## Tests

`test/modules/sandbox/decision-log.test.ts` for the writer, `test/tools/bash-decision-log.test.ts` for the parent hook, the child-gate cases in `test/tools/agent-scout-bash.test.ts`, and `test/scripts/permission-report.test.ts`, which feeds the script records produced by the real writer so the fixture cannot drift from the schema. See the `testing` memory for the suite-wide opt-out.
