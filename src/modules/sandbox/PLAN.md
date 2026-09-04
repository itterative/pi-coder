# Confined path expansion: tilde and glob support in the cwd-confinement heuristic

## Status

**Stages 1 and 2 implemented.** Written for review after mining the bash decision log (418 records,
232 prompted, 559 uncovered segments; see `docs/bash-decision-log.md`). The sections below keep the
original reasoning; where reality differed, the implemented behavior is marked.

Landed with stage 1:

- `BashWordExpansions { tilde, glob, brace, variable }` on `BashWordNode`, computed by the tokenizer
  per character (`noteExpansionChar`).
- `isExpandableHomePath()` in `heuristics/command-access.ts`: a path slot holding an unquoted `~` or
  `~/…` with no other live expansion is resolved against the home root and confined normally. The
  text scan still refuses everything else, so mutators, `$name`, brace expansion, `~user`, and any
  word carrying quoted content behave exactly as before.
- `resolveHomeDirectory()` in `src/common/home-directory.ts` (`$HOME` first, `os.homedir()` as
  fallback), used by every `~` expansion in the sandbox heuristics, `bubblewrap.ts`, and
  `src/tools/file-permissions.ts`, so the certified path and the path the shell opens agree.

Landed with stage 2:

- `heuristics/glob-expansion.ts` — `expandGlobPattern(pattern, cwd, maxDepth)` answers only "which
  operands can the shell pass?". Confinement stays in the existing path checks, which receive the
  operand list, so containment, sensitive names, symlinks, and read-versus-write policy remain in one
  place. Structure: reject `**`, `[`, `..`, `.`, and a trailing separator; walk component by component
  (magic never crosses `/`); skip dot entries unless the component asks for one; tolerate a missing
  path as no-match but refuse an unreadable directory; budget 512 operands and 2 000 entries read.
- Support is `*` and `?` only; bracket expressions are refused rather than translated. POSIX classes
  (`[[:alpha:]]`), locale-collated ranges (`[a-z]` under UTF-8), and literal `]`/`-` placement all
  disagree with a JavaScript character class, and `[z-a]` **throws** while compiling. That throw was
  real: `cat [z-a].ts` escaped `resolvePermissionDetails`, and both gates survived it only because they
  already wrap the resolver in `try/catch` — which loses the segment breakdown, so the dialog and the
  decision log would report no uncovered command. Restricting the alphabet to `*`, `?`, and escaped
  literals makes an invalid expression unrepresentable.
- Redirection targets are marked as writes *before* their operand is inspected
  (`inspectAstRedirections`), so a `>` target cannot reach the expansion gate with `writes` still
  false. Bash creates one literal file there, so its operand set is not ours to choose.
- The write gate is **per slot**, not per command: `expandGlobOperands()` receives `slotWrites`, which
  each call site derives from what it is inspecting — `flagSpec.writes` for a flag value,
  `positionalsAreDestinations(spec)` for a positional, the computed `writesTarget` for a redirection.
  The command-level `this.writes` remains only the SAFE_READONLY-versus-SAFE_EDIT decision.
- `resolveSlotOperands()` in `command-access.ts` — now the single operand decision shared by the AST
  extractor and the short-flag cluster handler, so neither can drift from the other.
- Configuration: `heuristics.cwdConfinement.globExpansion` (default `true`) skips expansion entirely,
  and `globMaxDepth` (default `10`) bounds the walk. Both flow through `ConfinementOptions` and are
  passed explicitly in tests, per the existing config-resolution pattern.
- Reads only: `expandGlobOperands()` refuses when the command or slot writes, and the
  `additionalRootOnly` check still rejects dynamic argv before expansion is consulted, so `rm *.ts`
  and `sed -i … *.ts` prompt exactly as before.

### The refinement that came out of testing

