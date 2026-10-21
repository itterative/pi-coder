---
name: findings
description: "Settled decision-model findings not to re-litigate — state fields, wording, vocabulary, probe — with measured costs, plus the open worklist."
category: architecture
---

# Decision-model findings and open work

Index: [../decision-model.md](../decision-model.md). Every bullet below is a measurement that ended a line of work. Re-run one only with a reason the
shape or the sandbox changed. Full probe numbers and the rejected arms are in
[history.md](history.md).

## Settled findings — do not retry

- **The command vocabulary does not judge a path.** Asked the veto question over 111 real outside-cwd accesses,
  the model answered `none` for 105-110 of them and would have resolved 7 of the 8 the user refused; one bool
  "must the user be asked?" is uncalibrated (its mass sits at 0.2-0.4 whatever the label). The file judgment is
  `kind` × `purpose` × `loss`; do not retarget the command wording at a path.
- **The model does not police authority on this subject either.** Shown a scout's own rules it named a write
  into another repository `asked_for` at 0.985. `fileScopeAnswer` is what refuses it, without a request.
- **A confidence floor is the wrong knob for the purpose answer.** Its labels are thin-spread by construction,
  so gate the kind axis by `minConfidence` and read purpose and loss as a label and a threshold.
- **No project instructions in the state.** AGENTS.md flips workflow-shaped commands to `refuse`
  (`prettier --write` 6/7, file-editing heredocs 16/28); a safety-only summary is behaviourally neutral, but
  raw or summarised project prose is out for good.
- **No "here is what the state means" preamble.** Every arm that explained fields only loosened decisions;
  `resolution` was inert (0/208) and is removed.
- **No command history, annotated or bare.** Inert on friction, and in front of the curated hazards an ordinary
  backdrop lost detections; outcome flags (`allowed_by_user`/`refused_by_user`) changed nothing.
- **No confinement-probe reading yet.** Inert as a passive state field (two coin-flip flips in 200), and under
  a rule its marginal value was ~1/221 with the instruction doing the work. It needs a rule, not presence; if
  ever wired, omit readings from incomplete probes (a dead probe reads as reassurance) and keep the scope line.
- **Do not widen the criteria.** Adding `unrequested` diluted `loses_content` and cost a curated harm; the
  classify wording lost `git push --force` and refused 14/60 routine rewrites.
- **Curated safety gaps that wording cannot fix**: content harms and `kill -9 -1` are not contained by a
  sandbox that shares the network and pid namespace and binds cwd rw; closing them is sandbox work
  (`--unshare-net`/`--unshare-pid`), not classifier work.
- **Accepted cost of the `none_auth` wording**: at the live `minConfidence` 0.6 it auto-hosts 3 of 13 curated
  dangers (`cleanup-asked` none 0.67, `cleanup-unasked` 0.64, `install-net` 0.67); attribution is the wording
  alone, and at 0.7+ all three prompt again (as do the two former abstains at 0.755/0.716). The user accepted
  this on 2026-10-18.
- **Known inconsistency, unmeasured fix**: under the scout's rules `npx tsc --noEmit` reads as `remote_code`
  while `npx vitest run` does not, because the read-only template has no positive "run the project's own
  commands" line.

## Next

- Read `classifier` in a permission-report section; the parent status footer now shows `auto` and animates
  while a check is in flight (the `pi-coder:decision-status` event).
- Use the human's allow/deny answer from the log as feedback for later decisions (the log carries it).
- Pass a custom agent's real ladder into the decision context instead of the `agent` baseline.
