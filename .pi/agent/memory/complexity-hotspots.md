---
name: complexity-hotspots
description: "Conventions for interpreting and reducing complexity in pi-coder; per-file invariants live in nested detail docs."
category: architecture
priority: 3
keep_updated: true
---

# Complexity conventions

Complexity metrics are review signals, not defects. A high score should trigger inspection rather than automatic refactoring.

- Prefer cognitive complexity for readability decisions; use cyclomatic complexity mainly as a signal for testing and path-coverage risk.
- Prioritize severe outliers and changed code before attempting to reduce the historical baseline.
- Refactor by semantic responsibility: separate parsing, validation, state transitions, persistence, and rendering rather than splitting arbitrary blocks to lower a score.
- Do not game the metric with dispatch tables, excessive indirection, or tiny wrappers that make the code harder to follow.
- Prefer guard clauses and explicit phases. Parser methods should have clear recognition guards, one responsibility, and obvious progress/termination behavior.
- Keep cursor and state ownership unambiguous. Cursor movement should have one owner; parser context should be separate from cursor control where practical.
- Preserve domain invariants explicitly. Parser and security code may legitimately need defensive branches or conservative fallbacks; document those reasons.
- Require behavior-preserving tests before refactoring. Run focused tests first and the full suite after structural changes.
- Treat coverage gaps as a diagnostic for choosing what to protect, not a target. Rest, including the coverage script: `complexity-hotspots/measurement.md`.
- Expect refactors to shift microtask-relative timing, because they add async boundaries. Rest, including the widget-snapshot timing rule: `complexity-hotspots/measurement.md`.
- Use complexity suppressions only when narrowly scoped, documented, and justified by inherently complex domain behavior.
- Review other dimensions alongside scores: nesting depth, function length, mutable state count, number of modes, and testability.
- Per-function scores are blind to two shapes: one long undecomposed body, and a long span assembled from many small callbacks where each piece scores alone. Taxonomy, floors, and artifacts: `complexity-hotspots/measurement.md`.
- Track trends rather than only absolute values. A smaller score is not an improvement if readability gets worse.

## Qualitative priorities

When prioritizing refactors, start with delegated-agent lifecycle/state-machine orchestration and sandbox parser/policy phases. Persistence normalization and validation boundaries are secondary; TUI rendering and input handling can usually be addressed incrementally.

Use `scripts/cognitive_load_report.py` for current measurements rather than storing threshold values or dated score tables in this memory.

## Targeted references

Load only the detail needed for the task; these nested documents are on-demand and are not listed in the memory index.

- `complexity-hotspots/agents-runtime.md` — per-file invariants for `src/tools/agent/`: action dispatch, restoration, drive and terminal settlement, leases, stored records, discovery, and the capability-assembly model.
- `complexity-hotspots/sandbox-logic.md` — per-file invariants for `src/modules/sandbox/`: path extraction, heuristic evaluator, permission matcher, segment resolution, and the conservative-security rule.
- `complexity-hotspots/measurement.md` — blind spots the size pass found, the accumulates/assembles taxonomy, the coverage and timing detail, and the report scripts.