§4 below proposed allowing partially quoted globs because the per-character flags say which
metacharacters are live. That is true for `*` and `?` and false in general: in
`'[a]'*.ts` the quoted bracket is the three-character literal `[a]`, while translating the stored
`[a]` into a character class matches `a.ts` instead. The resulting operand set is **narrower** than
the shell's, which is the one unsound direction — a sensitive or escaping file the shell really opens
can go unchecked. Since the flags record only *whether* a word has live glob characters, not which
characters were quoted, expansion now additionally requires `!word.quoted`. Mixed-quoting words keep
prompting, and `find . -name "*.jsonl"` stays out of the enumerator for the same reason.

A third finding came from the fuzz seeds: adding `src/**` and `[z-a]*` to `ESCAPE_PATHS` failed the
"an unsafe segment is never auto-allowed" property — correctly. Assignment values are not
pathname-expanded (POSIX), so `FOO=src/** cat file.txt` stays a confined relative string. That pool
must hold paths that escape in **both** roles, argument and assignment value; argument-level
refusals belong in `heuristics.test.ts`, which is where the bracket and `**` cases now live.

## Problem

`DYNAMIC_PATH` accounts for 73 of the 559 uncovered segments. Splitting those by what is
actually dynamic in the offending token:

| cause            | gaps | example                                          |
| ---------------- | ---- | ------------------------------------------------ |
| unexpanded glob  | 38   | `grep -rn "persist(" src/tools/agent/child/*.ts` |
| leading tilde    | 12   | `cat ~/.pi/agent/memory/heuristics.md`           |
| glob + tilde     | 5    | `find ~/.pi/agent/sessions -name '*.jsonl'`      |
| `$VAR` / `$(…)`  | 10   | `jq -r .id $CF`                                  |
| heredoc          | 6    | `cat > /tmp/…/sample.sh <<'SH'`                  |

Simulating expansion against the real log: confined-glob handling would **fully rescue 19 of
232 prompted records and partly help 6**; tilde alone rescues little in this sample (most tilde
paths point outside the repo anyway) but removes a permanent asymmetry with the file tools.

### The asymmetry today

`~/.pi/agent/memory` is a read-only additional root for parent Bash, and both spellings of the
same file are decided differently:

```
SAFE_READONLY   cat /home/sd/.pi/agent/memory/heuristics.md
UNSAFE          cat ~/.pi/agent/memory/heuristics.md   DYNAMIC_PATH
```

while the direct file path check used by `read`/`edit` (`getPathConfinementAssessment`) answers
`SAFE_READONLY` for **both**.

## Where the refusal happens

Tilde expansion already exists — `resolvePath()` in `heuristics/path-policy.ts` expands `~` and
`~/…` before `path.resolve(cwd, …)`, and `src/tools/file-permissions.ts` does the same for direct
file access. The command heuristic never gets there:

| site                                              | what it does                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `heuristics/command-access.ts:253` `hasDynamicShellExpansion()` | refuses a value containing `$ ` `` `{` `}` `*` `?` `[` `]` or starting with `~` |
| `command-access.ts:159-160` and `:570-571`        | path-slot inspection calls `hasUnmodeledPathExpansion(value, word)`                 |
| `command-access.ts:66`                            | specs with no modeled args reject any dynamic argument                              |
| `heuristics/evaluator.ts:612`                     | any spec with an additional-root policy rejects dynamic text in all argv            |
| `command-access.ts:269` `hasUnmodeledPathExpansion()` | uses `word.substitutions` provenance, then falls back to the text scan          |

The text scan runs on the **post-quote-removal value**, so it cannot tell a live metacharacter
from a literal one.

## Why the AST must be extended

`BashWordNode` (`src/modules/sandbox/bash.ts:740`) keeps `value`, one sticky word-level `quoted`
boolean (`:825`, set from `token.protected`), and `substitutions`. No raw text or source spans are
retained, so quoting cannot be re-derived downstream. Observed output of the current lexer:

