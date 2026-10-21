---
name: memory-system
description: "History and rationale for the pi-coder memory module and frontmatter: what changed, why these categories, and deferred improvements."
category: meta
keep_updated: true
---

# Memory system history and rationale

Index: [../memory-system-improvements.md](../memory-system-improvements.md) holds the frontmatter schema and
the presentation rules. This doc keeps the change history, the design rationale, and the deferred work, so the
indexed memory stays a thin contract.

## Overview

This doc tracks the changes made to the consolidated pi-coder memory module and project memory frontmatters. The goal was to eliminate the "every memory says read me first" problem, establish a clear reading hierarchy, and make high-churn memories visually distinct.

## Extension Changes (`src/modules/memory/`)

### Files Modified

- `src/modules/memory/frontmatter.ts` — parses the optional frontmatter fields
- `src/modules/memory/index.ts` — groups, sorts, and annotates the memory list and injects the prompt appendix

## Memory Frontmatter Updates

### Top-Level Memories

All descriptions were rewritten to remove "read this memory first" noise. Now they describe *what* the memory contains and *when* to read it.

### Subsystem Docs

Added `category: architecture` where applicable, plus `keep_updated: true` on high-churn docs.

### Plans

Added `category: meta` and `status` frontmatter (was previously only in body text). This lets the extension display plan status without reading the full document.

## Design Decisions

### Why these categories?

- **architecture** — The foundation. Read first when exploring or changing how things are structured.
- **meta** — Index/organizational memories. Read after architecture to navigate deeper docs, or to check for existing plans/todos.
- **workflow** — Operational commands. Read when you need to *do* something (lint, test, search).
- **convention** — Rules and constraints. Read when unsure about a specific pattern.

### Why priority instead of a strict "read first/second" ordering?

Priority gives flexibility within categories without creating rigid dependencies. It also sorts uncategorized memories gracefully (default 99 puts them last).

### Why keep_updated instead of a freshness timestamp?

A boolean is simpler to maintain than a date. The `[high-churn]` annotation is a visual reminder to the agent, not a hard rule. The human decides which memories are high-churn.

## Future Improvements

- **Status filtering**: The extension could optionally hide `status: Complete` plans from the memory list to reduce noise. Not implemented — might be confusing if a completed plan is still useful reference.
- **See-also / precedes**: Relationship fields between memories (e.g. `precedes: [doc-management]`) were considered but deferred to avoid over-engineering. The description prose handles this for now.
- **Plan history files**: Sidecar history files do not have frontmatter. They could inherit `category: meta` and `status: Complete` for consistency.

## The two-tier hierarchy, in full

`scanMemories()` reads only `.md` files directly in `.pi/agent/memory/`, so the hierarchy is exactly two tiers:

- **Index** (top level, ≤ 4 KB, description ≤ 150 chars): what the subsystem is, where its code lives, the few
  invariants an agent needs *before* choosing a detail doc, then `## Targeted references` listing every nested
  doc with a one-line pointer. A nested file that no index lists does not exist as far as any agent is concerned.
- **Detail docs** (`<index-stem>/<topic>.md`, one topic per file, `##`/`###` headings so a single rule is
  locatable): everything with reasoning, measured numbers, and per-file invariants. Length is bounded by topic,
  not by prompt cost, since they are never rendered into the system prompt; their descriptions may exceed 150
  characters.
- **Demotion instead of deletion**: a stale or one-time memory moves into a directory as an archive that keeps
  its text and gains a `status:` naming it an archive (`meta/system-prompt-changes.md`,
  `agents/workspace-invariants.md`, `decision-model/history.md`).
- **Link rules**: a nested doc links its index as `../<index>.md`, siblings link by bare filename, and moving a
  file one level deeper requires one more `../` on every relative link to a repo file
  (`../../../docs/x.md` → `../../../../docs/x.md`). Cross-cluster references name the final path; naming an old
  memory is how `docs/bash-decision-log.md` came to point readers at a `heuristics` memory that no longer exists.

## The 2026-10-21 restructure

19 top-level memories / 173 KB → 12 indexed memories / ~40 KB of indexes, with 61 nested docs behind them. Each
cluster was split by an isolated worker against a verified base commit, landed as its own commit, and gated by
the same two checks: every exact backticked span and every number in the sources must appear in the output set
(0 misses in the five clusters the parent measured — 502 spans for sandbox, 494 for testing/test-doubles, 227 for
complexity/meta, 149 for agents/compaction, 135 for TUI; decision-model was gated on targeted symbol and
settled-finding checks plus the child's own line-range verbatim build), and the demoted/merged prose must still
match its source verbatim or differ only by disclosed paraphrase.

Landed layout: `agents.md`+`agents/` (6), `compaction.md`+`compaction/` (9), `complexity-hotspots.md`+its dir (3),
`decision-model.md`+its dir (10), `memory-system-improvements.md`+`meta/` (2), `sandbox.md`+its dir (6),
`test-doubles.md`+its dir (6), `testing.md`+its dir (13), `tui.md`+its dir (6); flat: `extension-layout.md`,
`patch-hygiene.md`, `pi-version.md`. Deleted as top-level entries: `heuristics.md`, `session-rules.md`,
`confinement-probe.md`, `bash-decision-log.md`, `workspace-lifecycle.md`, `tui-components.md`,
`edit-cursor-navigation.md`, `tui-flickering-fix.md`, `system-prompt-changes.md`.

What the gates caught, and what to remember from each:

- **A `description` containing `: ` must be quoted.** Unquoted, `parseFrontmatter` throws, `scanMemories` drops
  the file, and the memory disappears from every system prompt with only a UI warning. A rewritten `agents.md`
  index hit this; only a run of the repo's own `scanMemories()` found it, after a PyYAML-based check passed.
- **`category` must be lowercase.** `patch-hygiene.md` shipped `category: Workflow` for months, which rendered a
  second `#### Workflow` section because unknown categories get their own heading.
- **Indexed descriptions are prompt cost.** They totaled 2,904 characters (~730 tokens) with a single 366-char
  outlier; the worst offenders are why rule 8 exists.
- **Byte counts go up, load-per-question goes down.** Clusters grew 14–45% in words (frontmatter blocks,
  headings, lead-ins, index summaries). That is the intended trade: a fact that used to cost a 21 KB read now
  costs a 1.5–4 KB doc.
