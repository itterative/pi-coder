---
name: blocks-and-flow
description: The `block` declaration kind for named callback calls (test suites, routes) and the `flow` action that lists call sites by scope.
category: architecture
priority: 7
keep_updated: true
---

# Blocks and `flow`

Two features that moved `outline` from "where things are declared" to "what a file contains and what it does".
Design notes: `src/tools/code/README.md` (`## Blocks`, `## Call sites`).

## `block`: a declaration that is not a declaration

**One discriminator, no framework allowlist.** TypeScript/JavaScript extraction emits a `block` for a
*statement-level* call whose **first argument is a string literal** and whose **last argument is a function
literal**. `describe`/`it`/`test`, `router.get("/x", h)`, `pi.on("event", h)`, `vi.mock("fs", () => …)` all answer
to it. Rejected by the same rule: no callback (`console.log("x")`), no literal (`router.get(path, handler)`),
identifier handler (`watch("file", handler)`), substituted template (`` describe(`suite ${name}`) ``). The one
false positive it admits, `console.log("x", () => …)`, is still a labelled block.

Fields: `name` is the title, `blockCallee` is the call (`describe`, `test.describe`), `qualifiedName` composes
(`suite::case`), `children` are nested blocks, `bodyRange` is the callback body. Everything else in the tool then
works unchanged: digest renders `describe "outline digest"  :95-170`, search matches the title, show lists a
suite's cases, usages groups a case's occurrences under its title.

## Invariants that are easy to break

- **Position is identity.** `TypeScriptVisitor.push()` dedupes by qualified name + signature + params to pair a
  header declaration with its definition. Two suites may share a title in one file, so a block's
  `range.startIndex` joins the key — without it the second suite vanishes silently.
- **A block is a container only when it holds blocks** (`show.ts` `isSection`). A suite has members; a case's body
  is code and must render as a leaf, or `show` answers `no public members` for a 12-line test.
- **No `[def]` tag** on block rows (`search.ts` `declarationTag`): every block has a body, so the tag is noise.
- **Prose matching.** `format.ts` `headingMatch` covers blocks as well as Markdown headings: prefix and substring
  of the normalized title, every candidate reported, with a `# title:` note naming loose rows. A test title is
  remembered as a phrase, so `show("commented-out import")` must reach
  `it("does not turn a commented-out import into an edge")`.
- Ruby RSpec has the same shape and is **not** covered: `ruby.ts` needs the rule on `call`/`do_block` nodes.

## `flow`

Call sites of a file, directory, or glob, grouped by scope and then by callee. It parses once per file through the
adapter's `callTargets` (no usage index, no call graph); `scopeAt`/`ownerScope` from `usages.ts` decide ownership.

- **Rows are call expressions, not source lines.** A line holding `.filter((line) =>` or `filter ?? ""` is a fragment;
  `callee(args)` is the unit a reader scans. Multi-line arguments collapse to one row, trailing comma removed.
- **A call that opens a block belongs to the enclosing scope and prints as the bare callee** (`describe  :1`), because
  its arguments span the whole body. A suite's rows are therefore its cases (`it  ×2  :2,:6`), each case being its own
  scope heading.
- **Only a call inside another call's *callee* is dropped** (`expect(x)` within `expect(x).toBe(y)`); a call in another
  call's arguments is kept — `timing.measure("x", () => work())` is two things the scope does.
- **Repeats collapse** into `callee  ×N  :line,line,…` (six lines, then `,…`); a single call prints whole.
- **Scopes and files.** `Name  :start-end` with the qualified owner (`BashTokenizer::tokenize`), or
  `describe "title"  :start-end`; each file prints `path  · N call sites · M scopes`. 40 callee rows per scope, then
  `# +N more call site(s)`; the header counts withheld ones.
- **`query` selects scopes by name**, listing every match under its own heading with its range.
- Grammar note: Ruby's paren-less `helper` is an `identifier`, not a `call` node, so it is invisible to both `flow`
  and `usages`.

## Search rows for blocks

A block row is the callee, the quoted title, and the suite in parentheses:
`test/x.test.ts:101-110  it  "caps one scope's rows"  (outline flow)`. The kind column says `it`/`describe`, not
`block`; the signature is dropped because for a block it *is* the name.

Two dedupe rules sit in the hit assembly, and both were visible bugs before they were rules:

- a body row whose declaration is already listed by name/doc **folds its evidence onto that row** (the same location
  used to appear twice, once with `[body]`);
- a body row whose evidence sits inside a listed **descendant** is dropped, or a case's line prints under its suite's
  heading.

Related rows are guesses and are counted as such: the summary prints literal matches only, `no literal matches ·
N related guesses` when nothing literal landed, and `matches` carries the literal count. A literal row displaced below
the related rows is named in the footer (`# also: …`), not left to a page the caller may never open.

## Digest empty state

A file with no declarations says what it does have:
`# no declarations · 17 top-level call sites · outline(action="flow", path="…") lists them`, or a
re-export/comment-only line. The count is one usage-index pass taken **only** on the empty path. This exists
because `src/index.ts` answering `# no declarations` is what teaches an agent that `outline` does not apply to
entrypoints or scripts.