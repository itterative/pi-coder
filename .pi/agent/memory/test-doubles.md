---
name: test-doubles
description: Catalog of shared test doubles and helpers (pi surface, ExtensionContext, domain partials, TUI driving, e2e scaffolding) plus the rule to reuse them instead of hand-building literals.
category: workflow
keep_updated: true
---

# Test doubles and shared helpers

**Find the helper before writing a literal.** Hand-built `const pi = { on(...) {...} } as any;` appeared 28 times across 10 test files, and each cast silently absorbed a rename or a missing field: the test kept passing while describing an object production cannot construct. That is how `test/` reached 199 `no-explicit-any` findings. When a shape is missing, extend the shared helper so the next suite inherits it — do not re-declare it locally.

## Which double do I need?

| Need | Use | Not |
| --- | --- | --- |
| the `pi` surface an extension registers into | `test/helpers/pi-stub.ts` → `createPiStub()` | `const pi = { ... } as any` |
| the context a handler is invoked with | `stubContext()`, `stubUi()`, `stubSessionManager()` | `{ cwd, ui } as any` |
| a domain object where most fields are irrelevant | `test/helpers/agent-doubles.ts` → `partialRun`, `partialDetails`, `partialWorkspace`, `partialWorkspaceResult`, `partialTracker`, `zeroUsage` | partial literal + cast |
| a child-session event to feed `updateTracker` | `test/helpers/session-events.ts` → `messageStartEvent`, `textDeltaEvent`, `thinkingDeltaEvent`, `toolExecutionStartEvent`, `toolExecutionEndEvent` | partial event + `as any` |
| a durable-persistence or state-writer double | `agent-doubles.ts` → `partialPersistence`, `partialStateWriter` | duck-typed object + cast across the two contracts |
| driving a real dialog component | `pi-stub.ts` → `stubUiWithDialogs(theme)` → `{ ui, dialogs }` | private `custom(factory)` driver per suite |
| a context whose session manager must **write** entries | `pi-stub.ts` → `stubSessionContext(parent)` / `SessionBackedContext` | `ctx as any` to reach `appendCustomEntry` |
| a child extension wired the way production wires it | `test/tools/child-run-fixture.ts` → `buildChildRun`, `probeDefinition` | hand-built grant or option bag |
| driving a TUI component | `test/helpers.ts` → `KEY`, `mockTheme`, `press`, `type`, `paste`, `interact`, `renderText`, `snapshotText` | inline ANSI sequences, hand-rolled key strings |
| temp dirs, SQLite, git repos for agent lifecycle | `test/tools/e2e/helpers.ts` → `createE2EPaths`, `withE2EMetadataDatabase`, `createScriptedChild`, `insertE2EAgentRun`, `createClaimedTaskWorkspace`, `initializeRepository` | ad-hoc `mkdtemp` plus open-by-hand |
| template-string fixtures without indentation | `test/modules/memory/utils.ts` → `dedent` | manual leading-space stripping |

## `createPiStub` surface

`createPiStub({ eventBus?: EventBus | null })` records the seven `pi` members production calls (`on`, `registerTool`, `registerCommand`, `registerShortcut`, `appendEntry`, `sendMessage`, `events`) and exposes:

- `pi` — typed `ExtensionAPI`, one boundary cast inside the helper rather than one per suite.
- `order` — **cross-member** registration log: `on:<event>`, `tool:<name>`, `command:<name>`, `shortcut:<key>`. Separate recorders cannot express interleaving, and handler registration order *is* permission precedence in `child/gates/`.
- `handlersFor(event)`, `requireHandler(event, index?)` — handlers in registration order; the `require` form fails naming the event and listing what was registered.
- `requireTool<Details>(name)`, `tools` — `Details` re-materializes the result generic pi erases from `ToolDefinition.execute`, so a suite does not cast every call. The `tools` array itself stays heterogeneous, so that generic is asserted once inside `requireTool`.
- There is no `stub.events` field; read `stub.pi.events`. A second handle on the same object is what we removed elsewhere.
- `requireCommand(name)` (returns the recorded options), `commands`, `shortcuts`, `entries`, `sentMessages: Array<{ message; options }>` holding pi's own argument pair, so `display` and `details` survive.
- `handlerView(stub, ...events)` and `invoke(handler, event, ctx)` — see the snapshot rule below.

