---
name: complexity-hotspots
description: Conventions for interpreting and reducing complexity in pi-coder.
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
- Use complexity suppressions only when narrowly scoped, documented, and justified by inherently complex domain behavior.
- Review other dimensions alongside scores: nesting depth, function length, mutable state count, number of modes, and testability.
- Track trends rather than only absolute values. A smaller score is not an improvement if readability gets worse.

## Qualitative priorities

When prioritizing refactors, start with delegated-agent lifecycle/state-machine orchestration and sandbox parser/policy phases. Persistence normalization and validation boundaries are secondary; TUI rendering and input handling can usually be addressed incrementally. Preserve conservative security behavior and existing tests when decomposing sandbox logic.

Use `scripts/cognitive_load_report.py` for current measurements rather than storing threshold values or dated score tables in this memory.
