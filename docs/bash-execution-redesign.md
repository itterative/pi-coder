# Bash execution redesign: runtime roots, a bash tool wrapper, and a decision model

**Status:** draft for review. Nothing here is implemented yet.

This document started as a plan for two changes: a persistent sandbox (one long-lived `bwrap` process)
and a decision model for unresolved commands. Investigation changed the first half. The revised plan
has three parts:

1. **Runtime-roots policy (layer 1)** — one place that decides every host path the sandbox and the
   read-confined tools may touch, so scratchpad, truncated-output temp files, memory, and agent read
   roots stop being assembled per call site.
2. **Bash tool wrapper (layer 2)** — a real `bash` tool that owns execution, so the permission gate
   stops rewriting `event.input.command` into a `bwrap` string and the child no longer needs a ledger of
   temp paths.
3. **Decision model (layer 3)** — an optional classifier that labels commands the rule/heuristic
   pipeline leaves unresolved, built on pi's native classifier API (`ctx.modelRegistry.classify()`).

The persistent sandbox is not rejected outright; it is recorded under
[Considered and deferred](#considered-and-deferred-persistent-sandbox) as a backend that could sit
behind layer 2 later.

## Why the direction changed

The original motivation was "stop spawning `bwrap` per command." Measurement said that is not worth it:

| What                                              | Median   |
| ------------------------------------------------- | -------- |
| `bash -c true` (the host shell pi already spawns) | ~2.0 ms  |
| Full-profile `bwrap ... bash -c true`             | ~16.8 ms |
| Minimal `bwrap` (a handful of mounts)             | ~7.0 ms  |
| `node -e ''` (nvm node)                           | ~20.1 ms |

Full-profile `bwrap` costs ~15 ms over the host shell, and a Node forwarder process is slightly
_slower_ than `bwrap`, so only in-process routing would remove the cost. Against model latency, 15 ms is
invisible. Filesystem state already persists across commands because `bwrap` bind-mounts the real
directories; only process/shell state does not, which is niche and arguably a leak hazard.

What actually hurt was different, and both symptoms are the same root cause:

- **Scratchpad** is assembled per call site (`getScratchpadPath(ctx.sessionManager)` in the parent,
  `scratchpadRoots(ctx)` in the child), passed down as `additionalRoots`, and mounted. Wrong assembly
  means a command silently cannot write its scratch file.
- **pi's truncated-output files** are written by the _host_ bash tool to `os.tmpdir()`. They are visible
  to sandboxed commands only because `bubblewrap.ts` blanket-binds `/tmp`. The child read policy then has
  to track those paths individually (see [the ledger](#the-truncated-output-ledger)), because they live
  outside every declared root.

The fix is not a daemon. It is one owner for the sandbox's and the tools' visible host paths.

## Findings that shape the design

### Current flow

```
tool_call hook (parent: src/tools/bash/index.ts; child: .../child/command-permissions.ts)
  → resolvePermissionDetails() → permission
  → if ask: prompt (selectWithMessage) → permission
  → if sandboxed: event.input.command = sandbox(bwrap, command, options)   // a bwrap command string
  → pi built-in bash tool spawns that string on the host
```

`src/modules/sandbox/bubblewrap.ts` builds the string: `bwrap` + bind mounts + env + `-- sh -c '<cmd>'`.
The mutation of `event.input.command` is invisible in the session transcript: pi's agent loop calls
`validateToolArguments()`, which `structuredClone`s the arguments before handing them to the `tool_call`
hook, so the renderer still sees the model's original command.

### pi extension surface

- `createBashTool(cwd, { operations, commandPrefix, shellPath, spawnHook, exposeSessionEnvironment })`
  and `BashOperations.exec(command, cwd, { onData, signal, timeout, env })`.
- Extensions may override built-in tools (`bash`) by registering a tool with the same name. Built-in
  renderers are inherited per slot; prompt metadata is not, and must be redefined.
- `createBashTool`'s `execute` applies `commandPrefix` and `spawnHook` **before** `operations.exec`
  (`resolveSpawnContext()` in the built-in implementation).
- The bash tool result carries `details: { truncation?, fullOutputPath? }`. `tool_call` and
  `tool_result` both carry `toolCallId`, and the tool's `execute(toolCallId, …)` receives it, which is
  what makes [id correlation](#b2-decision-correlation-by-toolcallid) possible.
- `pi.getAllTools()` returns metadata only (no `execute`), so the built-in tool cannot be captured and
  delegated to.
- `ExtensionContext` does not expose pi's settings manager, so an override cannot read
  `shellCommandPrefix`/`shellPath` (the current user config sets neither).

### The truncated-output ledger

`src/tools/agent/child/gates/bash-output.ts` is 141 lines that:

- remember each `details.fullOutputPath` reported by a child's own Bash results,
- re-`lstat`/`realpath` it on every read and compare device + inode,
- prune stale entries,
- reconstruct the set from the transcript on resume,

all so a child can read its own truncated output without being granted general `/tmp` access. The
inode/device checks are defensive, but the existence of the ledger is the smell: the file lives outside
every declared root, so the read policy cannot say "this root is readable" and must enumerate files.

### `os.tmpdir()` is a lever

Verified on this Node: `os.tmpdir()` re-reads `process.env.TMPDIR` at call time.

```
before:            /tmp
after setting env: /tmp/pi-coder-runtime-test
```

pi's `output-accumulator.js` and `bash-executor.js` call `tmpdir()` at the moment they create the file.
So pointing `TMPDIR` at a directory the extension owns makes every truncated-output file land in a
declared root.

pi's other `tmpdir()` users all use it at creation and do not re-derive the path later: clipboard image
import, external editor, the `session.html` export, and `bash-executor`. That makes a process-wide
`TMPDIR` redirect low risk, though it is still a process-wide change.

### Native classifier support (pi 1.3.0)

pi already implements the classifier transport; extensions do not need their own HTTP client:

- `ctx.modelRegistry.classify(model, { state, questions }, options?)` returns
  `{ answers, usage?, stopReason, errorMessage? }` and **never rejects** — inspect `stopReason`.
- Models are discovered with `getModelOfType("classifier", provider, id)` / `findOfType` /
  `getModelsOfType` / `getAvailableOfType`. Sources include `typesafe`, `openrouter`,
  `cloudflare-workers-ai`, `vercel-ai-gateway`, `opencode`, `openai` (`gpt-6-luna`), and llama.cpp
  decision models served through `/v1/systemone`.
- Question kinds are `choice` (`criteria` label→meaning; answer carries `probabilities` and
  `confidence`), `bool` (answer carries `probability`), and `score` (answer carries `score` and
  `confidence`). These cover the script's `choice`/`noul`/`score` shapes one-for-one; `noul` becomes
  `bool`.
- pi owns provider authentication, transport, retries, and usage/cost accounting (`result.usage`).

The project's pinned `@earendil-works/pi-*` dev dependencies (0.84.1) predate this API, so bumping them
is a prerequisite for layer 3, not a nicety. The extension already runs under a global pi 1.3.0, so the
runtime is known to work; the bump is what puts the classifier types and `ctx.modelRegistry.classify()`
in front of the compiler and tests.

### Probe: a persistent sandbox is feasible but not worth it

`.pi/local/probe-persistent-sandbox.ts` proved a long-lived `bwrap` can host a Node server whose unix
socket (created in a `/tmp` bind) is reachable from the host: `HOST got: pong:ping`. Node is available
inside only because the user's global config mounts `~/.nvm` read-only. It works; the cost is a server,
a protocol, profile keying, lifecycle, a Node-in-sandbox dependency, and a fallback path. Recorded under
[Considered and deferred](#considered-and-deferred-persistent-sandbox).

### Long-lived processes need a persistent sandbox, not just a network namespace

Measured 2026-10-17 against the current profile (`--die-with-parent` only, no `--unshare-*`):

| profile         | background process survives the call      | port reachable in a later call   |
| --------------- | ----------------------------------------- | -------------------------------- |
| current         | **yes** — reparented orphan, never reaped | **yes** (HTTP 200 from the host) |
| `--unshare-all` | no — dies with the call's namespaces      | n/a                              |

`nohup sleep & disown` inside a call is still alive after `bwrap` exits, and a `python3 -m http.server`
started inside a call answers on the host in the _next_ tool call. Under `--unshare-all` neither happens: the
pid namespace reaps the process when `bwrap` (PID 1) exits, and a `--unshare-net` namespace would strand a
survivor even if one remained.

So **loopback-only networking cannot support "start a server, talk to it next call"** under one `bwrap` per
tool call: isolating pid _or_ net per call breaks every long-lived process. The capability exists today as a
side effect of isolating nothing — the server shares the host network namespace, binds a host port, and
outlives the call with no cleanup, which is also a stray-process and port-exposure hazard worth naming on its
own. Supporting the workflow _under isolation_ is the deferred persistent sandbox above, with the same
reasons to defer it.

Cheapest middle ground if network isolation is wanted first: default to an isolated namespace and let a
command opt into the host's — the permission dialog already has a per-command toggle and a session-remember
rule. The server then binds host ports exactly as it does today, which is the thing being opted into rather
than a regression.

---

## Part A — Runtime-roots policy (layer 1)

### A.1 Goal

One module computes the complete set of host paths a request may touch, and both consumers derive from
it:

```
                    +----------------------+
  request context → |  computeRuntimeRoots | → rw roots, ro roots, runtime temp dir
  (session/agent)   +----------------------+
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     sandbox mount builder            read-confinement policy
     (bubblewrap.ts)                  (file-permissions.ts, child gates)
```

If the two consumers disagree, that is the bug class this layer removes. Today they are assembled
separately in the parent and child gates.

### A.2 The roots

| Root                  | Mode          | Notes                                                    |
| --------------------- | ------------- | -------------------------------------------------------- |
| cwd / worktree        | rw            | the session cwd; a child's isolated worktree replaces it |
| scratchpad            | rw            | per session; children use their own                      |
| runtime temp dir      | rw            | holds pi's truncated output and the session's temp files |
| user memory           | ro            | parent only, as today                                    |
| agent read roots      | ro            | child only, from the agent definition                    |
| sandbox config mounts | as configured | unchanged                                                |

`computeRuntimeRoots` is the single call site; `bubblewrap.ts` becomes a pure "profile to argv"
function and the read hook stops building its own root list.

### A.3 Runtime temp dir

- Choose a stable directory for the pi process (stable per session so a resume reuses it). Candidates:
  reuse the scratchpad, or a dedicated `.state/runtime/<sessionId>` with its own cleanup.
- Set `process.env.TMPDIR` to it once, early (extension factory / `session_start`), before the first
  Bash call can truncate output. Verified to affect `os.tmpdir()`.
- Also set `TMPDIR` in the sandbox environment, so host and sandbox agree.
- Declare it a runtime root: mount it rw in every profile and allow reads under it for
  `read`/`grep`/`find`/`ls`.

### A.4 Ledger removal

With the runtime temp dir declared as a root, `BashOutputLedger` is deleted, along with its plumbing in
`runtime.ts` and `file-access.ts` (`rememberFromSession`, `active()`, the per-path validation). The
runtime dir is a root; individual files need no tracked exception.

This also fixes the parent side: today `/tmp/pi-bash-*.log` is outside the parent's read confinement, so
reading its own truncated output is inconsistent with the sandbox, which can already read `/tmp`.

### A.5 Config

```json
"sandbox": {
  "runtimeDir": null,
  "runtimeCleanupMs": 86400000
}
```

`runtimeDir` defaults to a per-session directory under extension state. `tryLoad()`/`mergeConfigs()` in
`src/common/config.ts` must learn the keys explicitly or they are silently dropped.

### A.6 Risks and alternatives

- **Process-wide `TMPDIR`.** Enumerated users above; all create-then-use. Accepted.
- **Alternative if that is unwanted:** do not redirect; instead declare `os.tmpdir()` itself as a read
  root. Simpler, but grants read access to all of the host `/tmp` (sandboxed Bash already has it) and
  does not isolate the sandbox from other temp files.
- **Stable-vs-fresh runtime dir.** Fresh per session is cleaner but invalidates paths in a resumed
  transcript; stable per session keeps resume working and lets a cleanup policy age files out.

### A.7 Testing

- Unit tests for `computeRuntimeRoots` over parent, child, isolated-worktree, and additional-read-root
  inputs, asserting the rw/ro split.
- A test that a truncated Bash result's path resolves under the runtime root and is readable by a child
  `read`, and that an unrelated temp path is still rejected.
- Removal tests: the ledger's old cases become runtime-root cases; the transcript-resume case asserts a
  resumed child can still read a previously spilled path.
- A subagent profile test asserting a child profile is exactly parent roots minus memory plus the
  child's read roots, with the same runtime dir.

---

## Part B — Bash tool wrapper (layer 2)

### B.1 Goal

A registered `bash` tool that owns execution, so that:

- the permission gate stops rewriting `event.input.command` into a `bwrap` string,
- the sandbox profile and the execution backend meet in one place,
- the full-output temp location is under the runtime root by construction.

The permission/prompt/audit/decision-log flow stays in `tool_call` / `tool_result`; only execution
moves.

### B.2 Decision correlation by `toolCallId`

pi already hands the same id to both sides:

```
tool_call  (gate)      event.toolCallId = "call_abc"
                         resolve permission, prompt if needed
                         decisions.set("call_abc", { sandboxed, roots, cwd })
                              │
bash tool  execute(id)  id = "call_abc"
                         const decision = decisions.take(id)
                         run through the matching backend
```

- No input mutation, no sentinel string.
- Parallel-safe: ids are unique, so concurrent calls cannot cross.
- A missing entry (a Bash call that bypassed the gate) falls back to local execution.
- Entries are removed on execute; blocked calls must be cleaned up on the block path.

### B.3 Shape

Register a tool whose `execute` reads the decision and delegates to a `createBashTool` constructed with
operations bound to that decision:

```
pi.registerTool({
  name: "bash",
  ...createBashTool(cwd, { operations: localOps }).definition-ish fields,
  execute(toolCallId, params, signal, onUpdate, ctx) {
    const decision = decisions.take(toolCallId);
    const tool = createBashTool(ctx.cwd, {
      operations: decision.sandboxed ? sandboxOperations(decision) : createLocalBashOperations(),
    });
    return tool.execute(toolCallId, params, signal, onUpdate, ctx);
  },
});
```

Because `createBashTool` is reused per call with the operations bound per decision, the built-in
`execute` still owns truncation, streaming, timeout, and abort formatting. Renderers are inherited when
omitted; `promptSnippet`/`promptGuidelines` must be redeclared.

### B.4 Execution backend

`sandboxOperations(decision)` spawns `bwrap` with an **argv array** built from the profile — no shell
string and no escaping:

```
spawn(bwrap, [...profileArgs, "--", shell, "-c", command], { cwd, env, detached })
```

and streams stdout/stderr into `onData`, honoring `signal` and `timeout`, killing the process tree on
cancel. This is strictly cleaner than today's `escapeArg` string construction.

The same seam is where a pooled/persistent backend would live later; the layer-2 interface does not
change if that happens.

### B.5 Parity surface

The built-in `execute` behavior that must not regress (pinned by tests to add):

- streaming `onUpdate` with the ~100 ms throttle,
- truncation at 2000 lines / 50 KB with the `[Showing lines …]` footer,
- abort, timeout, and non-zero-exit error formatting,
- `BashToolDetails` `{ truncation?, fullOutputPath? }`,
- process-tree kill and detached-child tracking,
- `commandPrefix`/`shellPath`/`spawnHook`/`exposeSessionEnvironment` and the `PI_*` variables.

The last item is the known gap: the extension cannot read pi's settings manager, so an override that
declares its own tool loses `shellCommandPrefix`/`shellPath` unless it resolves them from settings
itself. The current user config sets neither. Document the gap and resolve from settings if it matters.

### B.6 Children

Child sessions are created with `tools: grant.sessionTools` (names) and their own cwd, and the child
extension installs its own `tool_call` gates. Two things to verify:

- the wrapper is registered where child sessions bind, so children get it too;
- the child gate and the child wrapper share the decision map (same module instance), or the child
  registers its own wrapper through the same helper.

If module instances are not shared across parent and child extension loads, the child must register its
own wrapper; the helper and map should be constructed per extension instance either way.

### B.7 Testing

- Parity suite driving the wrapper against the built-in tool over a command corpus: output, exit code,
  truncation footer, timeout, abort, streaming chunks (snapshot the frames), `PI_*` env.
- Decision correlation: sandboxed decision runs through `bwrap`; direct decision runs locally; no
  decision runs locally; a blocked call leaves no map entry.
- argv correctness for the sandbox profile (mount order, rw/ro, dedup) without string escaping.
- A child-session case asserting the wrapper is present and captures the child cwd.

---

## Part C — Decision model

> **Status.** The prose and numbers below are the record of how the design got here, including arms that
> were later reversed. Where this section disagrees with `.pi/agent/memory/decision-model.md`, the memory is
> the current one: the batch size, the default state shape, and the veto criteria list have all been
> re-measured since.

### C.1 Where it fits

Rules and heuristics run first and unchanged. If they leave the command `ask`, the model is consulted
**before** the human prompt:

```
resolvePermissionDetails → allow / allow:sandbox / deny / ask
                              │
                             ask
                              ▼
              decision model enabled for this surface?
                   │ yes                         │ no / abstain / error
                   ▼                             ▼
            classify → host|sandbox|refuse      human prompt (today's flow)
                   │ confident
                   ▼
              apply permission, log, optionally notify
```

The model never runs for commands already decided, never overrides an explicit `deny`, and never
overrides a heuristic grant. The call itself is `ctx.modelRegistry.classify(...)` — see
[C.2](#c2-classifier-contract-pi-130).

### C.2 Classifier contract (pi 1.3.0)

`classify(model, { state, questions }, options?)` is the whole transport. We supply `state` and
`questions`; pi resolves the provider, authenticates, calls the llama.cpp `/v1/systemone` endpoint (for
decision models) or the provider's classifier endpoint, and returns typed answers.

| Our question kind | pi type  | Answer                                                  |
| ----------------- | -------- | ------------------------------------------------------- |
| `choice`          | `choice` | `{ type: "choice", choice, probabilities, confidence }` |
| `noul`            | `bool`   | `{ type: "bool", probability }`                         |
| `score`           | `score`  | `{ type: "score", score, confidence }`                  |

`stopReason` is `"stop" | "error" | "aborted"` and `errorMessage` carries the reason. `usage`
carries input/output/total tokens and cost when the service reports them, and pi already counts
classifier usage toward the session cost.

`.pi/local/test_systemone.py` remains the question/state authoring reference — it prototyped the same
`choice`/`noul`/`score` shapes against the HTTP endpoint directly — but its HTTP transport is no longer
the implementation.

### C.3 Module layout

```
src/modules/decision/
  types.ts            DecisionContext, actions, reasons, config, verdict
  config.ts           the model's own config file: global → project → environment
  provider.ts         register the configured endpoint as a classifier provider
  runner-rules.ts     the generic per-runner authority lines that go into the state
  state.ts            build the `state` object from a decision context
  script.ts           resolve the scripts a command runs, chasing nested package lines and the files they invoke
  session-context.ts  the request and the recent turns, from the session branch
  questions.ts        the question sets, the answer readers, and the veto instruction
  policy.ts           thresholds + authority gates → host|sandbox|refuse|abstain
  model.ts            resolve the configured ClassifierModel from `ctx.modelRegistry`
  evaluator.ts        one request per command, cooldown, and usage accounting
  gate.ts             the gate's bridge: context, shared evaluator, never throws
  strategies/         one named design per file: state + questions + criterion → action
    classification.ts  the criteria, the instruction, the action table, the answer reader
    veto.ts            the measured default
    history.ts         the default plus the session's own earlier commands
  index.ts            facade
```

`DecisionEvaluator` runs the configured strategy: **one** request whose answer is a criterion that the action
table maps to an action. `decisionModel.strategy` selects it and defaults to the measured `veto`; the request
each strategy sends is pinned as indented JSON in
`test/modules/decision/__snapshots__/decision-strategy.<id>.<fixture>.json`, so a payload can be read and
compared against the probe arms that measured it. The action-question design (a three-way `action`, then a
gated veto for a low-confidence `host`) stays in `questions.ts` and `policy.ts` with its tests, but nothing
drives it any more: it could only escalate to `sandbox`, and `sandbox` contains 5 of the 13 curated harms.

Both gates consult the model when their surface is enabled: the parent hook (`src/tools/bash/index.ts`) and
the delegated command gate (`src/tools/agent/child/command-permissions.ts`). The shared bridge is
`src/tools/decision-model.ts`, which maps a verdict to a permission, builds the decision-log `classifier`
record, and notifies when a verdict replaces a prompt. `decisionModel.apply` is the single toggle: with it
off the verdict is recorded and the human is still asked, with it on the verdict decides — except a `refuse`,
which never resolves anything by itself.

The editing surface is the `/agents` Settings tab: `src/tools/decision-settings.ts` projects the effective
config into an `AgentSetting` row, and `src/tui/decision/settings.ts` opens the dialog (Enabled, Apply, a
classifier picker from `ctx.modelRegistry.getAvailableOfType("classifier")`, and endpoint/API-key/model rows
for the custom endpoint). It saves to the global file only — the credential must never land in a repository —
and re-registers the `systemone` provider in place, so a change applies without a reload.

### C.3b Why strategies

The rounds of measurement moved three levers independently, so they are one object in the code:

- the **state** — which facts reach the model (`buildState`, plus `command_history` for `history`),
- the **questions** — the wording and the criteria (`classification.ts`),
- the **table** — criterion → action, which is where policy lives rather than in the model.

`buildRequest` returns the state and the questions of a single request together, because a wording and the
state it accompanies drifting apart is exactly what an arm cannot survive; `actionFrom` is the only place a
criterion turns into authority. Thresholds stay outside, in `policy.ts`: `host` needs confidence whatever the
wording, and a `refuse` never applies by itself because a wrong refusal blocks work a prompt would have
surfaced.

| strategy  | state                           | measured on the curated oracle    | corpus friction         |
| --------- | ------------------------------- | --------------------------------- | ----------------------- |
| `veto`    | production `request_context`    | 10/13 harms prevented             | 11 denials of 185       |
| `history` | the same plus `command_history` | 9/13 with this session's backdrop | 0 verdict changes of 80 |

`veto` is the default: the veto wording asks the criteria directly (`out_of_scope` is the seventh), which is
worth more than any threshold — the two-request design could only escalate to `sandbox`, and `sandbox`
contains 5 of the 13 curated harms, so it plateaued at 9/13. `history` differs in one thing only, which is
what makes a difference between them attributable to the state.

### C.4 Context and questions

The `state` is built from:

- the proposed command (exact text),
- the working directory,
- the runner's generic authority rules (the same facts for every project),
- the runner's uncommitted changes from `git status` (clipped to ten entries; absent when the tree is clean or
  git is unavailable),
- the capabilities of the bodies it runs, from the script classification (the code itself is not re-sent),
- the user's request and the items immediately before the command (the current turn included, the request
  kept out of the window), in the `request_context` shape,
- `command_history`, only for the `history` strategy.

Two subjects, two requests, one authority. A resolved body is classified as a **property of its code**: the
request carries the body alone under a `code` key and the answer cache keys on its content hash, so the same
bytes share one capability profile across commands, runners, and sessions. The command is then classified as
an **invocation**: its state carries the command, the directory, the runner's rules, the request and recent
turns, and each body's capability as a `script_capabilities` summary — not the code — so scope (may this
runner run code that writes files or uses the network) is judged where it belongs, beside the rules that
decide it. The `workspace_status` field is the same kind of command fact as `cwd`: a command that rewrites or
discards files is read against the files already modified in the tree.

The capabilities are the script vocabulary — `read_only`, `writes_files`, `writes_outside`, `privileged`,
`network`, `remote_code`, `destructive`, `process_control` — and `src/modules/decision/script-classification.ts`
owns the instruction, the criteria, and the capability-to-action table. The table maps a capability to the
most that can be done with it before the runner is considered: `privileged` and `writes_outside` are contained
by the sandbox (an unprivileged user namespace, no writable paths outside the checkout) and map to `sandbox`;
`destructive`, `remote_code`, and `process_control` are not contained (the checkout is bound read-write, the
host network and pid namespace are shared) and map to `refuse`; `read_only`, `writes_files`, and `network` map
to `host`, because the runner's rules — which the command classification sees — are what allow or forbid them.
`foldAnswers` in `policy.ts` rebuilds the one answer the command needs: a `refuse` answer on any form sends
the command to the human, a `sandbox` answer withholds host execution, and `host` is granted only when every
form answered safely. Capabilities can withhold but never grant, so a `host` fold is gated by the **command
answer's** confidence — one unsure capability no longer drags a confident command behind the floor.
`scopeAnswer` in `scope.ts` is the deterministic third opinion: it maps each capability to the least authority
rung it needs (`read_only` = inspect, `writes_files` = command, everything else = mutate) and turns a
capability the runner's own rung does not cover into an `out_of_scope` refusal — no request, confidence 0, so a
named danger outranks the label when both refuse. That is what keeps a reviewer from running `writes_outside`
code when the command classification alone came back lenient. The rung normally follows the runner name; a
caller that knows the child's declared rung (a read-only child's `inspect`) passes it alongside the runner, so
a custom definition is scope-checked at its real rung even though its name maps to the `agent` baseline. A body with
no answer (error, timeout, size
rejection, an unrecognized capability) abstains the whole verdict before the command is even asked: an unread
script is one the command would run unchecked. Bodies are sent **whole** — no clipping — so a body is judged
as the file it is; a body must instead be a small text file (≤ 64 KiB, no NUL byte, valid UTF-8), and a
compiled binary or an oversized file is never read into a body at all (`kind: "binary"`, logged with nothing
sent). That is deliberate: an ELF decoded as UTF-8 is not code a classifier can judge, and the timeout it
would earn also pauses the model for later prompts. Recognition (`src/modules/decision/script.ts`, reusing
the sandbox's own `parseBashAst` and `unwrapWrapperCommand`, and the same `timeout` unwrapping the permission
pipeline uses) covers the `npm run`-family package scripts, interpreter file runs, and any command that is
itself a literal path to a readable file (`./scripts/deploy.sh`); `inline` forms (`-c`/`-e`/`--eval`, a
heredoc feeding an interpreter) carry the literal code as a body too — a capability is a property of the
code, not the invocation — while a dynamically assembled operand (`-c "$(cat file)"`) and `binary` forms
(`npx`-family, `uv run`/`uvx`) add nothing, because the bytes are not known here or not in the repository.
The decision log still records both kinds, so a body that was unavailable is visible.

The resolver does not stop at the first line. A package script line is itself shell text, so the chase parses
it with the same machinery and follows every package-script invocation it finds (`npm run`, `run-script`, the
`npm test`/`start` aliases, pnpm/yarn/bun `run`), resolving each against the same `package.json`, and reads
the local file each line invokes. A visited set on the script name terminates a cycle and a depth cap of five
bounds a pathological chain; either stop records an **omission** — visible in the state as a bracketed marker
after the bodies (`[script not resolved: cycle at package.json#a]`) and in the decision log as a
`reason:source` entry — so an incomplete resolution never reads as a complete one. Neither stop ever clips a
body that was resolved. Imports or requires inside a resolved file are out of scope: a file is a body to
judge, not another shell to parse.

Two process-lifetime, in-memory, bounded caches sit under it. The **read cache** keys on absolute path,
mtime, and size, so a file whose mtime or size changed is read again; it is shared by the package.json files
and every invoked file. The **answer cache** keeps only successful answers and is really two keys: a **script
answer** keyed on provider, model, and the body's content hash — so a rename, a touch, or a different command
is the same verdict, and editing any byte is a new one — and a **command answer** keyed on strategy, provider,
model, command, runner, isolation, and the capability summaries of the bodies it runs, so the request it
settles is the request it was asked. A hit skips that request entirely (its answer is marked `cached`, and it
adds zero tokens) and flows through the same fold and policy as a fresh verdict, which is why `apply` and
`minConfidence` were never part of either key. Cached answers are keyed on the command and the scripts, not on
the current request or recent turns: a cached answer ignores conversational context, a recorded trade-off
because those fields measured nearly inert while the bodies are the fact the verdict is about. Failures are
never cached as verdicts. A deterministic size rejection (the endpoint's "input too large" failure) is
remembered against the same key plus the request size, so the doomed form is not retried on every consult
until its content (or the command's summaries) changes. Both the failure and the memo abstain — a failed,
timed-out, or too-large form reaches the human prompt and never approves.

**Measured, not assumed** (`.pi/local/probe_shapes.py` against 3986 real commands plus curated
adversarial cases). The state shape is `command_cwd` — the command and its directory, **no conversation**:

- Sending the user request or recent history made the model _worse_, not better: `curl … | bash` went
  from `refuse` to `sandbox` once the request "asked for it". Context is a way to rationalize.
- The server's prefill batch is **512 tokens**, independent of `n_ctx` (32k). Median command+context is
  already ~320 tokens and long heredoc commands do not fit at all, so the state must be clipped
  (command ≤ 400 chars, request ≤ 240, 2 recent items ≤ 120 each).
- Default question set: `single` (one 3-way choice). `decomposed` is safer but ~2.6× tokens and ~5×
  slower; `risk` never emits `refuse` and is unusable as a gate.

### C.4b Second-opinion veto

The 3-way `host` answer is the one direction that gains authority, and it is the model's weakest: it
answered `host` for `rm -rf` (destructive 0.82), `sudo systemctl` (privileged 0.95), and
`git push --force`. The veto signal is **more reliable than the action**, so it is used as a guardrail
rather than an annotation:

```
R1 action == "host" && confidence < 0.6
        → R2 veto: "any strong reason NOT to run on the host?"
             destructive | privileged | exfiltration | remote_code | off_task   (≥ 0.6)
        → escalate host → sandbox
```

On the curated set this took agreement 11/15 → 13/15 with **zero false-hosts**, firing the second
request on only ~43% of commands (avg ~305 tokens / 133 ms). Two requests score the same as asking both
questions in one request, but the per-request 512-token budget and the ability to gate the second call
make them preferable. A veto request that fails abstains and cools down — an unavailable second opinion
must not let a low-confidence `host` through.

This is implemented in `src/modules/decision/` (`DecisionModelConfig.veto`,
`DecisionVerdict.veto`, two-stage `DecisionEvaluator.evaluate`).

### C.4c Project instructions: do not send them

Adding AGENTS.md to the state changes the verdicts, but the change is the project's _workflow_ rules being
misread as **permission** rules. `npx prettier --write …` — which AGENTS.md forbids mid-task — is
auto-denied by that one line alone (6/7 cases); file-editing `python3 - <<'PY'` heredocs, which AGENTS.md
tells the agent to prefer the `edit` tool over, flip to `refuse` (16/28). A **word-shuffled** AGENTS.md of
the same length reproduces the baseline exactly, so this is semantics, not context length. A **safety-only**
summary (project facts, bwrap, `.state/`, npm `.npmrc`, capability split) is behaviourally neutral.

The classifier is asked "is it safe to run?", not "does this follow the project's conventions?", so project
instructions must not be part of the state. If project facts are ever wanted, curate safety-only lines and
keep every workflow prohibition out.

### C.5 Authority and thresholds

`policy.ts` converts answers to a verdict:

| Model action                     | Default authority                                          |
| -------------------------------- | ---------------------------------------------------------- |
| `refuse`                         | never applies by itself; prompt with the reason recorded   |
| `sandbox`                        | auto-`allow:sandbox` (requires sandboxing available)       |
| `host`                           | applies only at confidence ≥ `minConfidence` (default 0.8) |
| low confidence / error / timeout | abstain → prompt                                           |

A verdict carries the strategy, the criterion, a machine-readable reason, the confidence, and the raw
answers, which is what the decision log records. When a verdict resolves a prompt instead of asking, the hook
notifies through `ctx.ui.notify`, so a silent allow/deny is still visible.

### C.6 Config and secrets

```json
"decisionModel": {
  "enabled": true,
  "suggestions": true,
  "apply": false,
  "baseUrl": "http://host:5001/v1",
  "apiKey": "…",
  "provider": "systemone",
  "model": "vllm-d3-flash",
  "strategy": "veto",
  "contextWindow": 32768,
  "timeoutMs": 2000,
  "cooldownMs": 30000,
  "minConfidence": 0.8,
  "surfaces": ["parent"],
  "fileSurfaces": []
}
```

- The file is its own (`src/modules/decision/config.ts`) rather than a section of
  `bash-sandbox-config.json`: `~/.pi/decision-model-config.json` holds the credential, the nearest
  `.pi/decision-model-config.json` overrides it per field, and the environment has the last word
  (`SYSTEMONE_API_URL`, `SYSTEMONE_API_TOKEN`, `SYSTEMONE_MODEL`, `SYSTEMONE_TIMEOUT` in seconds, plus
  `DECISION_MODEL_CONFIG_PATH` / `_GLOBAL`). Folding it into `src/common/config.ts` later is a copy.
- `baseUrl` + `model` are registered with pi as a classifier provider (`provider.ts`, id `systemone`) that
  reuses pi's own System One implementation, so the wire protocol, credential, cancellation, and usage stay
  pi's: the request is `POST {baseUrl}/systemone`. `models.json` cannot express this — its entries have no
  model type, and a classifier needs a discriminant plus an implementation.
- `enabled` is the master switch; `apply` is the single authority toggle and is off by default. With `apply`
  off the model is consulted and the verdict recorded while every unresolved command still reaches the
  human; with it on the verdict resolves the prompt. `refuse` never applies by itself (a wrong refusal
  blocks work a prompt would have surfaced) and `host` resolves only at confidence ≥ `minConfidence`
  (default 0.8). `suggestions` (default true) is the one advisory use: when the suggestion table offers a
  narrow rule and a wider one for an unrecognized package runner, the model's `executes_code` answer picks
  between them. It grants no authority and is not tied to `surfaces`; `false` keeps the table's own rule.
  The former `autoHost`, `autoRefuse`, and `applySurfaces` keys were removed and are ignored by a file that
  still sets them.
- `provider` + `model` select the classifier through `ctx.modelRegistry` (`systemone` + the endpoint's model
  id for the registered one; a built-in classifier can be named instead). When `model` is omitted, the first
  classifier of the configured provider is used, or the first available one overall when `provider` is also
  omitted.
- `cooldownMs`: `classify` does not reject, but a request with `stopReason !== "stop"` (error, aborted,
  timeout) counts toward a consecutive-failure streak; after two of them the model is put in cooldown so a
  down service does not add latency to every prompt. One failure does not pause anything, and any answered
  request resets the streak (`src/modules/decision/cooldown.ts`).
- `surfaces`: `["parent"]`, `["child"]`, or both. Children cannot prompt in headless runs, so enabling
  the model for children is the highest-value case (it converts "uncovered without a prompt" into a
  decision) and the highest-risk, so it is opt-in. The child gate can only produce `allow`/`allow:sandbox`;
  a `refuse` still reaches whatever prompt path the run has.
- `fileSurfaces`: the same two ids, naming the **file** gates instead of the Bash ones, and empty by
  default. Two lists rather than one because the subjects differ in kind: a command verdict has a sandbox to
  fall back on and a path verdict has none, so a config that enabled the model for commands does not thereby
  claim anything about reads and writes outside the working tree. See `docs/file-access-gates.md`.
- The existing `audit` config section (`provider`/`model`, currently display-only) should be renamed or
  folded into `decisionModel`; `/bash-sandbox-config` grows a section for it.
- The `/agents` Settings tab edits the common fields without touching the file by hand: the `Decision model`
  row opens a dialog with `Enabled` and `Apply verdicts`, a model row that lists `ctx.modelRegistry` classifier
  models plus a `Custom endpoint…` choice, and endpoint/API-key/model rows when the custom endpoint is the
  source. Every change writes the **global** file only (the credential must never land in a repository),
  merging into the existing document so the keys above survive, and re-registers the `systemone` provider
  immediately; a project file still overrides the global values.

### C.7 Decision log

The record gains one optional field, written only when the model was consulted — which is exactly the
unresolved population, so it joins on the command text with `resolution.source === "unresolved"`. It is
optional, so `v` stays `1` and older records stay valid:

```ts
classifier?: {
  strategy: string;                    // `veto`, `history`
  provider?: string;                   // absent when the request never happened (cooldown)
  model?: string;
  criterion?: string;                  // the veto reason / `out_of_scope` the model named
  action?: string;                     // before policy
  confidence?: number;
  outcome: string;                     // what the policy settled on: host|sandbox|refuse|abstain
  status: string;                      // applied | abstained | timeout | error
  reason: string;
  latencyMs: number;
  applied: boolean;                    // the verdict replaced the prompt
  tokens?: { input: number; output: number; total: number };
};
```

`resolution` stays the pre-model outcome; `decision` stays the applied permission. `status: "applied"` with
`applied: false` is the dry run saying the policy would have resolved the prompt, which is the question the
mode decision needs answered. The permission-report script and its fixture gain a section for model decisions
so the mining loop can see what the model handled and where it abstained (not done yet).

### C.8 Widget

Later phase, on top of `src/tui/status/`:

- a status section for the sandbox (active profile, runtime dir, last restart reason) and the decision
  model (enabled, last latency/error, last action),
- an overlay/pager view for recent model decisions, fed from the decision log,
- both published through typed `pi.events` snapshots, consistent with the existing status package.

### C.9 Testing

- `model.ts` / integration: a stub `ctx.modelRegistry` whose `classify()` returns canned answers,
  `stopReason: "error"` results, and aborts, covering success, error, timeout, and cooldown.
- `questions.ts`/`policy.ts`: pure table-driven tests for every answer combination and threshold
  boundary, including "must abstain" cases.
- Integration: unresolved command + confident `sandbox` → no prompt, `allow:sandbox`; confident `refuse`
  → deny; low confidence → prompt; error → prompt.
- Decision-log schema tests and permission-report fixture updated in the same change.

---

## Considered and deferred: persistent sandbox

**Status:** discussion recorded, no decision; nothing here is implemented. The deferral below was
argued on latency grounds; the motivation that reopened the question is different, so those
conclusions do not settle it.

### Why the question reopened

The original reason to consider a long-lived sandbox was avoiding a `bwrap` spawn per command, and the
measurements killed that argument. The current discussion is about two different goals:

- **Coarse confinement replacing per-command gating.** Shift the question from "is this command safe?"
  (a heuristic plus a prompt, correct only up to the commands it models) to "what world did I hand the
  agent, and is everything outside it out of reach?" (a boundary, correct up to its leaks). The gate
  does not disappear; it moves to the boundary crossings — host execution, network, widening the world,
  reading a secret, committing writes. That is fewer, higher-signal decisions, and a better use of the
  Part C decision model than classifying every unresolved command.
- **An installable tool environment.** A bind-mount view can only expose the host's toolchains; a
  mutable container can install what the task needs.

Neither is a latency argument, so "~15 ms is invisible" is not a counter-argument to them.

### The current profile is a path view, not a security boundary

`sandbox()` passes no `--unshare-*` flags (only the probe profile uses `--unshare-all`), so net, pid,
ipc, and uts are shared with the host; it bind-mounts cwd rw, `/tmp` rw, `/usr /bin /lib /lib64 /etc
/sys` ro, home configs ro, and the configured mounts, and the global config mounts `~/.pi` rw and
`/etc` ro. Against that profile, "let it run free inside the box" is _less_ safe than the gate: the
agent can delete the checkout, signal host processes, read `/etc` and `~/.pi`, and reach the network.
Coarse confinement needs a strengthened profile first (decision 13).

### Backend A — persistent `bwrap` plus a unix-socket supervisor

The original idea: keep one `bwrap` process alive and forward commands to it over a unix socket, with
profile-keyed instances that restart when sandbox settings change. A probe in `.pi/local/` proved a
long-lived `bwrap` can host a Node server whose socket the host reaches, and the protocol is
straightforward:

```
[type: u8][length: u32 big-endian][payload]
0x01 REQUEST { cwd, command, timeoutMs? }   0x02 STDOUT   0x03 STDERR
0x04 EXIT    0x05 CANCEL                    0x06 ERROR
```

What it buys beyond per-command `bwrap`: long-lived processes under a pid namespace (`npm run dev &`
surviving across calls), loopback-only networking under isolation, and a stable session profile. What it
costs: a server, a protocol, lifecycle, profile keying, a runtime inside the sandbox (the probe leaned
on Node via the `~/.nvm` mount — fragile as a hard dependency), and a fallback. It cannot install tools.

### Backend B — a rootless container per session (`podman run -d` + `podman exec`)

A long-lived rootless container with `podman exec -w <cwd>` per command replaces the custom protocol:
lifecycle, mounts, networking, per-command isolation, concurrency, signals, exit codes, and streams all
come from the runtime. It also makes the world mutable and installable (base image + session writable
layer + named cache volumes), which is the goal Backend A cannot serve. Costs: a runtime dependency, an
image carrying the toolchain, a second isolation model alongside `bwrap`, and a fallback when absent.

| Concern     | Note                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ownership   | `--userns=keep-id` (or equivalent) so files created on the bind-mounted worktree stay host-owned; SELinux hosts may need `:Z` or `label=disable`     |
| installs    | session writable layer for `apt`/`pip`/`npm -g`; named volumes for npm/pip/uv/cargo caches so the reinstall cost is paid once                        |
| GPU         | `--device /dev/kfd --device /dev/dri` (or `--gpus`) to mirror the `bwrap` profile                                                                    |
| network     | default NAT enables installs and pushes but is the exfiltration hole; alternatives are a proxy/allowlist or `--network=none` with per-command opt-in |
| credentials | pi stays on the host, so model keys stay out; `git push` needs an agent socket or `gh` config — a deliberate, visible hole                           |
| degradation | fall back to today's per-command `bwrap` when the runtime is missing                                                                                 |

### Measured: Shape A on this machine

Measured 2026-10-28 with `.pi/local/probe-podman-sandbox.ts` (rootless `podman` 5.8.7, SELinux
Enforcing, 232 MB `node:22-bookworm-slim`). **Shape A** is the posture where the real checkout is
bind-mounted at its real absolute path: the host `read`/`edit`/`grep` tools and in-container `bash`
see the same bytes, `.git` worktree pointers need no rewrite, and the container buys a mutable
toolchain plus an egress and process boundary — not protection of the checkout.

| What                                                        | Measured                  |
| ----------------------------------------------------------- | ------------------------- |
| `sh -c true` on the host                                    | 2.8 ms                    |
| full-profile `bwrap`, per command, real builder             | 24.8 ms                   |
| `podman exec` + `sh -c true`, one-shot                      | 148 ms                    |
| persistent `podman exec -i`, one frame per command          | 0.6 ms                    |
| container create + start, image local                       | ~135 ms                   |
| image pull (first ever session)                             | 4.5 s                     |
| `apt-get install git` into the writable layer               | 4.6 s                     |
| teardown with `rm -f` (SIGTERM ignored, SIGKILL after 10 s) | 10 s → 240 ms with `-t 0` |

The latency fork is the outcome that shapes everything else. One-shot `exec` costs **+125 ms per
command over `bwrap`**, which turns a per-command backend into a visible regression once a task runs
forty commands. A single long-lived `podman exec -i` shell driven over its stdin costs **0.6 ms** per
command, cheaper than `bwrap`, and needs no unix socket, no in-sandbox runtime, and no protocol beyond
a framing marker. That is Backend A's capability, at a fraction of Backend A's cost, but it adds a
dispatcher: shell state leaks between commands (`cd` persists, and `sh -c` inherits it), so the
dispatcher must restore cwd per command and decide what to do about exported environment; a command
that calls `exit` kills the session, so framing has to survive that; and parallel tool calls need a
small pool of sessions rather than one. Backend B's mutable image layer is what the persistent
session makes usable.

Verified behaviours that the design depends on:

- **`--userns=keep-id` is the user model**, now that provisioning is a build rather than `apt-get` inside
  the session. Every file written inside arrives host-owned (`1241:1241`) either way — rootless podman
  maps container-root onto the user — but keep-id also means no process inside holds privilege over the
  image, and the bind mounts are reached as the same uid the host uses. The cost is that `apt-get` inside
  fails with `EACCES` on `/var/lib/apt/lists`, which is the intended trade: the recipe is the only way to
  install anything. `--user <uid>` is _not_ a substitute: rootless maps it to a subuid, so the checkout
  becomes unwritable and files land as `590xxx`.
- **A mounted `$HOME` comes with it.** Keep-id leaves the image's `/root` unwritable, and the first `npm`
  or `git config --global` write fails without a home it owns, so the session mounts the shared
  `.state/container/home` at the _real_ home path and exports `HOME`, so `~` resolves the same
  inside and outside. The dispatcher layers per-request
  env over the container's own, so that value survives into every command.
- **SELinux needs `label=disable`** (or `:Z`, which relabels the user's checkout). Both were tested;
  `label=disable` is the one that leaves host labels alone.
- **Git works, including a linked worktree at its real path**: `git status`, `git log`, and a
  `.state/probe-wt-*` worktree all worked through the repo-root mount, confirming that no `.git`
  pointer rewrite is needed.
- **The mount set is frozen, and a widened cwd fails loudly**: `exec -w <unmounted dir>` exits 127
  with `chdir ... No such file or directory`, so podman does not silently run in an empty world.
  Widening means recreate: stop + start ≈ 375 ms, plus any install replay.
- **The runtime `TMPDIR` mount works**: pi's truncated-output files land in a host-visible directory,
  which is layer 1's runtime-roots goal, unchanged by the backend.
- **No `--die-with-parent` equivalent, but no watchdog needed either.** Verified 2026-10-28: start the
  container _attached_ with `podman run -i … sh -c 'cat >/dev/null'` and never write its stdin. The
  container's PID 1 blocks on pi's pipe, so pi's death (clean, SIGINT, or SIGKILL) closes the write end,
  PID 1 gets EOF and exits, the pid namespace dies, and the orphaned `podman` client exits too. PID 1
  exiting also reaps every stray process, so a `nohup`'d dev server survives across `exec` calls but not
  past pi — the semantics decision 9 wanted. A bind-mounted FIFO (`sh -c 'exec cat "$FIFO"'` as PID 1) is
  the equivalent if the container must be detached. Set `--sig-proxy=false` so a terminal interrupt is not
  proxied into PID 1. The fd must be process-global rather than owned by a module instance (an extension
  reload would otherwise kill live sessions), and no other child may inherit that write end.
- **Stop without `--rm`, and resume works — verified.** A stopped container keeps its writable layer and
  its frozen mount set, and `podman start -ai` re-attaches a fresh stdin pipe, so the lifetime trick above
  survives the cycle (`Exited` → `Up` → stdin EOF → `Exited`) with `/usr/local/bin` state and `/tmp` both
  intact. That makes the writable layer a persistent cache, not a disposable one, and moves the costs
  elsewhere: crash-consistent state persists (`/tmp` keeps stale sockets and pid files, so mount `--tmpfs
/tmp`; a `SIGKILL` during `apt-get` leaves dpkg's journal, so resume needs a best-effort `dpkg
--configure -a`); profile drift is invisible because image, mounts, and env are frozen, so a label
  carrying a hash of (image digest, mounts, env) must force recreate on mismatch — the same check that
  detects a widened mount set; stopped containers accumulate disk, so prune label- and age-scoped
  (`podman container prune --filter label=pi.session --force`, never a global prune); and `Running` on
  resume is ambiguous (this session alive under another pi, or a leaked write end), so a session-keyed
  name turns it into a checked assertion instead of an attach. Cross-session warmth then needs a
  committed image (`podman commit` on graceful exit, labelled by repo+profile hash) or named volumes for
  `/usr/local` and package caches — not a shared container, which would re-break the per-session `/tmp`,
  pid, and port isolation. The `pi.session=<id>` label plus a startup reap pass remains the backstop for
  creation races, a killed pause process, or host OOM.
- **Network**: default NAT resolves DNS and reaches host services through
  `host.containers.internal`; the container's own `127.0.0.1` is not the host's loopback;
  `--network=none` has no DNS. NAT is therefore the exfiltration path, and the default for a
  container-backed session is a decision, not an inherited default.
- **Rootless podman cannot be started from inside the `bwrap` sandbox.** `newuidmap` fails with
  `write to uid_map failed: Operation not permitted`, and the failed attempt leaves a pause process
  that breaks later host `podman` until `podman system migrate`. The backend must be invoked from the
  extension's own unsandboxed process; a sandboxed bash call that reaches `podman` corrupts the
  user's runtime state and needs repair.

The probe also demonstrated the reaping hazard directly: a crashed probe run left
`pi-probe-*` containers running, found by the label filter, as designed.

### Worktree mounting and the Git reference problem

A Git worktree stores absolute paths in three places. On this machine:

```
.state/workspaces/<slug>/.git              gitdir: <repo>/.git/worktrees/<slug>
<repo>/.git/worktrees/<slug>/gitdir        <repo>/.state/workspaces/<slug>/.git
<repo>/.git/worktrees/<slug>/commondir     ../..   (the main <repo>/.git)
```

The fix is not to rewrite them but to **mount them at the same absolute paths** inside the container,
which is exactly what `buildGitWorktreeMountCmd` already does for per-command `bwrap` (it parses
`gitdir:`, reads `commondir`, and mounts both). Worktrees already live inside the repository at
`.state/workspaces/<slug>`, so this is two bind mounts — `<repo>/.git` rw and the worktree rw, both at
their real paths. Mounting the worktree at `/workspace` instead would require rewriting `.git`,
`gitdir`, and `commondir` (and `git worktree repair` on resume) — fragile, and it breaks host tooling.

Two consequences worth naming:

- `.git` must be read-write for a functional worktree (index, objects, refs, `worktrees/<slug>`). That is
  an authority surface: the sandboxed agent can move refs, edit `.git/config` or `.git/hooks`, and
  rewrite history. Cheap mitigations are read-only `.git/config` and `.git/hooks`, and a reserved ref
  namespace; detached worktree commits still need a durable ref anchored (as `RESULT_REF_PREFIX` does)
  or GC can prune them.
- Same-path mounting also keeps the host `read`/`write`/`edit` tools coherent with in-container `bash`:
  they see the same worktree files, so no file RPC and no overlay is needed for coherence. Only `.git`
  and the worktree directory need mounting; the rest of the repository root can be an empty directory
  inside the container.

### Isolated workers: a shared clone beats a linked worktree

Measured and verified 2026-10-28. A linked worktree forces the whole rw `.git` into the worker's
container, which is the authority surface above. A **shared clone** (`git clone --shared`) removes it:
the clone borrows the parent's objects through `objects/info/alternates` and keeps its own small store,
so the parent's object store is only ever read.

```
$CLONE                       rw   # the worker's own repo; .git/objects is ~4 KB
$REPO/.git/objects           ro   # the alternates target
$REPO/.git/refs              ro   # optional: lets the worker fetch upstream (plus packed-refs, ro)
```

Verified inside such a container: 406 commits readable through the alternates, 4.0 KB of own objects,
commit lands in the clone's store, parent `.git/objects` not writable, parent repo otherwise not
reachable at all, `git fetch origin` works with `refs` mounted read-only (615 commits visible, branch
from `origin/main` succeeds), `git push` fails and creates no ref in the parent, and the transfer still
works across the two stores — `git diff --binary base..workerHead` then `git apply --check --binary` in
the parent.

What this buys over "rw `.git` plus read-only `config` and `hooks`": no path to `.git/config`,
`.git/hooks`, `.git/worktrees/<other>`, `.git/HEAD`, or the parent checkout exists at all. The
config/hooks hardening is a narrowing; this is a removal, and it also ends the cross-worker hazard
(worker A could otherwise rewrite worker B's `gitdir`). Note what it does not buy: the worker can still
move its _own_ refs, which is harmless, and the parent's history is safe because nothing can write it.

Overlaying the worktree instead is possible — rootless overlayfs works here (`podman volume create
--opt type=overlay --opt o=lowerdir=…,upperdir=…,workdir=…`, writes land in the upper dir, lower
untouched) — but it is the wrong tool once `.git` is shared rw: git's index records the overlay's stat
data, so the host (or a later container without the overlay) sees every file as modified, and a
whiteout in the upper dir can disagree with a committed delete in `.git`. Overlay is right for
`probe.ts`, which never applies anything back; a worker's tree is already the disposable copy.

Costs and caveats:

- **The workspace model changes**, not just the mounts: `.state/workspaces/<slug>` becomes a shared
  clone rather than a linked worktree. That touches workspace allocation and recycling, run persistence
  and resume, `buildGitWorktreeMountCmd` (no longer needed for workers), the durable `RESULT_REF_PREFIX`
  anchor (still needed, now in the clone's store), host-side apply (`prepareAgentWorkspaceApplication`'s
  `git add -A` + commit works unchanged), and agent/prompt wording that calls the workspace a worktree
  (prompt snapshots are tested). Two layouts — worktree for the `bwrap` fallback, clone for the container
  backend — would be a maintenance trap; make it one layout for both.
- **Alternates couple the worker to the parent's object store.** Git's own documentation warns that a
  clone sharing objects breaks if the source is deleted or has its objects pruned. In practice the worker
  borrows only history reachable from parent refs, so the exposure is a mid-run rewrite plus
  `gc --prune`, and the failure is loud (`git diff` errors on the missing object) rather than silent.
  `--dissociate`, or fetching the base, copies what is borrowed at the cost of the property that made this
  cheap.
- **Pushes fail with a confusing message** (`Please make sure you have the correct access rights`), which
  invites retries. `git remote set-url --push origin no_push` in the clone turns it into an explicit one.
- `--shared` needs a local path and the alternates path is absolute, which works only because Shape A
  mounts at real paths. Submodule objects are not shared, so a submodule checkout becomes a network
  operation.

### Bringing changes back

Because `.git` is shared, the agent's commits are already in the same object store; transfer is a local
Git operation, not a copy. The existing worker flow is the reference implementation:

1. `prepareAgentWorkspaceApplication()` commits a dirty worktree (`git add -A` + `git commit --no-verify`),
   anchors the detached commits with a durable ref, and records `baseRevision..workerHead`.
2. `applyAgentWorkspaceApplication()` requires a clean parent, generates
   `git diff --binary base..workerHead`, runs `git apply --check --binary`, then `git apply --binary` in
   the parent — leaving the changes uncommitted and creating no parent commit.

Alternatives: merge or cherry-pick from a branch (more Git-native, but abandons the no-parent-commit
contract), or an overlay upper layer plus an explicit commit step (recoverable writes, at the cost of
coherence with the host file tools). A live session adds friction the terminal worker result did not
have: patch-apply is not idempotent, and an apply dirties the parent, so the next sync needs a
checkpoint/rebase model rather than the worker's one-shot disposition.

### Parent vs worker: the decisive question

The worker path is terminal, discrete, leased, and recycled (three worktrees per repository), which fits
background delegation. The parent is the surface the user is watching in real time, and a per-session
worktree changes more than the allocation:

- **Two sources of truth.** The user's editor, LSP, and `git status` show the main checkout while the
  agent edits another tree.
- **Uncommitted changes are invisible.** Isolated work is based on committed `HEAD` only — a much larger
  loss for the interactive agent than for a background worker.
- **Project state resolves unevenly.** `memoryDirectories(cwd)` is `join(cwd, ".pi/agent/memory")` with
  no walk-up, while `findConfigLocations()` (sandbox config) and `nearestProjectAgentsDir()` (agent
  definitions) walk up. With the parent's cwd in a worktree, config and agents still resolve, but memory
  silently points at the worktree's copy — and because `.pi/agent/memory/*.md` is tracked, that copy is
  a stale base-revision snapshot rather than a missing directory, so it fails quietly. Any parent
  worktree needs project-scoped paths resolved from the repository root (or the main memory bound into
  the tree).

Crucially, the container goal does **not** require a worktree: mounting the real checkout read-write at
its real path into the container gives the tooling and the boundary with no transfer problem and a single
source of truth, giving up only destructive-write isolation from the working tree. The posture fork is
therefore: parent proposes changes (per-session worktree plus a sync/review contract) versus parent
collaborates live (real checkout in the container), and that choice, not the mount layout, determines how
much of the workspace machinery is reusable.

If a longer-lived backend is ever built, it belongs behind the layer-2 `operations.exec` seam. Backend
A's protocol above is a starting point; Backend B needs no protocol of its own.

---

## Implemented: the container backend

Selected by `sandbox.backend` in `bash-sandbox-config.json` — `auto` (default), `container`, or `bwrap` — with
`PI_SANDBOX_BACKEND` as an override for tests and CI, and `PI_SANDBOX_IMAGE` / `PI_SANDBOX_SHELL` as the image
escape hatches.

`auto` is the state that makes the environment variable unnecessary: the image tag is content-addressed, so
"the recipe has never been built" is a normal state, and the session offers to build it once
(`Build the image now` / `Keep using bubblewrap`) rather than asking the user to know about `/sandbox build`.
The answer is remembered in the project's config; a dismissed dialog records only the declined recipe tag, so
a later recipe edit asks again. Children, `pi -p`, and CI never prompt — they resolve silently and stay on
`bwrap`, which is why `test/setup.ts` can keep pinning `PI_SANDBOX_BACKEND=bwrap` for the whole suite.

A rebuild changes the tag, so the running container describes a recipe that no longer exists. `/sandbox build`
therefore marks the session stale and replaces its container at the next command boundary instead of asking
for a reload — "reuse" was never an option, since the old container's image _is_ the old recipe.

### The seam is pi's `BashOperations`, not a wrapper script

`exec(command, cwd, { onData: (Buffer) => void, signal, timeout (seconds), env })` returning
`{ exitCode }`. `createBashToolDefinition(cwd, { operations })` builds pi's normal bash tool — timeouts,
truncation, streaming, rendering are pi's, not ours — and `pi.on("user_bash") => { operations }` covers
`!` commands. Registering a tool named `bash` overrides the built-in: extension tools are written into
the registry _after_ the built-ins, which is how pi's own Gondolin example reroutes `ls`/`find`/`grep`.

This is why no host-side client shim exists. A session cannot be reached by rewriting the command string,
so the alternative was a per-command client connecting to a socket, which costs a process start
(~28 ms for Node) and lands right back at the `bwrap` latency the persistent session was meant to beat.
With the operations seam the command goes straight from pi's bash tool into the session's stdin, so the
measured 0.6 ms round trip survives.

That also means permissions and execution are finally separate concerns: the existing `tool_call` hook
still resolves and records the permission, but when the container backend is active it no longer rewrites
the command with `sandbox(bwrap, …)`. `allow:sandbox` also stops requiring the `bwrap` binary, because
the container executes every command regardless of the permission's verdict.

**Child runtimes get the same backend.** The rule is the one the parent already follows: the verdict decides
permission, the backend decides location. A child therefore loads the backend as a hidden `pi-coder-container`
extension (`childExtensionEntries` in `src/tools/agent/child/index.ts`), which resolves the same config and
registers the container-backed `bash`, `user_bash`, and file tools through `registerContainerBackend` when the
image is ready. It receives `prompt: undefined` — a build dialog in the middle of a delegated run would be
attributed to whoever is watching — so a child without a built image simply stays on `bwrap`. A command the gates
allowed directly — a model `host` action, a remembered rule — then runs in a container instead of on the literal
host, which is what makes a child's file tools and commands describe the same place.

The differences between the two runtimes are presentation, not policy: a child registers with
`{ notify: false, eagerStart: false }`, so it announces nothing into the parent's transcript and pays no
container start for a run that never executes a command. The run reaps its container through the handle's
`dispose`, and `close()` makes a late command fail rather than start a container nothing will collect.

Because the switch is process-wide, the child gate cannot read it: it asks `options.containerBash()`, a
per-run predicate the container extension sets when it installs. With that predicate the gate skips the `bwrap`
probe, skips the wrapper, and hides the sandbox/direct toggle; without it (switch off, or an image that failed to
resolve) it behaves exactly as before. `test/tools/agent-scout-bash.test.ts` pins both directions, and
`test/modules/sandbox/container/backend.test.ts` pins what each runtime registers.

A container mounts the working tree and nothing else, so `gitSupportMounts` adds what git needs outside it: a
linked worktree's git directory and its `commondir` target read-write, and a shared clone's
`objects/info/alternates` target read-only. This also fixes the parent when pi itself runs inside a worktree,
which was previously left with an unreadable `HEAD`.

One diagnostic lesson is worth keeping from the earlier attempt: a sandbox claim needs
`.state/bash-log.jsonl`, not only `ps`. Two delegated probes looked like proof of a broken gate — host
`pid 1`, Fedora `os-release`, readable `~/.ssh`, no `bwrap` in the ancestry — and the log showed every
command was `action: host` from the decision model (`criterion: none`, confidence 0.71–0.87) and therefore
`allow`/`sandboxed: false` by design. They never exercised the wrapper at all.

Tests are the deliberate exception: `test/setup.ts` pins `PI_SANDBOX_BACKEND=bwrap` for the whole suite, so a
run _inside_ the container still asserts bwrap wrapping, and the bwrap-executing tests keep using the real
binary. Only a live session stops using it.

**The verdict decides permission; the backend decides location.** A row in `.state/bash-log.jsonl` saying
`decision: allow`, `sandboxed: false` does not mean the command ran on the host: in a container session the
parent's bash tool _is_ the container-backed tool (`container/bash-tool.ts`), so a model `host` action or a
remembered rule runs in the container without an extra wrapper. That is the intended meaning of "host" here —
"no additional sandbox", not "outside the backend" — and it is pinned by
`test/modules/sandbox/container/bash-tool.test.ts`. A child gets the same treatment because it loads the same
backend, so "host" never falls back to a literal host command in either runtime.

### One posture, two backends

Permission rules must not branch on which backend is running. The container and bubblewrap bind the same
checkout at the same path, so "allow it, we are in a container" would grant there what it asks for under
bubblewrap while both can write the same files. What a rule may branch on is _enforcement_, so
`src/modules/sandbox/posture.ts` turns one mount plan into one `SandboxPosture`:
`{ role, enforcement, network, entries, writableRoots, readOnlyRoots, warnings }`. `writableRoots` is derived
from the entries, never declared — a rule that trusts it can only be as sound as the derivation.

Both backends resolve their configurable mounts through `resolveConfiguredMounts`, which is also where a
misconfigured mount stops being a silent `--volume`: `~` is expanded, relative paths are dropped with a
warning, a path that does not exist is dropped rather than left for podman to satisfy by creating an empty
directory, duplicates collapse to the most permissive mode, and parents are ordered before children so a later
mount cannot shadow a deeper one. A mount that reaches a credential path (`.ssh`, `.aws`, `.gnupg`, …) is
allowed — `~/.config/gh` is a legitimate opt-in that happens to hold a token — but it is reported once.

A migration note that cost a live session: until this layer, the container silently ignored `sandbox.mounts`,
so a config written under bubblewrap assumptions can now push host paths into an image built to contain its
own. `"/etc": "readonly"` is the example worth knowing — redundant for bubblewrap (its profile already
read-only-binds a fixed list that includes `/etc`) and wrong for the container, where it puts a Fedora `/etc`
under a Debian image. It appears to work only because Fedora ships
`/etc/ssl/certs/ca-certificates.crt` as a compat symlink.

`homeMounts` is gone, and the container's `$HOME` is one shared directory
(`.state/container/home`) mounted at the _real_ home path, so `~` means the same thing in and out and the
caches a session fills survive into the next one. The host home is never mounted; `sandbox.mounts` is what
puts specific parts of it back, read-only unless the entry asks for `readwrite`. (The first version made the
home per session, which threw the caches away and left a directory per session behind.)

The posture also carries a **role**. A child whose authority cannot run a build is `readonly`: its checkout,
its worktree git data, and the memory directory are mounted read-only, and it gets no network. That is
enforcement rather than another prompt, and it is what would let its Bash gate relax later without becoming a
hole. The rung matters: `command` children run test suites that write `coverage/`, so only `read` and
`inspect` are read-only (`src/tools/agent/child/sandbox-role.ts`).

Network is posture, not a per-command question: a per-command ask has no enforcement behind it, so it is
advice. `readonly` means `--network=none` in the container (no route, no resolver — DNS included, because DNS
is the search channel) and `--unshare-net` under bubblewrap. Egress stays the default for a mutating runtime,
because a build needs it; the proxied middle ground is deferred.

**Reads follow the runtime's own view (decided 2026-10-29).** A container-backed runtime may be _less strict about
reads_: its mount set is the boundary, so re-checking a read against the cwd adds nothing, and a scout's `find`,
`rg`, or `cat` outside the checkout should not need a prompt. Writes are unchanged, and sensitive names still
refuse, so a credential directory mounted on purpose stays behind a prompt. The switch is the runtime predicate
(`readConfinement: "runtime"`), never the backend's name: under bubblewrap the same path is the host's and stays
confined. This is the one place where the two backends legitimately differ, and the difference is what the
filesystem view _is_, not what the backend is called.

Deliberately not done yet: letting a rule _spend_ `writableRoots` (a `SAFE_EDIT` command whose operands all
miss the writable set could be allowed, since the kernel answers `EROFS`). That needs per-operand read/write
knowledge the heuristics do not expose today — `UnsafeReason` is per reason, not per operand — so it stays a
follow-up rather than a half-sound rule.

### Protocol

`src/modules/sandbox/container/dispatch.mjs` is plain JavaScript on purpose: it runs inside the image,
where no TypeScript exists. It is mounted read-only from the extension's own path at `/run/pi/dispatch.mjs`
and is the container's main process. It is deliberately _not_ baked into the image: it is the counterpart of
the host client and carries the protocol version, so a copy could only drift from the extension that is
running (and the default and `PI_SANDBOX_IMAGE` images have no build step to bake it into anyway).

```
host -> container   exec   { id, params: { command, cwd, env, timeoutMs } }
                    cancel { params: { id } }                            (notification)
                    ping   { id }
container -> host   ready  { protocol, pid, node, shell, cwd }
                    output { id, stream, data }                          (base64)
                    result { id, { exitCode, signal, timedOut, cancelled, wallTimeMs } }
                    error  { id | null, { code, message } }
```

`spawn` is `exec` without a shell (argv in, no quoting, stdout and stderr kept apart), and `fs` answers one
file operation per request: `readFile` (optionally a byte prefix), `writeFile`, `mkdir`, `access`, `stat`,
`readdir`, `exists`, `glob`. They exist for the [file tools](#file-tools-run-in-the-container), so a tool call
cannot read or write a file that a command would not see.

### File tools run in the container

Annotations were the wrong answer to the divergence question. A sandbox is coherent only if a tool call and a
command answer from the same place, and Shape A makes that cheap to achieve: the checkout and the scratchpad are
mounted at their real paths, so pi's file tools can be rebuilt over the container with no path mapping at all.

pi exports the whole family with an operations seam — `createReadToolDefinition`, `createWriteToolDefinition`,
`createEditToolDefinition`, `createLsToolDefinition`, `createFindToolDefinition`, `createGrepToolDefinition`
— and registering a tool by a built-in's name shadows it, the same mechanism the bash override uses. So
`src/modules/sandbox/container/file-operations.ts` implements `ReadOperations`, `WriteOperations`,
`EditOperations`, `LsOperations`, and `FindOperations` over the session's `fs` protocol, while truncation,
image resizing, the diff preview, the mutation queue, renderers, and system-prompt metadata stay pi's.

`grep` is the exception that needed its own implementation. Its seams cover only the directory check and the
context-line reads; the `rg` process is spawned inside pi's implementation
(`dist/core/tools/grep.js`, `spawn(rgPath, …)`), so an operations-only override would list the host's files
and read the container's lines. `src/modules/sandbox/container/grep-tool.ts` therefore reproduces pi's execute
and registers it against pi's own definition object (schema, description, renderers). Duplication is a drift
risk, so `test/modules/sandbox/container/grep-tool.test.ts` runs pi's implementation and this one over the same
checkout and compares output, details, and behaviour on the truncation and match-limit edges — a legitimate
oracle precisely because the checkout is shared.

What the overrides change, beyond the view:

- **Only active, genuine built-ins are taken over.** `pi.getActiveTools()` keeps a disabled `ls`/`find`/`grep`
  disabled (registering would activate it), and `ToolInfo.sourceInfo.path` must say `builtin:<name>`, so a
  same-named tool from another extension keeps its own backend and the user sees a warning instead.
- **User memory is mounted read-write** (`~/.pi/agent/memory`). It was read-only while only commands could
  write; now that `edit` runs inside too, a read-only mount would make the memory workflow fail on both paths.
- **The host's git identity is seeded** into the sandbox home as `.gitconfig` (only `user.name` and
  `user.email`, read with `git config --global`). Without it a command in the sandbox cannot commit at all,
  and the host file's credential helper, `hooksPath`, and LFS filters point at paths the image does not have.
- **A runtime without a container gets nothing.** Both the backend switch and a failed start leave pi's
  built-ins in place rather than half-sandboxing the tools.

Newline-delimited JSON, base64 for anything that can carry arbitrary bytes. Request-id multiplexing is
what replaces the session pool: parallelism is a protocol property, not N exec sessions. Command
semantics mirror pi's `createLocalShellOperations` deliberately — own process group per command, merged
stdout/stderr, `128 + signum` for signal deaths, and the drain rule where `exit` is followed by reading
until both pipes end with a 100 ms idle re-arm. That last one is why `cmd &` neither hangs the request nor
truncates a descendant's tail; it is the single most load-bearing behaviour copied from pi.

Lifetime is unchanged from decision 10: attached `podman run --interactive`, stdin EOF on host shutdown
translates to "exit", `--rm` removes the container. No watchdog, no heartbeat, no timeout guess.

### Flags that are not optional

`--init` (the dispatcher is long-lived and backgrounded grandchildren are reparented to PID 1, so a real
reaper has to be PID 1), `--sig-proxy=false` (a terminal Ctrl-C must cancel the running command through
the protocol instead of tearing the session down), `--security-opt label=disable` (SELinux Enforcing, and
`:Z` would relabel the checkout), and `--userns=keep-id` (the container runs as the host user, so nothing
inside is privileged over the image; affordable only because a `Containerfile` provisions the image, not
the session). Starting podman from inside `bwrap` is refused before the first spawn, because that
corrupts the rootless pause process and needs `podman system migrate` to repair.

### What the repository's own suite says about the image

Running `npm run test:run` _inside_ the sandbox is the harshest smoke test the image can face, and the
first attempt failed in three ways that say nothing about the sandbox backend:

- `vendor/sqlite3` requires `GLIBC_2.38`; Debian 12 bookworm ships 2.36, so `sqlite` and the session-store
  suites fail to load. The default image and this repo's recipe are now `node:24-trixie-slim` (Debian 13,
  glibc 2.41), which also matches the host's Node 24.
- Some tests silently require a developer machine: `defaultConfig()` sets `inheritEnv: {}`, so a test that
  asserts "no `--clearenv` when `inheritEnv` is undefined" only passes when a _global_ config file exists.
  A fresh `$HOME` — the container's mounted home — flips it. Same shape for the user-memory path in
  `file-permissions` and for `agent-child-decisions`.
- `agent-scout-bash` drives `bwrap`, which does not exist inside the container by design.

The focused `container/` suite (104 tests) does pass inside. Making the rest pass there would mean removing
those `$HOME`/`bwrap` dependencies from the tests, which is a separate piece of work.

### Keep-id, verified against the recipe image

`--userns=keep-id` runs the container as the host user, and the probe (`.pi/local/probe-keep-id.ts`)
checks the things it can break. Measured on `localhost/pi-coder-sandbox:af6a6cfc98a9`:

| What                   | Result                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| identity               | `id -u` = `1241`, the host uid, with `HOME` at the real home path                            |
| home                   | writable; `git config --global` and `npm`/`npx` both work                                    |
| checkout               | writable; `git` reads it and writes a loose object into `.git`                               |
| metadata ownership     | `.git/index`, `.git/HEAD`, `package.json` all `1241:1241` inside and out                     |
| read-only memory mount | still refuses writes, despite the uid matching — the mount flag is what holds                |
| dispatcher runtime     | `/opt/pi/node` v22.23.4, plus `ps`, `rg`, `python3` from the recipe                          |
| installing inside      | `sudo` absent, `apt-get` cannot write the image — the recipe is the only path                |
| identity guard         | `/proc/self/uid_map` inside is the remapped range, so podman still refuses to start in there |

Two failure modes came out of building this, both worth keeping:

- **Short image names are a registry lookup.** `pi-coder-sandbox:<hash>` unqualified made podman try to
  resolve it against the search registries when the tag was missing locally, which fails without a TTY
  (`short-name resolution enforced but cannot prompt`) and, with permissive short-name mode, would _pull_
  whatever a registry served. The tag is now `localhost/pi-coder-sandbox:<hash>`: an unbuilt image is a
  clean "not found" instead.
- **`--tmpfs /tmp` needs no mode hint.** Podman's default tmpfs options (`rw,noexec,nosuid,nodev`) leave the
  kernel's default 1777, so a non-root user can still write `/tmp`.

### Environment got a second policy

Bubblewrap inherits the host environment because it _is_ the host filesystem view; a container cannot, so
`src/modules/sandbox/env.ts` now holds both rules. `resolveSandboxEnv` is the old bubblewrap ordering,
extracted unchanged. `resolveContainerEnv` is new and narrow: the image supplies `PATH`, `HOME`, and the
rest, so host values for those keys are dropped instead of shadowed, and what crosses is explicit intent
(`sandbox.env`, `inheritEnv: "allow"`) plus terminal/locale/`PI_*` variables. Credential-shaped names are
excluded unless `inheritEnv` names them, since an explicit allow is a decision the user made. This is a
provisional answer to decision 13, not the finished profile.

### Validated where

67 unit tests drive the real dispatcher and the real client over pipes — protocol, concurrency, cancel,
timeout, missing cwd, `cmd &`, byte-exact output, teardown, and typed failures — with no podman and no
image in the loop. `.pi/local/probe-container-backend.ts` (`npm run scratch -- …`, **unsandboxed**) adds
the container-level checks.

Measured against real rootless podman, `node:22-bookworm-slim`, warm image (2026-10-28):

| What                     | Value                                                             |
| ------------------------ | ----------------------------------------------------------------- |
| container start          | ~175 ms                                                           |
| warm command (`true`)    | **1.9–2.3 ms** (vs 24.8 ms for a full-profile `bwrap` call)       |
| two overlapping commands | 303 ms (a 0.3 s sleep dominates)                                  |
| `cmd &` round trip       | ~104 ms (the drain grace, by design)                              |
| cancel                   | exit 143, `cancelled: true`, 300 ms, **0 survivors** in the group |
| timeout of 200 ms        | reported `timedOut` at 201 ms                                     |
| stop, idle session       | 45 ms; the 250 ms kill grace is only paid with commands running   |
| PID 1                    | `podman-init`; `zombies=0` after a backgrounded grandchild        |
| identity                 | same inode inside and out at the real checkout path               |
| `command -v node`        | `/usr/local/bin/node` — the image's PATH, not the host's nvm path |

Two probe findings worth keeping: `node:22-bookworm-slim` ships no `procps`, so in-container introspection
must read `/proc` (a `node -e` scan, not `ps`/`pgrep`); and a bundler rewrites `import.meta.url`, so
`ContainerSessionOptions.dispatcherPath` exists to name the dispatcher when the sibling `.mjs` is not
next to the module. A third is about the probe rather than the backend: argv is NUL-separated, so a
survivor check must join and compare the command exactly — a prefix match also counts a scan that mentions
the command, and any unrelated backgrounded child.

Still missing, all deferred on purpose: TUI footer state, `sandbox.backend` in the config file and its
`/config` UI, mount widening when a permission grants a new root, per-worker containers with the shared
clone from decision 14, `podman commit` warmth across sessions, and routing the file tools inward (they
stay host-side).

The test count above is the first slice's; the recipe flow adds 35 more (see below), for 102 in the
`container/` suite.

## The sandbox image is a recipe, not a mutated container

A session's image is described by a `Containerfile`, at `.pi/Containerfile` for the project or
`~/.pi/Containerfile` globally. No recipe means the default image, so nothing changes for a
checkout that has not adopted one.

The alternative — `apt-get install` inside a live session and `podman commit` — was rejected: a committed
layer is unreviewable (the diff you would want to read does not exist), unreproducible on another machine,
and it turns root's writes inside the container into _persistent_ state. A recipe is text in the repo, it
is layer-cached, and the only privileged step is a build that a human approves.

### The prologue: a Node runtime for a base image that has none

The dispatcher is a Node program, so the image needs Node. Requiring `FROM node:*` would constrain every
recipe, so the effective Containerfile is generated instead: the user's text stays verbatim, with a stage
prepended and two lines appended.

```dockerfile
FROM node:22-bookworm-slim AS pi-dispatcher-node
<the recipe, verbatim>
COPY --from=pi-dispatcher-node /usr/local/bin/node /opt/pi/node
RUN /opt/pi/node --version
```

Three choices inside that:

- **Appended after the recipe**, so a later `apt-get remove` in the recipe cannot take the dispatcher with
  it. The appended lines land in the recipe's final stage, which is also the image podman produces.
- **A verification step**, because a glibc-linked Node in a musl base fails with `Exec format error` at
  session start, which reads like a pi-coder bug. `RUN /opt/pi/node --version` turns it into a failed build
  naming the real cause. Alpine/musl `FROM` lines are also rejected before podman is invoked.
- **The dispatcher runs from `/opt/pi/node`**, not `PATH`, so the runtime is the one the build verified.

### Tagging, triggers, and what a build may not do

The tag is `pi-coder-sandbox:<12-hex>` over the effective Containerfile plus the base image, so a stale
image is detectable without bookkeeping and an unchanged recipe never rebuilds. `PI_SANDBOX_IMAGE` wins
over a recipe (the escape hatch), and `PI_SANDBOX_BASE_IMAGE` changes which image the runtime is copied
from.

`/sandbox status` reports the recipe, the tag, and whether it is built; `/sandbox build` shows the recipe
in a confirmation dialog and builds it. The command is registered whether or not the container backend is
active, because building ahead of time is the useful case. There is **no auto-build**, and a session whose
recipe image is missing **refuses to start** with the tag, the recipe path, and the command to run.

That refusal replaced an earlier warn-and-fall-back, on evidence: after a base-image change made the
effective Containerfile hash differ from the built image, a session silently ran in the bare default image
and produced 56 test failures that looked like product bugs (`spawn git ENOENT`, no `rg`, no `ps`) instead
of one actionable message. A content-addressed tag is always a "build me" state, never something to absorb
at runtime.

A build is **host code execution**: `RUN curl … | sh` runs as the user, with network. That is the same
class as writing `.git/config`, so the approval prompt showing the recipe is the boundary, and a mode
without dialogs refuses to build rather than building unasked.

### Measured (2026-10-28, rootless podman, `debian:bookworm-slim` + `git`)

| What                        | Value                                                 |
| --------------------------- | ----------------------------------------------------- |
| first build (apt install)   | 9.6–10.1 s                                            |
| second ensure (cache hit)   | 66–73 ms                                              |
| image contents              | injected `node` v22.23.4 · recipe's `git` 2.39.5      |
| session start on that image | 163 ms, dispatcher ran from `/opt/pi/node` (v22.23.4) |
| command through it          | `git --version` and the real checkout path            |

That run also proved the copy survives the recipe's own package management, which is the ordering rule
above — and that a recipe can therefore be as small as a `FROM` line plus the tools the work needs.

---

## Cross-cutting decisions needed

| #   | Decision                     | Options                                                                                            | Recommendation                                                                                                                                                                                                                       |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | pi dev-dependency version    | stay on 0.84.1 · bump to 1.3.0                                                                     | bump to 1.3.0: `classify()` does not exist earlier                                                                                                                                                                                   |
| 1   | Order of layers              | layer 1 first · go straight to layer 2                                                             | layer 1 first: independently useful and de-risks layer 2                                                                                                                                                                             |
| 2   | Runtime dir location         | reuse scratchpad · dedicated `.state/runtime/<session>`                                            | dedicated dir with cleanup; keeps the scratchpad scope narrow                                                                                                                                                                        |
| 3   | Temp-dir approach            | redirect `TMPDIR` · declare `os.tmpdir()` as a read root                                           | redirect `TMPDIR`; the alternative broadens `/tmp` reads                                                                                                                                                                             |
| 4   | Decision model authority     | auto-sandbox/refuse only · also auto-host behind a flag                                            | auto-sandbox/refuse; auto-host opt-in + threshold                                                                                                                                                                                    |
| 5   | Decision model surfaces      | parent only · parent + child                                                                       | parent first, child behind a config flag                                                                                                                                                                                             |
| 6   | Context shape / question set | single/decomposed/risk; five context shapes                                                        | start `single` + `request_history`, keep configurable                                                                                                                                                                                |
| 7   | `audit` config fate          | rename to `decisionModel` · keep and extend                                                        | rename to `decisionModel`                                                                                                                                                                                                            |
| 8   | Sandbox networking           | full (today) · loopback-only · none, opt-in per command                                            | loopback-only needs the persistent sandbox; until then isolate by default and let a command opt into the host netns                                                                                                                  |
| 9   | Long-lived processes         | leak as today · reap at call end · persistent sandbox                                              | reap at call end; the persistent sandbox is what buys them back                                                                                                                                                                      |
| 10  | Session sandbox backend      | persistent `bwrap` daemon · rootless container · stay per-command                                  | **decided: rootless container**, selected by `sandbox.backend` (`auto` prompts once for a missing image); a per-command `exec` measured +125 ms over `bwrap`, so it rides one attached session (0.6 ms)                              |
| 11  | Session workspace posture    | per-session worktree (propose) · real checkout in container (live)                                 | **decided: live (Shape A)** — real checkout at its real path; no transfer problem, no project-state split, `.git` worktree pointers stay valid                                                                                       |
| 12  | Change-transfer contract     | patch-apply into a clean parent (reuse worker) · branch-per-session merge                          | n/a for Shape A (live checkout, no transfer); it returns only if Shape B's overlay is added                                                                                                                                          |
| 15  | Execution seam               | command-string rewriting · pi's `BashOperations`                                                   | **decided: `BashOperations`** for the container (and the target for `bwrap` in layer 2); a session cannot be expressed as a rewritten command string, and a socket client would re-add process-start latency                         |
| 14  | Worker workspace model       | linked worktree sharing the rw `.git` · shared clone with object alternates                        | **decided: shared clone** — `$CLONE` rw + `.git/objects` ro (+ `refs` ro); no path to `.git` config/hooks/worktrees or the parent checkout, transfer still `diff` + `apply`                                                          |
| 13  | Profile strengthening        | unshare net/pid/ipc/uts · drop `~/.pi` rw and `/etc` ro · filter env                               | prerequisite for any "free inside the box" model; the current profile is a path view, not a boundary                                                                                                                                 |
| 16  | Image provisioning           | live `apt-get` in the session + `podman commit` · `Containerfile` recipe with a generated prologue | **decided: `Containerfile`** — reviewable text, layer-cached, reproducible; the prologue copies `node` into the user's base so a recipe need not be `FROM node:*`, and the build (never the session) is the approved privileged step |

## Implementation order (proposed)

1. **Bump `@earendil-works/pi-*` dev dependencies to 1.3.0** and get `npx tsc --noEmit`,
   `npm run typecheck:tests`, and the suite green again. This prerequisite exposes
   `ctx.modelRegistry.classify()` and the classifier types.
2. **Runtime-roots policy (layer 1):** `computeRuntimeRoots`, runtime temp dir + `TMPDIR`, mount/read
   consumers, delete `BashOutputLedger`, parent/child/subagent tests.
3. **Decision model (layer 3):** config, `model.ts` resolution, `policy.ts`, parent integration,
   decision-log v2, tests. Independent of layer 2 and can run in parallel with it.
4. **Bash tool wrapper (layer 2):** argv-based `bwrap` operations, `toolCallId` decision map, parity
   suite, child registration.
5. **Children for the decision model**, then the status footer.
6. Optional later: a session-level sandbox behind the layer-2 seam — strengthen the profile first
   (decision 13), then choose the posture (decision 11) and backend (decision 10). See
   [Considered and deferred: persistent sandbox](#considered-and-deferred-persistent-sandbox).
