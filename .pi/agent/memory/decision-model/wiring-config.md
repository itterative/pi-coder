---
name: wiring-config
description: "Decision-model wiring map (which file holds what), config layering and keys, the settings dialog, the alt+a shortcut, and the status footer surface."
category: architecture
keep_updated: true
---

# Decision-model wiring, config, and status surface

Index: [../decision-model.md](../decision-model.md). Load this before touching `src/modules/decision/`, `src/tools/decision-model.ts`,
`src/tools/decision-settings.ts`, or `test/setup.ts`.

## Wiring

All three bash decision points consult the model when `enabled` is true and their surface is in `surfaces`:
the parent hook, the delegated command gate, and the read-only child gate (`safe-bash-decision.ts`) — the last
only for commands whose sole heuristic failure is the curated allowlist
([child-consult.md](child-consult.md)). The reminder subject is the one non-gate consumer: `src/modules/reminders`
asks it before an agent turn when `reminders` is true, and falls back to its deterministic schedule on any
unusable answer.

| file | holds |
| ---- | ----- |
| `config.ts` | model config file and its layering |
| `provider.ts` | registering the endpoint with pi as a classifier provider |
| `gate.ts` | context building, the shared evaluator, `decideWithPolicy` plumbing, never-throw contract |
| `session-context.ts` | the session half: `request` + up to 4 recent items |
| `workspace.ts` | `workspaceStatusFor` / `parseGitStatus` (`MAX_WORKSPACE_CHANGES = 10`) |
| `state.ts` | `buildState` for both shapes |
| `evaluator.ts` | one request per form via the configured strategy; verdict carries `strategy` + `criterion`; caches + cooldown |
| `scope.ts` | the deterministic capability × runner-rung gate |
| `script.ts` / `script-classification.ts` | body resolution and the capability verdict |
| `strategies/` | `types.ts`, `veto.ts` (default), `history.ts`, `classification.ts` (criteria + table), `index.ts` |
| `tools/decision-model.ts` | the shared bridge: `APPLIED_PERMISSIONS`, `appliedPermission`, `classifierRecord`, `consultForGate` (consult + map + notify + the `pi-coder:decision-status` check count the footer animates), the suggestion bridge (`suggestRuleForPrompt`, `consultSuggestionForPrompt`), and the runner-facing block sentences (`attributedBashBlockReason`, `readOnlyGateSentence`, `permissionAllowsCall`) |
| `decision/suggestion.ts` | the suggestion subject: the `executes_code` bool, `buildSuggestionState`, `suggestionRoleFrom` (probability ≥ 0.5 → code), and the separate `SuggestionEvaluator` with its own cache/cooldown |
| `decision/reminder.ts` | the reminder subject: `reminderRequest` / `reminderDecisionFrom` over the caller's ids plus `none`, and the separate `ReminderEvaluator` with its own cache/cooldown |
| `tools/bash/index.ts` | parent hook: consult on `ask`, record, prompt unless `apply` resolves it |
| `tools/agent/child/command-permissions.ts` | child hook: consult with the child's own session, runner/isolation, and the parent's registry |
| `tools/agent/child/safe-bash.ts` | read-only assessment; the relaxed (generic-spec) re-check `isRelaxedConfinementSafe` |
| `tools/agent/child/safe-bash-decision.ts` | read-only consult: allowlist-only reasons, `classifyRelaxedConfinement` (`safe`/`readable`), no sandbox, held unjudged bodies, `readOnlyGate` record; returns `SafeBashConsultResult` (`{ allowed, reason? }`) so the guard can name the verdict |
| `decision/file-access.ts` | the file subject: its questions, the grant sets, the rung check in code, and `file-access` as the logged strategy |
| `sandbox/file-roots.ts` | the layer in front of it: which roots make a prompt unnecessary at all (see `docs/file-access-gates.md`) |
| `tools/file-permissions.ts` | both file gates: consult only an `OUTSIDE_CWD`-only access, grant one call and never the folder, log whichever resolved it |

- The endpoint is a System One classifier, which pi already implements; `models.json` cannot express a
  classifier (its entries have no type and a classifier needs a discriminant plus an implementation), which is
  why `src/index.ts` registers the provider.
- The classifier log field is described in `sandbox/decision-log.md` (index: `sandbox.md`); `scripts/decision-report.ts`
  (`npm run decision-report`) reads it back, including the script bodies sent ("FILES SENT").

## Config and settings

- Layering: global `~/.pi/decision-model-config.json` (holds the token), project
  `.pi/decision-model-config.json` (no secret, may be committed), then `SYSTEMONE_*` environment last.
  `DECISION_MODEL_CONFIG_PATH_GLOBAL` / `DECISION_MODEL_CONFIG_PATH` redirect the files; **set-but-blank means
  "no file"** (which is what `test/setup.ts` pins, so a suite can never reach a live endpoint). A blank env
  value otherwise falls through to the config rather than clearing it.
- Config keys: `enabled`, `suggestions` (default true; model-refined session-rule suggestions), `reminders`
  (default false; model-chosen agent reminders, consulted by `src/modules/reminders`), `apply`,
  `baseUrl`, `apiKey`, `provider` (default `systemone`), `model`,
  `contextWindow` (32768), `strategy`, `timeoutMs` (5000), `cooldownMs` (30000), `minConfidence` (0.8),
  `surfaces` (default `["parent"]`), and `fileSurfaces` (default none), which names the read/write gates rather
  than the Bash ones. The old `autoHost`/`autoRefuse`/`applySurfaces` keys are ignored.
- The strategy id comes out of a file, so both the config and `resolveStrategy` use `Object.hasOwn`;
  `toString` would otherwise return a prototype function.
- Settings dialog (Settings tab): writes the **global** file only, merges into the existing document so
  unknown keys survive, writes `0600`, and re-registers the provider after a change so no `/reload` is needed.
  It warns when a project file overrides the global values, and never writes one.
- The hooks read the config per prompt from `ctx.cwd`, so an edited config takes effect without a reload.

## Status surface

The global `alt+a` shortcut (`registerDecisionModelShortcut` in `src/tools/decision-settings.ts`) toggles
`enabled` in the global file, re-syncs the endpoint provider so the change lands without a reload, and uses the
footer's `» auto` / `» manual` badge as the state readout (the footer's first help tip also advertises the
shortcut while the model is off); it warns when a project config file outranks the saved value or when enabling
finds no endpoint configured.

`consultForGate` wraps every consult (all three gates) in a process-wide in-flight count and emits
`pi-coder:decision-status` `{ checking }` on the bus the caller passes — the parent's, which the child gate
receives through its extension options, so a child's check animates the parent footer too. The parent footer
shows `» auto` while the model is enabled, with the spinner frame replacing the marker while the count is
nonzero.
