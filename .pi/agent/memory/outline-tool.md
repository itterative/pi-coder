---
name: outline-tool
description: The `outline` tool in src/tools/code - digest/search/show/usages for C/C++/HIP, JS/TS, Java, C#, Go, Rust, Python, PHP, Ruby, and Markdown headings.
category: architecture
priority: 7
keep_updated: true
---

# `outline` tool

Agent-facing `outline` tool answers four questions: `digest` (map a file or directory), `search` (declarations by
partial name), `show` (exact source for named declarations), and `usages` (syntactic occurrences). Registered from
`src/index.ts` next to the file-tool hooks. Full design notes live in `src/tools/code/README.md`.

## Invariants that are easy to break

- **One filesystem view.** All I/O goes through `CodeSource` in `src/tools/code/source.ts`. With a container
  active, `ContainerCodeSource` uses the session's `fs`/`spawn`; it never reads host `fs`. Source selection is
  per call from `ContainerState.sessionFor`, because a session can move onto a container after an image build.
- **Local confinement is per file.** `LocalCodeSource.assertReadable` realpaths every file; `loadParsedFile`
  checks it before reading, so a symlink below the root cannot escape the cwd.
- **The parse buffer is not the output buffer, and preprocessing is adapter-scoped.** `adapters.ts` is the one
  language registry; each entry owns its grammar (when it has one), preprocessor, and parser, and `usages`
  resolves the same entry instead of guessing from a grammar id. Only C++/HIP runs `preprocess.ts`, which neutralizes HIP/CUDA
  qualifiers, `<<<...>>>` launches, declaration macros, C++/GCC attributes, and `= {}` defaults with
  **same-length** replacements that preserve newlines. Preprocessor directive lines are copied verbatim.
  Every other language uses an identity preprocessor; Markdown is line-scanned without a grammar. `cpp.ts`
  parses the neutralized text but every signature/source slice comes from the original, so offsets and
  `__global__` survive; `declarationStart()` recovers blanked prefix macros and attributes for signatures.
- **The declaration IR is not an AST.** `parse.ts` dispatches to language adapters, which emit `Declaration`
  (kind, qualified name, ranges, signature, parameter types, access, children) through the shared
  `visitor.ts` bookkeeping. Parser node types do not leak into digest/search/show/usages or the formatter.
  C++/HIP parse the neutralized buffer and slice the original; the tree-sitter adapters parse directly and
  Markdown is line-scanned. The function-body walkers extract named inner functions and arrow/function constants
  (JavaScript/TypeScript), named lambdas (C++), and Python nested functions. Nested qualified names are
  `outer::inner` or `dequant::decode::decode_row`.
- **No persistent index.** Parsed files use a disposable 2Q cache (2,000 entries / 64 MiB, keyed by path +
  mtime + size); eviction only costs a reparse. Search hits use a four-query per-file WeakMap keyed by
  normalized query; a changed file creates a new `ParsedFile` and drops them.
- **`usages` reuses a per-file identifier index.** A cached file builds a plain-data index once and releases the
  WASM tree; later symbols filter it, so a multi-symbol scan does not reparse. It lives on the `ParsedFile` via
  `WeakMap`, so cache eviction releases it. Files ≥256 KiB index in the parser worker; Markdown has none.
- **Large files leave the main thread.** `worker.ts` lazily starts one `parse-worker.mjs` and sends files at or
  above 256 KiB there. The worker loads the parser modules through jiti, keeps tree-sitter warm, and is
  terminated on abort so cancellation does not wait for a synchronous parse. A missing loader, failed start, or
  worker error falls back to inline parsing; small files never pay the worker startup cost.
- **Loops yield.** `common/async.ts`'s referenced `yieldToEventLoop` is used between parsed files and at
  index/search boundaries, with `AbortSignal` checks, so a long scan does not starve the TUI. `stats/scan.ts`
  uses the same helper instead of a local timer.
