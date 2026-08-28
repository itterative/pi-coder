# Agent TODO lists

## Status

Parser, prompt, capability wiring, write/edit validation hooks, Bash change
guarding, parent UI, and live worker progress are implemented. Documentation
and hardening remain for later phases. This document records the implementation
shape for a `todolist` capability built on the existing temporary scratchpad.
It is not a user-facing command reference.

## Purpose

Give the parent agent and opted-in delegated agents a small, structured task
list stored in the runtime's private scratchpad while leaving the rest of the
file as ordinary agent-authored Markdown notes.

The TODO document has two deliberately different regions:

- YAML frontmatter is machine-readable state and is validated by pi-coder.
- Markdown after the closing frontmatter delimiter is freeform content. It may
  contain headings, prose, code blocks, links, checklists, or other notes and
  is not interpreted by the TODO state machine.

The TODO list is not a replacement for persistent memories, the delegated-agent
SQLite state, a Git workspace, or a user-managed project TODO file.

## Scope and lifetime

The parent runtime always has the existing temporary scratchpad. The parent
TODO module uses the file:

```text
<parent scratchpad>/TODO.md
```

A delegated agent receives TODO support only when its definition has the
`todolist` capability. `todolist` implies `scratchpad`, so custom definitions
do not need to declare both capabilities. The built-in `worker` receives
`todolist`; read-only built-ins do not receive it by default.

Each runtime has its own TODO file. The TODO extension creates a valid empty
`TODO.md` during initialization before the first refresh, so the managed path
always exists while that runtime is active:

- the parent and every child have separate files;
- workers do not automatically see the parent's TODO file;
- deleting an existing TODO.md is normalized to a valid empty list rather than leaving the managed path absent;
- isolated workers keep their TODO outside the Git worktree;
- no TODO contents are shared through `agent` arguments or run leases.

The TODO file follows the scratchpad's ephemeral lifetime. It is not persisted
in the agent SQLite snapshots and is not expected to survive process restart,
child resume, session replacement, or scratchpad recreation. A retained
in-memory worker result may expose its last TODO state until that result is
collected, but restored runs start without a live TODO state until the child
recreates the file.

## Document format

The initial schema is intentionally small and strict:

```md
---
version: 1
todos:
  - id: inspect
    title: Inspect the existing implementation
    status: pending
  - id: implement
    title: Implement the feature
    status: in_progress
---

# Notes

The agent may write any Markdown here, including implementation notes and
useful evidence.
```

### Frontmatter fields

The validator accepts only the following top-level fields:

- `version`: required integer `1`;
- `todos`: required YAML sequence, possibly empty.

Each TODO entry requires:

- `id`: unique, non-empty identifier with a bounded, filename-safe shape;
- `title`: non-empty bounded display text;
- `status`: one of `pending`, `in_progress`, `completed`, or `blocked`.

Recommended implementation limits are 50 entries, 64 characters per ID, 500
characters per title, 128 frontmatter lines, and a bounded complete document
size. These limits protect parsing, prompt/UI rendering, and tool-result
memory from unbounded model output.

IDs provide stable edit targets when titles change or duplicate titles exist.
The widget displays titles and statuses, not IDs.

The parser must recognize the closing delimiter only when it is a delimiter
line, so a Markdown horizontal rule or `---` inside a fenced code block in the
body does not accidentally redefine the frontmatter boundary.

Unknown fields, duplicate IDs, missing required fields, invalid statuses,
malformed YAML, and frontmatter limits are validation errors. The body is not
subject to Markdown validation.

## Agent instructions

The TODO extension adds a stable system-prompt block similar to the memory and
scratchpad blocks. It includes:

- the absolute TODO path;
- the frontmatter schema and allowed statuses;
- an instruction to read TODO.md before beginning substantive work;
- an instruction to update status as work starts, completes, or becomes blocked;
- an instruction to use `write` or `edit` for TODO changes;
- an instruction to preserve the freeform Markdown body;
- a reminder that the file is temporary and runtime-local.

The parent receives the block from the top-level TODO extension. A capable
child receives the same block from an explicit child extension factory, just
as the child receives the scratchpad extension. The child protocol also
advertises the TODO capability in the normal agent catalog/definition flow.

The prompt must not tell the agent that Bash TODO writes are transactionally
safe. It should explicitly prefer `write` and `edit` for TODO.md.

## Parser and validation ownership

Add a dedicated TODO parser/model under `src/modules/todolist/`. Do not broaden
the memory frontmatter parser for this feature: that parser intentionally
supports only flat scalar memory metadata, while TODOs require a bounded
sequence of mappings.

The parser should expose a pure validation/read path so it can be used by:

