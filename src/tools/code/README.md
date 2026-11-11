# outline tool

One agent-facing tool, `outline`, with four actions:

- `digest` — map a file or directory: namespaces/types, public signatures, line ranges, `[def]` tags.
- `search` — declarations whose names or doc comments match a query, with a conservative typo fallback.
- `show` — exact source for named symbols; a directory target pairs header declarations with source definitions.
- `usages` — syntactic occurrences with `[def]` / `[decl]` / `[call]` / `[ref]` tags, plus `[launch]` for
  HIP/CUDA kernel launches.

`show` and `usages` take a `symbols` array, and an entry may itself be a comma-joined list
(`"A::b, C::d"`): `format.ts`'s `splitSymbolList` splits on **top-level** commas only, so an overload
selector's parameter list (`Socket::connect(const Address&, int)`) survives intact. Empty entries are
dropped; repeated ones are kept, because `usages` counts them separately.

A `show` selector's parameter hint may be a **leading** subset: `Type::method(const X&)` selects the overload
whose parameters start with those types, and the output says the hint was partial together with the full
signature. When a requested symbol is absent from the target, `show` greps the containing directory and then
the working directory for it and names the files it actually lives in, so pointing at the wrong file no longer
reads like naming a symbol that does not exist.

The surface and defaults are documented in `index.ts`; this file records the invariants that are easy to break.

## Filesystem seam

All I/O goes through `CodeSource` (`source.ts`):

- `LocalCodeSource` uses the host filesystem and confines every read to the cwd (realpath, so a symlink cannot
  escape).
- `ContainerCodeSource` uses the active container session's existing `fs` and `spawn` operations, so the tool
  answers from the same view as `bash`, `read`, `edit`, and `write`.

The container source is selected per call from `ContainerState.sessionFor`, not captured at registration: a
session can move onto a container after an image build. **Never** fall back to host `fs` while a container is
active — that is the bug `container/grep-tool.ts` exists to avoid.

## Parser

`@vscode/tree-sitter-wasm` supplies both the `web-tree-sitter` runtime and the compiled grammars. Native
`tree-sitter-*` bindings are avoided because the checkout sets `ignore-scripts=true` and the native prebuild path
is not worth the packaging cost.

`parse.ts` dispatches through `adapters.ts`, which is the single registry for every supported language. Each
entry owns its grammar id, its parse-only preprocessor, its parser, and the call-site shapes used by `usages`.
Adapters extract the same small `Declaration` model (kind, name, qualified name, ranges, signature, parameter
types, access, children). It is not an AST and no parser node types leak past an adapter, so digest, search,
show, usages, and the formatter stay language-neutral. New adapters share `visitor.ts` for ranges, signatures,
doc-comment adjacency, qualified names, and dedupe. Markdown is the exception to the tree-sitter rule: it has no
bundled grammar, so `markdown.ts` scans ATX/setext headings and fenced-code boundaries directly.

Supported sources:

- C and C++ (`.c`, `.h`, `.cc`, `.cpp`, header variants, modules)
- CUDA and HIP (`.cu`, `.cuh`, `.hip`)
- JavaScript and JSX (`.js`, `.jsx`, `.mjs`, `.cjs`), using the `javascript` grammar
- TypeScript and TSX (`.ts`, `.tsx`, `.mts`, `.cts`)
- Java (`.java`), C# (`.cs`)
- Go (`.go`), Rust (`.rs`)
- Python (`.py`, `.pyi`, `.pyw`), PHP (`.php`, `.phtml`), Ruby (`.rb`, `.rake`, `.gemspec`)
- Markdown (`.md`, `.markdown`) — ATX/setext headings

### HIP/CUDA preprocessor

Preprocessing is adapter-scoped: only the C++/HIP registry entry runs `preprocess.ts`. `parse.ts` and
`usages.ts` both resolve the same `LanguageAdapter`, so a usage index can never silently use a different parse
buffer from the declaration parser. Every other language uses the identity preprocessor.

`preprocess.ts` neutralizes tokens `tree-sitter-cpp` cannot parse:

- execution-space qualifiers (`__global__`, `__shared__`, …) become same-length stand-ins;
- `kernel<<<grid, block>>>(args)` becomes `kernel    (args)` with the launch config replaced by spaces;
- all-caps macros alone on a line (`FMT_BEGIN_NAMESPACE`, `UCLASS(...)`, `GENERATED_BODY()`) are removed;
- declaration-prefix macros (`MYLIB_API`, `FMT_CONSTEXPR20`, `VIBES_AVX2`, …) are removed where they would
  break parsing;