- **`usages` is syntactic.** It matches the selector's last component on purpose (call sites say
  `socket.connect`, not `Socket::connect`). Overloads, generics, templates, macros, and dynamic dispatch are not
  resolved; clangd is the eventual provider for C++ references. The index resolves grammar, preprocessor,
  and call-site shapes from the same `LanguageAdapter`, and still releases the tree after building plain entries.
- **`search` is declaration-name search, not grep.** A plain query is a case-insensitive simple-name substring; a
  query containing `::` or `.` matches the qualified name. Literal hits are ranked exact, prefix, substring. Only
  when the literal pass finds nothing does `fuzzy.ts` run a bounded Damerau-Levenshtein comparison against the
  full name and snake/camel tokens; queries under three characters are not fuzzed. Approximate rows are marked
  `~N`. Comments, strings, and source text stay with `bash`/`rg`.

## Defaults

16k-character `limit`; 1 MB file cap; 2k discovered files; build/out/cmake-build/third_party/generated
directories ignored; a 2Q parsed-file cache keyed by path + mtime + size; `[huge]` files render top-level
declarations only; digest degrades to a directory map over the limit.
Declaration rows and
locations use `:start-end` or `:line`. `show` pairs headers with definitions when `path` is a directory and
lists locations for same-signature definitions in different files. Extracted blocks are dedented by
declaration indentation. Scanning `.` honors the tree's ignore files; an explicitly named subdirectory is
scanned literally, so fixtures under an ignored path are reachable.

Character-limit cuts are resumable: every action takes `offset` in rendered body lines, and a cut result ends
`# next: offset=N`. Pages prefer block boundaries but can resume inside an oversized block; a source line
longer than the limit cannot be split; the page reports the limit needed.

## Extension points

`@vscode/tree-sitter-wasm` bundles the runtime and grammars for C++, C#, Java, Go, Rust, Python, TS/TSX, JS,
Ruby, PHP, Bash, CSS, PowerShell, Regex, and INI. A new language is a grammar id + extraction adapter registered
in `adapters.ts`; `parse.ts` and `usages.ts` both consume that entry. Current entries cover C/C++/HIP,
JavaScript/JSX (one `javascript` grammar), TypeScript/TSX, Java, C#, Go, Rust, Python, PHP, Ruby, and Markdown
headings. Bash, CSS, INI, regex, and PowerShell are deferred; resolved references would be a future provider.

## Targeted references

- `src/tools/code/README.md` — full action semantics, per-language behavior, preprocessor rules, limits, and tests.
- `src/tools/code/adapters.ts` — language registry: grammar, adapter-scoped preprocessor, parser, and call sites.
- `src/tools/code/visitor.ts` — shared declaration bookkeeping for new adapters.
- `src/tools/code/parse.ts` — parse dispatch through the registry.
- `src/tools/code/cpp.ts` — C++/HIP declaration extraction and the `declarationStart()` prefix-macro recovery.
- `src/tools/code/typescript.ts` — JavaScript/TypeScript/TSX declaration extraction.
- `src/tools/code/java.ts`, `csharp.ts`, `go.ts`, `rust.ts`, `python.ts`, `php.ts`, `ruby.ts` — per-language
  declaration extraction and scope/access rules.
- `src/tools/code/markdown.ts` — line-oriented heading extraction without a tree-sitter grammar.
- `src/tools/code/preprocess.ts` — the byte-preserving HIP/CUDA and macro neutralizer.
- `src/tools/code/search.ts` and `src/tools/code/fuzzy.ts` — declaration-name search and the zero-hit
  approximate fallback.
- `src/tools/code/source.ts` — container/local filesystem seam and confinement.
- `src/tools/code/cache.ts` — the 2Q parsed-file cache and its entry/byte eviction policy.
- `src/tools/code/usages.ts` — syntactic identifier indexing and scope/tag classification.
- `src/tools/code/worker.ts` and `src/tools/code/parse-worker.mjs` — the lazy large-file worker and its jiti
  bootstrap.
- `test/tools/code/` and `test/helpers/code-source.ts` — C++/TypeScript parser and action, source, cache, worker,
  and registration coverage.