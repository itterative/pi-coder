---
name: measurement
description: "Metric blind spots, the accumulates/assembles taxonomy, coverage and timing rules when refactoring, and the report scripts."
category: architecture
keep_updated: true
---

# Measurement blind spots, taxonomy, and the report scripts

Index: [../complexity-hotspots.md](../complexity-hotspots.md) for the general conventions every refactor
decision needs. This doc holds what the per-function scores do not report, the vocabulary the size pass uses,
and the coverage/timing detail that was too tool-specific for the index.

## Blind spots the size pass found

Source-side blind spots that the size pass found and neither metric reports: `prepareIsolatedWorkspace` (253 lines with no nesting at all), `executeParentWorkspaceAction` (self 177) with `executeWorkspaceAction` (159), `runWorkspaceSetup` (143) and `createAgentWorkspaceManually` (125) around it, and the `registerAgentBrowser` registration closure. `createAgentRunStateWriter`, `loadAgentRunPersistence`, `createAgentChild`, `workspaceBlockers` (cognitive 41 in `presentation/outcomes.ts`), `childProtocolPrompt` (self 113, cognitive 37), and the `registerChildExtension` closure (self 171) are resolved; construction-phase work changes no scores at all (a build script has no branches to score), so judge it by self lines and by whether each invariant now has one owner. Re-measure rather than trusting these numbers, and prefer the accumulation cases first: an undecomposed 250-line body has no delegation to read around, while the assembled spans already split their behavior into named steps.

## `accumulates` versus `assembles`

`scripts/cognitive_load_report.py` names them _accumulates_ and _assembles_ in its "Function size and nesting" tree, ranked by self lines (what a reader holds at once) with span and nested counts shown. Treat a large span with a small self and many nested functions as the assembly case, and a large self as the accumulation case. Both sections say so in their output: the numbers are review signals that order what to read, never a requirement list, and the size tree's floor only hides rows — measurement always runs at the lower inventory floor so self counts stay honest. When judging a row, remember that an inner function below the measurement floor is folded into its parent's self, so a suspicious `accumulates` label on a function you know delegates is a threshold artifact rather than a finding.

## Coverage and timing when refactoring

Do not chase full branch coverage: pinning every path, especially wording and unreachable defensive arms, makes the code inflexible and generates churn. Write a test when a structural change could silently break an invariant a caller depends on—ordering, ownership, rollback, resource release—and prefer one characterization test per invariant over one per branch. Use `scripts/coverage_report.py <source> --tests <files...>` to find gaps before starting and re-run it afterwards to confirm the refactor lost no protection.

Any assertion that counts renders, callbacks, or flushes re-dirties on every refactor, so assert states or ordered sets, or wait explicitly. The delegated-agent widget snapshot is a distinct-state trace rather than a render-frame trace for exactly this reason; keep new TUI widget assertions state-based (see `testing/snapshots-and-assertions.md`).

Related: how these scripts fit the repo's quality workflow is the `testing` memory's
`testing/scripts-and-measurement.md`.