- C++ attributes (`[[nodiscard]]`, …) and GCC `__attribute__((...))` are blanked, and `= {}` defaults become
  `= 0`; the original text is restored in signatures and source slices;
- preprocessor directive lines are copied verbatim, so `#define VIBES_AVX2` and `#ifndef VIBES_KERNEL_HASH`
  are not mistaken for declaration macros.

Two invariants make this safe:

1. Every replacement preserves byte length and newlines, so tree-sitter offsets still index the original file.
2. **All output slices the original source.** The neutralized buffer is only ever parsed. Signatures therefore
   still show `__global__`, `MYLIB_API`, and the real parameter text.

`declarationStart()` walks backwards over original prefix macros and attributes to keep them in a signature
after their parse stand-in was removed. Prefix macros are only a parse aid; the exact source remains in the
output.

### C++ behavior worth knowing

- Qualified names use `::`; out-of-line `Socket::connect` keeps that name and can be paired with its header
  declaration by `show` when the target is a directory.
- Overloads are grouped by qualified name + normalized parameter types; `show` accepts
  `Type::method(const X&)` as a selector.
- Templates are transparent: the `template <...>` prefix belongs to the declaration it wraps.
- Preprocessor branches and duplicate declarations are deduped by qualified name, kind, signature, and
  definition state; a forward declaration and its definition remain distinct.
- Named lambdas assigned to locals are extracted as functions (`dequant::decode`), including lambdas nested in
  those bodies (`dequant::decode::decode_row`). Anonymous inline callbacks stay part of the enclosing source
  because they have no stable name to select.
- Parse errors are counted and reported, never fatal.

### JavaScript and TypeScript behavior worth knowing

- JavaScript uses the `javascript` grammar for `.js`, `.jsx`, `.mjs`, and `.cjs`; JSX is part of that grammar.
  TypeScript and TSX use their own grammars. All three share the visitor in `typescript.ts`.
- Namespaces, interfaces, classes, type aliases, enums, functions, variables, and arrow-function constants are
  extracted. Class and interface members keep their `public` / `protected` / `private` access when the grammar
  provides it; JavaScript members default to public.
- `export`, `export default`, `declare`, and ambient module wrappers are included in the signature and range, so
  `show` returns the whole declaration rather than the unwrapped inner node.
- Interfaces are containers: digest lists their properties and method signatures, and `show` returns the
  interface members without the class-only public filter.
- Qualified names use the same `::` separator as C++ (`ReminderSignals::currentTurn`), while selectors still
  accept `Type.member` and `Type::member`.
- JavaScript and TypeScript have no preprocessor pass; source slices come directly from the file. JSX and TSX
  use their respective grammars.
- Named functions and arrow/function constants declared inside a function or method body are extracted as
  children of that scope (`outer::inner`, `outer::helper`). Plain local variables are not declarations, so a
  local `const value = 1` does not clutter the map; a local `const helper = () => ...` does, because it is a
  callable closure. `show outer::inner` and `usages inner` work through the nested scope.

### Java and C#

- Java packages and C# file-scoped namespaces prefix qualified names (`com::acme::Service`); C# block
  namespaces are containers.
- Classes, interfaces, enums, C# structs/records, constructors, methods, fields, and C# properties are
  extracted. Access modifiers are preserved; C# members default to private, Java members default to visible in
  the digest because package-private has no keyword to display.
- C# expression-bodied methods (`=>`) count as definitions.

### Go and Rust

- Go package and Rust module scopes prefix qualified names. Go `type` specs become structs, interfaces, or type
  aliases; receiver methods use `Type::method`. Rust structs, enums, traits, modules, constants, and type
  aliases are containers/declarations; `impl` methods attach to the implemented type.
