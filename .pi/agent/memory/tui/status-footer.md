---
name: status-footer
description: "One compact parent footer line: badge, agent summary, TODO progress, usage totals, pruning order, TipRotator semantics. Load for src/tui/status/ work."
category: architecture
keep_updated: true
---

# Status footer (`src/tui/status/`)

## Registration and rendering

- Shared parent status footer. `footer.ts` registers one custom footer through `ctx.ui.setFooter()` for the whole session (session start/tree re-register it; shutdown restores the built-in footer) and renders exactly one compact line.
- It replaced the old above-editor `setWidget` registration and the itemized multi-line renderers; pi's working spinner stays in the editor border.

## Left cluster

### Decision state badge

- The left cluster is the decision model's state badge (`footer.ts` — accent `» auto` while the decision config enables the model, dim `» manual` while it is off so the `alt+a` toggle's state stays visible, with the `»` marker before the label when idle and the shared spinner frame replacing it while a consult is in flight, driven by the `pi-coder:decision-status` count that `withDecisionCheck` maintains for *every* consult — Bash, file access, and reminder selection alike).
- The judged phase follows as a dim ` · implementing` suffix (` · ${phase}` after the same separator the line uses between segments), shown in both modes: the phase comes from the reminder module's deterministic inference, so it is known while the model is off, and the model moves it on every tool-using response once it is on (`turn_end` checkpoints), so the suffix changes inside a long run rather than only when the user speaks. The turn boundary publishes the held state at once and the deferred judgement republishes when its answer lands, so a slow consult never withholds the badge. `setDecisionLabels` re-renders only when publishing happens; the component is built lazily on the first render, so a state that arrives before that is held on the per-bus `StatusFooterState` and passed to the constructor, exactly like `runs`/`todo`.

### Agent summary

