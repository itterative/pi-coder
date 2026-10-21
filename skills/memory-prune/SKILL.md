---
name: memory-prune
description: Review and prune stale or outdated pi-memory files. Use when the user asks to clean up memories or when memory files may be obsolete.
---

# Memory Prune

Guide the user through reviewing and cleaning up memory files in the pi-memory system.

## Memory locations

- Project-level: `.pi/agent/memory/*.md` (indexed) plus nested on-demand docs in subdirectories
- User-level: `~/.pi/agent/memory/*.md`

Only files directly in those directories are indexed and shown to every agent. Subdirectory files are
reference docs and are reachable only through an indexed memory's `## Targeted references` list.

## Procedure

1. **Get the structural state first, not by reading files.** Run the `/memory-audit` command (or the
   `memory_audit` tool with `scope` `"project"`, `"user"`, or `"both"`). It reports memories that fail to
   index, oversized index files, over-budget descriptions, nested docs no index lists, dangling references, and
   broken links. Fix or note those before judging content. Errors mean something is broken (a memory that does
   not index, a reference that resolves nowhere); warnings are review indicators - a dense index or a long nested
   description may be exactly what that tree wants.
2. **Inventory with sizes, then read only the top level.** `wc -c .pi/agent/memory/*.md | sort -n` shows what
   you are about to pay. Do not read every file in both trees: a large memory tree can exceed 100k tokens before
   any judgement is made, and nested docs cost the same while offering no routing value. Read the indexed
   memories, then open only the nested docs whose subject looks stale or duplicated.
3. **For each memory**, assess whether it is:
    - **Current** — still accurate and relevant
    - **Stale** — outdated or superseded by newer information
    - **Redundant** — duplicates or overlaps with another memory
4. **Ask the user** which memories to update, merge, or delete. Offer demotion as the fourth option: moving a
   one-time or historical memory into a subdirectory keeps the text and stops occupying a prompt entry.
5. **Execute the user's choices**:
    - **Delete**: `rm <path>` via bash
    - **Update**: use `edit` to revise content and/or frontmatter
    - **Merge**: combine content into one file, update frontmatter, delete the redundant file
    - **Demote**: `git mv <name>.md <group>/<name>.md`, add frontmatter (`name` equal to the filename stem, a
      one-line `description`, lowercase `category`, `status:` naming it an archive), add one `../` to every
      relative link it carries, and list it from the index that now owns it
6. **Re-run `/memory-audit`** and report the before/after finding counts. Confirm the change with a final
   summary of what was updated, merged, demoted, or deleted.

## Guidelines

- Never delete or modify a memory file without explicit user approval.
- When merging, preserve the most descriptive `description` in frontmatter, or combine them.
- Suggest a `description` update if the content no longer matches the existing description.
- A recorded measurement (a byte count, a token figure, a percentage) is a claim. Re-measure before citing it,
  and keep the command that produced it next to the number.
- Quote any frontmatter `description` that contains `: ` — unquoted, the memory fails to parse and disappears
  from every system prompt with nothing but a startup warning. `/memory-audit` reports it; `memory_audit` is the
  same check for an agent.
- For splitting or restructuring the hierarchy rather than removing content, use the `memory-restructure` skill.
