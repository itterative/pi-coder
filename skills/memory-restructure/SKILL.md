---
name: memory-restructure
description: Split or reorganize a bloated pi-memory tree into thin indexes plus nested detail docs. Use when top-level memories are large, flat, duplicated, or hard to load selectively.
---

# Memory Restructure

Move `.pi/agent/memory/` (project) or `~/.pi/agent/memory/` (user) from a pile of large flat files to a
two-tier tree: one small index per subsystem, with single-topic detail docs behind it. This is a
**move / segment / relabel job, not a rewrite** — the deliverable is reachability, and any lost invariant is a
regression.

## Know the mechanism before choosing a layout

- Only `.md` files directly in the memory directory are indexed and rendered into every system prompt as
  `- **name** — description`, grouped by `category` and sorted by `priority`.
- Subdirectory files are never listed. They exist for an agent only if an indexed memory names them.
- `name` must equal the filename stem; `category` must be lowercase (an unknown or capitalized value renders
  its own section, which duplicates the intended one); `description` containing `: ` must be quoted, or the file
  fails to parse and silently vanishes from the index.
- Budget an index at **~8 KB advisory** and its description at ~150 characters. Neither is a hard rule: an index
  that legitimately carries more load-bearing invariants is a reasonable choice, and the audit reports both as
  warnings (indicators), not failures. Nested docs have no prompt cost, so they may be longer and may keep long
  descriptions.
- The audit separates **errors** (a memory that does not index, a `name` that does not match its stem, an index
  naming a path that does not exist, a link that resolves nowhere) from **warnings** (size, description length,
  category spelling, a nested doc no index names, a pointer to a memory name that no longer exists). Fix the
  errors; weigh the warnings and record why you left one.

## Procedure

1. **Measure, then decide clusters.**
   `wc -c .pi/agent/memory/*.md | sort -n` and `grep -n '^## ' <file>` per large file. Group files by subsystem,
   not by size, and give every cluster a directory name plus a fixed index filename.
2. **Publish the target layout before delegating.** Every worker needs the whole tree's final layout, not just
   its own slice, because cross-cluster pointers must name final paths.
3. **Split one cluster per agent, with disjoint ownership.** Concurrent isolated worktree runs are the fast
   path; keep same-checkout mutation single-flight. See the brief contract below.
4. **Land one cluster per commit** — inspect the diff, verify fidelity, commit, then the next. Keep the working
   tree clean between landings.
5. **Do the parent pass last**: cross-cluster references, link depth, `category`/`priority`/description
   normalization, and stale names in `AGENTS.md`, `docs/`, and source comments that pointed at renamed memories.
6. **Close with the audit**: run `/memory-audit` (or the `memory_audit` tool) and report before/after indexed
   counts, prompt-visible bytes, and description characters. Repeat the check after any follow-up edit. Fix every
   error; treat each warning as an indicator and decide rather than obey it.

## Brief contract for a split agent

Write the brief so a child that cannot see your conversation can verify its own footing. Required, and each
item is a check the child must run and quote:

- **Objective and mechanism.** What the memory system does and why nested docs are unreachable unless listed.
- **Exact base.** The commit the work must sit on, plus: if `git rev-parse HEAD` differs and the tree is clean,
  `git checkout -f --detach <hash>` and `git clean -fd <memory paths>`; if the tree is dirty or the identity
  check fails, **stop and report** rather than working from an unverifiable tree. Re-pointing HEAD is safe
  because abandoned heads are pinned by durable checkpoint refs.
- **Input identity as byte sizes**, not counts. Give the size of every input file (`heuristics.md` 20868, …) so
  the child can prove it is on the right tree. Do not put numbers you have not measured yourself in a brief — a
  wrong count ("19 files" vs "23") costs a round trip and erodes trust in every other assertion.
- **Ownership list.** The paths it may create, move, and delete; the paths it must not touch (other clusters,
  `src/`, `docs/`, `AGENTS.md`, `.state/`); and "do not create stub files for other clusters".
- **Hard rules.** No information loss (every claim, path, symbol, env var, number, date, and `must`/`never`
  appears exactly once; merge only literal duplicates; keep the _reasoning_ attached to a rule); the advisory
  index budget (~8 KB) and description limit (~150 chars) stated as budgets a reviewer may argue with, not gates
  that fail a build; `name` == stem; one-line descriptions; lowercase `category`; heading structure so a single
  rule is locatable; link depth (`../../../docs/x.md` → `../../../../docs/x.md` when a doc moves deeper); `git
mv`/`git rm` for moves; no Prettier until edits are finished.
- **Fidelity gate, defined precisely.** Extract every exact backticked span and every number token from each
  input and assert presence in the output set. Do not judge rewording with a similarity ratio against a large
  corpus — it reads ~0 for everything. Use whitespace-normalized sentence containment instead, and hand-inspect
  the sentences that fail it.
- **Handoff fields.** The child must commit on top of the verified base and report: `git rev-parse HEAD`,
  `git log -1 --format='%h %p'` (proving the single parent), `git diff --stat <base>..HEAD` (proving path
  scope), `git status --porcelain` clean, the section→destination coverage table, input/output `wc -w`, and
  anything stale or contradictory it noticed — reported, not "fixed".

## Landing isolated results

- Compare the collect report's **Base revision** with the base the child reported. If they disagree, the
  prepared patch may span unrelated commits — a child that repaired its own worktree can leave the recorded
  base stale.
- Before applying, verify the child commit independently: `git log -1 --format=%p <workerHead>` names the base
  it was built on, and `git diff --name-status -M <base>..<workerHead>` is limited to the expected paths.
- If the recorded base is wrong, land with `git cherry-pick -n <workerHead>` after that verification and
  `discard` the prepared result to free the workspace. Applying a mis-based patch drags history into the
  checkout; `git patch-id` on the child commit and the landed commit should match when the content is identical.
- Apply requires a clean working tree, so land clusters one at a time with a commit between them.

## Report format for the user

A before/after table (indexed memories, prompt-visible bytes, description characters, nested doc count), the
fidelity numbers per cluster, the gates re-run at the end, and a list of judgment calls left for the content
owner. State plainly when byte totals go up: the win is load-per-question, not repository size.
