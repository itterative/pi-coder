---
name: state-policy
description: "Decision-model request state (command, cwd, runner_rules, request context, workspace status, script capabilities) and the apply/confidence policy."
category: architecture
keep_updated: true
---

# Decision-model state and policy

Index: [../decision-model.md](../decision-model.md). Load this before changing `state.ts`, `contract.ts`, `session-context.ts`, `workspace.ts`, `policy.ts`, or any
field added to the classifier request. Each absent field listed at the end of the state section was measured
and rejected; [findings.md](findings.md) has the numbers.

## Request contract (`contract.ts`)

- The outgoing shapes are typed there — `CommandState`, `CommandHistoryState`, `FileAccessState`,
  `ScriptState`, `SuggestionState`, `ReminderPhaseState`, `ReminderChoiceState` — and the builders return
  them, so a state key is declared where the type is. `types.ts` holds the *incoming* domain types (what the
  caller gathered); do not put wire keys there.
- The question ids (`VETO_QUESTION`, `SCRIPT_QUESTION`, `FILE_*_QUESTION`, `SUGGESTION_QUESTION_ID`,
  `REMINDER_PHASE_QUESTION`) live here too, because an id is the wire name of a `questions` key; only the
  wording stays in the subject module. `DECISION_REQUEST_SUBJECTS` is the list of the six requests. Keep the
  dependency one-way: this file imports only *types* (today: `ReminderPhase` from `reminder.ts`, the domain
  types from `types.ts`) and the subject modules import its values. A value import from a subject module would
  close the initialisation cycle that moving the ids here was meant to avoid.
- The drift check is `test/modules/decision/contract.test.ts`: it builds the smallest request of every subject
  and pins it in `__snapshots__/decision-request.<subject>.json`, state and questions together with the exact
  wording the model reads. A changed key, a dropped question, or reworded criteria is a snapshot diff. Extend
  `BUILT_REQUESTS` when adding a subject; richer cases (a full transcript, a dirty tree, both script forms)
  stay pinned in `decision-strategy.*.json` and `decision-evaluator.*.json` beside the tests that build them.
- This replaced a `DECISION_CONTRACTS` declaration table that restated each subject's fields as data, kept
  honest by a type lattice (`RequiredStateFields`/`Record<OptionalStateFields<…>>`) plus a second test half. It
  declared what the snapshots already show, with no runtime consumer, so it was deleted; do not reintroduce a
  field-level index beside the types. A field typed optional in the wire shape is still sent only in a
  condition — say which in the type's comment, where the request snapshots keep it visible.

## State (`state.ts`, `session-context.ts`, `workspace.ts`)

- Every shape carries `command`, `cwd`, and `runner_rules` — hardcoded generic facts per runner, **not** project
  rules. Phrase positively where the runner has no prohibition (parent, worker); state the prohibition only
  where it is about *authority* (the read-only children). The rungs mirror the delegated-agent ladder in
  `RUNNER_AUTHORITY` (parent/worker `mutate`, reviewer/agent `command`, scout/advisor `inspect`) and must stay
  in step.
- `request_context` (the default) adds one `conversation` text: the planned window rendered as `User:` /
  `Assistant:` / `Tool:` lines, oldest first, with the current request appended (clipped) as its **last** `User:`
  line. The window is up to 4 items immediately before the command — the current turn's own prose and commands
  first, earlier turns when the turn is shorter — and its item for the request is dropped rather than ending it;
  ending there discarded the whole current turn, and that bug is what made two logged commands abstain at
  0.48/0.51 (the fix took them to 0.64/0.64). Tool output is excluded, except as the `[blocked: …]` marker. A
  non-bash call renders as `name(arg)`; `outline` keeps its action, path, query or symbols, and offset, because
  a bare action alone is not the structural read the state needs. The facts are the ones the measured arm sent
  as separate `request` + `recent_messages` fields; the render is newer and **not re-measured** — the earlier
  flatten finding used a state that folded the request into the transcript, where this one keeps it last and
  keeps the plan's item selection (`state.ts` `commandConversation`).
- **A blocked command says so.** The walk pre-collects, per bash `toolCallId`, the reason of a result that is
  an error carrying no pi execution status (a call the gate stopped: `blockedBashReasons`), and the command
  item carries it as `blocked`. Every renderer appends `[blocked: <reason>]` after the command's own clip, so
  truncation cannot cut off the marker; the reason is the person's `User message:` note when the gate recorded
  one, else the gate's sentence, clipped to `BLOCK_REASON_CHARS` (160). A command that ran and exited nonzero
  is never marked — pi's four status lines (`Command exited with code` / `aborted` / `timed out after` /
  `terminated without an exit code`) are what tell a failed run from a refusal. `windowTranscript` (tier-1
  reminders) and the tier-2 allocator render the same marker.
- `decisionSessionContext` builds four things from one walk: `request`, `recent` (the planned window, in the
  `{role, text}` shape above, plus `blocked` where a call never ran), `omitted` (how many items the plan
  dropped), and `items` — every item of the walk with a `turn` stamp, request included. The turn stamps let a
  caller select turns the way the probe did; the state transcript (`decision/transcript.ts`) and the tier-2
  reminder conversation (`decision/window.ts`) are the two readers of `items`. A user message starts a new turn
  unless it joined the running one (a steer: the previous message is a tool result or an assistant message that
  called a tool), and a compaction or fold starts a fresh turn. The request is not added to `items` twice — it is
  already there at its own turn — and the command/file-access contexts take `request`/`recent` explicitly rather
  than spreading the whole context, so the transcript atoms never reach a permission verdict.
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
