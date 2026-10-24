# File-access gates: declared roots and the decision model

The direct file tools — `read`/`grep`/`find`/`ls` and `write`/`edit` — are guarded by
`src/tools/file-permissions.ts`, shared by the parent and by a same-checkout worker. Two layers decide
whether an access needs a human, and they are deliberately separate: the first is a declaration the user
wrote, the second is a model's opinion about one access the declaration did not already settle.

Both layers were built against a measured corpus rather than intuition. The harness, the corpus, and the
full numbers live in `.pi/local/decision-models/` (`extract_file_cases.py`, `probe_file_access.py`,
`analyze_file_access.py`, `probe_file_curated.py`, `file-access-report.md`); this document is the
conclusion, not the experiment.

## Layer 1 — declared roots (`src/modules/sandbox/file-roots.ts`)

A root is a path an access may resolve inside without a prompt. The set is, in order:

1. the cwd and the session scratchpad (the runtime's own, as ever);
2. `files.readRoots` / `files.writeRoots` from the sandbox config — explicit, `~/…` expanded by the
   confinement checks themselves;
3. the `sandbox.mounts` sources, **only** when `files.honorMounts` is true (default false);
4. the running pi package's directory, for reads, unless `files.honorPiPackage: false`.

```json
"files": {
  "readRoots": ["~/Repos"],
  "writeRoots": [],
  "honorMounts": false,
  "honorPiPackage": true
}
```

The three rules that shape it, each earned:

- **A root is not a sensitive-name exemption.** Declared roots go in as `additionalRoots`; only the
  runtime-owned scratchpad is passed as `sensitiveAdditionalRoots`. A `.env`, `.git`, key, or credential
  path under a declared root still reaches the human.
- **Mounts widen reads, never writes, and they are opt-in anyway.** A `readwrite` mount states what a
  _sandboxed command_ may write, and that command arrived through an approval and ran contained. A direct
  tool write is neither, so the mode does not carry over — honouring `~/.pi: readwrite` for writes would
  let an agent edit its own memory and settings files silently, which every gate has always prompted for.
  The reason `honorMounts` defaults to false is the same class of case: `~/.config/gh: readonly` exists so
  `gh` works in a sandbox and holds a token in a file no name filter catches.
- **The pi package is the one derived default**, because this harness's own instructions tell every agent
  to read pi's docs and examples. On the measured corpus that single root covered 51 of the 111 accesses
  that were reaching a prompt, and it costs no tokens and no round trip.

Read-only children get the same read roots through `createChildGateRuntime`'s `readRoots`: below the
`command` rung a child has no prompt to fall back on, so the confinement check _is_ its reach, and a scout
told to read pi's docs was being blocked where the parent read the same file freely. A child's _writable_
surface still comes only from its definition.

## Layer 2 — the file-access subject (`src/modules/decision/file-access.ts`)

For an access no root resolved, the gate may ask the classifier instead of asking you. This is a **subject**,
not another command strategy: the command vocabulary does not transfer. Asked the shipped veto question over
111 real outside-cwd accesses, a classifier answered `none` for 105 to 110 of them and would have resolved 7
of the 8 you refused — "is there any reason not to read this `.md` file?" has no discriminative answer.

One request carries up to three questions, and the rules are asymmetric on purpose:

| question             | what it decides                                                                                            | how its answer is read                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`               | what the file is, from location and name alone: `code`, `data`, `settings`, `personal`, `secret`, `system` | its confidence is the one `minConfidence` gates — it is the calibrated axis (median 0.93 on `code`)                                           |
| `purpose`            | whether the request reaches the file: `asked_for`, `routine`, `tangential`, `unrelated`                    | read as a **label**, never as a number: its probability sits near 0.24 even when correct, and a floor on it collapses the subject to 2 of 102 |
| `loss` (writes only) | probability the write destroys content the request did not ask to lose                                     | withheld at ≥ 0.5 — the measured dangers scored 0.70/0.71, the ordinary writes ≤ 0.20                                                         |

Grant (`host`, which for this subject means _let this one access through_) requires all of: an ordinary kind,
a purpose that reaches the file — `asked_for` for a write, `asked_for` or `routine` for a read — a write that
loses nothing, and the kind confidence at or above `minConfidence`. Anything else is `refuse`, and policy
never applies a `refuse` by itself, so **this subject can prevent a prompt and can never replace one with a
denial.** Measured on the corpus: 72 of 102 approved accesses resolved, 0 of the 8 refused granted, 0 of the
9 hand-labelled private paths leaked.

Four rules hold it in check, and they are the reason the numbers are trustworthy:

- **Only a path whose single unresolved reason is `OUTSIDE_CWD` is ever asked about.** A sensitive name, a
  symlink escape, or a dynamic target is a different kind of "no", decided by the confinement checks, and a
  classifier does not get a vote on those.
- **Authority stays in code.** `fileScopeAnswer` refuses a write whose runner sits below the `mutate` rung
  without sending a request, because the measurement showed the model does not police authority: shown a
  scout's own rules it called a write into another repository ordinary.
- **A grant covers one access.** It never remembers a folder — that is the prompt's "always allow" choice and
  stays a human's standing decision. A session approval outranks the model and is checked first, and the
  answer cache keys on path _and_ request, so an approval earned while the user was asking about notes cannot
  carry into an unrelated turn.
- **Content is never sent.** The judgment is made from the path, the operation, the request, and the runner's
  file-scoped rules; a classifier that read a file to decide whether it was sensitive would leak the thing it
  is gating.

The rules themselves are phrased for paths in `runnerRulesForFileAccess`, because the command phrasing ("DO:
read, create, edit, and delete files in the user's working tree") reads every outside path as unauthorised:
widening the parent's rules to name documentation, installed packages, and the user's own tool settings as
ordinary material moved resolution from 63 to 72 of 102 and cost no additional wrong grant.

## Which surfaces, and where it is configured

`decisionModel.fileSurfaces` names the file gates, separately from `surfaces`, which names the Bash gates.
A config that reads `surfaces: ["parent", "child"]` therefore keeps exactly the meaning it was written with,
and a file surface only consults when the model is `enabled` and the surface is listed. `apply` is still the
single authority toggle for both subjects.

A child consults with its own runner and isolation, the parent's model registry (pi's registry is
process-wide and the parent registered the provider there), and the parent's event bus, so a worker's check
animates the parent's `» auto` badge exactly as its command check does — the same contract as the Bash child
gate, in `src/tools/agent/child/gates/file-access.ts`. The phase the badge also reads is the one exception:
only the parent reminder module publishes that state, so a child's session cannot overwrite the parent's.

## Reading what happened

Every access that reached the model or a human is appended to the same development log as the Bash decisions
(`.state/bash-log.jsonl`) with `gate: "file"`; see `docs/bash-decision-log.md`. `resolvedBy` says which of
the three resolved it — `classifier`, `prompt`, or `unavailable` — and the `classifier` block carries the
criterion, the confidence, and whether it acted. `npm run permission-report` reads Bash records only.

```sh
jq -c 'select(.gate=="file") | {operation, resolvedBy, criterion: .classifier.criterion,
  confidence: .classifier.confidence, path}' .state/bash-log.jsonl
```

## Not done, on purpose

- **A withheld read-only child's block is not lifted.** Below the `command` rung there is no prompt for the
  model to replace, so releasing a block would be a capability change rather than a friction fix; the
  declared-roots layer covers the documented case (pi's own docs) and nothing else widens.
- **Isolated workers keep prompting** for outside-worktree paths: their confinement is the point of the
  worktree, and it is not a prompt.
- **The write-side `purpose` phrasing is the measured one** ("Reading it is an ordinary step…"), which is why
  writes resolve at 2 of 10. Rewriting it for writes is an experiment to run against `file-cases.jsonl`, not
  a string to swap.
