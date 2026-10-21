---
name: pi-stub
description: The createPiStub surface - recorded pi members, tool/thinking surfaces, cross-member order, handler views, and the context doubles in pi-stub.ts.
category: workflow
keep_updated: true
---

# `test/helpers/pi-stub.ts`

The `pi` surface an extension registers into, plus the context doubles built on it. The reuse rule and the
`no-explicit-any` baseline are in `../testing/doubles-and-any.md`.

## `createPiStub({ eventBus?: EventBus | null })`

Records the eight `pi` members production calls (`on`, `registerTool`, `registerCommand`, `registerShortcut`,
`registerProvider`, `appendEntry`, `sendMessage`, `events`) and exposes:

- **`pi`** — typed `ExtensionAPI`, one boundary cast inside the helper rather than one per suite.
- **`toolSurface`** — `{ active: string[]; all: StubToolInfo[] }`, what `pi.getActiveTools()` and
  `pi.getAllTools()` answer from. Assign it before invoking a handler
  (`stub.toolSurface.active = ["bash", "read"]`); order is meaningful, because a handler that rebuilds a provider
  request has to reproduce pi's tool array exactly. `stubToolInfo(name)` builds an entry without pi's unexported
  `SourceInfo`, which nothing reads.
- **`thinkingSurface`** — `{ level: string; unsupported: boolean }`, what `pi.getThinkingLevel()` answers with
  (default `"medium"`). Assign `level` to set the session's thinking level; `unsupported = true` makes the getter
  **throw**, which is how a suite reaches a caller that guards the read — an absent accessor on an older pi build
  arrives as a `TypeError`, so one guard shape covers both.
- **`order`** — **cross-member** registration log: `on:<event>`, `tool:<name>`, `command:<name>`,
  `shortcut:<key>`, `provider:<id>`. Separate recorders cannot express interleaving, and handler registration
  order *is* permission precedence in `child/gates/`.
- **`handlersFor(event)`, `requireHandler(event, index?)`** — handlers in registration order; the `require` form
  fails naming the event and listing what was registered.
- **`requireTool<Details>(name)`, `tools`** — `Details` re-materializes the result generic pi erases from
  `ToolDefinition.execute`, so a suite does not cast every call. The `tools` array itself stays heterogeneous, so
  that generic is asserted once inside `requireTool`.
- **There is no `stub.events` field;** read `stub.pi.events`. A second handle on the same object is what we
  removed elsewhere.
- **`requireCommand(name)`** (returns the recorded options), `commands`, `shortcuts`, `entries`,
  `sentMessages: Array<{ message; options }>` holding pi's own argument pair, so `display` and `details` survive.
- **`providers`** — `pi.registerProvider(id, config)` calls, keyed by id, with the config exactly as registered.
  The decision module's classifier provider is the only caller so far, and a suite asserts the registered model
  shape without reaching into pi.
- **`handlerView(stub, ...events)` and `invoke(handler, event, ctx)`** — see the snapshot rule in
  [`rules.md`](rules.md) (rule 2) and the synchronous-handler caveat (rule 5).

## Context doubles that live in this file

- **`stubCommandContext(overrides?)`** covers the other half: `ExtensionCommandContext` extends
  `ExtensionContext` with seven session actions (`getSystemPromptOptions`, `waitForIdle`, `newSession`, `fork`,
  `navigateTree`, `switchSession`, `reload`) that a command-handler suite never exercises. Each **throws**
  `stubCommandContext does not model X()` — inventing a return value would let a test pass on a fabricated answer,
  and unlike rule 1 these members are required, so absence is not an option. Overrides apply after the base
  context, so a suite that does exercise one supplies it. Invoke a registered slash command as
  `stubCommandContext()` + `stub.requireCommand(name).handler(args, ctx)`, not a hand-built
  `{ hasUI, ui } as any`.
- **`stubModel(overrides?)`** for `ctx.model` — a wide-window non-reasoning stand-in whose `contextWindow`,
  `maxTokens`, `reasoning` and `samplingParams` a suite can move: the first two are what the native-request fit
  gate reads, the other two are what decides whether thinking and sampling parameters reach a request body.
  **`stubModelRegistry(complete)`** for `ctx.modelRegistry`, which answers only `complete` — pi's `ModelRegistry`
  is a class surface with no partial construction path, so that single cast lives in the helper and an unmodelled
  member still fails at the call. Neither had a double at all until the compaction suite needed them.
- **`stubUiWithDialogs(theme)`** → `{ ui, dialogs }` for driving a real dialog component — not a private
  `custom(factory)` driver per suite.
- **`stubSessionContext(parent)` / `SessionBackedContext`** for a context whose session manager must **write**
  entries — not `ctx as any` to reach `appendCustomEntry`.
- **`StubComponentFactory`** and **`StubDialogOptions`** type a dialog factory and its options — not
  `custom(factory: any, options: any)`.
- **`noRenderContext`** stands in for pi's tool-render context (unexported, unused here) — not
  `renderText(tool.renderCall(...) as any, w)`.

Which context to pass where is a separate question: see [`domain-partials.md`](domain-partials.md) for picking by
parameter type, and [`rules.md`](rules.md) for the seven rules about stub behavior.
