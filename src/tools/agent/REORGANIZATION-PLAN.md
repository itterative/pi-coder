# Delegated-agent architecture review and reorganization plan

## Purpose

Reorganize `src/tools/agent` around stable responsibility boundaries without changing delegated-agent behavior, persistence formats, tool contracts, workspace safety rules, or TUI behavior.

This is a structural plan, not a feature phase. Each stage should be independently reviewable and leave the full suite passing.

## Implementation status

The first reorganization pass is implemented:

- Stages 1–6 are complete: dependency-neutral contracts, definition contracts, shared metadata/catalog storage, workspace store/results/lifecycle/action modules, child decomposition, and run-manager extraction.
- Stage 0 coverage was strengthened with a real shared-action apply/lease-release test; direct setup and standalone formatting characterization remain optional follow-up.
- Stage 7 is complete: `index.ts` contains the 43-line registration/composition function, while top-level `lifecycle.ts`, `browser.ts`, and `action-dispatch.ts` own session state/hooks, `/agents` orchestration, and tool action routing respectively. Formatting/finalization/parent/TUI workspace adapters remain independently extracted.
- Stage 8 compatibility cleanup is complete: workspace action contracts live outside TUI, source and tests import canonical modules, and the temporary deep-import facades have been removed. Broader browser view-model changes remain optional rather than required architecture work.

The implementation has no internal import cycles, and dependency direction is expressed directly by canonical module imports.

## Pre-reorganization shape

The directory had 16 TypeScript files and about 6,829 lines. Four files accounted for most of the implementation:

| File | Lines | Current responsibilities |
| --- | ---: | --- |
| `runtime.ts` | 1,400 | Run contracts, in-memory state machine, restoration, persistence serialization, usage accounting, tracing/events, result construction |
| `workspaces.ts` | 1,359 | SQLite schema, row mapping, run catalog, workspace queries, leases, Git commands, result preparation/application, reset/discard, worktree creation |
| `index.ts` | 911 | Composition root, extension lifecycle, discovery cache, mailbox scheduling, TUI controller, workspace actions, setup UI, tool dispatch, result formatting |
| `child.ts` | 869 | Child tools, read confinement, direct interaction, progress/tracing, usage aggregation, model runtime/auth, transcript repair, SDK session construction |

The remaining modules were generally cohesive, but most depended on `runtime.ts`, making it the subsystem's de facto contract module. `discovery.ts`, `mailbox.ts`, `trace.ts`, and `worker.ts` do not need internal redesign initially; they mainly need relocation or narrower contracts after the larger boundaries are established.

Useful seams already exist and should be preserved: `ChildAgentFactory`, `AgentRunPersistence`, `AgentEventSink`, injected tracing, function-based workspace APIs, and provider-free registration tests.

## Findings

### 1. Cross-layer contracts live in implementation modules

`runtime.ts` defines types used by eleven other files. `workspaces.ts` imports `WorkerMutationReport` from `runtime.ts`, while `runtime.ts` imports `AgentWorkspaceResult` from `workspaces.ts`. `events.ts` imports the run status from `runtime.ts`, while `runtime.ts` emits events through `events.ts`.

The resulting `runtime.ts` / `events.ts` / `workspaces.ts` strongly connected component is mostly type-level today, but it obscures dependency direction and makes extractions risky.

**Recommendation:** establish dependency-free contracts before moving implementation code.

### 2. `index.ts` is both composition root and application layer

The registration function owns mutable extension-wide state and also implements:

- session start/tree/shutdown hooks;
- manager replacement and persistence restoration;
- mailbox scheduling;
- prompt discovery and warning deduplication;
- setup-run presentation state;
- browser data loading and callbacks;
- parent workspace action authorization;
- start/spawn/resume/cancel/collect dispatch;
- isolated-result finalization;
- metadata/result text formatting.

This makes behavior such as apply/release/discard easy to implement differently between parent tool actions and TUI actions.

**Implemented:** keep the registration function in a small `index.ts` composition root and move lifecycle state/hooks, browser orchestration, and action dispatch into explicit top-level modules.

### 3. Workspace persistence and workspace behavior are fused

`workspaces.ts` owns both the shared `meta.sqlite` database and all Git/worktree behavior. The `agent_runs` catalog is not workspace-specific, yet its schema and access functions are in this file. Many operations interleave Git side effects and SQLite updates, so a naive file split could silently alter safety and rollback behavior.

**Recommendation:** first extract database/schema and catalog access, then split workspace queries/leases from Git result operations. Preserve operation ordering exactly during the move.

### 4. Parent and TUI workspace actions need one application service

