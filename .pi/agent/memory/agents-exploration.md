---
name: agents-exploration
description: Implemented in-process read-only agent architecture, lifecycle, discovery, and remaining extension points.
category: architecture
priority: 4
keep_updated: true
status: MVP implemented
---

The agent MVP is implemented under `src/tools/agent/` and registered from `src/index.ts`. `runtime.ts` owns the parent-runtime-local start/resume/cancel state machine; `child.ts` creates controlled in-process SDK sessions; `discovery.ts` loads built-in, user, and trusted-project definitions. Tests are under `test/tools/agent*.test.ts`, including a real no-provider-call SDK construction smoke test. The evolving design and later phases remain in `src/tools/agent/PLAN.md`.

Behavior: ship a built-in read-only `scout`; custom user agents live in `~/.pi/agent/agents`, trusted-project agents in the nearest `.pi/agents`; built-in names are reserved; definitions sort by path and same-scope duplicates are first-wins with warnings; project agents override user agents with an informational diagnostic. One sequential parent `agent` tool exposes `start`/`resume`/`cancel`. A child-only `ask_parent` tool pauses the retained session for cooperative parent guidance. Keep up to four parent-runtime-local active/waiting runs with no TTL; IDs become stale on reload, fork/session replacement, or restart.

Safety/runtime constraints: child resources use `noExtensions: true` plus one explicit inline extension; all custom definitions remain under the `read`, `grep`, `find`, and `ls` ceiling; every path is confined to cwd with sensitive/symlink checks; parent abort calls `childSession.abort()`; agent instructions append to pi's base prompt; exact nested usage is aggregated and emitted as per-parent-call deltas. Model runtime setup preserves child-resolved OAuth, mirrors registered provider/native-provider configuration and resolved base URL/headers, and copies runtime API keys only for non-OAuth providers lacking child auth. Runtime-only unpersisted OAuth cannot be transferred through the public extension context and fails explicitly. Direct child-to-user UI and background mailbox delivery remain deferred.
