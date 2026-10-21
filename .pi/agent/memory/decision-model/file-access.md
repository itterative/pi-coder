---
name: file-access
description: "File-access subject: the kind/purpose/loss questions, their asymmetric confidence rules, the four invariants, and where the harness and numbers live."
category: architecture
keep_updated: true
---

# Judging a file access

Index: [../decision-model.md](../decision-model.md). The deterministic root layer in front of this subject, and the measured coverage of it, are in
`docs/file-access-gates.md`; the gates that consult are `tools/file-permissions.ts` (see
[wiring-config.md](wiring-config.md)).

## The file-access subject (`file-access.ts`)

The second thing the module judges: one direct `read`/`write`/`edit` that no root resolved. It is a **subject**,
not a command strategy, because the command vocabulary does not transfer (see [findings.md](findings.md)). One request
carries up to three questions, and the rules for reading them are asymmetric on purpose:

- `kind` — what the file is, from its location and name alone (`code`/`data`/`settings` grant;
  `personal`/`secret`/`system` withhold). **Its confidence is the axis `minConfidence` gates**, because it is
  the calibrated one (`code` at 0.93 median).
- `purpose` — whether the request reaches the file. Read as a **label, never as a number**: its probability is
  spread across four criteria and sits near 0.24 even when correct, so a floor on it collapses the subject to 2
  of 102 approved accesses. A write needs `asked_for`; a read also accepts `routine`.
- `loss` — asked only for a write, and it withholds at `P ≥ 0.5` (measured dangers 0.70/0.71, ordinary writes
  ≤ 0.20).

Grant means `host`, which for this subject means *let this one access through*: there is no sandboxed form of a
path, so `appliedFilePermission` accepts `allow` and nothing else, and a `refuse` still never applies by itself.
Four invariants are what makes the numbers trustworthy, and none is negotiable without a measurement:

- Only a path whose **single** unresolved reason is `OUTSIDE_CWD` is ever asked about. Sensitive names, symlink
  escapes, and dynamic targets belong to the confinement checks, which a classifier cannot overwrite.
- **Authority stays in code.** `fileScopeAnswer` refuses a write below the `mutate` rung with no request, and
  it folds like any other form.
- A grant approves **one call**, never the folder, and a session folder approval is checked first: a person's
  standing decision outranks a model opinion about the same path.
- **Content is never sent.** The state is `{operation, path, cwd, request, runner_rules}` — no transcript, no
  working-tree status, no command. `request` is load-bearing (dropping it turned 0 wrong grants into 7 of 8),
  which is also why `fileAccessCacheKey` carries it while the command key does not.

The premises are phrased for paths by `runnerRulesForFileAccess`, because the command phrasing ("read, create,
edit, and delete files in the user's working tree") reads every outside path as unauthorised. Surfaces are
configured apart (`fileSurfaces`), and the log records `strategy: "file-access"` because naming a command
strategy on a path verdict would misreport which question was asked. The design, the measured coverage of the
deterministic layer that sits in front of it, and the numbers live in `docs/file-access-gates.md`; the corpus
and harness live in `.pi/local/decision-models/` (`extract_file_cases.py`, `probe_file_access.py`,
`analyze_file_access.py`, `probe_file_curated.py`, `probe_file_access_live.ts`, `file-access-report.md`).