`executeParentWorkspaceAction()` and `handleWorkspaceAction()` are separate coordinators over the same low-level workspace functions. They differ in authorization context and user interaction, but disposition semantics should be shared.

**Recommendation:** introduce one workspace action service returning typed action results/events. Parent and TUI adapters should handle only authorization input, confirmation, notifications, and rendering.

### 5. `AgentRunManager` is large, but its state machine is cohesive

The manager combines lifecycle transitions, foreground/background behavior, cancellation, restoration, retention, and disposal. These operations share private mutable state and invariants. Splitting the class early would add abstraction without reducing risk.

Useful separable concerns are:

- public run/factory/persistence contracts;
- usage arithmetic and bounds;
- conversion between an internal run and `PersistedAgentRun`;
- trace and event sink interfaces.

**Recommendation:** extract dependencies around the manager first. Keep the state machine intact until its inputs and outputs are stable; reassess its size afterward.

### 6. Child construction has four natural seams

`child.ts` contains:

1. child extension tools and confinement;
2. progress/activity/trace projection;
3. model-runtime and authentication setup;
4. persistent session creation/repair and final SDK assembly.

These seams already have focused tests, so they can be separated without redesigning the public `ChildAgentFactory` contract.

### 7. Agent-specific TUI types point back into storage modules

Agent browser components under `src/tui` import session and workspace records directly from `src/tools/agent`. The agent registration then imports those TUI components. There is no immediate runtime cycle through `index.ts`, but presentation is coupled to persistence-shaped records, and `AgentWorkspaceAction` is currently declared by the TUI.

**Recommendation:** define browser view models and action types in the agent feature boundary. Keep reusable TUI primitives in `src/tui`; either keep the agent-specific browser components there with contract-only imports, or move them under an agent `presentation/` folder in a later, separate change.

### 8. Test layout mirrors history more than architecture

`test/tools/agent.test.ts` (manager behavior) and `test/tools/agent-tool.test.ts` (registration/integration behavior) are broad. Workspace tests exercise storage, Git behavior, and lifecycle in one file. Coverage is strong, but locating the contract for a moved component is harder than necessary.

**Recommendation:** reorganize tests only after production boundaries stabilize. Preserve end-to-end registration tests while splitting lower-level tests by domain.

### 9. Pure usage and definition concerns are duplicated or implementation-owned

Usage cloning/bounding/projection appears in runtime, child, persistence, and outcome code. `AgentDefinition` and fingerprinting are owned by `discovery.ts`, forcing runtime and child code to depend on discovery implementation.

**Recommendation:** extract definition contracts/fingerprinting and shared usage helpers early. Keep semantically different status predicates separate; “terminal,” “retained,” and “active” are not interchangeable.

## Proposed dependency direction

```text
contracts
   ↑
definitions     storage/meta     git adapter
   ↑                 ↑               ↑
child runtime    run persistence   workspace store/results
       ↖             ↑              ↗
               run manager
                    ↑
          workspace/run services
                    ↑
     tool + browser + lifecycle adapters
                    ↑
                 index.ts
```

Rules:

1. Contract modules import no agent implementation modules.
2. The run manager does not import concrete SQLite, TUI, mailbox, or workspace implementations.
3. Workspace modules may depend on shared contracts and the metadata/Git adapters, but not the run manager.
4. Presentation modules receive view models and callbacks; they do not query persistence directly.
5. `index.ts` wires concrete implementations and remains the only extension entrypoint.
6. Cross-domain operations such as “apply then release lease then emit event” live in an application service, not in presentation adapters.

## Recommended target structure

Names may be adjusted during extraction, but the responsibility boundaries should remain:

