---
name: upstream-gaps
description: "pi and pi-ai limitations compaction has to work around: nested core package, missing copyable entry kinds, hooks complete() bypasses, no typed provider error, unreachable Retry-After, no client-side deadline, and the hidden constrainedSampling field."
category: architecture
keep_updated: true
---

# pi and pi-ai gaps behind compaction

Detail companion to the `compaction` memory. Each row is a limitation upstream, not a defect in
`src/modules/compaction/`. Where an upstream ask is known it is stated as one.

## Types and registration

- `@earendil-works/pi-agent-core` is nested under `pi-coding-agent/node_modules`, so `src/` must not name it:
  `AgentMessage`/`CompactionPreparation` types are derived in `types.ts` from `SessionBeforeCompactEvent`.
- pi's `appendMessage` doc comment references an `appendBranchSummary()` that **does not exist**, so `branch_summary`
  (and `label`/`session_info`) entries cannot be copied into the span transcript. `buildSpanSession` reports them in
  `skippedEntries` rather than faking them; stage 2's transcript still contains branch summaries because it is built
  from `preparation.messagesToSummarize`. `skippedEntries > 0` therefore disqualifies the count tiers (`sizing.md`).
- `ctx.getSystemPrompt()` includes pi-coder's injected `<memory_system>`/`<scratchpad_system>` blocks, because it
  reflects the `before_agent_start` augmentation — but it reads `agent.state.systemPrompt`, which only equals the
  request path's prompt *during* a run. That divergence is why a compaction outside a run sees the 12,817-char base
  prompt; the mechanism is worked out in `prefix-cache.md`.

## Hooks that `complete()` bypasses

- `modelRegistry.complete()` does **not** traverse the agent's `onPayload` path, so `before_provider_request` never
  sees requests we send — that is why the prefix diff needs both hooks.
- `ModelRegistry.complete()` does not traverse `sdk.js`'s stream wrapper, so it inherits none of that layer's
  `timeoutMs`, `maxRetries`, or attribution headers. Consequence worth acting on: **our summarization requests have no
  client-side deadline at all**, so a stalled endpoint can hold a compaction open indefinitely. Not hypothetical:
  observed stage times of 62.2s and 32.2s, and 47s for one reduce that contributed nothing.
- **A provider failure never throws at a `complete()` caller.** pi-ai normalizes it into an `AssistantMessage` with
  `stopReason: "error"` and `errorMessage`; our `catch` only catches programming errors, so classifying the exception
  arm as anything but `unknown` would be theatre. There is no typed provider error either: the HTTP status survives
  only as a string prefix (`"429 ..."`) because both vendored SDKs format `${status} ${msg}`, which pi-ai's own
  patterns (`/429/`, `/502/`) rely on. Not a contract.
- **`Retry-After` is unreachable from an extension.** The error object that carries `headers` is discarded in the
  adapter's catch, and `onResponse` is invoked on the line *after* `retryProviderRequest`, so it never sees a non-2xx
  for `openai-completions` (our llama.cpp route) or `anthropic-messages`. The only way to honour a server-directed
  delay is to pass `maxRetries` and let the transport retry do it blindly — blind in both directions: it resends
  quota-shaped 429s, and its retries never appear in our trace. Upstream ask: surface `status` (or a parsed
  `retryAfterMs`) on the normalized error.
- pi-ai's transport retry (`retryProviderRequest`), its status list, and its quota block-list are all module-local,
  and the package `exports` map has no `./utils/*` subpath. Root-exported and usable:
  `isContextOverflow(message, contextWindow)`, `isRecoverableLength(message, desiredMaxOutput)`,
  `isRetryableAssistantError(message)`, `retryAssistantCall(produce, policy, signal, callbacks)`. Naming the *cause*
  beyond those three is ours, which is why `failure.ts` restates the quota and auth wording and pins it in tests.

## `ToolInfo` hides a field that reaches the wire

The one place our rebuilt prefix is **not** guaranteed by construction. `pi.getAllTools()` returns
`Pick<ToolDefinition, "name"|"description"|"parameters"|"promptGuidelines"> & {sourceInfo}` and pi keeps the full
`ToolDefinition` privately (`getToolDefinition` exists on the runner, not on the extension API). pi-ai's OpenAI
serializer reads `tool.constrainedSampling` to decide `function.strict` (`constrained-sampling.js:50`), so a tool
declaring it would make pi's `tools` array differ in bytes from ours while the extension API cannot see the field at
all.

**Latent today, but the field is on the wire already**: for an OpenAI-compatible endpoint `supportsStrictMode` is true
(only Moonshot/Together/Cloudflare/NVIDIA are excluded), and `convertTools` emits `strict: strict ?? false`, so every
tool in a llama.cpp request carries an explicit `"strict": false`. Our rebuilt tools are
`{ name, description, parameters }` and pi-ai fills in the same `false`, which is why the two bodies match byte for
byte — that equality depends on nobody declaring the field. If one did, pi would send `true` where we send `false`, and
because llama.cpp renders tool definitions into the templated preamble the break would land before any message token:
stage 1 pays full price. Detection is the chain's `toolsHash`: a run would read `divergences: ["tools"]` with
`reference=none`, `prefixUsable` omitted, and `cache-read-zero`. A grammar-flavored tool diverges the shape further
(`type: "custom"` plus a grammar format, and arguments become one required string property), but that path needs
`compat.supportsOpenAIGrammarTools`, which defaults to false.

Upstream ask: add the field to the `ToolInfo` projection, or expose `getToolDefinition`. Side effect worth knowing:
`strict: "require"` against an endpoint without strict mode **throws** inside the adapter, which arrives as
`stopReason: "error"` with an unmatched message, classifies as `unknown`, and cascades to stage 2 — which sends no
tools at all, so it succeeds. The cause policy happens to be the right handler for it.
