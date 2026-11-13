# outline tool

One agent-facing tool, `outline`, with five actions:

- `digest` — map a file or directory: namespaces/types, public signatures, line ranges, `[def]` tags.
- `search` — declarations whose name, doc comment, frontmatter, or literal body text matches a query, with a
  conservative typo fallback.
- `show` — exact source for named symbols; a directory target pairs header declarations with source definitions.
- `usages` — syntactic occurrences with `[def]` / `[decl]` / `[call]` / `[ref]` tags, plus `[launch]` for
  HIP/CUDA kernel launches.
- `deps` — one file's imports and the files that import it, file-level and syntactic.

Narrowing is a parameter, not an action. `path` takes a literal file or directory, or an rg-style pattern: one
containing `/` is anchored (`*` is one level, `**` crosses directories), and one without `/` matches the basename
at any depth. The literal prefix bounds discovery, and the walker applies the pattern, so a scoped pattern does not
walk the whole cwd and the 2000-file discovery cap counts *matches* rather than every file under the prefix. The
post-filter still trims the rare pattern the walker over-collects (a `*` remainder such as `src/*`). `kind` keeps
one declaration kind for `search`/`digest`, and one occurrence class for `usages`. Both name the active filter in a
`# filter:` line, with a hidden count when the post-filter removed anything — a smaller result must not read as
"nothing matched". A `kind` filter in `digest` lists the matching declarations flat, with no ancestor lines: the
qualified name carries the container, and an indented child under a hidden parent would draw a tree that does not
exist.

`search` takes a phrase in `query`; `show` and `usages` take selectors there, and one string may hold a
comma-joined list (`"A::b, C::d"`): `format.ts`'s `splitSymbolList` splits on **top-level** commas only, so an
overload selector's parameter list (`Socket::connect(const Address&, int)`) survives intact. Empty entries are
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
- The **frontmatter block is a declaration** (`kind: "frontmatter"`, name `frontmatter`, range over the delimited
  block, doc text the whole block). It is the densest text in a memory tree — a curated `description:` says what the
  file is for — and leaving it out made `search` weaker than `grep` on the one channel that matters there. Rows that
  match it carry `[frontmatter]` and rank above body-token matches (below a body *phrase*: a frontmatter `keep_updated`
  key matches 82 files, while the section that explains the field should win). `digest` prints it as `frontmatter
  :1-7` and `show frontmatter` prints the block, which is why discovery treats `frontmatter` as a synthetic name: it
  never appears in the source, so a grep-based candidate list would miss every file.
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

## Literal body text

`search` also reads the text *inside* a declaration body — log messages, thrown errors, inline comments, SQL
fragments — and reports **the declaration that contains it**, not the line. Those rows carry `[body]`, rank below
`[doc]` and above `[related]`, and print one evidence line, with `×N` when the text occurs more than once:

    src/store/artifact.ts:1-8  function  download  ...  [def] [body]
      :6  throw new Error(`${spec} failed its checksum`);

Three rules keep it from becoming a second grep:

- **Text-shaped queries only.** At least two whitespace-separated words. A single word is an identifier question,
  and every body that mentions `connect` would otherwise flood a result `usages` already answers properly.
- **Declaration granularity.** A match inside a method body belongs to the method, not to its class
  (`innermostOnly`), and repeated hits collapse into one row with a count. The follow-up is one `show`.
- **Markdown is excluded.** A memory's prose *is* its doc channel; a body row would restate the section the doc
  tier just found.

The cap is a budget decision, not an evidence one: up to 20 rows when the name and doc channels found little and 3
when they already lead, with a footer naming what it withheld. Body evidence counts as literal evidence for the
related tail, so `[related]` rows cannot lead above it.
Everything still line-level — regex, `-C` context, counts, text in files `outline` does not parse — remains `rg`'s
job.

## Dependency scope

`within` narrows `search` and `usages` to one file's direct dependency neighbourhood:

    outline(action="search", query="backoff", within="src/store/artifact.ts")
    outline(action="usages", query="retry", within="dependents:src/store/retry.ts")

The bare form is `imports`; `dependents:` flips to the files that import the anchor. The anchor is resolved
against the literal prefix of `path`. There is no depth knob: the scope is the anchor and its direct neighbours,
because the useful question is "what can this file actually reach" rather than a transitive closure nobody can
read. The anchor stays in scope even when the `path` pattern would exclude it, and a neighbour that exists but
fell outside is counted in the `# within:` footer rather than silently dropped — the same honesty rule as
`# filter:`. Edges are the resolved imports `deps` reports, so a neighbour is real only when the scan can see its
target; the resolution index uses the whole discovered root, not the pattern-narrowed parse set, exactly as in
`deps`. When a pattern is active, a second unfiltered discovery supplies that root: the pattern bounds what is
searched, not which imports are real.

