---
name: memory-prune
description: Review and prune stale or outdated pi-memory files. Use when the user asks to clean up memories or when memory files may be obsolete.
---

# Memory Prune

Guide the user through reviewing and cleaning up memory files in the pi-memory system.

## Memory Locations

- Project-level: `.pi/agent/memory/*.md`
- User-level: `~/.pi/agent/memory/*.md`

## Procedure

1. **Read all memory files** in both directories using the `read` tool.
2. **Present a summary** to the user — list each memory with its `name`, `description`, and a brief note on the content.
3. **For each memory**, assess whether it is:
    - **Current** — still accurate and relevant
    - **Stale** — outdated or superseded by newer information
    - **Redundant** — duplicates or overlaps with another memory
4. **Ask the user** which memories to update, merge, or delete.
5. **Execute the user's choices**:
    - **Delete**: `rm <path>` via bash
    - **Update**: use `edit` to revise content and/or frontmatter
    - **Merge**: combine content into one file, update frontmatter, delete the redundant file
6. **Confirm changes** with a final summary of what was done.

## Guidelines

- Never delete or modify a memory file without explicit user approval.
- When merging, preserve the most descriptive `description` in frontmatter, or combine them.
- Suggest a `description` update if the content no longer matches the existing description.
