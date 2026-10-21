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

- The left cluster is the decision model's state badge (`footer.ts` — accent `» auto` while the decision config enables the model, dim `» manual` while it is off so the `alt+a` toggle's state stays visible, with the `»` marker before the label when idle and the shared spinner frame replacing it while a consult is in flight, driven by the `pi-coder:decision-status` count).

### Agent summary

- The agent summary (`formatAgentSummary` in `agent-activity-format.ts` — waiting runs first, then running, then terminal; one run's label plus detail, with `+N` for extra visible/hidden runs).

### TODO progress

- TODO progress (`formatTodoProgress` in `format.ts`, current item capped in the footer; `summarizeTodoList` adds a final item once the list is complete, the footer mutes the segment with `dim` and hides it entirely while `hasActiveAgentRuns`, and `shrinkToFit` trims it beside the badge rather than dropping it — with a `dim` ellipsis when the segment itself is dim).

### Extension statuses

- `setStatus` extension statuses.

## Right cluster

- The right-aligned cluster is usage totals (`120k tok · $0.133 · CH42.9%`, cost only when nonzero and cache hit only when the session reported cached tokens), context utilization, the model, and the cwd/branch repo — rightmost.
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

- Domain modules publish typed `pi.events` snapshots on `pi-coder:agent-status`, `pi-coder:todo-status`, and `pi-coder:decision-status`, while the status package alone owns footer registration, its `Spinner` instance, the `TipRotator`, and event listeners; `invalidate()` is a no-op because each render rebuilds the line from pushed state.

Related: [`packages.md`](packages.md) for the `Spinner` component the badge drives, [`../agents.md`](../agents.md) + [`../agents/lifecycle.md`](../agents/lifecycle.md) for agent-run states the summary renders, and [`../decision-model.md`](../decision-model.md) for the `alt+a` toggle and the consult the badge reports.
