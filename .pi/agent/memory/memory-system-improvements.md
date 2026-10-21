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

## Targeted references

Load only the detail needed for the task; these nested documents are on-demand and are not listed in the memory index.

- `meta/memory-system.md` — extension change history, why these categories and fields were chosen, and the deferred improvements.
- `meta/system-prompt-changes.md` — archived validation checklist for the 2026-06-01 prompt-appendix changes; on-demand history, not a live checklist.