```
cat ~/.ssh/x     value="~/.ssh/x"    quoted=false   subs=-      ← bash: $HOME/.ssh/x
cat '~/.ssh/x'   value="~/.ssh/x"    quoted=true    subs=-      ← bash: literal ./~/.ssh/x
cat \~/.ssh/x    value="~/.ssh/x"    quoted=true    subs=-      ← literal
cat ~'/'x        value="~/x"         quoted=true    subs=-      ← bash does NOT expand (quoted login name); we refuse
 cat ~"/"x"       value="~/x"         quoted=true    subs=-      ← bash DOES expand; the `quoted` guard refuses anyway
cat 'x'*.ts      value="x*.ts"       quoted=true    subs=-      ← * IS LIVE
cat '*.ts'       value="*.ts"        quoted=true    subs=-      ← * is literal
cat \*.ts        value="*.ts"        quoted=true    subs=-      ← * is literal
cat a{b,c}.ts    value="a{b,c}.ts"   quoted=false   subs=-      ← brace expansion live
cat "a{b,c}.ts"  value="a{b,c}.ts"   quoted=true    subs=-      ← brace expansion suppressed
cat $HOME/x      value="$HOME/x"     quoted=false   subs=-      ← variable, not a substitution
```

Conclusions:

1. **Tilde is expressible today** — `!quoted && (value === "~" || value.startsWith("~/"))`. The
   partial form `~'/'x` collapses to `quoted=true` and keeps prompting: lossy, never wrong.
2. **Globs are not.** `'x'*.ts` (live) and `'*.ts'` (literal) share `value` shape and
   `quoted=true` with opposite semantics. Deciding on the word-level flag must pick wrong in one
   direction, and "treat a live `*` as literal" is the unsound direction: the operand set the shell
   passes differs from the one we certified.
3. `$name` produces no `substitutions` entry, so any provenance-based rewrite must add it back or
   it silently loses a refusal.

The lexer already knows all of this per character (`appendUnquotedChar` vs `parseQuoteStart` vs
`parseEscape` vs `parseLineContinuation`) and collapses it into one boolean.

## Design

### 1. Per-word expansion provenance

```ts
/** Shell expansions that can still act on this word after quote removal. */
export interface BashWordExpansions {
    tilde: boolean; // unquoted leading ~ that bash expands
    glob: boolean; // unquoted * ? [ ] outside single/double quotes and escapes
    brace: boolean; // unquoted {a,b} or {1..9}
    variable: boolean; // unquoted $name or ${…}, including inside double quotes
}
```

Set during token assembly on `BashLexedWordToken`, exposed on `BashWordNode` as
`readonly expansions: BashWordExpansions`:

