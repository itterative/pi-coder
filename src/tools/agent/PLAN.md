# Agent Support for pi-coder

Status: active design investigation; implementation has not started.

This document records the current findings and a plan that can be refined across sessions.

## Goal

Add agent/subagent support to pi-coder so the main agent can delegate focused work to specialized agents while preserving pi-coder's safety model and providing useful progress in the parent TUI.

The initial direction recorded in `src/tools/agent/README.md` is:

- subagents should run in the same process;
- interaction should be richer than a one-shot model call.

## Current Repository State

- `src/index.ts` is the consolidated pi-coder extension entrypoint.
- `src/tools/agent/index.ts` is currently empty and is not registered from `src/index.ts`.
- Existing extension functionality includes:
  - memory injection and persistence;
  - the ask-user tool;
  - bash permission/sandbox hooks;
  - read/write file permission hooks;
  - custom TUI components for prompts and selection.
- Tests are under `test/`, with module tests under `test/modules/`.
- The project uses pi-coding-agent `0.84.x` APIs.

## Findings

### Pi APIs relevant to agents

#### Direct model completion

`ExtensionContext.modelRegistry.complete(model, context, options)` performs a model call in the current process.

Advantages:

- simple;
- uses the current model registry and provider configuration;
- naturally supports one-shot planning, extraction, or summarization;
- easy to attach an abort signal.

Limitations:

- no normal agent loop;
- no built-in tool execution loop;
- no independent context/session state;
- richer interaction must be implemented manually.

This is appropriate for helper calls, not a general-purpose subagent.

#### SDK `AgentSession`

`createAgentSession()` creates a complete agent session with:

- a model;
- built-in and custom tools;
- an independent message context;
- streaming events via `session.subscribe()`;
- `prompt()`, `steer()`, and `followUp()`;
- abort and disposal;
- compaction and retry behavior;
- optional persistent or in-memory session storage.

`SessionManager.inMemory(cwd)` is the likely default for delegated agents. Their output can be returned as the parent tool result, while their internal conversation remains out of the parent context.

One detail to account for: SDK-created sessions load extensions through a `ResourceLoader`, but extension bindings and UI mode must be deliberately configured. We should not assume that creating a session automatically gives it the same interactive runtime as the parent.

#### Official subprocess example

Pi includes an official subagent extension at:

`/home/sd/.nvm/versions/node/v24.11.1/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent`

It runs each delegated agent as a separate `pi --mode json --no-session` process and implements:

- markdown agent definitions;
- user/project agent scopes;
- single, parallel, and chain modes;
- streaming output;
- usage tracking;
- cancellation;
- custom tool rendering;
- project-agent confirmation;
- workflow prompt templates.

This is a useful behavioral and rendering reference, but its process model differs from the intended in-process direction.

### Agent definitions

The official example uses markdown files with YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read, grep, find, ls
model: some-model
---

