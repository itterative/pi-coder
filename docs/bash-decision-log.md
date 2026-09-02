# Bash permission decision log

Every bash permission decision is appended to a development log so approval
patterns can be mined offline and turned into heuristics or curated rules. The
writer is `src/modules/sandbox/decision-log.ts`; the reader is
`scripts/permission-report.mjs`.

## What is recorded

One JSON object per line, written by both bash gates — the parent hook
(`src/tools/bash/index.ts`) and the delegated command gate
(`src/tools/agent/child/command-permissions.ts`):

| Field                  | Meaning                                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`, `ts`              | record version (`1`) and ISO timestamp of the decision                                                                                                                                                                                                      |
| `surface`, `agent`     | which gate decided (`parent` or `child`), plus the delegated agent name                                                                                                                                                                                     |
| `cwd`, `command`       | working directory and the command exactly as requested, before any sandbox wrapping                                                                                                                                                                         |
| `resolution`           | the resolver's own answer before any human: `permission`, `source`, `pattern`, `segments[]`                                                                                                                                                                 |
| `resolution.segments`  | one entry per chain command: unwrapped `tokens`, `source` (`policy`, `heuristic`, `unresolved`), `permission` when resolved, the matched `pattern`, and `coveredBy` for a rule match (`segment`, or `whole-line` when one chained pattern covered the line) |
| `prompt`               | only when a human was asked: `outcome` (`yes`, `remember`, `no`, `dismissed`), the `suggestion` offered by `src/modules/sandbox/suggestions.ts`, and the `rule` actually remembered                                                                         |
| `decision`             | permission finally applied (differs from `resolution.permission` after a prompt)                                                                                                                                                                            |
| `sandboxed`, `blocked` | whether it ran under bwrap, and whether it ran at all — a denial and an approval that could not be executed both set `blocked`                                                                                                                              |
| `note`                 | the note the user attached while approving or denying                                                                                                                                                                                                       |

Writing is best-effort: `logBashDecision()` swallows every failure so a logging
problem can never change whether a command runs. Records are structured data
produced by the resolver itself — nothing is inferred from shell text afterwards.

Not recorded: the read-only child confinement gate
(`src/tools/agent/child/gates/confinement.ts`), which classifies commands without
consulting the resolver and never prompts.

## Location and configuration

Default: `.state/bash-log.jsonl` next to the installed extension
(`PI_CODER_STATE_DIR`), mode `0600`, enabled by default. It is gitignored runtime
state like the agent session database, so it lives with the checkout that recorded
it — an isolated worker worktree under `.state/workspaces/` gets its own file.

| Control                            | Effect                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `SANDBOX_DECISION_LOG=0`           | disable (`0`, `false`, `no`, `off`) — wins over config                 |
| `SANDBOX_DECISION_LOG_PATH=<file>` | relocate — wins over config                                            |
| `decisionLog.enabled`              | config enable/disable                                                  |
| `decisionLog.path`                 | config location                                                        |
| `decisionLog.maxBytes`             | rotation threshold, default 8 MiB; past it the log moves to `<path>.1` |

The single `.1` generation is the only history kept, so disk use is bounded at
roughly twice `maxBytes`. Delete the file to start clean; nothing else reads it.

## Reading it

```sh
npm run permission-report -- --since 7d
npm run permission-report -- --prompted --group-depth 4 --limit 40
npm run permission-report -- --json            # for an agent or jq
```

The report groups by command _shape_ — file names, paths, numbers, hashes and
`key=value` arguments collapse to placeholders — so repeated approvals of the same
kind land on one row. Sections:

- **APPROVED AFTER PROMPT** — humans kept saying yes to these; the top heuristic or
  rule candidates. The `remembered rule` and `offered rule` lines show what was
  already judged safe enough to save.
- **REFUSED AT PROMPT** — anti-patterns, with any user note explaining the refusal.
- **AUTO-ALLOWED BY HEURISTIC** — what cwd confinement grants silently today.
- **UNCOVERED WITHOUT A PROMPT** — a command-runner child that needed something and
  could not ask (headless run), i.e. a missing rule blocking real work.
- **RULE HITS** — which configured patterns actually fire, and the permission granted.

## Using it to widen coverage

1. Run the report over a real interval (`--since 30d`) and pick a shape that repeats
   in **APPROVED AFTER PROMPT**.
2. Confirm the refusal sections show nothing contradictory for that shape.
3. Decide the narrowest correct mechanism:
    - a `CommandSpec` in `src/modules/sandbox/commands/` when the command is
      generally safe under cwd confinement (see the `heuristics` memory);
    - a row in `src/modules/sandbox/suggestions.ts` when it is safe enough to _offer_
      as a session rule but not to grant silently;
    - an explicit config rule, when it is project- or machine-specific.
4. Add tests beside the existing ones (`test/modules/sandbox/heuristics.test.ts`,
   `test/modules/sandbox/suggestions.test.ts`) seeded from the logged command shape,
   including the arguments that were _not_ approved.
5. Re-run the report later to confirm the shape moved from **APPROVED AFTER PROMPT**
   to **AUTO-ALLOWED BY HEURISTIC** — the log is the regression check for curation.

Approval frequency is evidence, not proof: a shape that was approved once under a
note like "just this once" is not a candidate.