```text
src/tools/agent/
├── index.ts                         # registration function and composition root
├── lifecycle.ts                     # owned state, mailbox, restoration, pi session hooks
├── browser.ts                       # /agents data and callback orchestration
├── action-dispatch.ts               # agent tool action routing
├── contracts/
│   ├── runs.ts                      # run status/details/factory/usage-facing contracts
│   ├── persistence.ts               # persisted-run and persistence-port contracts
│   ├── workspaces.ts                # workspace/result/action contracts
│   └── events.ts                    # event payload and sink contracts
├── definitions/
│   ├── types.ts                      # AgentDefinition and fingerprinting contract
│   ├── discovery.ts
│   └── prompt.ts
├── runs/
│   ├── manager.ts                   # AgentRunManager state machine
│   ├── usage.ts                     # usage cloning/subtraction/zero value
│   ├── outcomes.ts
│   └── persistence.ts               # parent journal loading/parsing/writer adapter
├── child/
│   ├── index.ts                     # createAgentChild facade
│   ├── extension.ts                 # ask_parent/ask_user/confinement registration
│   ├── progress.ts                  # session-event projection and trace summaries
│   ├── model-runtime.ts             # provider/model/auth resolution
│   ├── session.ts                   # transcript materialization and repair
│   └── worker-permissions.ts        # existing worker mutation hooks
├── storage/
│   ├── metadata.ts                  # meta.sqlite open/migrations/permissions
│   └── run-catalog.ts               # agent_runs table mapping and queries
├── workspaces/
│   ├── store.ts                     # workspace/result rows and lease transactions
│   ├── git.ts                       # checked Git command adapter
│   ├── results.ts                   # prepare/inspect/apply/ref lifecycle
│   ├── lifecycle.ts                 # create/reset/discard/recovery
│   ├── setup.ts
│   └── actions.ts                   # shared parent/TUI disposition service
├── presentation/
│   ├── tool.ts                      # tool registration/rendering
│   ├── schema.ts                    # AgentParameters and schema
│   ├── formatting.ts                # metadata and response formatting
│   ├── mailbox.ts
│   ├── widget.ts
│   └── browser-controller.ts
├── observability/
│   ├── events.ts                    # pi event-bus adapter
│   ├── trace-store.ts
│   └── trace-command.ts
├── README.md
├── PLAN.md
└── REORGANIZATION-PLAN.md
```

This structure is a destination, not a requirement to create every directory immediately. Avoid one-function files and merge adjacent modules if the extracted implementation remains small.

## Staged migration

### Stage 0 — Freeze behavior and document invariants

- Treat the current full suite and TypeScript check as the baseline.
- Add focused characterization where missing, especially:
  - parent and TUI apply use the same disposition sequence;
  - successful apply records the result and releases the lease;
  - failed apply leaves result/workspace/lease unchanged;
  - post-apply cleanup never alters parent changes;
  - foreground/background no-change finalization remains identical;
  - workspace setup behavior is tested directly rather than only through registration mocks;
  - agent metadata formatting has direct tests before moving out of `index.ts`.
- Record persistence compatibility: custom parent entries, child JSONL paths, SQLite schema/table names, durable Git ref names, and tool metadata must not change during reorganization.
- Record the intended `cwd` versus `parentCwd` semantics for run events before moving event code; UI refresh filtering currently depends on them.

**Exit criterion:** behavior is characterized at the seams that will move.

### Stage 1 — Extract contracts and remove dependency cycles

- Move run types, `WorkerMutationReport`, persistence ports, workspace/result types, and event payload types into dependency-free contract modules.
- Move `AgentDefinition` and fingerprinting out of discovery implementation.
- Consolidate genuinely shared usage constants/cloning/arithmetic while retaining specialized aggregation and distinct status predicates.
- Define a narrow trace sink contract consumed by the manager rather than importing `AgentTraceStore` directly.
- Keep compatibility re-exports from the old module paths while callers migrate; existing tests and TUI use deep imports, and registration tests spy on current workspace exports.
- Add a lightweight dependency-boundary test or script that rejects imports from contracts back into implementations.

**Exit criterion:** no strongly connected component among run, event, and workspace implementation modules; no behavior changes.

### Stage 2 — Split shared metadata storage from workspaces

- Extract lazy SQLite loading, migrations, database path/permissions, and connection setup into `storage/metadata.ts`.
- Move `agent_runs` mapping and queries into `storage/run-catalog.ts`.
- Point run persistence and session browsing at the catalog module rather than `workspaces.ts`.
- Preserve the single `.state/meta.sqlite` location and existing migration versions exactly.

**Exit criterion:** workspace code no longer owns the agent-run catalog; migration and persistence tests still pass against existing-format databases.

### Stage 3 — Split workspace internals behind a compatibility facade

- Extract the Git command helpers first.
- Separate read/query and lease operations from result/apply/ref operations.
- Separate destructive lifecycle operations (create/reset/discard/recover).
- Keep temporary re-exports from `workspaces.ts`, or replace it with a small barrel, so TUI and tests can migrate incrementally.
- Do not change transaction boundaries, Git-before-database ordering, cleanup paths, or lazy SQLite behavior during these moves.

**Exit criterion:** no workspace implementation file is responsible for schema, catalog, leases, Git application, and worktree lifecycle simultaneously.

### Stage 4 — Introduce one workspace action service

- Create typed actions and results independent of TUI.
- Centralize sequences such as prepare/apply/release, retain/release, discard/reset, revise/reclaim, and emitted workspace state changes.
- Adapt parent `agent` actions and TUI callbacks to this service.
- Keep confirmation and notification wording in their respective adapters.