- The agent summary (`formatAgentSummary` in `agent-activity-format.ts` — waiting runs first, then running, then terminal; one run's label plus detail, with `+N` for extra visible/hidden runs).

### TODO progress

- TODO progress (`formatTodoProgress` in `format.ts`, current item capped in the footer; `summarizeTodoList` adds a final item once the list is complete, the footer mutes the segment with `dim` and hides it entirely while `hasActiveAgentRuns`, and `shrinkToFit` trims it beside the badge rather than dropping it — with a `dim` ellipsis when the segment itself is dim).

### Extension statuses

- `setStatus` extension statuses.

## Right cluster

- The right-aligned cluster is usage totals (`120k tok · $0.133 · CH42.9%`, cost only when nonzero and cache hit only when the session reported cached tokens), context utilization, the model, and the cwd/branch repo — rightmost.
- While an assistant response streams, the usage slot carries its live rate instead (`62 tok/s`, dim, same `dropPriority: 2`) and outranks a right-placement tip; the rest of the cluster is untouched, and a tip that loses the slot no longer hides the context figure. `PiCoderFooter.setStreamRate` holds the slot for `STREAM_RATE_TTL_MS` (1 s) after the last update and reverts to the totals on its own timer, so the footer never needs a message-end signal; the tracker restarts on the next `message_start`.
- The number comes from streamed characters, not from provider usage, because a provider's cumulative `usage.output` is usually reported once, in the final chunk: pi already requests `stream_options: { include_usage: true }` whenever `compat.supportsUsageInStreaming !== false` (`pi-ai/dist/api/openai-completions.js`, so the flag is only meaningful as `false`), and the protocol then puts usage in the **final** chunk only — measured against the custom `qwenapi` provider (Qwen MaaS compatible-mode in `~/.pi/agent/models.json`) as 28 chunks with `include_usage: true` and 24 without, exactly one usage-bearing chunk in both cases, always the last. `models.json` therefore cannot buy a live number: `compat.supportsUsageInStreaming: true` restates the default, and `samplingParams` (free-form request fields `Object.assign`-ed in last) cannot make a server emit counts it does not produce. Anthropic-compatible streams do send cumulative output tokens mid-stream, but the estimate is used either way so the basis never mixes.
- `StreamRateTracker` (`stream-rate.ts`) counts every streamed character — `text_delta`, `thinking_delta` **and** `toolcall_delta`, since tool-call arguments are output the provider counts and a long file write streams as them — and divides by `charsPerToken`: `CHARS_PER_TOKEN_INITIAL` (4) until the provider's own numbers move it, crediting the characters it had not accounted for when a report showed growth and folding that measurement in as a token-weighted EMA step (`tokens / (tokens + CALIBRATION_HALF_LIFE_TOKENS)`, so 1000 output tokens move it halfway), clamped to 1.5–12 so one odd response cannot skew it. The ratio lives in memory for the life of the process and `reset()` deliberately keeps it, so a new session starts calibrated rather than from the guess, while the sample window still restarts per response; a 6.4 chars/token stream at a true 100 tok/s reads 160 → 114 → 104 → 100 across the first four responses. `observeOutput` records one sample per update: the characters since the previous sample over that interval, or — only for a stream with no characters at all — the provider's own growth, because attributing a whole response to the update that finally reported it would spike the number; an update that produced nothing records nothing (which is what kept `0.0 tok/s` off the end of a response), and below `STREAM_MIN_TOKENS` (~8) or `MIN_VISIBLE_RATE` (which would print `0.0 tok/s`) the totals simply stay. The shown value is the position-weighted average, newest heaviest, over at most `STREAM_WINDOW_MS` (5 s) of streaming time, so old output falls out on its own.
- Built by `footerInfoSegments` from `footer-info.ts`; totals are cached per session/leaf/entry count by `UsageTotalsCache` (features-detects `getEntryCount` to avoid copying the session each frame).

## Layout and pruning order

- The right cluster reserves its width first, so `layoutFooterLine`'s `FooterLineSegment[]` prunes the left first: extension statuses → TODO → auto → agent, down to one segment which is then truncated; right segments shed only when the right cluster alone cannot fit (model → usage → repo → context last).
- A segment marked `shrinkToFit` is shortened into the leftover width before it is dropped, using the segment's own `ellipsis` so a dimmed trim stays dimmed.

## Tips — `tips.ts`

### Cadence

- `tips.ts` owns `FOOTER_TIPS` and the `TipRotator` (first tip ~20s in on a busy line, then one per ~90s, visible ~10s, shuffle-bag so nothing repeats until all were seen).
- The rotator takes an `isLineIdle` predicate from the footer (`isIdle`: no active run and no TODO progress) and idle lines skip every wait: the first tip arrives without the initial delay, a line that becomes idle while a tip is pending picks one up at once (`setAgents`/`setTodo` call `tips.recheck()`), and a tip whose window ends stays *held* until the next one replaces it, so a new session keeps its one hint instead of blanking the space — idle swaps come every ~30s (`idleIntervalMs`), not the ~90s busy-line gap, since nothing else is competing for the line.
- An idle-line tip yields to content immediately — mid-window too — and a pending idle shortcut goes back to the full first delay if the line fills before it fires; tips shown over a busy line keep the plain show-then-hide window.

### Availability and priority gates

- A tip is a `FooterTip` — `text` plus optional `when` and `preferFirst`: `when` gates it at pick time (an unavailable tip stays queued and shows in its place once its condition holds; a window where nothing is available is skipped) and the footer re-checks it per render, so a tip drops the moment its state stops applying; a `preferFirst` tip jumps the queue at its first available window, once per footer.
- The `alt+a` tip is both — offered only while `decisionConfig.current.enabled !== true` and preferred first, so a manual-mode user is told about the toggle.

### Slot placement

- While a tip shows it takes whichever slot is free — the right cluster's usage/context while an agent is active, otherwise the TODO's left slot — rendered dim with a `tip: ` prefix; a left tip takes all remaining left width (`shrinkToFit` with a dimmed `ellipsis`, so the layout shortens it instead of dropping it), while the right placement is capped at 56 columns so it cannot balloon the reserved cluster.

## Event ownership

- Domain modules publish typed `pi.events` snapshots on `pi-coder:agent-status`, `pi-coder:todo-status`, `pi-coder:decision-status` (the in-flight count), and `pi-coder:decision-state` (the judged labels), while the status package alone owns footer registration, its `Spinner` instance, the `TipRotator`, and event listeners; `invalidate()` is a no-op because each render rebuilds the line from pushed state.
- The live rate additionally subscribes to pi's own `message_start` (restart the estimate) and `message_update` (feed the streamed characters, then the provider's cumulative output, and push the rate) events, which fire for the parent session only — a delegated child's stream never reaches them. There is deliberately no `message_end`/`agent_end` handler: the rate's TTL timer is what reverts the slot.
- The two decision channels differ in who may publish: the count is a process-wide guard shared with delegated children (a child's check animates the parent badge), while the state is parent-only — a child's session must not overwrite the parent's phase.

Related: [`packages.md`](packages.md) for the `Spinner` component the badge drives, [`../agents.md`](../agents.md) + [`../agents/lifecycle.md`](../agents/lifecycle.md) for agent-run states the summary renders, and [`../decision-model.md`](../decision-model.md) for the `alt+a` toggle and the consult the badge reports.
