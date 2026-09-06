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
| invoking a registered slash command | `stubCommandContext()` + `stub.requireCommand(name).handler(args, ctx)` | hand-built `{ hasUI, ui } as any` |
| a domain object where most fields are irrelevant | `test/helpers/agent-doubles.ts` → `partialRun`, `partialDetails`, `partialWorkspace`, `partialWorkspaceResult`, `partialTracker`, `zeroUsage` | partial literal + cast |
| a child-session event to feed `updateTracker` | `test/helpers/session-events.ts` → `messageStartEvent`, `textDeltaEvent`, `thinkingDeltaEvent`, `toolExecutionStartEvent`, `toolExecutionEndEvent` | partial event + `as any` |
| a durable-persistence or state-writer double | `agent-doubles.ts` → `partialPersistence`, `partialStateWriter` | duck-typed object + cast across the two contracts |
| driving a real dialog component | `pi-stub.ts` → `stubUiWithDialogs(theme)` → `{ ui, dialogs }` | private `custom(factory)` driver per suite |
| a context whose session manager must **write** entries | `pi-stub.ts` → `stubSessionContext(parent)` / `SessionBackedContext` | `ctx as any` to reach `appendCustomEntry` |
| a widget's or dialog's terminal environment | `test/helpers.ts` → `stubTui(overrides)` / `FocusAwareTui` | `{ requestRender() {} } as any`, `as unknown as TUI` |
| a dialog factory and its options, typed | `pi-stub.ts` → `StubComponentFactory`, `StubDialogOptions` | `custom(factory: any, options: any)` |
| pi's tool-render context (unexported, unused here) | `pi-stub.ts` → `noRenderContext` | `renderText(tool.renderCall(...) as any, w)` |
| a two-member event bus that records emits | annotate `const events: EventBus = { emit, on }` | `} as any` around a mini bus |
| a child extension wired the way production wires it | `test/tools/child-run-fixture.ts` → `buildChildRun`, `probeDefinition` | hand-built grant or option bag |
| a compaction event, summarized span, or provider summary response | `test/helpers/compaction-doubles.ts` → `compactEvent`, `compactionPreparation`, `userMessage`/`assistantMessage`/`toolResultMessage`/`bashExecutionMessage`/`customMessage`/`compactionSummaryMessage`, `messageChain`, `fileOperations`, `summaryResponse`, `toolCallResponse` | hand-built `AgentMessage` literals, or a `SessionManager` transcript you then have to parse |
| driving a TUI component | `test/helpers.ts` → `KEY`, `mockTheme`, `press`, `type`, `paste`, `interact`, `renderText`, `snapshotText` | inline ANSI sequences, hand-rolled key strings |
| temp dirs, SQLite, git repos for agent lifecycle | `test/tools/e2e/helpers.ts` → `createE2EPaths`, `withE2EMetadataDatabase`, `createScriptedChild`, `insertE2EAgentRun`, `createClaimedTaskWorkspace`, `initializeRepository` | ad-hoc `mkdtemp` plus open-by-hand |
| a TypeScript script driven as a real CLI (argv, exit codes, stdout) | `test/helpers/script-bundle.ts` → `bundleScript(entry)` → `{ bundle, run, dispose }`; bundle once in `beforeAll`, `dispose()` in `afterAll` | spawning `node --import tsx <script>` per test call (~130ms each: node start plus the tsx loader; the bundle drops each spawn to ~30ms) |
| template-string fixtures without indentation | `test/modules/memory/utils.ts` → `dedent` | manual leading-space stripping |

## `createPiStub` surface

`createPiStub({ eventBus?: EventBus | null })` records the seven `pi` members production calls (`on`, `registerTool`, `registerCommand`, `registerShortcut`, `appendEntry`, `sendMessage`, `events`) and exposes:

- `pi` — typed `ExtensionAPI`, one boundary cast inside the helper rather than one per suite.
- `toolSurface` — `{ active: string[]; all: StubToolInfo[] }`, what `pi.getActiveTools()` and `pi.getAllTools()`
  answer from. Assign it before invoking a handler (`stub.toolSurface.active = ["bash", "read"]`); order is
  meaningful, because a handler that rebuilds a provider request has to reproduce pi's tool array exactly.
  `stubToolInfo(name)` builds an entry without pi's unexported `SourceInfo`, which nothing reads.