## Five rules that are easy to get wrong (each already cost a bug)

1. **Unmodelled members read as absent, never as placeholders.** Production branches on presence: `typeof sessionManager.getEntries === "function"` selects the marker-collection path (`runs/persistence/load.ts`), `pi.registerShortcut?.(...)` feature-detects, `ctx.ui.setWidget?.()` skips. A double answering unknown reads with a callable passes every presence check and quietly moves tests onto different code paths — that is what a throwing-Proxy prototype did before it was replaced. A direct call on an unmodelled member still fails, as `x is not a function`.
2. **`handlerView` is a snapshot.** Build it only after every extension that registers for those events has run; a suite that registers afterwards gets a stale list (`session_start[0] is not a function`). Move the registration into the setup helper keeping its order — the `registerScratchpad` option in `test/tools/agent-worker.test.ts` exists for exactly that — or read `stub.handlersFor(...)` inline.
3. **Per-test behavior goes through assignment**, which stays typechecked: `stub.pi.appendEntry = (type, data) => store.push({ type, data })`. For absence, ask for it: `createPiStub({ eventBus: null })` omits the key entirely, which is why the sentinel is `null` and not `undefined` (`undefined` is indistinguishable from "not passed").
4. **`ui` and `sessionManager` stay partial on purpose.** `stubUi`/`stubSessionManager` take `Partial<...>` and cast once, documented; `ExtensionUIContext.custom` is re-declared because it is a *generic method* (`custom<T>(factory, options): Promise<T>`) and no concrete return value is assignable to `T`.
5. **`handlerView` wraps handlers in `async`, so it cannot serve a synchronous assertion.** A suite that asserts a handler returns `undefined` *without awaiting* (`expect(check(event, ctx)).toBeUndefined()`) must call `stub.handlersFor("event")[0]` directly, or the promise it gets back changes what the test observes. Discovered while migrating `agent-scout-bash.test.ts`, whose non-UI cases pin exactly that.

## Narrowing policy: which casts remain acceptable

New tests get no `any` in any spelling. Where a real signature cannot be implemented from test code, cast **to the real type** and state the reason in place: `undefined as never` for the unexported `ToolRenderContext`; `{ bold, ... } as ExtensionUIContext["theme"]` for a partial theme; `as SessionEntry[]` for a hand-built branch entry list; `as unknown as ManagerLike` to reach private state, following `src/`'s `_userMessage` note convention. A cast to `any` is never that fix, because it also erases every other field in scope.

## Known drift to fold back

- `test/tools/e2e/helpers.ts` defines its own `zeroUsage()`; `test/helpers/agent-doubles.ts` exports the same thing. Consolidate on the doubles module.
- `createE2EContext(paths, overrides): any` is the sanctioned e2e context builder (the `testing` memory points at it) but returns `any`; it should build on `stubContext` so its overrides are checked.
- Remaining hand-built `const pi = {` doubles: `e2e/registered-continuation.test.ts` and `agent-child-interaction.test.ts` — 50 `any` sites left in `test/` as of this writing, of which the largest single concentration is `agent-tool.test.ts`'s neighbours in the `tui/` cluster and `agent.test.ts`.
- `LoadedAgentRunPersistence.catalog` is produced (`runs/persistence/load.ts:451`) and **never read** in `src/` or in tests. `partialStateWriter` exists so the fixture stops conflating it with `AgentRunPersistence`, but the field itself is a candidate for removal from the contract — a production change, so confirm intent first.
- `test/tools/agent.test.ts` holds ~50 of the ~83 test-tree type errors while containing only 2 `any` sites: its debt is genuine signature violations (sync-vs-`Promise` returns, missing event fields), not suppression. Run the single-file probe on it before touching it.

Related: `testing` (validation commands and the writing-tests checklist), `agents/architecture` and `agents/safety` (what the child gates do with registered handlers), `complexity-hotspots`.
