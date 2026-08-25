---
name: memory-system-improvements
description: Changes made to the pi-memory extension and memory frontmatter structure to improve agent guidance. Read before editing memories or the extension.
category: meta
keep_updated: true
---

# Memory System Improvements

## Overview

This doc tracks the changes made to the consolidated pi-coder memory module and project memory frontmatters. The goal was to eliminate the "every memory says read me first" problem, establish a clear reading hierarchy, and make high-churn memories visually distinct.

## Extension Changes (`src/modules/memory/`)

### Files Modified

- `src/modules/memory/frontmatter.ts` — parses the optional frontmatter fields
- `src/modules/memory/index.ts` — groups, sorts, and annotates the memory list and injects the prompt appendix

### New Frontmatter Fields

| Field | Type | Purpose |
|-------|------|---------|
| `category` | string | Groups memories into sections: `architecture`, `meta`, `workflow`, `convention` |
| `priority` | number | Sorts memories within a category (lower = first) |
| `keep_updated` | boolean | Marks high-churn memories with `[high-churn]` in the list |
| `status` | string | For plans: `Complete`, `In progress`, `Deferred`, etc. |

### Presentation Rules

1. **Indexing**: Only `.md` files directly in each memory directory are indexed and shown. Nested Markdown files may serve as on-demand reference documents linked from an indexed memory.
2. **Grouping**: Memories are grouped by `category` under markdown headers (`#### Architecture`, etc.)
3. **Order**: Categories appear in fixed order: `architecture` → `meta` → `workflow` → `tools` → `convention` → *unknown categories (alphabetical)* → `Other` (uncategorized). Memories with a category not in the fixed list render as their own titled section between the known categories and `Other`, so a new category never causes a memory to disappear.
4. **Sorting**: Within each category, memories sort by `priority` ascending (default 99)
5. **Annotation**: `keep_updated: true` renders as `[high-churn]` next to the memory name
6. **Guideline**: The system prompt includes: *"Memories marked with [high-churn] are high-churn — review and update them after relevant changes"*

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
