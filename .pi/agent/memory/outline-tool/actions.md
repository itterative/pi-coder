---
name: actions
description: What each outline action shows - digest detail modes and the directory map, show's heading and comma rules, one-row-per-line usages, offset cuts, and narrowing filters.
category: architecture
priority: 7
keep_updated: true
---

# Actions

## Routing and the guide

Routing lives in an `outline_tool_guide` section, not in the description. Triggers name the agent's next action
(about to `read` a long file, about to `rg` for a declaration, have a symbol name, about to write a test) and five
literal invocations carry the `digest → show → usages → flow → deps` workflow; cheapness is stated, tidiness is not.
**Intent-level triggers fail**: an agent already heading for `rg` answers "no, not structure". State the boundary as
a real limitation, since a wasted turn teaches preference for `rg`.

**The framing is structure, not declarations.** The guide used to read as a declaration tool, and a test suite, an
entrypoint, or a script then correctly classified as out of scope — the files whose shape is worth one call. So the
digest trigger names those files by name, blocks put `describe`/`it` trees in the map, and `flow` is offered for the
behaviour question a `read` would otherwise answer. Do not let the wording drift back to "declaration map".

**The limitation must be the literal one.** `search` still appends relevance-ranked `[related]` rows when names and
doc comments are thin, and `SEMANTIC_HINT` is suppressed once hybrid is active, so a guide saying `search` reads
"names and doc comments and nothing else" leaves the agent no in-band signal that a conceptual query can land. The
honest boundary is "no identifier or doc comment spells it out", not "no such code".

## No action guesses

- **`usages` is syntactic, and one row is one line.** It matches the selector's last component on purpose (call
  sites say `socket.connect`, not `Socket::connect`). Same-line, same-tag occurrences collapse to one row while the
  header keeps counting occurrences (`· 74 matches on 66 line(s) ·`); a def and a call on one line stay separate.
  Overloads, generics, templates, macros, and dynamic dispatch are not resolved; clangd is the eventual C++ provider
  for references.
- **`deps` is a file graph, not a call graph.** Text extraction on comment-masked source, three resolution states,
  dependents as a whole-tree scan (`outline-tool/deps.md`).
- **`search` ranks in tiers.** Exact name, prefix, substring, doc phrase, frontmatter/doc tokens, literal body
  text (`[body]`), then the relevance tail and a capped fuzzy pass. Rows carry `[doc]`, `[frontmatter]`,
  `[body]`, `[related]`; body chunks (`semantic/chunks.ts`) make code inside a long declaration reachable from the
  vector channel. With no strong lexical hit the related rows lead, but the leading page keeps one slot for the
  strongest literal row. Tiers, caps, chunks: `outline-tool/search.md`.
- **A filtered view says what it hid.** Signatures mode drops a class's non-public members, which reads as a class
  with no extension points, so the digest footer counts them (`# visibility: N non-public member(s) hidden`).
  Access hides only — fields, enum members, and nested variables are the shape of a signature list — and a root
  variable is a module constant, so the file's own map keeps it. A **single-file** digest names the kind hides too
  (`# kinds: 2 enum members, 1 field hidden in signatures detail; detail=full lists all`) and, when nothing visible
  remains, replaces `# no declarations` with that explanation. A directory digest omits the kind line because it
  would repeat per file. The directory map, which shows no members, carries no note. **`show` prints the same count in
  the container header** (`class ListViewComponent · 8 member(s) · 13 non-public hidden (detail=full lists all)`),
  because the member count is what a caller repeats as the class's shape.
- **Narrowing is a parameter.** A `path` pattern and `kind` narrow the discovered set (`deps` takes a literal file);
  `# filter:` names them and any hidden count (`outline-tool/search.md`). A zero-hit under the default scope adds
  `# note: the default scan skips ignored paths (…); pass path= to search one`, because a named path is scanned
  literally while the cwd scan honors ignore files.

## `digest`

