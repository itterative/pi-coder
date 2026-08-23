---
name: agents-exploration
description: Agent implementation options for pi-coder; no agent runtime is implemented yet.
category: architecture
priority: 4
keep_updated: true
status: Active design
---

`src/tools/agent/index.ts` is empty. The evolving design is recorded in `src/tools/agent/PLAN.md`. A no-provider-call spike validated an in-process `createAgentSession()` using `SessionManager.inMemory()`, the current model, a four-tool read-only allowlist, an appended scout prompt, and a `DefaultResourceLoader` with no discovered extensions.

Decisions: ship a built-in read-only `scout`; allow custom user agents and project agents only in pi-trusted projects; reserve built-in names; sort definitions by path and use first-wins with warnings for same-scope duplicates; let project agents override user agents with an informational shadowing diagnostic; use one sequential parent `agent` tool with explicit `start`/`resume`/`cancel` actions; and implement child-to-parent interaction first as cooperative pause/resume. A child-only `ask_parent` tool records a question and terminates the child turn, the parent receives a short run ID and may investigate, then resumes the same in-memory child with guidance. Keep up to four parent-runtime-local active/waiting runs with no TTL; IDs become stale on reload, fork/session replacement, or restart. Keep the state machine extensible for a later background mailbox using `pi.sendMessage(..., { deliverAs: "steer" })` and `childSession.steer()`. Direct child-to-user UI is deferred.

Implementation constraints: use `noExtensions: true` plus only explicit inline child hooks; confine `read`, `grep`, `find`, and `ls` to cwd; bridge parent abort by listening to its signal and calling `childSession.abort()`; append agent instructions rather than replace pi's base prompt; aggregate exact nested usage and report per-parent-call deltas; bound waiting sessions and clean them on parent session lifecycle. Existing permission state is module-global and should not be reused in children without refactoring. `withFileMutationQueue()` coordinates individual same-file operations across in-process sessions, but not multi-step transactions or subprocesses.