Agent-specific system instructions.
```

Likely locations:

- user-level: `~/.pi/agent/agents/*.md`;
- project-level: `.pi/agents/*.md`.

Project-local definitions are repository-controlled instructions and should require trust and/or explicit confirmation before execution.

Pi already exports a full YAML `parseFrontmatter()` helper, which is a better fit for agent definitions than the memory module's intentionally limited flat-frontmatter parser. Agent parsing should still have its own validation and discovery tests.

### Safety and runtime concerns

#### Avoid recursive extension loading

A child session using the default resource loader may rediscover pi-coder and register the agent tool again. This can cause recursive delegation or duplicate hooks.

The child runtime should use a controlled resource loader. The validated approach is a `DefaultResourceLoader` configured with `noExtensions: true` and an explicit minimal `extensionFactories` list. This prevents discovery of pi-coder's parent extension while still allowing purpose-built child hooks/tools such as path confinement and `ask_parent`.

#### Preserve bash and file protections

The current bash and read/write protections are extension-level hooks. If a child session is created without those hooks, delegated agents may bypass the safety behavior that applies to the parent.

This needs an explicit design rather than accidental inheritance.

Potential approaches:

1. Bind a carefully scoped copy of the relevant hooks to the child session.
2. Build child tools with operations that call shared permission/sandbox logic.
3. Start with read-only agents and explicitly exclude mutation tools.
4. Run mutation-capable agents in isolated worktrees or subprocesses.

The first prototype will be read-only. Its confinement hook must cover `read`, `grep`, `find`, and `ls`; guarding only `read` would still allow the search/list tools to inspect paths outside `cwd`.

The selected first implementation is a stateless child-only `tool_call` hook. It treats omitted search/list paths as `cwd` and uses the existing canonical cwd-confinement heuristic for every explicit path. Any unconfined path is blocked without a UI escalation path.

The existing bash and file-permission modules keep some session state in module-level variables. Re-registering those modules in multiple in-process sessions could share or reset parent state, so they will not be loaded into the read-only child. Their state should still become registration-scoped before mutation-capable agents reuse them.

#### Child-to-parent guidance and parent UI

The primary interaction requirement is child-to-parent guidance, not necessarily child-to-user UI. A normal parent tool call is synchronous: while it is waiting for the child, the parent model cannot generate a new answer for that child. Blocking child-to-parent questions would therefore deadlock.

The first protocol will use cooperative pause/resume:

1. The child calls a child-only `ask_parent` tool with a question and context.
2. `ask_parent` records the request and returns `terminate: true`, ending the current child run.
3. The parent `agent` tool returns a `waiting_for_parent` result with a run ID, partial findings, and the question.
4. The parent may investigate or use other tools before responding.
5. A later `agent` invocation resumes the same in-memory child session by run ID with guidance.

The tool result itself puts the request in the parent transcript, so a second injected message is unnecessary. The child prompt should require `ask_parent` to be called alone in a tool batch because SDK early termination occurs only when every result in that batch has `terminate: true`.

A future background-mailbox mode may allow non-blocking child messages while the child continues. Pi's `pi.sendMessage(..., { deliverAs: "steer" })` can insert a custom child message into the parent context after the current parent tool batch. For that to be timely, the initial `agent` call must return a run handle while the child continues in the background; later parent guidance can use `childSession.steer()`. This also introduces delivery ordering, race handling, shutdown, and nested-usage accounting problems, so it is explicitly deferred.

Direct child-to-user interaction remains possible: a minimal child extension can forward the parent `ctx.ui` and register `ask_user`. It is explicitly deferred. Initially the child always asks the parent; the parent can answer, investigate, or invoke its own `ask_user`. This keeps ownership of the conversation clear and avoids nested UI binding.

#### Parallel mutation

Parallel agents that edit the same working tree can overwrite each other. `withFileMutationQueue()` uses a module-global per-file queue, so it does coordinate individual built-in write/edit operations across in-process sessions that share the same module instance. It does not make a multi-step read/modify/write workflow transactional, prevent stale decisions, or coordinate subprocesses.

Parallel execution should initially be:

- read-only;
- restricted to disjoint paths;
- serialized for mutation; or
- isolated through separate git worktrees.

#### Model and authentication handling

The parent extension context exposes `modelRegistry` and the active model, but not the parent `ModelRuntime` directly.

A full child `AgentSession` needs a `ModelRuntime`. Creating one from the normal pi auth/model files works for built-in providers and was validated with the current `openai-codex/gpt-5.6-sol` model.

Dynamic extension providers need explicit synchronization. The parent `modelRegistry` publicly exposes registered provider IDs, configs/native providers, and resolved auth. A child runtime can mirror the active provider registration and copy a resolved runtime API key when necessary. This is preferable to relying on private access to the parent's runtime. The first implementation should validate this path and return an explicit unsupported-provider error rather than silently selecting a different model.

For a single-child MVP, a runtime per active run is simplest and isolates credentials/provider mutation. A shared runtime or pool can be considered when parallel execution is introduced.

#### Cancellation and cleanup

`AgentSession.prompt()` does not accept an external abort signal. The parent tool must check its signal during setup, attach an abort listener that calls `childSession.abort()`, remove that listener during cleanup, and wait for abort settlement before disposal. Runtime creation accepts a signal, but resource loading does not, so setup needs explicit cancellation checkpoints.

Completed and failed child sessions must be disposed promptly. A session in `waiting_for_parent` state is deliberately retained in a bounded run registry until resumed, canceled, expired, or the parent session shuts down.

#### Context and output limits

Delegated output can be large. Child results should:

- be truncated before being returned to the parent model;
- retain bounded partial findings for a waiting guidance request;
- expose bounded structured state through tool `details` for the TUI;
- report nested model usage using the tool result's `usage` field.

`getSessionStats()` is useful for display but loses the per-category cost breakdown required by the `Usage` type. Exact nested usage should be accumulated from assistant and nested tool-result messages, including cache and reasoning fields where present.

Usage attached to each parent `agent` result must be the delta since the previous start/resume result, not the run's cumulative usage; otherwise resuming a waiting child would double-count earlier calls in the parent session. Cumulative usage can remain in bounded TUI details.

## Validated SDK Spike

A no-provider-call smoke test successfully constructed and disposed an in-process child with:

- `SessionManager.inMemory(cwd)` and no session file;
- the current `openai-codex/gpt-5.6-sol` model;
- exactly `read`, `grep`, `find`, and `ls` active;
- zero discovered extensions and zero extension errors;
- an agent-specific prompt appended to the normal system prompt.

The tested loader used `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and `noContextFiles`. The production scout will make a deliberate choice about loading project context files rather than inheriting that smoke-test setting blindly.

## Proposed Architecture

### Top-level extension module

Register an agent tool from `src/index.ts`:

```text
src/tools/agent/
├── index.ts             # registration and tool contract
├── definitions.ts       # frontmatter parsing and AgentDefinition type
├── discovery.ts         # built-in/user/project discovery and trust handling
├── runtime.ts           # child AgentSession creation and execution
├── runs.ts              # bounded pause/resume run registry
├── child-extension.ts   # ask_parent and read-only confinement hooks
├── usage.ts             # exact nested usage aggregation
├── rendering.ts         # tool call/result rendering
├── workflows.ts         # optional later chain/parallel orchestration
└── PLAN.md              # this document
```

The exact split can be reduced for the first implementation.

### Agent definition type

A definition should contain at least:

```ts
interface AgentDefinition {
    name: string;
    description: string;
    systemPrompt: string;
    tools?: string[];
    model?: string;
    source: "builtin" | "user" | "project";
    filePath?: string;
}
```

Discovery should happen at invocation time so edits to agent files take effect without reload.

### Initial tool contract

Start with one tool and an explicit action discriminator:

```text
Start:  action="start"  + agent + task
Resume: action="resume" + runId + guidance
```

Later actions may include `status`, `cancel`, and background message delivery. An explicit action is clearer and more extensible than inferring behavior solely from optional fields. The tool should reject unknown fields for an action, unknown agent names, stale run IDs, and guidance sent to a non-waiting run.

Possible later modes:

- background message delivery and polling;
- `tasks`: bounded parallel delegation;
- `chain`: sequential delegation with a bounded `{previous}` result;
- `cwd`: an explicitly validated working directory;
- model and thinking overrides.

Agent scope should probably be extension configuration/trust policy rather than an LLM-controlled tool parameter. Available agent names and descriptions should be appended dynamically in `before_agent_start`, so the parent model can discover custom agents without reloading the extension.

### Child runtime defaults

For the first in-process implementation:

- use `SessionManager.inMemory(ctx.cwd)`;
- do not persist child sessions by default;
- use the current model unless the definition specifies one;
- bridge parent cancellation to `childSession.abort()`;
- restrict tools to the extension-controlled `read`, `grep`, `find`, `ls`, and `ask_parent` ceiling;
- confine every path-bearing tool to `cwd`;
- use `noExtensions: true` with only the dedicated child extension;
- preserve pi's normal coding prompt and append the agent definition;
- stream throttled child events into `onUpdate`;
- retain only bounded waiting sessions and dispose all terminal runs.

A read-only interactive scout is the selected first profile. “Interactive” initially means guidance exchange with the parent agent through pause/resume, not direct child ownership of the TUI.

## Incremental Implementation Plan

### Phase 0: Design decisions

Decided:

1. The first runtime is an in-process SDK `AgentSession`; subprocesses remain a possible later isolation fallback.
2. The first agent is read-only.
3. The first interaction protocol is child-to-parent pause/resume by run ID.
4. Background mailbox interaction should remain possible later, but is not part of the first implementation.
5. The first tool exposes single start/resume operations; chains and explicit parallel batches are deferred. A bounded registry may still contain multiple waiting runs.
6. A zero-configuration built-in `scout` will ship with the extension; custom markdown agents remain supported.

Still to decide:

1. Project-local definitions are enabled only when `ctx.isProjectTrusted()` is true. The read-only release does not add another confirmation prompt because the capability ceiling cannot be raised by frontmatter.
2. Built-in names such as `scout` are reserved. Duplicate user/project definitions produce diagnostics rather than silently changing the built-in contract.
3. What are the run count, waiting-session TTL, output cap, and update throttle limits?
4. Direct child-to-user `ask_user` is deferred; all first-release questions route through the parent.
5. The first release uses throttled tool updates and custom result rendering only. A persistent live widget is deferred until the run lifecycle is stable.

### Phase 1: Read-only pause/resume vertical slice

Implement the hardest path first with one built-in or test-only scout definition:

- register the parent `agent` tool;
- create one in-memory child session;
- load only the child confinement and `ask_parent` extension;
- allow only confined read-only tools;
- start, pause with a guidance request, resume by run ID, and complete;
- stream throttled progress through `onUpdate`;
- return exact nested usage;
- bridge cancellation and dispose reliably;
- bound and clean up waiting sessions.

Use injected child-runtime/session factories so orchestration tests do not require provider calls.

### Phase 2: Agent discovery and parent discoverability

Implement and test:

- built-in/user/project definition sources;
- directory resolution;
- full YAML frontmatter parsing and validation;
- tool-list normalization against the capability ceiling;
- duplicate-name precedence;
- malformed-file diagnostics;
- trust and project-agent confirmation behavior;
- a bounded dynamic available-agent block in the parent system prompt.

### Phase 3: Parent TUI rendering

Add compact and expanded rendering for:

- agent name and source;
- task text;
- running/completed/failed/aborted state;
- recent tool activity;
- final markdown output;
- token and cost usage.

Keep the collapsed output bounded and make expanded output useful for debugging.

### Phase 4: Direct user interaction

After pause/resume is stable, decide whether a child may call `ask_user` directly through a restricted parent UI binding. The default parent-guidance path remains available so the parent can answer, investigate, or escalate to the user. Add tests for non-interactive mode, cancellation, nested dialog behavior, and denied file access.

### Phase 5: Mutation-capable worker

Add a worker profile only after safety is established:

- explicit mutation permissions;
- file mutation serialization;
- clear user-visible reporting of changed files;
- optional git worktree isolation;
- tests for concurrent/conflicting edits.

### Phase 6: Chains and parallel work

Add workflow modes only after single-agent execution is stable:

- bounded chain length;
- bounded `{previous}` size;
- failure stops the chain;
- aggregate usage;
- bounded parallel concurrency;
- no unsafe parallel writes by default.

### Phase 7: Persistence and advanced workflows

Consider later:

- persisted child sessions and resume support;
- named agent runs;
- workflow prompt templates;
- project-agent configuration;
- subprocess fallback for stronger isolation;
- richer live widgets or a dedicated child-run view.

## Testing Plan

At minimum:

- built-in scout availability;
- agent frontmatter parsing;
- discovery scope and precedence;
- malformed definitions;
- unknown-agent errors;
- exact start/resume parameter validation;
- `ask_parent` waiting-state capture;
- same-session resume by run ID;
- stale, busy, canceled, and expired run handling;
- waiting-run bounds and parent-session cleanup;
- child session disposal on success/failure/abort;
- parent-signal-to-child-abort bridging;
- output and partial-finding truncation;
- exact nested usage aggregation;
- recursive extension loading prevention;
- confinement of `read`, `grep`, `find`, and `ls`;
- project-agent trust/confirmation;
- later parallel concurrency and mutation safety.

Run the existing checks after implementation:

```bash
npm run test:run
npx tsc --noEmit
```

## Open Questions / Decision Log

Use this section to record decisions as the design evolves.

- [x] First runtime: in-process SDK session; subprocess isolation may be added later.
- [x] First capability: interactive read-only agent/scout.
- [x] First interaction: pause/resume child-to-parent guidance by run ID.
- [x] Future interaction: keep room for a background mailbox.
- [x] Single start/resume flow before chain/parallel.
- [x] Child sessions are in-memory; only bounded waiting runs survive between tool calls.
- [x] Ship a built-in read-only `scout` alongside custom definitions.
- [x] Enable project definitions only in projects trusted by pi; no redundant confirmation for the read-only ceiling.
- [x] Reserve built-in agent names; duplicate markdown definitions cannot override them.
- [x] Use a stateless child-only path hook for `read`, `grep`, `find`, and `ls`; block out-of-cwd access without prompting.
- [x] Route first-release child questions through the parent; defer direct child-to-user UI.
- [x] Use tool updates/results first; defer a persistent live widget.
- [ ] Duplicate-name policy between user and trusted-project agents?
- [ ] Run limits, TTL, output cap, and update throttle?
- [ ] Custom provider synchronization details?

## References

- `src/tools/agent/README.md`
- `src/index.ts`
- `src/tools/bash/index.ts`
- `src/tools/file-permissions.ts`
- `src/modules/memory/frontmatter.ts`
- `src/modules/memory/index.ts`
- Pi extension API: `docs/extensions.md`
- Pi SDK: `docs/sdk.md`
- Official subagent example: `examples/extensions/subagent/`
- Official SDK examples: `examples/sdk/`
