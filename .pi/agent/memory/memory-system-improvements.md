---
name: memory-system-improvements
description: "Frontmatter schema and presentation rules for the indexed memory list in pi-coder. Read before editing memories or the extension."
category: meta
priority: 2
keep_updated: true
---

# Memory System Improvements

The list of memories every agent sees is generated from the frontmatter of the files in `.pi/agent/memory/`.
This index holds the schema and the presentation rules to obey when writing or moving a memory; the change
history, the reasoning behind the fields, and the deferred ideas live in [meta/memory-system.md](meta/memory-system.md).

## Frontmatter fields

| Field | Type | Purpose |
|-------|------|---------|
| `category` | string | Groups memories into sections: `architecture`, `meta`, `workflow`, `convention` |
| `priority` | number | Sorts memories within a category (lower = first) |
| `keep_updated` | boolean | Marks high-churn memories with `[high-churn]` in the list |
| `status` | string | For plans: `Complete`, `In progress`, `Deferred`, etc. |

## Presentation rules

1. **Indexing**: Only `.md` files directly in each memory directory are indexed and shown. Nested Markdown files may serve as on-demand reference documents linked from an indexed memory.
2. **Grouping**: Memories are grouped by `category` under markdown headers (`#### Architecture`, etc.)
3. **Order**: Categories appear in fixed order: `architecture` → `meta` → `workflow` → `tools` → `convention` → *unknown categories (alphabetical)* → `Other` (uncategorized). Memories with a category not in the fixed list render as their own titled section between the known categories and `Other`, so a new category never causes a memory to disappear.
4. **Sorting**: Within each category, memories sort by `priority` ascending (default 99)
5. **Annotation**: `keep_updated: true` renders as `[high-churn]` next to the memory name
6. **Guideline**: The system prompt includes: *"Memories marked with [high-churn] are high-churn — review and update them after relevant changes"*
7. **Quoting**: quote any `description` that contains `: `. An unquoted colon makes the frontmatter invalid YAML, `parseFrontmatter` throws, `scanMemories` silently drops the file, and the memory vanishes from the index without failing anything (`agents.md` hit exactly this on 2026-10-21)
8. **Length**: keep an *indexed* description to one line, ≤ 150 characters — every indexed description is rendered into every system prompt. Nested detail docs are never rendered, so a longer nested description is allowed and needs no trimming

## Two-tier layout

One top-level index per subsystem (≤ 4 KB), with detail docs in a directory of the same name reachable only
through the index's `## Targeted references` list. An index keeps what the subsystem is, where its code lives,
the few invariants needed *before* choosing a detail doc, and that list; everything longer belongs in a nested
doc. Stale or one-time memories are **demoted into a directory as on-demand archives, never deleted**. Moving a
doc one level deeper means adding `../` to its relative links, and cross-cluster pointers must name the final
path, never an old memory name. The full convention, the 2026-10-21 restructure that produced this layout, and
the verification gates that caught the bugs above are in [meta/memory-system.md](meta/memory-system.md).

## Targeted references

Load only the detail needed for the task; these nested documents are on-demand and are not listed in the memory index.

- `meta/memory-system.md` — extension change history, why these categories and fields were chosen, the deferred improvements, and the two-tier hierarchy in full.
- `meta/system-prompt-changes.md` — archived validation checklist for the 2026-06-01 prompt-appendix changes; on-demand history, not a live checklist.
