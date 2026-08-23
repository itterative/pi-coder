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
- `src/tools/agent/index.ts` registers the in-process `agent` tool from `src/index.ts`.
- `child.ts`, `runtime.ts`, and `discovery.ts` implement the read-only child SDK session, run state machine, and custom definition loading.
- The MVP supports built-in/user/trusted-project agents, foreground start, concurrent background spawn/status/collect, resume/cancel, parent guidance, confinement, usage deltas, lifecycle cleanup, and compact/expanded rendering.
- The stabilization pass makes waiting state explicitly paused in parent guidance, shows compact question/result previews, tests tool-level pause/resume rendering and additional lifecycle/confinement edges, and records a repeatable manual provider/lifecycle checklist in `README.md`.
- Diagnostics retain bounded sanitized timelines for recent runs and expose `/agent-trace`; the intended `PI_CODER_AGENT_TRACE=1` gate is temporarily hardcoded on during development.
- Existing extension functionality also includes:
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

Project-local definitions are repository-controlled instructions and are discovered only when pi marks the project trusted.

Pi already exports a full YAML `parseFrontmatter()` helper, which is a better fit for agent definitions than the memory module's intentionally limited flat-frontmatter parser. Agent parsing should still have its own validation and discovery tests.

Discovery and duplicate precedence are deterministic:

1. Built-in names are reserved; conflicting markdown definitions are ignored with a warning.
2. Files within each scope are sorted by path before parsing.
3. Within one scope, the first valid definition for a name wins; later definitions are ignored with a warning that identifies the selected and ignored paths.
4. After per-scope deduplication, trusted-project definitions override user definitions with the same name.
5. Expected project-over-user shadowing emits an informational diagnostic identifying both definitions, not a warning.

Discovery diagnostics should be returned structurally and deduplicated by fingerprint for the parent runtime. New warnings are surfaced once through `ctx.ui.notify`; informational shadowing remains available in expanded tool details/debug output without producing a warning notification.

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

Direct child-to-user interaction is implemented after MVP stabilization: the controlled child extension forwards a restricted question through the parent TUI using pi-coder's existing `askUser` component. The answer returns to the same child turn. `ask_parent` remains available when the parent can investigate or decide. Direct dialogs are TUI-only; other modes receive an explicit unavailable result and guidance to use `ask_parent`. Parent abort/session shutdown closes an active dialog through the child tool's abort signal.

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

Dynamic extension providers need explicit synchronization. The parent `modelRegistry` publicly exposes registered provider IDs, configs/native providers, and resolved auth. The MVP mirrors active provider registration, resolved base URL/headers, and non-OAuth runtime API keys when the child cannot resolve auth itself. It deliberately preserves child-resolved OAuth credentials: OAuth access tokens are exposed through an `apiKey` compatibility field but must not be installed as API-key credentials. Runtime-only OAuth credentials that are not persisted remain unavailable through the public extension API and produce an explicit synchronization error rather than silently selecting another model.

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
Start:   action="start"   + agent + task
Spawn:   action="spawn"   + agent + task
Status:  action="status"  + runId
Collect: action="collect" + runId
Resume:  action="resume"  + runId + guidance
Cancel:  action="cancel"  + runId
```

`cancel` releases waiting foreground runs and active background runs. `spawn` returns a run handle immediately; `status` reports bounded progress, and `collect` consumes a retained terminal result. Automatic background message delivery remains deferred. An explicit action is clearer and more extensible than inferring behavior solely from optional fields. The tool should reject unknown fields for an action, unknown agent names, stale run IDs, and guidance sent to a non-waiting run.

Possible later modes:

- automatic background result/mailbox delivery;
- `tasks`: an explicit bounded parallel batch in one call;
- `chain`: sequential delegation with a bounded `{previous}` result;
- `cwd`: an explicitly validated working directory;
- model and thinking overrides.

Agent scope should be extension configuration/trust policy rather than an LLM-controlled tool parameter. Available agent names, descriptions, and waiting run IDs should be appended dynamically in `before_agent_start`, so the parent model can discover custom agents and recover waiting state after compaction without reloading the extension.

### Run protocol and state machine

The parent `agent` tool is sequential for the first release. This avoids races when a model emits multiple start/resume/cancel calls in one tool batch. A run has one of these states:

```text
starting -> running -> completed
                    -> waiting_for_parent -> running (resume)
                    -> failed
                    -> aborted
