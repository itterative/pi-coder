---
name: system-prompt-changes
description: Validation checklist for the system prompt improvements made on 2026-06-01. Read after reloading to verify changes took effect.
category: meta
priority: 1
keep_updated: true
---

# System Prompt Changes — Validation Checklist

## What changed

The `buildPromptAppendix()` function in `src/modules/memory/index.ts` contains clarifications that reduce model confusion about the memory system.

## Items to verify

Read the `<memory_system>` section of your system prompt and confirm each of the following is present:

### Location clarity
- [ ] After the Locations bullets, there is a sentence: "All memory files are stored directly in these directories. The `category` field is frontmatter metadata and does not create subdirectories."

### Name/filename contract
- [ ] Under "How to use", there is a sub-bullet: "The `name` must match the filename without `.md` (e.g. `name: conventions` in `conventions.md`)"

### Description guidance
- [ ] Under "How to use", there is a sub-bullet: "Keep `description` to one line; it appears in the system prompt to help future agents decide whether to load the memory"

### No custom tools
- [ ] Under "How to use", there is a bullet: "Use the standard built-in tools (`read`, `write`, `edit`, `bash`) to work with memories — there are no custom memory tools"

### Proactive reading
- [ ] Under "Guidelines", the first bullet says: "At the start of each task, proactively read any memories whose names or descriptions appear relevant to the user's request"

### Cache staleness
- [ ] Under "Guidelines", there is a bullet: "The memory list below is cached at session start. New or updated memories created during this session will not appear in the list until the next session or a `/reload`"

## If any item is missing

If any item is missing after changing the memory module, reload the extension with `/reload` and start a new session, then re-read this memory.
