---
name: complexity-hotspots
description: Cognitive and cyclomatic complexity baseline for prioritizing pi-coder refactors.
category: architecture
priority: 3
keep_updated: true
---

# Complexity hotspots

The ESLint baseline uses cyclomatic complexity max 10 and SonarJS cognitive complexity max 15, both reported as warnings initially.

Highest cognitive-complexity hotspots from the 2026-08-30 baseline:

- `src/modules/sandbox/bash.ts:tokenizeBash` — 250 cognitive / 127 cyclomatic
- `src/modules/sandbox/heuristics/command-access.ts:extractCommandPaths` — 206 / 107
- `src/modules/sandbox/commands/text.ts:isSafeSedInvocation` — 77 cognitive
- `src/tools/agent/runs/manager.ts:AgentRunManager.restore` — 72 / 76
- `src/modules/sandbox/heuristics/evaluator.ts:isCommandConfined` — 68 / 64
- `src/modules/sandbox/permissions.ts:matchArgs` — 67 cognitive
- `src/tools/agent/action-dispatch.ts:executeAgentAction` — 60 / 53
- `src/tools/agent/definitions/discovery.ts:loadScope` — 58 / 34

Prioritize delegated-agent state-machine/orchestration paths first, then sandbox parser and policy phases. Persistence normalization and TUI rendering/input are secondary targets. Preserve conservative security fallbacks when decomposing sandbox logic; avoid broad rewrites.