| append context               | may set                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| unquoted character           | `tilde` (only at word start, so never inside `NAME=…`), `glob`, `brace`, `variable` |
| inside `'…'`                 | nothing — and the word becomes `quoted`, which is what makes the stored value equal the operand |
| inside `"…"`                 | `variable` only (plus existing `$(`/backtick subs)          |
| `\`-escaped, line continuation | nothing — also marks the word `quoted`                    |

`quoted` stays as-is: it has exactly one consumer (`command-access.ts:61`, the trailing-`*` rule in
the permission-pattern parser), so the new field is added alongside it rather than redefined.

### 2. Invariants this must not disturb

- **Expansion is classification-only.** `decisionTokens()`, `unwrapWrapperCommand()`, suggestion
  input, and the logged segment `tokens` keep the literal text. Rules are matched against
  `grep -rn foo src/tools/agent/child/*.ts`, not against its 40 expansions — one transform serves
  every consumer.
- A grant may never exceed what the literal command would have done: every operand the shell can
  actually produce must independently pass the existing confinement, sensitive-name, and symlink
  checks.
- Deny still dominates; heuristics still never relax a policy `deny`/`allow`.
- Provenance-free entrypoints (`getArgsConfinement*`, `safeBashCommands` strings, and
  `evaluator.ts:612`) keep the conservative text scan and the reason documented there.
- `substitutions` handling is unchanged: modeled `pwd`/literal `echo`/`printf` path slots stay as
  they are; `variable || brace` still refuses.

### 3. Tilde

Implemented. The classifier excuses a word only when `expansions.tilde` is set, the word carries no
quoted content at all, the remaining text is static, and the value is `~` or starts with `~/`.

- Home source is `resolveHomeDirectory()` = `env.HOME ?? os.homedir()`, matching what the sandbox
  exports. The previous split between `os.homedir()` in the heuristics and `$HOME` in
  `bubblewrap.ts` is what made the two disagree in principle.
- `~user` stays refused (needs a passwd lookup we do not model).
- Quoted `~` stays refused: bash passes a literal, and `./~` is a repo-controllable name — a planted
  `~` symlink is exactly the case the canonical checks exist for. `~'/'x` is the concrete trap: quote
  removal stores it as `~/x`, while bash leaves it alone because the login name region is quoted.
- Expansion is 1-to-1, so it grants nothing a spelled-out absolute path did not already grant. That
  is why the read-only scope below is a stage-2 constraint, not a stage-1 one.

### 4. Glob

**Implemented** — see the status note for the two ways the shipped rule is narrower than this
sketch: `!word.quoted`, and the refusal of `**`.

New helper in `heuristics/path-policy.ts`, e.g.
`expandConfinedGlob(pattern, cwd, home, options, diagnostics): string[] | null`, called from path
slots when `expansions.glob` is set.

Algorithm, mirroring the shell rather than approximating it:

1. Reject components that are `.` or `..`, that contain `**`, or that carry shell syntax we do not
   model (`[`, `]`, `(`, `)`). An **absolute** pattern is not rejected here: it is enumerated from `/`
   and refused afterwards by the path checks, which is deliberate — absolute shapes are how a scratchpad
   or another granted root gets globbed (`ls /tmp/pi-coder-scratchpad-<id>/*`).
2. Match **component by component**; `*`/`?`/`[…]` never cross `/`.
3. Skip dot entries unless the pattern component starts with `.` (bash `dotglob` is off).
4. Symlink components are not rejected during the walk: `readdirSync`/`statSync` traverse them, and an
   escaping operand is caught afterwards by the canonical path check (`SYMLINK_ESCAPE`), which is where
   the decision belongs. Verified: `cat escape/ho*st` → `SYMLINK_ESCAPE`.
5. Require at least one match; require **every** match to pass the existing per-path checks
   (lexical + canonical containment, sensitive segments, read/write access class).
6. Zero matches → check the literal operand instead, because `nullglob` and `failglob` are off, so
   bash passes the pattern through verbatim.
7. Budgets: at most 512 operands and at most 2 000 directory entries read per pattern, counted once
   per operand (a nested result is not re-counted at the ancestor level). Overflow refuses with
   `DYNAMIC_PATH`, so a pathological pattern costs a prompt, not a grant. Measured on a 40 000-entry
   directory: refused in ~16 ms, which is the single `readdir` itself.

Facts that make this tractable, measured with `bash -c` on this host: `globstar`, `nullglob`,
`failglob`, `extglob`, `dotglob` are all **off**, so `**` is just `*` (no recursive matching, bounded
work) and `@(...)` forms are inert. Keep refusing them anyway; a future shell switch should not turn
an old refusal into a grant.

Scope for v1: command **argument path slots only** — positionals under `positionals: "paths"` /
`"first-pattern"`, `PATH_VALUE`, and `pathSlots` flag values. Redirection targets, heredocs, and
process substitutions keep today's behavior.

### 5. Read slots vs mutate slots

`additionalRootOnly` mutators (`rm`, `mkdir`, `rmdir`, `touch`, `truncate`, `tee`, `mv`, `chmod`,
plus constrained `cp`) currently refuse any dynamic argv via `evaluator.ts:612`. A glob there turns
one approved intent into a whole set of mutations, and `rm *`/`mv a* b*` is the shape where a
mis-modeled match actually hurts.

Proposal: v1 allows expansion **only for reads** (`SAFE_READONLY` classification). Any spec whose
`writes` flag or `OUTPUT_PATH_VALUE`/`pathSlots`-with-`writes` semantics mark the slot as a mutation
target keeps refusing. That preserves the "scratchpad-only mutators reject expansion in consumed path
and data values" rule already documented in the heuristics memory, and `wc -l src/**.ts`,
`grep -rn foo src/*/`, `ls ~/Repos/*/README.md` are the cases with the evidence behind them.

### 6. Which shell runs the command

`sandbox()` ends with `-- ${env.SHELL ?? "sh"} -c …`, so the interpreter is the user's login shell,
not a fixed bash. zsh differs on unmatched globs (`NOMATCH` errors instead of passing the literal
through) and on extended-glob defaults. Mitigation: model only semantics common to bash and zsh
(component-wise matching, dot rules, no `**` recursion), and treat "no match" as refuse rather than
guess for shells other than bash/sh. Worth an explicit decision below.

## Non-goals

- No `$VAR`/`${…}` value tracking, no brace expansion, no extglob, no `~user`.
- No change to interpreters, `sqlite3`, `awk`, `npm`/`npx`, or heredocs — their refusals are
  deliberate (`UNKNOWN_COMMAND` is 421 of 559 gaps) and belong in curated rules, not heuristics.
- No glob support in the direct file-path checks (`read`/`edit` take one path; globs there are a
  user error, not a permission question).

## Adjacent fixes (independent mechanism, do not bundle silently)

- `find -name/-iname/-lname/-path/-regex` values are match patterns, never opened, yet are treated
  as path slots today — `find . -name '*.sqlite*' -not -path ./node_modules/*` prompts. Fix is a
  spec change (those flags become `VALUE`), not expansion. Evidence: 2 gaps.
- Bare assignment segments (`SID=01a0…`, 30 gaps, currently `EMPTY_INPUT`/unknown) can run nothing;
  modeling them as inert is a separate resolver question.
- Session rules never persist, so `npx prettier *` (63 gaps), `npx tsc *` (14), `npm run test:run`
  and friends re-prompt every session; a project-local `.pi/bash-sandbox-config.json` would remove
  most remaining friction without touching the heuristic. Evidence: 119 `npm`/`npx` gaps.

## Test matrix

| layer                | cases to pin                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| lexer (`bash.ts`)    | one per quoting context × metacharacter from the table above, asserting exact `expansions` flags; plus the forms whose stored value is not the operand (`$'…'`, `$"…"`, `"a\"b"*.ts`, `''~/x`, backtick or process substitution next to a live glob) |
| `glob-expansion`     | dot components with the parent granted as a root, `**`/`[`/`]`/`(`/`)` refusal, unreadable directory, entry budget, operand budget counted once, zero-match literal inside and outside the tree, malformed `globMaxDepth` |
| `heuristics`         | live shapes from the log (`grep -rn "x" src/…/*.ts`, `wc -l src/*/*.ts`, `ls -l .state/meta.sqlite*`) → `SAFE_READONLY`; refused shapes (`'*.ts'` as literal, `rm *.ts`, `$d/*.jsonl`, `find ~/.pi -name '*.jsonl'`, `sort -o out*.txt …`) |
| `resolve`            | logged token view and suggestion input unchanged for an expanded segment; chain combination still most-restrictive                                      |
| `fuzz`               | glob/tilde shapes in both pools, keeping the lesson that a pool entry must be unsafe in argument *and* assignment-value position                        |
| registry contract    | every spec whose last positional is a destination must already reject dynamic operands (`commands-registry.test.ts`)                                    |
| regression check     | `npm run permission-report -- --since 30d --all-gaps` should move glob-shaped `DYNAMIC_PATH` candidates into AUTO-ALLOWED BY HEURISTIC                  |

## Validation

`npx tsc --noEmit`, `npm run typecheck:tests`, `npx vitest run test/modules/sandbox/…`,
`npm run test:run`, then `npm run permission-report -- --all-gaps` to confirm the shapes moved.
Manual check that a sandboxed run still sees the expanded operand set (the shell, not pi-coder,
performs the expansion).

## Open decisions

Resolved during review, recorded here so the reasoning does not get re-litigated:

1. **Scope of v1** — reads only. Enumeration (one token → many operands) stays out of mutating
   commands; revisit after stage 2 ships and the shapes are known.
2. **Non-bash `$SHELL`** — resolved by construction rather than by detection: zero matches check the
   literal operand (sound for bash's pass-through and zsh's `NOMATCH` failure alike), `**` is refused
   (zsh expands it recursively by default, bash needs `globstar`), and extglob operators are refused
   through `UNSUPPORTED_PATTERN_CHARS` because they are live under `shopt -s extglob` and under zsh's
   default `EXTENDED_GLOB`, where `!(*.env)` matches *more* than a literal reading does. Caveat: the
   zero-match rule assumes `nullglob` is off in the executing shell; if a user enables it, the literal
   is never passed and the extra check is merely conservative. Nothing reads `env.SHELL`.
3. **Budgets** — hardcoded as `GLOB_MAX_MATCHES` (512) and `GLOB_MAX_ENTRIES` (2 000) in
   `glob-expansion.ts`, refusing with `DYNAMIC_PATH` on overflow; only `globMaxDepth` became a config
   key.
4. **HOME precedence** — done: one `resolveHomeDirectory()` helper for every `~` expansion instead of
   per-call-site `os.homedir()`.
5. **Bundling** — stage 1 (AST provenance + tilde) first, stage 2 (glob enumeration) as its own
   change on top.

## Review follow-ups

A `reviewer` pass over the stage commits found one reachable soundness gap and three precision
problems, all fixed with mutation-caught tests:

- **Extglob shapes were being expanded** — `cat !(*.env)` granted. Harmless on this host's default bash
  (the form is a parse error, so it fails closed), but live under `shopt -s extglob` and zsh's default
  `EXTENDED_GLOB`, where the negation matches *more* than a literal reading: the narrower-than-the-shell
  direction. `UNSUPPORTED_PATTERN_CHARS` now refuses `[`, `]`, `(`, and `)`.
- **The entry budget was only tested after a match**, so a wide directory cost a full readdir plus a
  stat and a freshly compiled RegExp per entry before refusing (~89 ms measured, and the classification
  *succeeded*). It is now checked as soon as a listing is read, the matcher is compiled once per
  component, and a 40 000-entry directory refuses in ~16 ms — the readdir itself.
- **Operand accounting double-counted nested matches and counted static leaves zero times**, so the
  documented cap meant neither. Counting happens once, at the leaf.
- **`globMaxDepth` failed open** on a non-integer: JSON can carry a string and `length > NaN` is always
  false, so a typo removed the bound. `resolveGlobMaxDepth()` falls back to the default and clamps to 64.
- New: `commands-registry.test.ts` states the registry contract that keeps the destination question
  closed for future specs, and the tilde caveat about `sandbox.env.HOME` is documented instead of
  contradicted by a docstring claiming the two cannot disagree.

Changed after review instead of accepted:

- **Order insensitivity.** The reviewer found that `sort src/*/*.ts -o out.txt` granted while
  `sort -o out.txt src/*/*.ts` prompted, because the guard read the command-level `writes` flag at
  inspection time. Rather than a pre-pass that would only narrow behaviour, the gate became per slot
  (see "Landed with stage 2"): reads expand whatever the flag order, write slots never expand in either
  order. Pinned by two tests, one per direction.
- **The exemption is now stated in code.** The parent bash gate passes
  `sensitiveAdditionalRoots: additionalRoots` explicitly, with the reason: the agent gets leeway inside
  its own scratchpad, and user-level memories are runtime data it is meant to read and write. Behavior
  is unchanged — it was already the default when the option is omitted — but the decision is now visible
  where a future reviewer would otherwise flag it as a hole.

Known and accepted, not fixed here:

- `positionalsAreDestinations()` is currently *redundant*: every destination-capable spec in the registry
  also carries `additionalRootOnly`, `additionalRootLastPositional`, or a `requiresAdditionalRoot` flag,
  and the blanket check at `evaluator.ts` rejects dynamic argv for all of those — so removing the helper
  passes the whole suite. It is defense for the next spec, and the layer that actually carries today's
  risk is `commands-registry.test.ts`, which was verified load-bearing by injecting a spec that writes
  through a flag with no path value and no destination marker (two tests fail). The precise future
  refinement, if mutators ever want expansion: allow globbed *sources* while keeping the last positional
  literal.
- A lone `]` in a name is now refused (`cat a]b` prompts) even though bash treats it literally and that
  expansion was sound. Explicit beats accidental.
