# Agent Support for pi-coder

Status: exploration complete; implementation has not started.

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

The existing memory module already contains frontmatter parsing code that may be reusable or generalized, although agent parsing should have its own validation and discovery tests.

### Safety and runtime concerns

#### Avoid recursive extension loading

A child session using the default resource loader may rediscover pi-coder and register the agent tool again. This can cause recursive delegation or duplicate hooks.

The child runtime should use a controlled resource loader. Possible approaches:

- no extensions, with explicitly supplied tools and hooks;
- a minimal inline extension set;
- a dedicated child resource loader that includes only safe, intentionally selected pi-coder functionality.

#### Preserve bash and file protections

The current bash and read/write protections are extension-level hooks. If a child session is created without those hooks, delegated agents may bypass the safety behavior that applies to the parent.

This needs an explicit design rather than accidental inheritance.

Potential approaches:

1. Bind a carefully scoped copy of the relevant hooks to the child session.
2. Build child tools with operations that call shared permission/sandbox logic.
3. Start with read-only agents and explicitly exclude mutation tools.
4. Run mutation-capable agents in isolated worktrees or subprocesses.

The first prototype should use the safest option that keeps the implementation understandable.

#### Parent UI and child interaction

A child agent does not get a second independent terminal UI. For richer interaction, the parent must either:

- forward child UI requests to the parent `ctx.ui`;
- provide a restricted UI adapter;
- prohibit child tools that require interaction;
- use a subprocess/RPC protocol with explicit UI forwarding.

Nested `ctx.ui.custom()` components are especially risky because the parent TUI has one active editor/focus model. Basic `select`, `confirm`, `input`, and `notify` forwarding may be feasible; arbitrary custom components should initially be disallowed.

#### Parallel mutation

Parallel agents that edit the same working tree can overwrite each other. `withFileMutationQueue()` coordinates mutations within one process, but it is not a cross-process or cross-session transaction mechanism.

Parallel execution should initially be:

- read-only;
- restricted to disjoint paths;
- serialized for mutation; or
- isolated through separate git worktrees.

#### Model and authentication handling

The parent extension context exposes `modelRegistry` and the active model, but not the parent `ModelRuntime` directly.

A full child `AgentSession` needs a model runtime. We need to decide whether to:

- create/reuse a `ModelRuntime` using the normal pi auth/model files;
- register the active provider into a child runtime;
- add a small internal provider/runtime adapter;
- use direct `modelRegistry.complete()` for helper agents until full runtime support is needed.

Custom providers registered dynamically by extensions must not silently stop working for child agents.

#### Cancellation and cleanup

The parent tool's `signal` must be passed to all child model/tool work. Every child session/process must be disposed after completion, failure, or cancellation.

The parent tool should return a clear error when a child is aborted rather than treating cancellation as successful output.

#### Context and output limits

Delegated output can be large. Child results should:

- be truncated before being returned to the parent model;
- retain enough final output for downstream chain steps;
- expose detailed state through tool `details` for the TUI;
- report nested model usage using the tool result's `usage` field.

## Proposed Architecture

### Top-level extension module

Register an agent tool from `src/index.ts`:

```text
src/tools/agent/
├── index.ts             # registration and tool orchestration
├── definitions.ts       # frontmatter parsing and AgentDefinition type
├── discovery.ts         # user/project discovery and trust handling
├── runtime.ts           # child AgentSession lifecycle
├── rendering.ts         # tool call/result rendering
├── workflows.ts         # optional chain/parallel orchestration
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
    source: "user" | "project";
    filePath: string;
}
```

Discovery should happen at invocation time so edits to agent files take effect without reload.

### Initial tool contract

Start with one explicit mode rather than the full official surface:

```text
agent: string
 task: string
```

Possible later modes:

- `tasks`: bounded parallel delegation;
- `chain`: sequential delegation with a bounded `{previous}` result;
- `cwd`: an explicitly validated working directory;
- `agentScope`: user/project/both;
- model and thinking overrides.

The tool should reject ambiguous combinations and unknown agent names with an available-agent list.

### Child runtime defaults

For the first in-process implementation:

- use `SessionManager.inMemory(ctx.cwd)`;
- do not persist child sessions by default;
- use the current model unless the definition specifies one;
- pass the parent abort signal;
- restrict tools to a safe explicit allowlist;
- avoid recursive loading of the agent extension;
- stream child events into `onUpdate`;
- dispose the child session in `finally`.

A read-only scout agent is the recommended first supported profile.

## Incremental Implementation Plan

### Phase 0: Design decisions

Before coding, decide:

1. Is the first release strictly in-process, or should subprocess execution remain an available fallback?
2. Should child agents be allowed to edit files immediately, or only inspect and plan?
3. Should child UI requests be forwarded to the parent, or should child agents be non-interactive initially?
4. Are project-local agent definitions enabled by default, only after confirmation, or disabled initially?
5. Should the first tool support only single-agent execution, or include chains/parallelism?
6. How should custom providers registered by extensions be made available to child sessions?
7. Is child output shown only as a tool result, or should it also appear as a live parent status/widget?

### Phase 1: Agent discovery

Implement and test:

- user/project directory resolution;
- frontmatter parsing and validation;
- tool-list normalization;
- duplicate-name precedence;
- malformed-file diagnostics;
- trust and project-agent confirmation behavior.

No child execution yet.

### Phase 2: Read-only in-process agent

Implement the smallest useful vertical slice:

- register the agent tool;
- discover user-level definitions;
- create one in-memory child session;
- allow only read-only tools;
- stream progress through `onUpdate`;
- return final text and usage;
- propagate cancellation;
- dispose reliably.

Add tests for orchestration with mocked child runtime/model behavior where possible.

### Phase 3: Parent TUI rendering

Add compact and expanded rendering for:

- agent name and source;
- task text;
- running/completed/failed/aborted state;
- recent tool activity;
- final markdown output;
- token and cost usage.

Keep the collapsed output bounded and make expanded output useful for debugging.

### Phase 4: Controlled permissions and interaction

Choose and implement the child safety model:

- inherit/rebind sandbox and file hooks; or
- provide explicitly guarded child tools/operations.

Then decide which basic UI methods can safely be forwarded to the parent. Add tests for non-interactive mode and denied access.

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

- agent frontmatter parsing;
- discovery scope and precedence;
- malformed definitions;
- unknown-agent errors;
- exact tool parameter validation;
- child session disposal on success/failure/abort;
- output truncation;
- nested usage aggregation;
- non-interactive behavior;
- recursive extension loading prevention;
- project-agent confirmation;
- permission enforcement;
- parallel concurrency and mutation safety.

Run the existing checks after implementation:

```bash
npm run test:run
npx tsc --noEmit
```

## Open Questions / Decision Log

Use this section to record decisions as the design evolves.

- [ ] First runtime: in-process SDK session, subprocess, or hybrid?
- [ ] First capability: read-only scout or mutation-capable worker?
- [ ] Child extension set and permission model?
- [ ] Parent UI forwarding policy?
- [ ] User/project agent discovery policy?
- [ ] Single mode before chain/parallel?
- [ ] Persistence policy?
- [ ] Custom provider/model runtime strategy?

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