- the write/edit pre-execution hook;
- the Bash post-execution check;
- parent and worker widget refreshes;
- focused unit tests.

The parser should return a bounded model similar to:

```ts
interface TodoItem {
    id: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "blocked";
}

interface TodoList {
    path: string;
    items: TodoItem[];
}
```

Parsing failures should include a concise, model-facing reason and should not
expose arbitrary unbounded file content in diagnostics.

## Write/edit validation hook

The parent and capable child runtimes register the same TODO validation hook.
It applies only to the exact runtime-managed path
`<scratchpad>/TODO.md`; unrelated files named TODO.md are not affected.
Canonical/symlink checks must ensure the target remains the runtime's own
scratchpad file.

For `write`:

1. read the proposed `content` from the tool input;
2. validate the complete proposed document;
3. return `{ block: true, reason }` for invalid content;
4. otherwise allow the normal file-permission and write pipeline to continue.

For `edit`:

1. read the current TODO document, if present;
2. reconstruct the prospective document from all requested replacements;
3. use the same matching/normalization assumptions as the built-in edit tool;
4. validate the complete prospective document;
5. block before execution if it is invalid.

An edit that changes only the freeform body must pass as long as the existing
frontmatter remains valid. Creating a new TODO file requires valid frontmatter;
`# TODO` alone is not a valid document once TODO support is active.

The hook should not rewrite valid agent formatting or normalize the freeform
body. Validation is a gate, not a formatter.

## Bash before/after guard

Bash cannot reliably be analyzed for every possible shell write expression.
The TODO module therefore adds a defensive before/after guard in addition to
the strict write/edit hook.

### Before Bash

For each Bash tool call in a TODO-capable runtime:

- capture whether TODO.md exists;
- capture its contents, bounded size, and a content hash;
- store the snapshot by `toolCallId`;
- bound and clean up outstanding snapshots so an interrupted tool cannot grow
  memory indefinitely.

The guard does not block unrelated Bash commands and does not claim to model
shell semantics.

### After Bash

When the corresponding tool result arrives:

1. read the current TODO file and compare its hash with the before snapshot;
2. do nothing when it is unchanged;
3. parse and accept it when it is valid;
4. if Bash deleted a previously valid TODO.md, safely recreate the canonical
   valid empty document (`todos: []`) when the path is still absent;
5. if it changed to invalid content, attempt a safe rollback to the previous
   snapshot;
6. report the validation outcome to the agent and refresh the UI.

If Bash deletes a previously valid file, the guard writes the canonical empty
TODO document rather than leaving the managed path absent. If the file existed
before and Bash writes invalid content, rollback restores its previous contents.
If it did not exist before and Bash created an invalid TODO.md, rollback removes
that new invalid file. Restoration and empty-file recreation must use a
compare-and-swap check, an atomic replacement or exclusive create where
practical, and preserve the prior file mode.

Rollback is allowed only when the current file still matches the invalid
post-command state and there is no known competing TODO mutation. This is a
compare-and-swap-style safety check, not a general filesystem transaction.

If rollback is unsafe, fails, or concurrent TODO operations are detected, do
not overwrite the file. Leave it in place and return a warning instructing the
agent to repair it with `write` or `edit`.

The warning should be visible in the tool result, including in child print
mode. It should explain that other Bash side effects may already have
completed. Do not mark the entire Bash call as an error merely because its TODO
side effect was rejected; doing so could cause the agent to repeat unrelated
side effects.

Example warning:

```text
TODO.md was changed by Bash but its frontmatter became invalid. The previous
valid TODO.md was restored. Other Bash side effects may still have completed.
Use write or edit to update TODO.md.
```

The post-execution hook is also a defensive check for write/edit calls, but
those calls should normally be rejected before execution.

## Concurrency and failure behavior

Pi can preflight sibling tool calls before executing them and can complete
parallel tool results in an order different from source order. The design must
not hold a validation lock across `tool_call` and `tool_result`, because doing
so could deadlock parallel preflight.

Instead:

- write/edit validation is performed before execution;
- Bash snapshots are independent and keyed by tool call;
- multiple outstanding TODO-affecting operations make automatic rollback
  conservative;
- a warning is safer than restoring an older snapshot over a valid concurrent
  update;
- worker mutation execution is already sequential, so its rollback path is
  less ambiguous but must still use the same safety checks.

Cleanup must happen for successful, blocked, failed, canceled, and aborted
calls whenever a matching result or lifecycle cleanup is available.

## Parent TODO widget

Add a separate parent widget, likely under `src/tui/`, with a distinct key such
as `pi-coder-todolist`. It must coexist with the existing agent activity widget
rather than replacing it.

The widget:

