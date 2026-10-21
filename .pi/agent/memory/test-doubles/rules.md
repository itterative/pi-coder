---
name: rules
description: Seven double-design rules that each cost a bug, plus the narrowing policy on which casts remain acceptable in test code.
category: workflow
keep_updated: true
---

# Seven rules that are easy to get wrong (each already cost a bug)

1. **Unmodelled members read as absent, never as placeholders.** Production branches on presence:
   `typeof sessionManager.getEntries === "function"` selects the marker-collection path
   (`runs/persistence/load.ts`), `pi.registerShortcut?.(...)` feature-detects, `ctx.ui.setWidget?.()` skips. A
   double answering unknown reads with a callable passes every presence check and quietly moves tests onto
   different code paths — that is what a throwing-Proxy prototype did before it was replaced. A direct call on an
   unmodelled member still fails, as `x is not a function`.
2. **`handlerView` is a snapshot.** Build it only after every extension that registers for those events has run; a
   suite that registers afterwards gets a stale list (`session_start[0] is not a function`). Move the registration
   into the setup helper keeping its order — the `registerScratchpad` option in `test/tools/agent-worker.test.ts`
   exists for exactly that — or read `stub.handlersFor(...)` inline.
3. **Per-test behavior goes through assignment**, which stays typechecked:
   `stub.pi.appendEntry = (type, data) => store.push({ type, data })`. For absence, ask for it:
   `createPiStub({ eventBus: null })` omits the key entirely, which is why the sentinel is `null` and not
   `undefined` (`undefined` is indistinguishable from "not passed").
4. **`ui` and `sessionManager` stay partial on purpose.** `stubUi`/`stubSessionManager` take `Partial<...>` and cast
   once, documented; `ExtensionUIContext.custom` is re-declared because it is a *generic method*
   (`custom<T>(factory, options): Promise<T>`) and no concrete return value is assignable to `T`.
5. **`handlerView` wraps handlers in `async`, so it cannot serve a synchronous assertion.** A suite that asserts a
   handler returns `undefined` *without awaiting* (`expect(check(event, ctx)).toBeUndefined()`) must call
   `stub.handlersFor("event")[0]` directly, or the promise it gets back changes what the test observes. Discovered
   while migrating `agent-scout-bash.test.ts`, whose non-UI cases pin exactly that.
6. **Narrow with a throwing helper, never cast through a gap.** Reading `details.runId` into a `string` parameter,
   or `content[0].text` off a `TextContent | ImageContent` union, wants `requireRunId(details)` /
   `requireWorkspaceResult(details)` / `firstText(content)` — see `test/tools/e2e/registered-continuation.test.ts`.
   A cast keeps compiling when the producer stops filling the field; a throw turns that into a test failure. This
   is how `tool: any` had been hiding six unguarded reads.
7. **A context member that production calls unguarded is not decoration.** `runWorkspaceSetup` calls
   `ctx.ui.notify(...)` directly and `loadAgentRunPersistence` hands `ctx.ui` to the refused-write reporter, so a
   context double without `ui` crashes instead of feature-detecting — the opposite case from rule 1. Absence is
   right where the caller writes `?.()` and wrong where it writes `()`; check which one the production path does
   before omitting a member.

## Narrowing policy: which casts remain acceptable

**New tests get no `any` in any spelling.** Where a real signature cannot be implemented from test code, cast
**to the real type** and state the reason in place:

- `undefined as never` for the unexported `ToolRenderContext` (the helper already exports `noRenderContext` for
  it).
- `{ bold, ... } as ExtensionUIContext["theme"]` for a partial theme.
- `as SessionEntry[]` for a hand-built branch entry list.
- `as unknown as ManagerLike` to reach private state, following `src/`'s `_userMessage` note convention.
- A two-member event bus that records emits: annotate `const events: EventBus = { emit, on }` rather than
  `} as any` around a mini bus.

**A cast to `any` is never that fix,** because it also erases every other field in scope.

**One more blind spot worth knowing:** the `import type` runtime-erasure hole — see
`../testing/typecheck-and-format.md`.