- Visibility maps to the shared access model where the language has a keyword (`pub`, Java/C#/PHP modifiers).
  Go exports are inferred from capitalization; unexported members stay private.
- `usages` call shapes: Go `call_expression`; Rust `call_expression` and `macro_invocation`.

### Python, PHP, and Ruby

- Python classes, methods, decorated definitions, nested functions, and typed parameters are extracted;
  decorators are included in the declaration signature.
- PHP namespaces may be file-scoped or braced, and classes, interfaces, traits, enum cases, methods, properties,
  functions, and constants are extracted. A leading `$` is removed from property names but kept in signatures.
- Ruby modules, classes, instance methods, and singleton methods (`def self.build`) are extracted. Local lambda
  variables remain part of the enclosing method source because their syntax has no stable declaration name.
- `usages` call shapes: Python `call`; PHP function/member/scoped calls and object creation; Ruby `call`.

### Markdown behavior

- ATX (`# Title`) and setext (`Title` + `---`) headings become `heading` declarations; ATX headings are limited
  to levels 1–6 and up to three spaces of indentation. Headings inside fenced code blocks and YAML front matter
  are ignored.
- Heading hierarchy is the declaration hierarchy, and each heading's range runs to the next heading of the same
  or higher level. `show Guide::Install` therefore returns the whole section, not just the heading line.
- A heading's **doc text is its own prose**: from the end of the heading line to the next heading of *any* level,
  trimmed, and unset when the heading has no prose before its first child. That one field feeds the doc tier of
  `search`, the BM25 document, and the embedded text, so a section is findable by its content. It is deliberately
  not the whole section range, which would repeat every subsection in the parent's doc, BM25 document, and vector.
  Setext underlines and fenced code belong to the heading/prose correctly: the underline is excluded, a fence is
  prose. Markdown prose skips the comment-marker stripping the code path uses, or `*` bullets and `**bold**` would
  be eaten. `show` prints the section once: a doc range that sits *inside* the declaration range is not rendered
  separately (`sourceForDeclaration`).
- `usages` has no identifier index for Markdown and reports zero matches. There is no code to resolve.

## Output and limits

- `digest` degrades to a directory map when the result exceeds the character limit, and large files (`[huge]`) render
  only top-level declarations. `detail="full"` includes private/protected members, fields, enum members, and
  variables. Declaration rows show `:start-end` when the declaration spans lines, and `:line` for a one-liner;
  `search` locations and `show` headers use the same range convention.
- `show` defaults to `full` for functions/fields and `signatures` for containers; `detail` overrides that.
  Containers in signatures mode show only public members. `show` keeps signatures intact, while digest shortens
  long ones. Extracted source is dedented by the declaration's own indentation so nested members read cleanly;
  relative indentation inside the body is preserved. A directory target pairs declarations and definitions; a
  file target stays scoped to that file.
  When a symbol has same-signature definitions in more than one file (e.g. per-example `main` functions),
  `show` lists the locations instead of choosing one. When several overloads match, it appends a note with a
  concrete parameterized selector; narrowing to one overload removes the note.
- `usages` matches by the selector's last component, because call sites normally say
  `socket.connect(...)`, not `Socket::connect(...)`. It is **syntactic**: overloads, generics, templates, macros,
  and dynamic dispatch are not resolved. clangd is the future provider for exact C++ references. The call-site
  shapes live on each `LanguageAdapter`, so adding a language does not add a switch to `usages`. A per-file
  identifier index is built on first use and reused for every requested symbol and later calls; the WASM tree is
  released after indexing. Files at or above 256 KiB build that index in the parser worker.
- `search` is declaration-name and doc-text search, not text search. A plain query is a case-insensitive
  substring of the simple name; a query containing `::` or `.` is matched against the qualified name, so
  `CallList::` finds the members. Exact names sort before prefixes, prefixes before later substrings, and a
  doc-comment match sorts after every name match and above every approximate one; its word tokens are matched
  in any order, all required, and the row carries `[doc]`. Qualified queries skip the doc channel, because the
  qualifier already chose the scope. It reports the qualified name and signature, so the follow-up is `show`
  with an exact selector.
  Only when neither a name nor a doc comment matches does search fall back to a bounded Damerau-Levenshtein
  comparison against the full name and its snake/camel-case tokens. Queries shorter than three characters are
  not fuzzed; longer queries allow one or two edits. At most eight approximate rows are returned, nearest
  first, and a footer reports how many were withheld. Approximate rows carry `~N`, and the output says how many
  edits were allowed. A doc match outranking a near-miss name is the point: prose is where a concept lives when
  no identifier spells it out, and a plausible identifier guess is the weaker evidence.
  Strings, comments outside a declaration's adjacent doc block, config, and arbitrary source text remain the
  job of `bash` + `rg`. Search hits are cached per parsed file and normalized query (a few recent queries per
  file); a changed path + mtime + size creates a new `ParsedFile` and drops the old hits with it.

### Call timings

Every call reports where it spent its time in `details.timing` (`timing.ts`), and the TUI renders it as one dim
line under the result. The tool *text* never carries it: the agent pays tokens for text, and where a call spent its
milliseconds is a question the human reading the session asks.

    timing: 1948 ms · parse 1877 · search 58 · discover 11 · work 2 · files 737 · cached 44 · parsed 693

`source` and `semantic` cover `createCodeSource` and the search channel's setup; `discover` wraps
`discoverFiles`/`candidateFiles`; `parse` wraps `loadParsedFiles` and is where a cold cache shows up; `search` is
the action's own selection work (literal and fuzzy matching, target resolution, the usage index); `tail` is the
relevance tail. `work` is the remainder rather than another span, so the phases add up without instrumenting every
early return. The counts are what make a slow number actionable: `parsed` above zero means a cold parse (a repo-wide
first search is ~2 s against ~25 ms warm), and `all cached` beside a high total points somewhere else.

## Relevance tail

When the literal pass produces fewer than three rows, no doc-comment match, and no identifier typo matched, `search`
appends a short tail of `[related]` rows. BM25 over name/doc/signature always backs it; an opt-in embedding
channel joins once a model is downloaded and the index for the searched root is warm. The channels are fused with
reciprocal rank fusion (k=60) so their score scales never have to agree. Every embedding failure degrades to BM25
only, and the tail never fails the search.

A doc-comment match suppresses the tail (`wantsTail` in `semantic/rank.ts`): the doc tier requires every content
word of the query to appear in one declaration's prose, so it is the strongest cheap evidence there is, and the
tail would cost a query embedding (0.6–3 s warm/cold) to append rows the agent never needed. Both gates count
*evidence*, not just rows: three weak name hits buy a tail, one exact doc hit does not. The doc tier tokenizes with
the same stopword-filtered tokenizer BM25 uses (`tokenize`), so filler words in a natural-language query cannot
make an otherwise perfect prose match miss.

Vectors are content-addressed (`embeddingKey` hashes the embedded text), so an edited declaration cannot match its
old vector — the lookup would need the old text. Staleness is therefore *absence*, never a wrong answer, and the
dead entries an edit leaves behind are bytes only. Width is the one property not covered by that key: a namespace is
rejected unless `header.dims === MODEL_DIMS` (the namespace hash carries model id and text version, not dims), and a
vector whose length differs from the query vector is treated as missing rather than scored — `cosine` truncates to
the shorter length with `Math.min`, which would turn a width mismatch into plausible-looking noise. A search counts
dead entries when its file set covers the whole namespace root and schedules a compaction once they clear both
floors (`shouldCompact`: 64 entries and 10% of the live set): the build has no jobs, so it is a manifest rewrite and
a few unlinks, no model and no parse. A subdirectory search never compacts — its live set is a fragment, and pruning
then would delete the rest of the index.

**Native runtime first, wasm fallback.** On a platform with a verified native ONNX Runtime (`semantic/native.ts`,
currently linux-x64) the child loads onnxruntime-node's CPU binding directly — two downloaded files, no npm
dependency, no vendored JS wrapper. That matters because the wasm build cannot use threads in Node: it bootstraps
them through a `blob:` module import, which Node's ESM loader rejects, so it runs single-threaded and needed one
process per core. Native takes real intra-op threads. Measured on 16 cores, same artifacts: query embedding 673 ms
(wasm) → 27 ms, a 93-token document 1589 ms → 90 ms, session start 2.5 s → 0.2 s, resident 767 MB → 486 MB. Vectors
are identical (cosine 1.000000), so switching runtimes never invalidates an index. The worker picks native whenever
`PI_OUTLINE_NATIVE_DIR` points at a payload of the pinned sizes, and otherwise takes the wasm path unchanged.

One embedding child per model directory is shared by every search (`sharedEmbedRuntime`), because the tool builds a
fresh `SemanticSearch` per call for its config and consent and never disposes it. A per-call runtime would reload
the ~197 MB model on every tail search — measured as 2.5 s per search instead of 0.64 s — and leave one resident
copy of the weights per search until the child's idle timeout. With native, an idle tail search costs 27 ms of
embedding on top of ~10 ms of lexical work.

Background refreshes are capped at `refreshWorkerCount()` (half the cores, at most four), because refresh builds run
in **separate** children and compete for cores. That cap was measured against the wasm runtime, where 4 build workers
cost a concurrent query 9% of its latency, 8 workers 20%, 16 workers 124% — each child paying ~1.85 s to load the
model. Under native the cap still applies, but it caps *threads* inside one or two processes, because a native build
process is cheap to start and shares its weights across threads.

**One writer per namespace.** A refresh, a foreground build, and another pi session on the same root all publish to
the same manifest, and each build reads it once and writes its whole in-memory view at the end — so two overlapping
builds drop each other's shard records, and a pruning one deletes shard files the other just wrote. `buildIndex`
therefore takes `build.lock` in the namespace directory (pid + ownership token, taken over when the holder's pid is
dead or the file is older than two hours), holds it across read → plan → embed → publish, and releases it in a
`finally`. A build that finds it held throws; a search-triggered refresh checks first and reports "not indexed"
instead of scheduling a refresh that would bounce. Readers never take the lock: `writeManifest` publishes with a
randomly named temp file and a rename, and the journal replay tolerates a truncated final line, so a killed build
loses at most its unfinished shard.

The semantic half is downloaded, not installed: no npm dependency, ~211 MB of pinned and hash-verified artifacts
under the pi-coder state directory (plus ~48 MB for the native runtime where the platform has one), and a
content-hash shard index. `docs/outline-search.md` records the artifact manifest, the ort-in-Node constraints, the
index layout, and the measured cold-build cost (~1.1 s per declaration on single-threaded wasm, parallelized across
processes; ~90 ms per declaration natively with four threads).
- Files at or above 256 KiB are parsed in a lazy worker so a large source file cannot freeze the TUI. The
  worker loads the existing parser modules through jiti, keeps its tree-sitter parser warm, and terminates on
  cancellation; it falls back to inline parsing if the worker or loader is unavailable. Smaller files parse
  inline. Scans, `usages`, and the literal/fuzzy search loops yield to the event loop at file, node, or
  declaration boundaries, and honor the caller's abort signal at those boundaries.
- Defaults: 4,000-character `limit`, 1 MB file cap, 2k-file discovery cap, build/third-party/generated
  directories ignored, and a 2Q parsed-file cache (2,000 entries / 64 MiB) keyed by path + mtime + size.
- Cut output is resumable. Every action accepts `limit` in characters and `offset` in rendered body lines
  (the header is repeated, not counted). A cut result ends with `# next: offset=N`; pass that offset with the
  same action, path, query/symbols, and `limit` to continue. Pages prefer whole declaration/match/section
  blocks, but can resume inside one oversized block when necessary. An offset beyond the end says so. A single
  source line longer than `limit` cannot be split by a line offset; that page reports the approximate `limit`
  needed.
- Scanning `.` honors the working tree's `.gitignore`; an explicitly named subdirectory is scanned literally,
  so a fixture under an ignored path still works. The built-in build/third-party list applies either way.

## Tests

- `test/tools/code/cpp-parser.test.ts` — C++ and HIP extraction, macros, forward declarations, preprocessor
  dedupe, and named/nested lambdas.
- `test/tools/code/cpp-closures.test.ts` — digest/show/usages for nested C++ lambdas.
- `test/tools/code/adapters.test.ts` — language-to-grammar mappings and adapter-scoped preprocessing.
- `test/tools/code/javascript-parser.test.ts` — JavaScript/JSX extraction and nested closures.
- `test/tools/code/javascript-actions.test.ts` — digest/show/search/usages on JavaScript and JSX.
- `test/tools/code/multi-language-parsers.test.ts` — Java, C#, Go, Rust, Python, PHP, and Ruby extraction.
- `test/tools/code/multi-language-actions.test.ts` — discovery, digest, show, and call classification across
  the extended language set.
- `test/tools/code/markdown.test.ts` — heading hierarchy, front matter/fence exclusion, digest/search/show, and
  the empty `usages` result.
- `test/tools/code/offset.test.ts` — whole-block pages, inside-block continuation, beyond-end offsets, and
  end-to-end offset paging for digest/show/search/usages.
- `test/tools/code/actions.test.ts` — digest/search/show/usages against C++/HIP `MemoryCodeSource` fixtures.
- `test/tools/code/typescript-parser.test.ts` — TypeScript and TSX extraction, access modifiers, parameters,
  interfaces, arrow-function constants, and nested closures.
- `test/tools/code/typescript-actions.test.ts` — digest/search/show/usages against TypeScript fixtures,
  including nested closure scopes.
- `test/tools/code/fuzzy.test.ts` — identifier tokenization, edit-distance bounds, and fuzzy name matching.
- `test/tools/code/cache.test.ts` and `test/tools/code/load.test.ts` — 2Q promotion/eviction, byte bounds, and
  cache retention across a scan larger than the old 128-entry limit.
- `test/tools/code/usages-cache.test.ts` — parsing once and reusing the identifier index across symbols.
- `test/tools/code/search-cache.test.ts` — reusing per-file search hits across offset pages.
- `test/tools/code/worker.test.ts` — large C++, TypeScript, and Java parse/usage-index requests through the
  worker, plus pre-start cancellation.
- `test/tools/code/source.test.ts` — local/container adapters, container selection, symlink confinement, tool
  registration.
- `test/helpers/code-source.ts` — the in-memory source used by action tests.

Run `npx vitest run test/tools/code` and `npm run typecheck:tests` after changes.