- reads the parent runtime's parsed TODO model;
- appears only when a valid TODO file has at least one entry;
- shows a compact heading/progress count and status-marked titles;
- retains completed and blocked entries so the list reflects the document;
- caps rendered items and line width to fit the TUI's widget limits;
- preserves the last valid display while an invalid update is being reported;
- clears on parent session shutdown/tree replacement and when the file is
  removed or becomes empty.

Refresh after parent `write`, `edit`, and `bash` results, session start, and
other relevant lifecycle events. A filesystem watcher is explicitly deferred;
external edits become visible on the next pi event that requests a refresh.

The widget should use shared TODO formatting helpers rather than embedding a
second parser or status interpretation.

## Worker activity widget

Do not add a second worker widget. Extend the existing agent activity path:

```text
child TODO state
  → volatile child progress/update
  → AgentRunDetails / AgentRunSummary
  → AgentActivityWidget
```

The worker activity row should show a bounded summary such as:

```text
TODO 2/5 · Implement the feature
```

The summary may include the current in-progress item or the first remaining
item, but should not expand every TODO entry for every worker. This keeps the
existing above-editor widget within its height budget when several runs are
active.

TODO state used only for live UI must remain volatile. If it is carried through
`ChildProgress`, persistence must explicitly strip it before writing a durable
run snapshot, and restoration must not recreate it from stale persisted data.

## Capability and runtime integration

Update the delegated-agent capability plumbing:

- add `todolist` to `AGENT_CAPABILITIES`;
- make effective `todolist` capability include `scratchpad`;
- update custom-definition parsing, validation, and fingerprints;
- add `todolist` to the built-in worker;
- advertise the capability and its behavior in the parent agent catalog;
- register the TODO child extension only for capable definitions;
- ensure the child has a scratchpad before the TODO extension initializes;
- preserve the existing distinction between read-only, command-capable, and
  edit-capable agents.

The capability grants TODO state and validation only. It must not grant edit,
write, or Bash authority by itself. A read-only custom agent may receive a
TODO document but cannot mutate it unless another capability already grants
that authority.

## Implementation phases

### Phase 1: parser and prompt

- Add the TODO model/parser and strict schema validator.
- Add the parent/child prompt appendix and formatting helpers.
- Add focused parser and prompt tests.

### Phase 2: capability and runtime hooks

- Add the capability and worker definition wiring.
- Register the child TODO extension through `createAgentChild`.
- Add write/edit prospective-document validation.
- Add focused parent and child hook tests.

### Phase 3: Bash defensive guard

- Add before/after snapshots keyed by tool call.
- Add valid-change, invalid-rollback, missing-file, failed-rollback, and
  concurrent-operation behavior.
- Ensure warnings reach both parent and child agents.

### Phase 4: UI and live progress

- Add the parent TODO widget and lifecycle refresh behavior.
- Thread volatile worker TODO state through child progress and run summaries.
- Extend the existing activity widget with a compact TODO summary.
- Add file snapshots for parent and worker rendering changes.

### Phase 5: documentation and hardening

- Document the ephemeral lifetime and Bash limitations.
- Review path/symlink handling and bounded parsing.
- Update project memories after implementation.
- Run the full test suite and type checking.

## Tests

Add focused coverage for:

- valid frontmatter with freeform Markdown body;
- every supported status and empty TODO lists;
- duplicate IDs, invalid statuses, missing fields, unknown fields, malformed
  YAML, oversized input, and delimiter edge cases;
- valid write/edit calls and invalid calls blocked before execution;
- edits that preserve the frontmatter while changing arbitrary body Markdown;
- Bash changes that are valid and invalid;
- invalid Bash changes restored when the snapshot is still safe to replace;
- invalid Bash changes warned about without rollback when concurrency or a
  compare-and-swap check makes restoration unsafe;
- invalid TODO creation and TODO deletion through Bash;
- cleanup after successful, failed, blocked, and aborted calls;
- parent and child TODO runtime isolation;
- custom capability parsing, implication, fingerprints, built-in worker
  capability, and child registration;
- parent widget visibility, status styling, truncation, clearing, and refresh;
- worker activity-widget TODO summaries;
- volatile TODO state not being restored from durable run snapshots;
- print/non-TUI mode receiving validation warnings without requiring UI.

Run:

```bash
npm run test:run
npx tsc --noEmit
```

## Non-goals and future refinements

- persistent TODO state across restart or child resume;
- explicit parent/child TODO sharing;
- a new TODO-specific LLM tool;
- automatic task extraction from user prompts or assistant prose;
- validation or formatting of the freeform Markdown body;
- complete shell parsing or transactional rollback of arbitrary Bash;
- a filesystem watcher for external TODO.md edits;
- changing the existing scratchpad lifetime or storage policy;
- allowing the TODO capability to grant mutation or command authority.