The scope changes what is searched, ranked, and reported, not the discovery walk: a scoped call still discovers and
parses the searched tree the way an unscoped one does, and the semantic tail draws its candidates from the scoped
files.

## File dependencies

`deps` takes one file and answers both directions: what it imports, and who imports it. The scan root is the working
directory when the subject lives inside it, otherwise the subject's own directory — a file's imports are local to it,
but "who imports it" is a question about the tree, so scanning only the subject's directory would answer "nobody"
for every file whose dependents live elsewhere. The subject must be a literal file: a pattern is rejected, and the
dependents scan covers the whole root with no filter. Resolution still sees that whole root, so an `include/` target
stays `local` even when it lives outside the subject's directory.

When the working-directory walk skips the subject — a gitignored test tree, `.pi/local/…` — the cwd scan would resolve
nothing and report no dependents, so the nearest enclosing project root (`CMakeLists.txt`, `Makefile`, `package.json`,
`Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `build.gradle`, `.git`) is scanned literally instead. That keeps
the subject's siblings and its dependents in play without widening the walk to the whole checkout.

Extraction is text-based on comment-masked source (`imports.ts`): imports are a small, regular surface in every
supported language, and the parse tree is gone by the time a dependents scan asks. A match whose **start offset** is
inside a string literal is dropped, so a fake import inside a template cannot become an edge; commented-out imports
are blanked first, with offsets preserved so lines stay original. Supported: JS/TS `import`/`export … from`/
`require()`, C/C++ `#include`, Python `import`/`from`, Rust `use`, Java `import`, C# `using`, Go single and block
imports, PHP `use`, Ruby `require`/`require_relative`.

Resolution has three states and never guesses:

- `local` — a file in the scanned tree: relative paths (JS/TS extension and `index.*` probing, C/C++ directory then
  scan root and the `include/` directory of every ancestor — which is how `<vibes/core/x.hpp>` resolves — Python dot
  counts, Ruby `x`/`x.rb`, Rust `crate`/`self`/`super` with the longest module prefix first),
  Java FQCN → `a/b/C.java`, C#/PHP namespace or declaration match, Go package path → the longest discovered directory
  suffix, Python absolute modules from the file's directory and the root.
- `external` — a module or namespace outside the tree (`node:path`, `<vector>`, `serde::…`, `System.Text`).
- `unresolved` — a relative path that matched no parsed file. The only state that means "this looks broken".

```
# deps src/tools/code/deps.ts · 8 imports · (6 local, 2 external, 0 unresolved) · 1 dependent · typescript
imports
  local       ./discovery  :3  → src/tools/code/discovery.ts
  external    node:path  :1
dependents
  src/tools/code/index.ts  :29
# note: imports only — a call graph is `usages`; resolution is syntactic (relative paths, crate and module names)
```

Dynamic `import()`, re-export chasing, type-only imports, and PHP trait `use` are out of scope; a dependents scan
costs what `usages` costs, and imports are cached per `ParsedFile` so an edited parse drops them with the file.

## Output and limits

- `digest` degrades to a directory map when the result exceeds the character limit, and large files (`[huge]`) render
  only top-level declarations. `detail="full"` includes private/protected members, fields, enum members, and
  variables. Declaration rows show `:start-end` when the declaration spans lines, and `:line` for a one-liner;
  `search` locations and `show` headers use the same range convention.
- **Paging.** A cut result ends with `# next: offset=N` *and* how many body lines remain, because the step between
  pages is set by the character budget rather than a line count: `# next: offset=19 · 111 of 130 line(s) left · raise
  limit to fit more per call`. When a page stops inside a block, `# omitted N more block(s) after this body` names the
  blocks it never reached, and a multi-symbol `show` prints one index line per resolved symbol before any body, so a
  cut body cannot make a symbol look missing. For a body over roughly 40 lines, the cheaper path is the span: every
  header carries `path:start-end`, and `read offset=start limit=n` fetches it in one call.
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
  shapes live on each `LanguageAdapter`, so adding a language does not add a switch to `usages`. A qualified
  request (`CallList::attention_paged`) keeps its type: occurrences whose enclosing type is that class sort first,
  and the rest are marked `[name-only]` with a footer note. The rows stay because an aliased or unqualified use is
  still a real use — only the claim that they are the same symbol is dropped. A per-file
  identifier index is built on first use and reused for every requested symbol and later calls; the WASM tree is
  released after indexing. Files at or above 256 KiB build that index in the parser worker.
- `search` is declaration-name, doc-text, and literal body-text search, not a text scan. A plain query is a
  case-insensitive substring of the simple name; a query containing `::` or `.` is matched against the qualified
  name, so `CallList::` finds the members. Exact names sort before prefixes, prefixes before later substrings, and a
  doc-comment match sorts after every name match and above every approximate one; its word tokens are matched
  in any order, all required, and the row carries `[doc]`. Qualified queries skip the doc channel, because the
  qualifier already chose the scope. It reports the qualified name and signature, so the follow-up is `show`
  with an exact selector.
  The doc channel splits by evidence strength: a query that appears **contiguously** in the prose (`page table`) sorts
  above one whose words are merely scattered through the section, and a quoted query (`"page table"`) requires the
  phrase outright. Doc tokens are lightly stemmed (`spilling` finds `spilled`); names and signatures are not, so
  `list` and `listing` stay distinct identifiers. The tiers, in order: exact name, name prefix, name substring, body
  phrase, frontmatter phrase, frontmatter tokens, body tokens, approximate name, relevance tail.
  A result cut by the limit also reports what is left: `# more: 69 of 82 match(es) on later pages, next in
  <path>`, so a caller can tell that the answer is one page down instead of reformulating the query.
  Only when neither a name nor a doc comment matches does search fall back to a bounded Damerau-Levenshtein
  comparison against the full name and its snake/camel-case tokens. Queries shorter than three characters are
  not fuzzed; longer queries allow one or two edits. At most eight approximate rows are returned, nearest
  first, and a footer reports how many were withheld. Approximate rows carry `~N`, and the output says how many
  edits were allowed. A doc match outranking a near-miss name is the point: prose is where a concept lives when
  no identifier spells it out, and a plausible identifier guess is the weaker evidence.
  Strings, config, and arbitrary source text remain the job of `bash` + `rg`, as do line-level output, regex, and
  counts: the body channel is literal and declaration-granular, so it cannot say *where in the function* the text
  is or how many files match. A comment between two statements is reachable as a `[body]` row on the enclosing
  declaration, but only for a text-shaped query. Search hits are cached per parsed file and normalized query (a
  few recent queries per
  file); a changed path + mtime + size creates a new `ParsedFile` and drops the old hits with it.

### Roots, and the index a root owns

`outline` reads the working directory plus the same roots `read`/`grep`/`find` are allowed: the user memory
directory, the roots the user declared in `files.readRoots`, and the runtime resource roots
(`codeReadRoots` in `index.ts` → `LocalCodeSource`). Without that, a root a human had already granted for `read`
answered `outline search` with "path is outside the working directory" — the tool disagreeing with the session
about its own files. A declared `~` is expanded once, by the same helper the confinement checks use.

Naming a tree is also what makes it literal: ripgrep runs with `--no-ignore` for any target that is not the cwd
itself, so a gitignored `tree` (`.pi/agent/memory`, a build output, a vendored copy) is searchable when the caller
names it and invisible to a walk of its parent. That asymmetry is the point — the ignore rules belong to the
parent's view, not to an explicit request.

**A tree the parent index cannot reach gets its own namespace.** `resolveIndex` falls back to the longest ancestor
index, which is right for a subdirectory of a built root and wrong for a gitignored tree: the parent's own walk
never included it, so its vectors are absent. Two rules (`semantic/index.ts`):

- no index at all for the searched root → its own first build, capped by `INITIAL_BUILD_LIMIT` (20k declarations)
  rather than `AUTO_REFRESH_LIMIT`, because a root with nothing to catch up on would otherwise never become
  searchable;
- a borrowed ancestor index that holds *none* of the search's declarations → the searched root gets its own
  namespace, so a small memory tree does not append a handful of vectors into an 11k-entry repo index.

An ancestor that holds *some* of them keeps the additive refresh: the tree is partially covered, and appending is
what fills the rest.

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

Measured on an 8-declaration fixture with the real artifacts: the dense channel changed no *rank* that BM25 had not
already got right (a tail needs only partial term overlap), and its visible effect was filling the tail to
`TAIL_ROWS` because it scores every declaration. Cosines for this model sit in a 0.6–0.75 band — a query with no
answer in the corpus scored 0.680, above the seventh row of a query that had one — so there is no usable absolute
floor; the `[related]` tag, the footer, and the row cap are the honest signals. Details and the table:
`docs/outline-search.md`.

A doc-comment match suppresses the tail (`wantsTail` in `semantic/rank.ts`): the doc tier requires every content
word of the query to appear in one declaration's prose, so it is the strongest cheap evidence there is, and the
tail would cost a query embedding (0.6–3 s warm/cold) to append rows the agent never needed. Both gates count
*evidence*, not just rows: three weak name hits buy a tail, one exact doc hit does not. The doc tier tokenizes with
the same stopword-filtered tokenizer BM25 uses (`tokenize`), so filler words in a natural-language query cannot
make an otherwise perfect prose match miss.

**The gate has a cost worth knowing.** One doc or frontmatter row is enough to suppress the tail, so a query whose
words land in a file's `description:` returns that one row *instead of* the section map the tail used to add: on a
memory tree, `knob registry tune table` went from five spans in `tuning.md` to one `[frontmatter]` row, and
`scripted edits assert the match count` from four loose sections to the frontmatter plus the one section that
answers. The right file still comes first, and the workaround is a second call — `search path=<that file>` returns
its sections — which is why the trade stands: a section list costs a query embedding, and it is not worth spending
on an answer that already points at the right file.

### Body chunks

A declaration's head vector embeds its doc comment, its **inline body comments**, and its signature — never its code.
A declaration whose body is at least `CHUNK_MIN_CHARS` (800 characters) also gets body chunks (`semantic/chunks.ts`):
the body is split at its direct child declarations first (a child that gets its own chunks is collapsed to its
signature line there, so a class chunk does not duplicate its methods' bodies), packed to a 1,600-character target, and
a single block above 2,400 characters is cut at line boundaries with 8 lines of overlap. Every chunk's text is
`title: <path> | text: <kind> <qualifiedName> (§i/n) <signature>. <body>`, so a fragment still names what it belongs
to. At most 12 chunks per declaration: adjacent chunks merge to reach the cap, and only an already-maximal set loses
its tail.

Chunks are content-addressed like heads, so editing one region of a long body invalidates that chunk alone. The live
set — what a prune keeps and what a refresh fills — is heads *plus* chunks, and an idle scan counts chunk keys too:
a body-only edit changes no head text, so scanning heads alone would call that index warm. Ranking scores a
declaration as its best vector and reports which one won, so a `§i/n :start-line-end` line under a `[related]` row is
the chunk to `read`.

Cost on this repository: ≈8.7k declarations under `src` become ≈1.2k chunks across ≈850 declarations (+14% vectors,
≈1.8 MB of chunk text), with planning at ~22 ms once per parse and cached per `ParsedFile`. A memory or `docs` tree
produces none — its declarations are small, and Markdown prose is already the doc channel.

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

**The mode is decided in one place.** `effectiveSemanticMode` (`semantic/config.ts`) returns the mode a search will
use *and* why: an explicit `PI_CODER_OUTLINE_SEMANTIC` (`off`/`bm25`/`hybrid`) always wins, an answered consent
dialog (`consent: enabled`) means hybrid, and otherwise hybrid is off. `/outline status` prints that same function's
answer with its source (`mode=hybrid (consent)`), because printing the *configured* mode while the search already used
embeddings — `mode=bm25 consent=enabled` — is how a working channel gets reported as broken.

Status also names the namespaces and whether this session's own root is among them. A namespace is keyed by
`sourceKind + root + model + text version`, and a container-built index is deliberately never borrowed by a local
session, so "2 namespaces" can mean "none that this search may use". `this session: no local index for .` is the
line that says so, and the fix is a first search there (which schedules the build) or `/outline build .`.

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
  same action, path, query, and `limit` to continue. Pages prefer whole declaration/match/section
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
- `test/tools/code/search-body.test.ts` — literal `[body]` rows: evidence lines, occurrence counts, innermost
  attribution, the adaptive cap, the identifier shape gate, and Markdown exclusion.
- `test/tools/code/comments.test.ts` — comment extraction (strings skipped, per-language markers) and the head text
  that embeds inline comments.
- `test/tools/code/chunk-plan.test.ts` — body-chunk planning: structural splits, collapsed children, overlap, cap,
  determinism, and per-chunk content keys.
- `test/tools/code/deps.test.ts` — import states across all ten languages, dependents, the pattern rejection, comment and
  string-literal exclusion, and dedupe.
- `test/tools/code/discovery.test.ts` — path-target parsing, prefix stripping, and the pattern-aware discovery cap.
- `test/tools/code/filters.test.ts` — `path` pattern matching (anchored, basenames, braces, no match) and
  `kind` narrowing in search and digest, including the hidden-count notes.
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