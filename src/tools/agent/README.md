# Agent tool

`pi-coder` provides an in-process, read-only `agent` tool for delegated codebase exploration.

## Actions

```text
agent(action="start", agent="scout", task="Investigate ...")
agent(action="resume", runId="scout-1", guidance="...")
agent(action="cancel", runId="scout-1")
```

A child may call `ask_parent` to pause its current turn. The parent receives its question and partial findings, may investigate independently, and resumes the retained child session by run ID. A `waiting_for_parent` result is paused rather than finished; a later `agent resume <run-id>` result should reach either another waiting state or `completed`. Collapsed TUI results show the pending question or a final-result preview, while expanded results include full details and usage.

Up to four active or waiting runs are retained. They have no TTL, but are in-memory and parent-runtime-local: reload, session replacement/fork, process exit, or explicit cancellation disposes them.

## Agent definitions

The built-in `scout` requires no configuration. Custom definitions use Markdown with YAML frontmatter:

```markdown
---
name: reviewer
description: Inspect architecture and identify risks
tools: [read, grep, find, ls]
model: provider/model-id
---

Agent-specific instructions go here.
```

Locations:

- user: `~/.pi/agent/agents/*.md`
- project: nearest `.pi/agents/*.md`, only when pi trusts the project

Definitions are sorted by path. Within one scope, the first valid duplicate wins and later files warn. Trusted-project definitions override user definitions with an informational diagnostic. Built-in names such as `scout` are reserved.

Custom definitions cannot raise the read-only capability ceiling. Unsupported tools are removed with a warning; every enabled `read`, `grep`, `find`, and `ls` path is confined to the working directory and sensitive paths remain blocked.

## Manual stabilization checklist

Run these checks after changing child sessions, providers, lifecycle handling, or rendering:

1. Start `scout` with OpenAI Codex OAuth and, separately, one API-key provider.
2. Have the child call `ask_parent`; verify the compact result shows its question and run ID, then resume it to completion.
3. Exercise two consecutive `ask_parent` cycles and verify prior usage is not counted again in each resume result.
4. Cancel a waiting run, then verify its run ID is stale. Start another run and verify IDs are not reused.
5. Reload while a child is waiting and while one is running; verify cleanup and stale IDs without an orphaned request.
6. Fill all four run slots and verify a fifth start is rejected until a waiting run is resumed or canceled.
7. Verify a user agent loads, a trusted-project agent overrides it, and an untrusted project definition does not load.
8. Ask the scout to access an absolute outside path, `..` escape, sensitive file, and in-cwd symlink to an outside target; all must be blocked without prompting.
9. Produce long findings and expand/collapse the result; verify the compact preview stays useful and expanded activity/usage remain readable.

Provider calls stay manual so automated tests do not require credentials or incur usage.