- `order` — **cross-member** registration log: `on:<event>`, `tool:<name>`, `command:<name>`, `shortcut:<key>`. Separate recorders cannot express interleaving, and handler registration order *is* permission precedence in `child/gates/`.
- `handlersFor(event)`, `requireHandler(event, index?)` — handlers in registration order; the `require` form fails naming the event and listing what was registered.
- `requireTool<Details>(name)`, `tools` — `Details` re-materializes the result generic pi erases from `ToolDefinition.execute`, so a suite does not cast every call. The `tools` array itself stays heterogeneous, so that generic is asserted once inside `requireTool`.
- There is no `stub.events` field; read `stub.pi.events`. A second handle on the same object is what we removed elsewhere.
- `requireCommand(name)` (returns the recorded options), `commands`, `shortcuts`, `entries`, `sentMessages: Array<{ message; options }>` holding pi's own argument pair, so `display` and `details` survive.
- `handlerView(stub, ...events)` and `invoke(handler, event, ctx)` — see the snapshot rule below.

`stubCommandContext(overrides?)` covers the other half: `ExtensionCommandContext` extends `ExtensionContext` with seven session actions (`getSystemPromptOptions`, `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload`) that a command-handler suite never exercises. Each **throws** `stubCommandContext does not model X()` — inventing a return value would let a test pass on a fabricated answer, and unlike rule 1 these members are required, so absence is not an option. Overrides apply after the base context, so a suite that does exercise one supplies it.

## Pick the context double by the parameter type, not by convenience

`stubContext` satisfies `ExtensionContext`; dialog entry points that declare `ExtensionCommandContext` (`confirm` at `src/tui/confirmation.ts:93`, `showAgentSessionBrowser`) need `stubCommandContext`, and the compiler rejects the swap. The branch each one guards also differs: `src/tui/confirmation.ts:95` requires `hasUI && mode === "tui"`, while `src/tui/ask-user.ts:384` and `src/tui/select-with-message.ts:521` read only `ctx.hasUI` and never `ctx.mode`. Copying one file's override set onto the other silently changes which branch runs.

Two more context members had no double at all until the compaction suite needed them: `stubModel(overrides?)` for `ctx.model` (a wide-window non-reasoning stand-in whose `contextWindow` and `maxTokens` a suite can move, which is what the native-request fit gate reads), and `stubModelRegistry(complete)` for `ctx.modelRegistry`, which answers only `complete` — pi's `ModelRegistry` is a class surface with no partial construction path, so that single cast lives in the helper and an unmodelled member still fails at the call.

## Seven rules that are easy to get wrong (each already cost a bug)

