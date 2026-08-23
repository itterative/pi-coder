# Agent tool

`pi-coder` provides an in-process, read-only `agent` tool for delegated codebase exploration.

## Actions

```text
agent(action="start", agent="scout", task="Investigate ...")
agent(action="resume", runId="scout-1", guidance="...")
agent(action="cancel", runId="scout-1")
```

A child may call `ask_parent` to pause its current turn. The parent receives its question and partial findings, may investigate independently, and resumes the retained child session by run ID.

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
