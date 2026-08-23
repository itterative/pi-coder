---
name: agents-exploration
description: Agent implementation options for pi-coder; no agent runtime is implemented yet.
category: architecture
priority: 4
---

`src/tools/agent/index.ts` is empty and its README records the intended direction: subagents should run in-process and need richer interaction. Pi provides `ctx.modelRegistry.complete()` for one-shot same-process calls and the SDK `createAgentSession()` for full tool-using child sessions. The official `examples/extensions/subagent` uses separate `pi --mode json --no-session` processes with markdown agent discovery, streaming, parallel, and chain modes, but this is not yet copied into pi-coder.

Important design constraints: use a controlled ResourceLoader to avoid recursively loading pi-coder; decide how child sessions inherit the bash/file permission hooks and parent UI; use `SessionManager.inMemory()` by default; propagate abort and nested usage; guard project-local agent prompts; and serialize or isolate parallel file mutations because `withFileMutationQueue()` does not coordinate separate sessions/processes. A read-only in-process scout is the safest first prototype.
