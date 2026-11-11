---
name: outline-tool
description: The `outline` tool in src/tools/code - digest/search/show/usages for C/C++/HIP, JS/TS, Java, C#, Go, Rust, Python, PHP, Ruby, and Markdown headings.
category: architecture
priority: 7
keep_updated: true
---

# `outline` tool

`digest` maps a file or directory, `search` finds declarations by partial name, `show` returns exact source for
named declarations, and `usages` lists syntactic occurrences. Registered from `src/index.ts` beside the file-tool
hooks; full design notes are in `src/tools/code/README.md`.

## Invariants

- **One filesystem view.** All I/O goes through `CodeSource` (`source.ts`). With a container active,
  `ContainerCodeSource` uses the session's `fs`/`spawn` and never host `fs`; the source is chosen per call from
  `ContainerState.sessionFor`, because a session can move onto a container after an image build.
- **Local confinement is per file.** `LocalCodeSource.assertReadable` realpaths every file before
  `loadParsedFile` reads it, so a symlink below the root cannot escape the cwd.
- **The parse buffer is not the output buffer.** `adapters.ts` is the one language registry: each entry owns its
  grammar, preprocessor, parser, and `usages` call sites. Only C++/HIP preprocesses (`preprocess.ts`), blanking
  HIP/CUDA qualifiers, `<<<>>>` launches, declaration macros, attributes, and `= {}` defaults with **same-length**
  replacements; directives are copied verbatim. `cpp.ts` parses that buffer but slices signatures and source from
  the original, so offsets and `__global__` survive, and `declarationStart()` recovers blanked prefix macros.
  Every other language uses an identity preprocessor; Markdown is line-scanned and a heading's doc text is its
section prose, so sections are searchable by content (`outline-tool/search.md`).
- **The declaration IR is not an AST.** Adapters emit `Declaration` (kind, qualified name, ranges, signature,
  parameter types, access, children) through `visitor.ts`; parser node types never reach an action or the
  formatter. Body walkers also extract inner functions and arrow/function constants (JS/TS), named lambdas (C++),
  and Python nested `def`s. Nested names are `outer::inner`.
- **No persistent index.** Parsed files live in a disposable 2Q cache (2,000 entries / 64 MiB, keyed by path +
  mtime + size); eviction only costs a reparse. Search hits and the usage index hang off `ParsedFile` in
  `WeakMap`s, so a changed file drops them with the object.
- **`usages` reuses a per-file identifier index.** Built once from plain data, then the WASM tree is released;
  later symbols filter it instead of reparsing. Files ≥256 KiB index in the parser worker; Markdown has none.
- **Large files leave the main thread.** `worker.ts` lazily starts one `parse-worker.mjs` for files ≥256 KiB,
  loading parsers through jiti; abort terminates it rather than waiting for a synchronous parse. A missing loader
  or worker error falls back to inline parsing, and small files never pay the startup cost.
- **Loops yield.** `common/async.ts`'s referenced `yieldToEventLoop` sits between parsed files and at index/search
  boundaries with `AbortSignal` checks, so a long scan does not starve the TUI.
- **Routing lives in an `outline_tool_guide` section, not in the description.** Triggers name the agent's next
  action (about to `read` a long file, about to `rg` for a declaration, have a symbol name) and three literal
  invocations carry the `digest → show → usages` workflow; cheapness is stated, tidiness is not. **Intent-level
  triggers are the failure mode**: asked whether a question is "about code structure", an agent already heading
  for `rg` answers no. State the boundary as a real limitation, since a wasted turn teaches preference for `rg`.
  **The limitation must be the literal one.** `search` still appends relevance-ranked `[related]` rows when
  names and doc comments are thin, and `SEMANTIC_HINT` is suppressed once hybrid is active, so a guide saying
  `search` reads "names and doc comments and nothing else" leaves the agent no in-band signal that a conceptual
  query can land. The honest boundary is "no identifier or doc comment spells it out", not "no such code".
  `promptSnippet` is that per-turn surface, `description` the call contract; action glosses belong to the enum.
