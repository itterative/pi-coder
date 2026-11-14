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
(about to `read` a long file, about to `rg` for a declaration, have a symbol name) and three literal invocations
carry the `digest → show → usages` workflow; cheapness is stated, tidiness is not. **Intent-level triggers fail**:
an agent already heading for `rg` answers "no, not structure". State the boundary as a real limitation, since a
wasted turn teaches preference for `rg`.

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
  would repeat per file. The directory map, which shows no members, carries no note.
- **Narrowing is a parameter.** A `path` pattern and `kind` narrow the discovered set (`deps` takes a literal file);
  `# filter:` names them and any hidden count (`outline-tool/search.md`).

## `digest`

4,000-character `limit`, 1 MB file cap, 2k mapped files (patterns are walker-applied, so the cap counts matches),
and build/out/cmake-build/third_party/generated ignored. `[huge]` files render top-level declarations only, and digest
 degrades to a directory map over the limit. Scanning `.` honors ignore files; an explicitly named subdirectory is
literal, so ignored fixtures stay reachable. With a directory `path`, `show` pairs headers with definitions and
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

## Cuts

Cuts are resumable: every action takes `offset` in rendered body lines and a cut ends `# next: offset=N`. Pages
prefer block boundaries but can resume inside an oversized block; a line longer than the limit cannot be split,
and the page reports the limit needed.