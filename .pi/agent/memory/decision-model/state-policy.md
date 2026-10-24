---
name: state-policy
description: "Decision-model request state (command, cwd, runner_rules, request context, workspace status, script capabilities) and the apply/confidence policy."
category: architecture
keep_updated: true
---

# Decision-model state and policy

Index: [../decision-model.md](../decision-model.md). Load this before changing `state.ts`, `session-context.ts`, `workspace.ts`, `policy.ts`, or any
field added to the classifier request. Each absent field listed at the end of the state section was measured
and rejected; [findings.md](findings.md) has the numbers.

## State (`state.ts`, `session-context.ts`, `workspace.ts`)

- Every shape carries `command`, `cwd`, and `runner_rules` — hardcoded generic facts per runner, **not** project
  rules. Phrase positively where the runner has no prohibition (parent, worker); state the prohibition only
  where it is about *authority* (the read-only children). The rungs mirror the delegated-agent ladder in
  `RUNNER_AUTHORITY` (parent/worker `mutate`, reviewer/agent `command`, scout/advisor `inspect`) and must stay
  in step.
- `request_context` (the default) adds `request` (current user message, clipped) and `recent_messages`: up to 4
  items immediately before the command, oldest first — the current turn's own prose and commands first, earlier
  turns when the turn is shorter. The request is its own field, so its item is dropped from the window rather
  than ending it; ending there discarded the whole current turn, and that bug is what made two logged commands
  abstain at 0.48/0.51 (the fix took them to 0.64/0.64). Tool output is excluded.
- `decisionSessionContext` builds three things from one walk: `request`, `recent` (the planned window, in the
  `{role, text}` shape above), and `items` — every item of the walk with a `turn` stamp, request included. The
  turn stamps exist for the state ask's transcript (`decision/transcript.ts`), which selects turns the way the
  probe did; only the transcript reads them, and `recent` stays `{role, text}` so the pool's request and the
  debug window are unchanged. A user message starts a new turn unless it joined the running one (a steer: the
  previous message is a tool result or an assistant message that called a tool), and a compaction or fold
  starts a fresh turn. The request is not added to `items` twice — it is already there at its own turn — and the
  command/file-access contexts take `request`/`recent` explicitly rather than spreading the whole context, so
  the transcript atoms never reach a permission verdict.
- `workspace_status` rides in every shape when the tree is dirty: the clipped
  `git status --porcelain=v1 --untracked-files=normal` list (1 s timeout, ≤10 entries, absent when clean or git
  fails). It supplies "these are the runner's own uncommitted edits" and is part of the answer-cache key.
- `script_capabilities` carries one `{source, capability}` summary per resolved body when the command runs a
  script; the command request never carries bodies.
- Deliberately absent, each measured: project instructions/AGENTS.md (workflow prohibitions are read as
  permission verdicts and auto-deny safe commands), a "what the state means" preamble (every semantics wording
  only loosened decisions), `resolution` (0/208), command history and annotated history, and the
  confinement-probe effects reading. See `sandbox/probe.md` (index: `sandbox.md`) and the settled list in [findings.md](findings.md).

## Policy (`policy.ts`)

- `apply` is the single switch that lets a verdict resolve a prompt. Off = consult + record only, policy
  still runs and the log says what would have happened.
- `refuse` never applies by itself ("refuse requires confirmation") — the measured false positive is a
  formatter whose `--write` reads as `loses_content`, and a wrong refusal blocks work a prompt would surface.
- `sandbox` applies at any confidence when a sandbox exists (it withholds authority).
- `host` needs `minConfidence`, default **0.8**; it is the one direction that grants authority.
- `APPLIED_PERMISSIONS`: `host → allow`, `sandbox → allow:sandbox`, `refuse → deny`.