waiting_for_parent -> canceled
```

Foreground terminal states are returned in the current tool result, then their child session is disposed and removed. Background child sessions are also disposed immediately on terminal settlement, but the latest 20 bounded terminal results remain collectable. Only `starting`, `running`, and `waiting_for_parent` consume the four-run active capacity.

#### Start

1. Validate the action-specific fields and resolve an agent definition.
2. Reserve a short parent-session-local run ID such as `scout-1` before awaiting setup. IDs use a monotonic parent-runtime counter and are never reused within that runtime, even after terminal cleanup.
3. Enforce the active-run bound: at most four starting/running/waiting sessions, with no automatic TTL.
4. Create and bind the child session, then transition to `running`.
5. Prompt with the delegated task.
6. On settlement, classify the run as waiting, completed, failed, or aborted.

A setup failure disposes any partially created resources and returns a failed result. The runtime must never silently fall back to another agent or model.

#### Waiting for parent

The child-only `ask_parent` tool accepts a question, relevant findings/context, optional choices, and an optional recommendation. It records one pending request and returns `terminate: true`. Its prompt guidelines require it to:

- make reasonable progress before asking;
- ask only when parent guidance can materially improve the result;
- include evidence and its recommended next step;
- invoke `ask_parent` alone in a tool batch.

After `childSession.prompt()` settles, a recorded request takes precedence over ordinary completion and transitions the run to `waiting_for_parent`. The parent result includes the same run ID, question, bounded partial findings, choices/recommendation, and explicit resume syntax. Waiting is a successful tool outcome, not an error.

The SDK only honors early termination when every tool result in a child batch has `terminate: true`. If the child violates the “call alone” guideline, it may perform additional work before settling; the recorded guidance request still wins and the run becomes waiting rather than being discarded.

#### Resume

1. Resolve the run ID and require `waiting_for_parent`.
2. Transition synchronously to `running` before any await, preventing a second resume/cancel from racing it.
3. Clear the old request and append bounded parent guidance as a new child user message with an explicit `Parent guidance:` prefix.
4. Prompt the same child session; do not reconstruct its context.
5. Allow repeated `waiting_for_parent -> running -> waiting_for_parent` cycles.
6. Return only usage accrued since the previous parent tool result.

A busy, stale, terminal, or unknown run ID returns a clear action-specific error. After extension reload or parent session replacement, all old IDs are stale by design.

#### Background execution

`spawn` reserves a run and starts child setup asynchronously, returning before setup or prompting completes. Multiple sequential `spawn` tool calls can therefore launch up to four read-only children concurrently. `status` snapshots bounded progress or reports that a terminal result is ready; `collect` returns that result once and makes the ID stale. Background `resume` returns immediately and keeps the run asynchronous. Usage checkpoints advance on each parent-visible spawn/status/resume/cancel/collect result, so nested usage is never duplicated.

Background children omit `ask_user` to prevent unsolicited dialogs from racing parent rendering or another tool call. They retain `ask_parent`, transition to `waiting_for_parent`, and appear in the dynamic parent prompt. Direct result/mailbox injection is deferred; the parent polls explicitly.

#### Cancel and shutdown

`cancel` is valid for a waiting foreground run or any nonterminal background run. Active background cancellation aborts and settles the child before disposing it and making the ID stale. A parent abort signal during foreground start/resume calls `childSession.abort()` and transitions that operation to `aborted` after settlement.

An idempotent `session_shutdown` handler handles quit, reload, new-session, resume, and fork. It marks the registry closing, aborts running children, waits for their operations to settle, disposes every retained session, and clears the registry. `session_start` creates fresh parent-session-local state; child runs are not transferred across parent sessions.

This parent-runtime-local lifetime is an explicit MVP choice. Pi's persistent `SessionManager` could support durable child sessions later, but the first release returns a clear stale-ID error after reload/replacement/restart rather than implementing a partial persistence format.

#### Results and errors

Each result carries a bounded snapshot in `details`: run ID, agent/source, task summary, status, latest question/final output, recent activity, cumulative display usage, and timestamps. LLM-facing content is separately bounded.

Completed and waiting states are successful. Invalid actions, setup/provider failures, failed child turns, stale resumes, and aborts are marked as errors by a parent `tool_result` hook so structured details and usage are preserved instead of being lost through an exception.

### Child runtime defaults

For the first in-process implementation:

- use `SessionManager.inMemory(ctx.cwd)`;
- do not persist child sessions by default;
- use the current model unless the definition specifies one;
- bridge parent cancellation to `childSession.abort()`;
- restrict tools to the extension-controlled `read`, `grep`, `find`, `ls`, `ask_parent`, and foreground-only `ask_user` ceiling;
- confine every path-bearing tool to `cwd`;
- use `noExtensions: true` with only the dedicated child extension;
- preserve pi's normal coding prompt and append the agent definition;
- stream throttled child events into `onUpdate`;
- retain only bounded active/waiting sessions, dispose every terminal child immediately, and bound retained background result metadata.

A read-only interactive scout is the selected first profile. It supports both parent guidance through pause/resume and restricted direct end-user questions in TUI mode; direct interaction does not grant broader child ownership of the TUI.

## Incremental Implementation Plan

### Phase 0: Design decisions

Decided:

1. The first runtime is an in-process SDK `AgentSession`; subprocesses remain a possible later isolation fallback.
2. The first agent is read-only.
3. The first interaction protocol is child-to-parent pause/resume by run ID, with explicit start/resume/cancel actions.
4. Background mailbox interaction should remain possible later, but is not part of the first implementation.
5. The first tool exposes single-run operations; chains and explicit parallel batches are deferred. A bounded registry may still contain multiple waiting runs.
6. A zero-configuration built-in `scout` will ship with the extension; custom markdown agents remain supported.
7. Project definitions are enabled only when `ctx.isProjectTrusted()` is true, without another read-only confirmation prompt.
8. Built-in names such as `scout` are reserved.
9. Retain at most four active/waiting runs with no TTL and parent-runtime-local lifetime.
10. Direct child-to-user `ask_user` is deferred; first-release questions route through the parent.
11. Use throttled tool updates and custom result rendering first; defer a persistent live widget.

Known limitation:

1. The public extension context cannot transfer a complete runtime-only OAuth credential into a child. Persisted `/login` OAuth, registered providers/native providers, resolved base URL/headers, and ordinary runtime API keys are supported.

### Phase 1: Read-only pause/resume vertical slice — implemented

The MVP implements:

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

### Phase 2: Agent discovery and parent discoverability — implemented

Implemented and tested:

- built-in/user/project definition sources;
- directory resolution;
- full YAML frontmatter parsing and validation;
- tool-list normalization against the capability ceiling;
- deterministic same-scope first-wins warnings and project-over-user informational diagnostics;
- malformed-file diagnostics;
- project trust gating behavior;
- a bounded dynamic available-agent block in the parent system prompt.

### Phase 3: Parent TUI rendering — MVP implemented

Compact and expanded rendering includes:

- agent name and source;
- task text;
- running/completed/failed/aborted state;
- recent tool activity;
- final markdown output;
- token and cost usage.

Keep the collapsed output bounded and make expanded output useful for debugging. A trace store captures up to 400 sanitized lifecycle/session events for each of the latest 20 runs. `/agent-trace` can inspect those timelines after terminal child disposal or explicitly save mode-`0600` JSON. The intended release gate is `PI_CODER_AGENT_TRACE=1`, but tracing is temporarily hardcoded on during development.

### Phase 4: Direct user interaction — implemented

The child-only `ask_user` forwards through a restricted parent TUI binding and reuses pi-coder's existing question component. Answers continue the same child turn; user cancellation is recoverable; parent abort and shutdown close active dialogs; non-TUI modes explicitly fall back to `ask_parent`. The default parent-guidance path remains available so the parent can answer or investigate. Tests cover answers, repeated questions, cancellation, non-interactive behavior, abort cleanup, and the unchanged path-confinement boundary.

### Phase 5: Concurrent background runs — implemented

The read-only runtime now supports:

- immediate `spawn` acknowledgements and up to four concurrent child operations;
- a persistent footer status that updates on running, waiting, ready, failed, collection, and cancellation transitions;
- explicit bounded `status` polling and one-shot `collect`;
- background pause/resume through `ask_parent`;
- active background cancellation and shutdown settlement;
- immediate terminal child disposal with the latest 20 results retained;
- exact usage checkpoints across asynchronous parent calls;
- no direct-user dialogs from background children;
- dynamic parent-prompt recovery of tracked background IDs after compaction.

Automatic completion/mailbox delivery and explicit batch syntax remain deferred.

### Phase 6: Mutation-capable worker

Add a worker profile only after safety is established:

- explicit mutation permissions;
- file mutation serialization;
- clear user-visible reporting of changed files;
- optional git worktree isolation;
- tests for concurrent/conflicting edits.

### Phase 7: Chains and explicit batch work

Add workflow modes only after single-agent execution is stable:

- bounded chain length;
- bounded `{previous}` size;
- failure stops the chain;
- aggregate usage;
- reuse the implemented four-run concurrency bound;
- no unsafe parallel writes by default.

### Phase 8: Persistence and advanced workflows

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
- background concurrency, retention, polling, collection, cancellation, shutdown, and mutation safety.

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
- [x] Add explicit spawn/status/collect background execution before automatic mailbox delivery or batch syntax.
- [x] Child sessions are in-memory and parent-runtime-local; waiting runs do not survive reload, parent session replacement/fork, or process restart.
- [x] Ship a built-in read-only `scout` alongside custom definitions.
- [x] Enable project definitions only in projects trusted by pi; no redundant confirmation for the read-only ceiling.
- [x] Reserve built-in agent names; duplicate markdown definitions cannot override them.
- [x] Use a stateless child-only path hook for `read`, `grep`, `find`, and `ls`; block out-of-cwd access without prompting.
- [x] Route first-release child questions through the parent.
- [x] After MVP stabilization, add restricted TUI-only child-to-user questions while retaining `ask_parent`.
- [x] Use tool updates/results first; defer a persistent live widget.
- [x] Within a scope, sorted first definition wins and later duplicates warn; trusted-project definitions override user definitions with an informational diagnostic.
- [x] Allow at most four active/waiting runs with no TTL; cleanup is explicit or tied to parent shutdown.
- [x] Bound task/guidance to 16,000 characters, LLM-facing final output to 32,000 characters, and progress updates to at most once per 100 ms.
- [x] Preserve child-resolved OAuth; mirror registered provider/native-provider configuration and resolved base URL/headers; copy runtime API keys only for non-OAuth providers lacking child auth. Runtime-only unpersisted OAuth remains an explicit limitation.

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