- **`usages` is syntactic.** It matches the selector's last component on purpose (call sites say
  `socket.connect`, not `Socket::connect`). Overloads, generics, templates, macros, and dynamic dispatch are not
  resolved; clangd is the eventual provider for C++ references.
- **`search` ranks in tiers.** Exact name, name prefix, name substring, then doc-comment tokens (all required,
  any order); below those a relevance tail (BM25 always, opt-in embeddings fused by RRF) and finally a capped
  fuzzy identifier pass. A tail row is tagged `[related]`. Comments outside a declaration's doc block, strings,
  and config stay with `bash`/`rg`. Details: `outline-tool/search.md`.

## Defaults

4,000-character `limit`, 1 MB file cap, 2k discovered files, and build/out/cmake-build/third_party/generated
ignored; `[huge]` files render top-level declarations only, and digest degrades to a directory map over the
limit. With a directory `path`, `show` pairs headers with
definitions and lists same-signature definitions across files. Extracted blocks are dedented to the
declaration's indentation. Scanning `.` honors ignore files; an explicitly named subdirectory is scanned
literally, so fixtures under an ignored path stay reachable.

Cuts are resumable: every action takes `offset` in rendered body lines and a cut ends `# next: offset=N`. Pages
prefer block boundaries but can resume inside an oversized block; a line longer than the limit cannot be split,
and the page reports the limit needed.

`show`/`usages` split a comma-joined `symbols` entry at top level only (`splitSymbolList`), so an overload
selector's parameter list survives; empty entries drop and repeats stay, because `usages` counts them. A `show`
parameter hint may be a leading subset (the output notes it was partial), and a symbol missing from the target
file is looked up in the enclosing directory then the cwd, naming the file it actually lives in.

## Extension points

`@vscode/tree-sitter-wasm` bundles the runtime and grammars. A new language is a grammar id plus an extraction
adapter registered in `adapters.ts`, which `parse.ts` and `usages.ts` both consume. Bash, CSS, INI, regex, and
PowerShell are deferred; resolved references would be a future provider.

## Targeted references

- `src/tools/code/README.md` — action semantics, per-language behavior, preprocessor rules, limits, tests.
- `outline-tool/search.md` — search tiers, BM25 parameters, the semantic tail, artifact/index layout, build cost.
- `src/tools/code/adapters.ts` — language registry: grammar, preprocessor, parser, call sites.
- `src/tools/code/visitor.ts` — shared declaration bookkeeping for new adapters.
- `src/tools/code/parse.ts` — parse dispatch through the registry.
- `src/tools/code/cpp.ts` — C++/HIP extraction and the `declarationStart()` prefix-macro recovery.
- `src/tools/code/typescript.ts` — JavaScript/TypeScript/TSX extraction.
- `src/tools/code/java.ts`, `csharp.ts`, `go.ts`, `rust.ts`, `python.ts`, `php.ts`, `ruby.ts` — per-language
  extraction and scope/access rules.
- `src/tools/code/markdown.ts` — heading extraction without a grammar.
- `src/tools/code/preprocess.ts` — the byte-preserving HIP/CUDA and macro neutralizer.
- `src/tools/code/search.ts`, `fuzzy.ts` — declaration-name search and its zero-hit approximate fallback.
- `src/tools/code/source.ts` — container/local filesystem seam and confinement.
- `src/tools/code/cache.ts` — the 2Q parsed-file cache and its entry/byte eviction policy.
- `src/tools/code/usages.ts` — syntactic identifier indexing and scope/tag classification.
- `src/tools/code/worker.ts`, `parse-worker.mjs` — the lazy large-file worker and its jiti bootstrap.
- `test/tools/code/`, `test/helpers/code-source.ts` — parser/action, source, cache, worker, registration coverage.