4,000-character `limit`, 1 MB file cap, 2k mapped files (patterns are walker-applied, so the cap counts matches),
and build/out/cmake-build/third_party/generated ignored. files over 1,500 lines render top-level declarations only, and digest
 degrades to a directory map over the limit. Scanning `.` honors ignore files; an explicitly named subdirectory is
literal, so ignored fixtures stay reachable. C/C++ `#define` and Rust `macro_rules!` are `macro` declarations (signature the first line, body the value or first rule) at file scope, because the preprocessor is textual; every preprocessor branch is indexed, so `kind=macro`, `show`, and literal body search all reach them. With a directory `path`, `show` pairs headers with definitions and
lists same-signature definitions across files — a digest row's `:start-end` is the span to `read`.

## `show`: a name, or a heading

`show`/`usages` split a comma-joined `query` entry at top level only (`splitSymbolList`), so an overload
selector's parameter list survives; empty entries drop and repeats stay, because `usages` counts them. A `show`
parameter hint may be a leading subset (the output notes it was partial), and a symbol missing from the target
file is looked up in the enclosing directory then the cwd, naming the file it actually lives in.

**A dedented body says so.** An indented declaration's source is dedented by its own indentation so it reads
cleanly, which means the printed text is not the file's bytes. Such a body carries, before the source,
`# dedented: read <path>:<start-end> for the exact indentation before editing`; an edit or a string replacement
needs that range. The note sits before the body so a line-comment language cannot mistake it for code.

**A heading is matched as prose, a symbol is not.** Exact names would leave most headings unreachable, so a heading
also matches by normalized prefix and substring (case, leading `#`, punctuation ignored), every candidate is
reported, and a note names the loose rows; identifier matching is unchanged. A comma in a title is text: an entry
whose split parts all miss but whose text names a heading is used whole (announced as `# comma:`).

## Prose and `flow`

- **Prose is matched as prose.** `format.ts` `headingMatch` covers Markdown headings *and* `block` titles: prefix
  and substring of the normalized title, every candidate reported, a `# heading:` / `# title:` note naming loose
  rows. A symbol still matches exactly, and a comma-joined entry that names one title is used whole (`# comma:`).
- **`flow` lists call expressions by scope and callee**, parsed from the adapter's `callTargets`: a call that opens a
  block belongs to the enclosing scope and prints as the bare callee, only a call inside another call's *callee* is
  dropped, repeats collapse into `callee  ×N  :lines`, 40 rows per scope with a `# +N more` count.
  `outline-tool/blocks-and-flow.md`.
- **A kind-filtered digest names the filtered-away owner** (`Port::  private void reset()`), because the flat list has
  no tree to carry it.
- **A guess is not a match.** `search` counts literal rows only (`no literal matches · N related guesses`), folds a
  body row's evidence onto a row that already lists its declaration, and names a literal row the related-led page
  pushed below the fold (`# also: …`) — only when the page cannot show it. The per-channel counts describe the rows the
  page keeps: a doc row the tail displaced is a guess there, so it is not also counted `by doc text`.
- **A file with no declarations is not empty.** `digest` counts its top-level call sites and names `flow` instead of
  saying `# no declarations`. The directory-map fallback says *why* it replaced the declarations and uses
  `# deeper:` (not `# next:`) for its descend hint, so a complete map never reads as a truncated one. The map is a
  tree with a fair budget: each directory shows its immediate child directories as rows instead of flattening their
  files into longer paths, its direct files sorted by declaration count (zero omitted), and names are spent one packed
  line per directory per sweep — greedy size order left every later directory anonymous. A small match set whose names
the tree would hide (≤8 files with some sitting in a child-directory count) renders flat with root-relative paths
instead: `permissions*.ts` used to answer `src/ 1 file · modules/ 1` twice and name neither file. `# deeper:` names the three
  largest directories, and the footer legend separates `file (declarations)` from `dir/ files`.

## Cuts

