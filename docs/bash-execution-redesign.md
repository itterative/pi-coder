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
code when the command classification alone came back lenient. A body with
no answer (error, timeout, size
rejection, an unrecognized capability) abstains the whole verdict before the command is even asked: an unread
script is one the command would run unchecked. Bodies are sent **whole** — no clipping and no budget guard —
so a script too large for the endpoint fails its own request rather than being silently trimmed into a
different script. Recognition (`src/modules/decision/script.ts`, reusing the sandbox's own `parseBashAst` and
`unwrapWrapperCommand`, and the same `timeout` unwrapping the permission pipeline uses) covers the `npm
run`-family package scripts, interpreter file runs, and any command that is itself a literal path to a
readable file (`./scripts/deploy.sh`); `inline` forms (`-c`/`-e`/`--eval`, a heredoc feeding an interpreter)
add nothing because the code is already in the command, and `binary` forms (`npx`-family, `uv run`/`uvx`) add
nothing because there is no body in the repository. The decision log still records both kinds, so a body that
was unavailable is visible.

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
  "surfaces": ["parent"]
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
  (default 0.8). The former `autoHost`, `autoRefuse`, and `applySurfaces` keys were removed and are ignored
  by a file that still sets them.
- `provider` + `model` select the classifier through `ctx.modelRegistry` (`systemone` + the endpoint's model
  id for the registered one; a built-in classifier can be named instead). When `model` is omitted, the first
  classifier of the configured provider is used, or the first available one overall when `provider` is also
  omitted.
- `cooldownMs`: `classify` does not reject, but an answer with `stopReason !== "stop"` (error, aborted,
  timeout) puts the model in cooldown so a down service does not add latency to every prompt.
- `surfaces`: `["parent"]`, `["child"]`, or both. Children cannot prompt in headless runs, so enabling
  the model for children is the highest-value case (it converts "uncovered without a prompt" into a
  decision) and the highest-risk, so it is opt-in. The child gate can only produce `allow`/`allow:sandbox`;
  a `refuse` still reaches whatever prompt path the run has.
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

The original idea: keep one `bwrap` process alive and forward commands to it over a unix socket, with
profile-keyed instances that restart when sandbox settings change.

It is feasible (probe above) and the protocol is straightforward:

```
[type: u8][length: u32 big-endian][payload]
0x01 REQUEST { cwd, command, timeoutMs? }   0x02 STDOUT   0x03 STDERR
0x04 EXIT    0x05 CANCEL                    0x06 ERROR
```

But it is deferred for now:

- It does not reduce latency (~17 ms `bwrap` is already the baseline, and an external Node forwarder is
  ~20 ms). Only in-process routing would, and that matters less than the runtime-roots problem.
- Filesystem state already persists across commands, so the shared-state argument is weak.
- It is net new architecture (server, lifecycle, profile keying, Node-in-sandbox dependency, fallback),
  which is the opposite of the cleanliness goal.
- The real pain was per-call assembly of runtime paths, which layer 1 fixes without it.

If it is ever wanted, it belongs behind the layer-2 `operations.exec` seam as a pooled backend, and the
protocol above is the starting point.

---

## Cross-cutting decisions needed

| #   | Decision                     | Options                                                  | Recommendation                                                                                                      |
| --- | ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 0   | pi dev-dependency version    | stay on 0.84.1 · bump to 1.3.0                           | bump to 1.3.0: `classify()` does not exist earlier                                                                  |
| 1   | Order of layers              | layer 1 first · go straight to layer 2                   | layer 1 first: independently useful and de-risks layer 2                                                            |
| 2   | Runtime dir location         | reuse scratchpad · dedicated `.state/runtime/<session>`  | dedicated dir with cleanup; keeps the scratchpad scope narrow                                                       |
| 3   | Temp-dir approach            | redirect `TMPDIR` · declare `os.tmpdir()` as a read root | redirect `TMPDIR`; the alternative broadens `/tmp` reads                                                            |
| 4   | Decision model authority     | auto-sandbox/refuse only · also auto-host behind a flag  | auto-sandbox/refuse; auto-host opt-in + threshold                                                                   |
| 5   | Decision model surfaces      | parent only · parent + child                             | parent first, child behind a config flag                                                                            |
| 6   | Context shape / question set | single/decomposed/risk; five context shapes              | start `single` + `request_history`, keep configurable                                                               |
| 7   | `audit` config fate          | rename to `decisionModel` · keep and extend              | rename to `decisionModel`                                                                                           |
| 8   | Sandbox networking           | full (today) · loopback-only · none, opt-in per command  | loopback-only needs the persistent sandbox; until then isolate by default and let a command opt into the host netns |
| 9   | Long-lived processes         | leak as today · reap at call end · persistent sandbox    | reap at call end; the persistent sandbox is what buys them back                                                     |

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
6. Optional later: pooled sandbox backend behind the layer-2 seam.