**Exit criterion:** disposition semantics have one implementation; parent/TUI parity tests pass.

### Stage 5 — Decompose child construction

- Move model/auth setup without changing provider behavior.
- Move transcript materialization/repair.
- Move child interaction/confinement extension registration.
- Move event-to-progress/trace projection.
- Retain `createAgentChild()` as the assembly facade and preserve the current factory contract.

**Exit criterion:** child SDK smoke, interaction, persistence, confinement, and worker-permission tests pass without broad mocks.

### Stage 6 — Slim the run module without fragmenting the state machine

- Move contracts and usage helpers out as planned.
- Move persisted-record projection/parsing concerns to the persistence adapter where practical.
- Keep `AgentRunManager` transitions and private mutable `AgentRun` state together.
- Reassess after extraction; split restoration into a collaborator only if it can operate through a narrow manager-owned API rather than direct state mutation.

**Exit criterion:** `runs/manager.ts` expresses lifecycle policy rather than shared types and storage formatting, with all lifecycle tests unchanged.

### Stage 7 — Extract extension orchestration from `index.ts`

- Give manager, active context, setup-run state, mailbox, prompt cache, and warning cache explicit owned state.
- Move browser data/callback orchestration into a browser controller.
- Move action dispatch and isolated-result finalization into application services.
- Move metadata/result formatting into presentation helpers.
- Leave `index.ts` responsible only for constructing dependencies and registering lifecycle, browser, and action-dispatch modules.
- Keep these extension-level modules at the top of the agent package so the composition boundary is visible without another wrapper directory.
- Do not replace the current closure with one large controller; keep browser and action workflows separate from lifecycle-owned state.

**Exit criterion:** `index.ts` is a small, readable composition root; no replacement controller becomes the new hotspot; session tree/shutdown/restore behavior remains integration-tested.

### Stage 8 — Align presentation and tests

- Move `AgentWorkspaceAction` out of the TUI module.
- Introduce browser view models if persistence records still leak into rendering.
- Decide separately whether agent-specific browser components should move from `src/tui` into the feature package; do not move shared list/pager/overlay primitives.
- Split broad tests to mirror the final domains while retaining a small number of registration-level flows.
- Remove compatibility barrels only after all internal imports and tests use the final modules.

**Exit criterion:** dependency direction matches the target architecture and test names map cleanly to responsibility boundaries.

## Sequencing and review guidance

Use small commits in this order:

1. characterization tests;
2. contract extraction;
3. metadata/catalog extraction;
4. workspace split;
5. shared workspace action service;
6. child split;
7. run-manager cleanup;
8. extension-controller extraction;
9. presentation/test alignment and compatibility cleanup.

The recommended first implementation tranche was stages 0–4. It removed the dependency cycle, separated shared metadata ownership, and eliminated duplicated workspace disposition orchestration. Subsequent child/runtime/presentation moves used temporary compatibility facades to stage the migration; those facades were removed after source and tests adopted canonical modules.

For each commit:

```bash
npx vitest run <focused-tests>
npx tsc --noEmit
npm run test:run
git diff --check
```

Prefer pure moves plus import changes before refactoring bodies. Do not combine schema migration changes, lifecycle behavior changes, or UI redesign with this reorganization.

## Primary risks

- **Workspace safety regression:** Git and SQLite cannot share one atomic transaction. Preserve current side-effect ordering and compensating cleanup exactly.
- **Lifecycle race regression:** shutdown, cancellation during setup, background completion, and tree switching depend on owned promises and callback order.
- **Persistence incompatibility:** parent custom-entry versions, exact-session ownership, child transcript paths, and catalog keys are recovery contracts.
- **Event scoping regression:** changing `cwd`/`parentCwd` projection can stop isolated-run UI refreshes without breaking core lifecycle tests.
- **Mock-only confidence:** compatibility re-exports can make unit tests pass while the composition root is wired incorrectly; retain registration-level tests.
- **Over-abstraction:** the manager state machine and workspace operations contain genuine complexity. The goal is clearer ownership, not smaller files at any cost.

## Definition of done

- `index.ts` contains the public registration function and acts as the composition root rather than the application implementation.
- Shared contracts do not depend on concrete runtime, workspace, storage, or presentation modules.
- Run/event/workspace implementation modules have no dependency cycle.
- `agent_runs` catalog ownership is separated from workspace behavior while remaining in `meta.sqlite`.
- Parent and TUI workspace dispositions use one application service.
- Child model/session/extension/progress responsibilities are independently testable.
- Existing persistence formats and user-visible behavior are unchanged.
- Full tests, TypeScript, and diff checks pass after every stage.