**Rows are grouped by file.** A search prints the path once as a heading, then its rows as `:range  kind  name`
subitems indented under it, carrying the same tags. A file named on ten rows used to cost ten full paths; the grouping
is in `groupBlocks` (`search.ts`), and `renderHit` no longer includes the path at all. `groupHitsByFile` runs first, so
the grouping holds across channels too: a related-led page that drew a guess and a literal row from one file used to
head it twice (the guesses render in one pass, the literal rows in another), and a repeated path reads as a second
file. Grouping by first appearance keeps the ranked order of files and keeps the block offsets ascending for the
pager. A heading row prints its literal text only (`heading  ## Install`):
`Parent::Parent::Child` repeated the chain a digest map already shows by indentation, and the signature column said
the title again. `show` still matches the chain, so the row stays addressable. A related row's score rides on
the tag (`[related 73%]`: a cosine prints as itself, since it is already 0-1; BM25 and fused RRF print a bare
`[related]`, because a share of the best guess is a ranking, not a similarity). `moreNote` names the file a cut page
hid and carries **no count** — `# next:`
already has the line count, and two counters a line apart read as two different remaining amounts. Its row starts are
exact line indices from `groupBlocks`, not a text match against the page. The `# related:` legend is suppressed when no
related row is on the page (a beyond-end offset), so it never explains rows the page does not show; the header count
stays, because that is a fact about the whole result. The same rule covers `# also:` — it names the literal row the
related-led page pushed down, so it fires only when the tail is non-empty (`displacedNote` takes `related.length`) and
that row is not on the page, because naming a row the caller can already read repeats it. A prose query whose
candidates all fell below the floor has no guesses to "follow", and the note used to promise them anyway. A page cut
short also says so: `# page: rows 1-6 of 38 · the header counts the whole result` reconciles the whole-result tallies
in the header with the rows the character budget left.

**A continuation reprints the heading it lost.** `renderWithinBudget` treats each block's first line as a heading when
the caller passes `{ headings: true }`: a page starting inside a block reprints that line, and a cut that would end
immediately after one moves back a line so the heading leads the next page instead of dangling. Callers opt in because
only they know whether their blocks lead with a heading — search (per file), usages (per file), deps (per section),
flow (per file), and show (per declaration) do; digest and raw bodies do not. Trailing separator lines are trimmed
**after** the retreat, since retreating onto one is what re-exposes it. Multi-symbol `usages` keeps one page header
and makes each symbol's line a subheading (`<symbol> · N matches`), so the block heading is the symbol rather than a
second `# usages …` copy; it passes one block per *paragraph* (the subheading, then each file group), so a
continuation inside a file reprints the file path. `flow` deliberately keeps one block per file: its continuation
reprints the file header, not the enclosing scope, because per-scope blocks would either add a blank line per scope
or need a third heading mechanism for a label the next scope supplies anyway. Usages scope labels (`<file scope>`,
`runDeps`) have the same limit for the same reason.

Cuts are resumable: every action takes `offset` in rendered lines and a cut ends with one `# next:` line carrying
`N more line(s)` and the complete `outline(…)` call that continues it — paste the call, do not re-derive the
parameters. **The directory map is the one terminal result**: it is a summary bounded by the tree's directory count,
so it is never paged and an `offset` into it is ignored rather than answered with one directory per call. The one
exception is `show`, whose offset is a **source line** (the note ends
`· source line, resumable with read`) so it can be passed straight to `read offset=550`; its blocks carry a
`sourceStart`/`prelude` map to translate, and a result spanning two files **or requesting symbols out of source order**
falls back to a rendered line — a source cursor there can step backwards, and a reader following `# next` assumes it
advances. Two failure modes to keep out: the inverse (`sourceLineToBodyOffset`) must find the block whose range
*contains* the requested line rather than walking from the first block (that replayed a page forever when the budget
fitted only a declaration header), and a reprint heading must yield to content when it would crowd out the only line
that fits. A page
never starts on the blank line between two blocks. There is no block allocator: the character `limit` is the page
size and lines are the unit, so a page may start inside a declaration. A line longer than the limit cannot be
split, and that page reports the limit needed.
