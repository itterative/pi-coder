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