1. **Unmodelled members read as absent, never as placeholders.** Production branches on presence: `typeof sessionManager.getEntries === "function"` selects the marker-collection path (`runs/persistence/load.ts`), `pi.registerShortcut?.(...)` feature-detects, `ctx.ui.setWidget?.()` skips. A double answering unknown reads with a callable passes every presence check and quietly moves tests onto different code paths — that is what a throwing-Proxy prototype did before it was replaced. A direct call on an unmodelled member still fails, as `x is not a function`.
2. **`handlerView` is a snapshot.** Build it only after every extension that registers for those events has run; a suite that registers afterwards gets a stale list (`session_start[0] is not a function`). Move the registration into the setup helper keeping its order — the `registerScratchpad` option in `test/tools/agent-worker.test.ts` exists for exactly that — or read `stub.handlersFor(...)` inline.
3. **Per-test behavior goes through assignment**, which stays typechecked: `stub.pi.appendEntry = (type, data) => store.push({ type, data })`. For absence, ask for it: `createPiStub({ eventBus: null })` omits the key entirely, which is why the sentinel is `null` and not `undefined` (`undefined` is indistinguishable from "not passed").
4. **`ui` and `sessionManager` stay partial on purpose.** `stubUi`/`stubSessionManager` take `Partial<...>` and cast once, documented; `ExtensionUIContext.custom` is re-declared because it is a *generic method* (`custom<T>(factory, options): Promise<T>`) and no concrete return value is assignable to `T`.
5. **`handlerView` wraps handlers in `async`, so it cannot serve a synchronous assertion.** A suite that asserts a handler returns `undefined` *without awaiting* (`expect(check(event, ctx)).toBeUndefined()`) must call `stub.handlersFor("event")[0]` directly, or the promise it gets back changes what the test observes. Discovered while migrating `agent-scout-bash.test.ts`, whose non-UI cases pin exactly that.
6. **Narrow with a throwing helper, never cast through a gap.** Reading `details.runId` into a `string` parameter, or `content[0].text` off a `TextContent | ImageContent` union, wants `requireRunId(details)` / `requireWorkspaceResult(details)` / `firstText(content)` — see `test/tools/e2e/registered-continuation.test.ts`. A cast keeps compiling when the producer stops filling the field; a throw turns that into a test failure. This is how `tool: any` had been hiding six unguarded reads.
7. **A context member that production calls unguarded is not decoration.** `runWorkspaceSetup` calls `ctx.ui.notify(...)` directly and `loadAgentRunPersistence` hands `ctx.ui` to the refused-write reporter, so a context double without `ui` crashes instead of feature-detecting — the opposite case from rule 1. Absence is right where the caller writes `?.()` and wrong where it writes `()`; check which one the production path does before omitting a member.

One more blind spot worth knowing: `import type { X } from "..."` erases at runtime, so importing a type from a module that never exported it stays green in Vitest and only surfaces in the single-file probe.

## Narrowing policy: which casts remain acceptable

New tests get no `any` in any spelling. Where a real signature cannot be implemented from test code, cast **to the real type** and state the reason in place: `undefined as never` for the unexported `ToolRenderContext`; `{ bold, ... } as ExtensionUIContext["theme"]` for a partial theme; `as SessionEntry[]` for a hand-built branch entry list; `as unknown as ManagerLike` to reach private state, following `src/`'s `_userMessage` note convention. A cast to `any` is never that fix, because it also erases every other field in scope.

## Known drift to fold back

- `test/tools/e2e/helpers.ts` defines its own `zeroUsage()`; `test/helpers/agent-doubles.ts` exports the same thing. Consolidate on the doubles module.
- `createE2EContext(paths, overrides)` now returns `AgentStartContext` and deliberately carries **no** `ui` (the start context has no such member; the child reaches the parent UI through `parentContext`). `loadE2EPersistence` builds a real `ExtensionContext` via `stubSessionContext`.
- `@typescript-eslint/no-explicit-any` is **zero repo-wide**, and `npm run typecheck:tests` reports zero errors for `src` + `test`. The last hand-built `const pi = { ... } as any` double went with the TUI/dialog cluster, so a new `any` or a test-tree type error is a regression from here, not baseline noise.
- Knip still lists three unused test-side exports that predate the cleanup: `paste` in `test/helpers.ts`, and `assertTemporaryStateDirectory` / `openE2EMetadataDatabase` in `test/tools/e2e/helpers.ts`. Left in place; delete them if you agree nothing external drives them.
- `LoadedAgentRunPersistence.catalog` is produced (`runs/persistence/load.ts:451`) and **never read** in `src/` or in tests. `partialStateWriter` exists so the fixture stops conflating it with `AgentRunPersistence`, but the field itself is a candidate for removal from the contract — a production change, so confirm intent first.
- `test/tools/agent.test.ts` is probe-clean as of this writing; its 50 type errors came from three root causes (a `getSessionLeafId` return that widened past the interface, `save` returning `boolean` instead of `Promise<boolean>`, and lease grantors returning the lease instead of a promise). Typing one `implements` clause cleared ~35 of them.

Related: `testing` (validation commands and the writing-tests checklist), `agents/architecture` and `agents/safety` (what the child gates do with registered handlers), `complexity-hotspots`.
