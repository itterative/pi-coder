# outline tool

One agent-facing tool, `outline`, with six actions:

- `digest` — map a file or directory: namespaces/types, public signatures, block titles, line ranges, `[def]` tags.
- `search` — declarations whose name, doc comment, frontmatter, or literal body text matches a query, plus the
  comment blocks no declaration owns, with a
  conservative typo fallback.
- `show` — exact source for named symbols; a directory target pairs header declarations with source definitions.
- `usages` — syntactic occurrences with `[def]` / `[decl]` / `[call]` / `[ref]` tags, plus `[launch]` for
  HIP/CUDA kernel launches.
- `deps` — one file's imports and the files that import it, file-level and syntactic.
- `flow` — the call sites of a file or a scope, grouped by the scope that owns them, in source order.

Narrowing is a parameter, not an action. `path` takes a literal file or directory, or an rg-style pattern: one
containing `/` is anchored (`*` is one level, `**` crosses directories), and one without `/` matches the basename
at any depth. The literal prefix bounds discovery, and the walker applies the pattern, so a scoped pattern does not
walk the whole cwd and the 2000-file discovery cap counts *matches* rather than every file under the prefix. The
post-filter still trims the rare pattern the walker over-collects (a `*` remainder such as `src/*`). `kind` keeps
one declaration kind for `search`/`digest`, and one occurrence class for `usages`. Both name the active filter in a
`# filter:` line, with a hidden count when the post-filter removed anything — a smaller result must not read as
"nothing matched". A `kind` filter in `digest` lists the matching declarations flat, with no ancestor lines: the
qualified name carries the container, and an indented child under a hidden parent would draw a tree that does not
exist. A member whose owner was filtered away is prefixed with that owner
(`Port::  private void reset()  :11-13`) — the tree can no longer carry it, and `reset()` alone does not say which
class it came from.

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
  decorators are included in the declaration signature. A module-level binding (`TIMEOUT = 30`) is a `variable`
  declaration, the Python equivalent of a TypeScript `const`; a binding inside a function body is a local and stays
  out of the map, exactly as a TypeScript local does. An attribute or subscript target is a mutation, not a name.
- PHP namespaces may be file-scoped or braced, and classes, interfaces, traits, enum cases, methods, properties,
  functions, and constants are extracted. A leading `$` is removed from property names but kept in signatures.
- Ruby modules, classes, instance methods, and singleton methods (`def self.build`) are extracted, plus constants
  (`LIMIT = 10`): Ruby already defines them as a capitalised target, so the adapter uses that rule and ignores
  lowercase assignments, which are locals. Local lambda variables remain part of the enclosing method source because
  their syntax has no stable declaration name.
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
- **`show` matches a heading by a piece of its title.** A heading's name is prose, so the exact-name rule that
  protects a code symbol (never guess between candidates) would leave most headings unreachable: a truncated or
  reworded title still names the section the caller wants. A heading therefore also matches by normalized prefix
  and substring — ignoring case, leading `#` marks, and the punctuation prose is quoted with, backticks included —
  and *every* candidate is reported, so a loose match lists sections instead of returning a confident wrong one.
  The result says which rows were loose (`# heading: 1 matched by title text, not the full title: … (substring of
  the title)`). Identifier matching is untouched, which a test pins: `show viewport` still misses
  `restoreViewport`.
- **A comma inside a title is text, not a separator.** `query` splits at top-level commas so one call can name
  several symbols (`login, logout`), which made `Framing, viewport restore, and the render cache` three selectors
  that match nothing. When the split leaves a selector unmatched and the entry *as written* names a heading, the
  entry wins and one selector is used; the result says so (`# comma: "…" matched as one heading title, not 3
  selectors`). The rescue runs before the per-part heading pass, so the parts cannot each add a looser near-match.
- A heading's **doc text is its own prose**: from the end of the heading line to the next heading of *any* level,
  trimmed, and unset when the heading has no prose before its first child. That one field feeds the doc tier of
  `search`, the BM25 document, and the embedded text, so a section is findable by its content. It is deliberately
  not the whole section range, which would repeat every subsection in the parent's doc, BM25 document, and vector.
  Setext underlines and fenced code belong to the heading/prose correctly: the underline is excluded, a fence is
  prose. Markdown prose skips the comment-marker stripping the code path uses, or `*` bullets and `**bold**` would
  be eaten. `show` prints the section once: a doc range that sits *inside* the declaration range is not rendered
  separately (`sourceForDeclaration`).
- `usages` has no identifier index for Markdown and reports zero matches. There is no code to resolve.

## Blocks

A declaration model stops where the grammar stops, and in a test suite that is the wrong place: `describe("outline
digest", () => …)` is a call, not a declaration, so a 600-line spec file would map as a couple of imports and
nothing else. TypeScript/JavaScript extraction therefore emits `block` declarations from one shape:

> a **statement-level** call whose first argument is a string literal and whose last argument is a function literal.

That rule needs no framework allowlist — `describe`/`it`/`test`, a route with an inline handler, an event
subscription, `vi.mock("fs", () => …)` all answer to it — and it filters out what merely looks similar: a call
without a callback (`console.log("x")`), a name without a literal (`router.get(path, handler)`), an identifier
handler (`watch("file", handler)`), and a substituted template (`` describe(`suite ${name}`) ``). The false
positive it does admit, `console.log("x", () => …)`, is still a labelled block, which is a cheaper mistake than a
missing suite.

A block is a `Declaration` in every other respect, which is what makes the rest of the tool work unchanged:
`name` is the title, `blockCallee` is the call (`describe`, `test.describe`, `router.get`), `qualifiedName`
composes across nesting, `children` are the blocks inside it, and `bodyRange` is the callback body. `digest`
renders `describe "outline digest"  :95-170`; `search` finds a case by the words of its title; `show` on a suite
lists its cases and on a case returns its code; `usages` groups a case's occurrences under its title; and both
the block and its body text are indexed for the semantic channel.

Three rules that are easy to break:

- **A block is a container only when it holds blocks** (`show.ts` `isSection`). A suite has members, a case's body
  is plain code, so a case must render as a leaf — its `no public members` header was the bug this prevents.
- **Position is part of a block's identity.** `push()` dedupes by qualified name, signature, and parameters to pair
  a header declaration with its definition; two suites may share a title in one file, so a block's
  `range.startIndex` joins the key, or the second suite would silently vanish.
- **No `[def]` tag.** A block always has a body, so the tag that marks a definition would be noise on every row.

Ruby's RSpec has the same shape and is not covered yet: `describe … do … end` is a call with a block argument, and
`ruby.ts` would need the same rule on `call` / `do_block` nodes.

## Call sites

`flow` answers what a stretch of code *does*, where `digest` answers where things are and `show` returns one body.
Rows are **call expressions grouped by callee**, not source lines: a line that merely contains an identifier and an
open paren is a fragment of an expression (`.filter((line) =>`, `filter ?? ""`), while `callee(args)` is the unit a
reader scans. The call shape comes from the adapter's `callTargets`, so all ten languages work without a node type
leaking into `flow.ts`.

```
# flow test/suites.test.ts · 1 file · 8 call sites · typescript

test/suites.test.ts  · 8 call sites · 6 scopes
  file
    describe  ×2  :1,:11
  describe "flow root"  :1-9
    it  ×2  :2,:6
  it "first case"  :2-4
    expect(one()).toBe(1)  :3
```

- **A call that opens a block is the block's heading.** It belongs to the enclosing scope (`ownerScope`: a scope
  whose body starts at the call is excluded) and prints as the bare callee `describe  :1` — its arguments span the
  whole body, so printing them would put a 90-line suite inside the file's row. A scope's rows are therefore its
  direct calls, and its cases collapse into one counted row (`it  ×2  :2,:6`).
- **Only a call inside another call's *callee* is dropped.** `expect(x)` is part of `expect(x).toBe(y)`, so it goes;
  `candidateFiles(...)` inside `timing.measure("x", () => ...)` stays, because those are two things the scope does.
- **Repeats collapse.** A callee that appears more than once prints `callee  ×N  :line,line,…` (first six lines, then
  `,…`); a single call prints the whole expression on one line, with a multi-line argument list collapsed and its
  trailing comma removed.
- **Scopes, files, and the cap.** A scope heading is `Name  :start-end`, or `describe "title"  :start-end` for a
  block; methods keep their owner (`BashTokenizer::tokenize`) because a flat list has no indentation to carry it.
  Each file prints its own `path  · N call sites · M scopes` line, so a directory or glob result is scannable per
  file. A scope prints at most 40 callee rows; the rest are reported as `# +N more call site(s) in this scope` and the
  header total counts the withheld ones.
- **`query` selects scopes, it does not resolve a call.** Every matching scope is listed under its own heading with its
  line range, so two suites that share a title are both shown instead of being guessed between.
- Same limitation, stated in the output, and one grammar note: a call is a callee followed by an argument list, so
  overloads, generics, macros, and dynamic dispatch are not resolved, and Ruby's paren-less `helper` is an
  `identifier` rather than a `call` node in the grammar — `usages` shares both limits.

## Literal body text

`search` also reads the text *inside* a declaration body — log messages, thrown errors, inline comments, SQL
fragments — and reports **the declaration that contains it**, not the line. Those rows carry `[body]`, rank below
`[doc]` and above `[related]`, and print one evidence line, with `×N` when the text occurs more than once:

    src/store/artifact.ts:1-8  function  download  ...  [def] [body]
      :6  throw new Error(`${spec} failed its checksum`);
    test/deps.test.ts:49-63  it  "separates local, external, and unresolved imports"  (outline deps)
      :56  expect(result.text).toContain("4 imports");  ×2

### Comment blocks

Prose that belongs to no declaration — a file header above the imports, a note between two top-level statements — is
in neither the doc channel (nothing owns it) nor the body channel (it is outside every body). It gets its own
channel, one row per block, with the matching line quoted because `show` has no name to take:

    src/modules/decision/window.ts:1-9  comment
      :1  The window allocator: spend a char budget on the items that carry the most context.

`commentBlocksOf` (`comment-blocks.ts`) scans a file's comments and keeps what no declaration's range or `docRange`
covers, merging a `//` run into one block, dropping anything under 60 characters or without prose, and capping the
text at the body-chunk limit. Blocks are **file**-granular, not declaration-granular: the row's span is what `read`
wants, and the footer says so. A kind filter suppresses them, because a comment has no declaration kind to name.

The channel is literal *and* semantic: each block also gets a vector keyed by its text (`commentEntriesOf` in
`semantic/index.ts`), so a paraphrase lands on a file whose own header answers it. A block reached only by
similarity is tagged `[related]` — a guess, never counted as a match. Doc comments are not duplicated this way: they
are already embedded in the head vector of the declaration that owns them, and counted as `[doc]` rows.

Three rules keep the body channel from becoming a second grep:

- **Text-shaped queries only.** At least two whitespace-separated words. A single word is an identifier question,
  and every body that mentions `connect` would otherwise flood a result `usages` already answers properly.
- **One row per declaration.** A body row whose declaration is already listed by name or doc moves its evidence onto
  that row; a body row whose evidence sits inside a *listed descendant* is dropped, so a case's line never appears
  under its suite's heading. Both were visible as duplicated locations (`deps.test.ts:49-63` twice) and as a suite
  heading with an evidence line from someone else's test.
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
against the literal prefix of `path`, which is what makes `within="pager.ts"` under `path=src/tui` the short form.
A caller who writes the path as it reads from the cwd instead — `within="src/tui/pager.ts"` — would otherwise
double-prefix into a file that does not exist, so that reading is tried when the documented one is *missing* (never
when it resolved, never for another failure), and the footer says which reading applied (`# within: imports of
src/tui/pager.ts (relative to cwd) · 2 files`). When neither reading resolves, the error names both. There is no depth knob: the scope is the anchor and its direct neighbours,
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

- A file with nothing to map says what it does have instead of `# no declarations`: `# no declarations · 17
  top-level call sites · outline(action="flow", path="…") lists them`, or a re-export/comment-only line when it
  holds no calls. The count costs one usage-index pass, and only on the empty path — `src/index.ts` reporting
  "nothing" was the answer that taught an agent the tool does not apply to entrypoints.
- `digest` degrades to a directory map when the result exceeds the character limit, and files over 1,500 lines
  render only top-level declarations. A file header states its line count (`src/net/socket.h [26 lines]`), so a
  reader can tell how much of the file the rows cover. `detail="full"` includes private/protected members, fields, enum members, and
  nested variables; a **root** variable is a module constant and is part of the signature list too. Declaration rows
  show `:start-end` when the declaration spans lines, and `:line` for a one-liner; `search` locations and `show`
  headers use the same range convention.
- **Signatures mode says what it hid.** A class's non-public members are dropped in `signatures` detail, and a reader
  cannot tell a class with no extension points from one whose extension points were filtered — so the footer counts
  them: `# visibility: 13 non-public member(s) hidden; detail=full lists all`. Only *access* hides are counted:
  fields, enum members, and nested variables are the documented shape of a signature list, not a visibility rule;
  a root variable is the file's own map and stays visible. A **single-file** digest additionally names the kinds it
  hid (`# kinds: 2 enum members, 1 field hidden in signatures detail; detail=full lists all`) because that call is
  asking what is in this file; if nothing visible remains, the line replaces `# no declarations` with the reason. A
  directory digest leaves it out, since it would repeat per file. A result that shows no members at all (the
  directory map) carries no such note, because the filter cost it nothing.
- **The directory map names files, within its budget.** A map of directory counts answers "where is the code" but
  not "which file", which is what a caller who named one directory usually asked. Names are added per row while the
  budget allows — the root's own files first, since they sit in no subdirectory, then each directory in size order
  — under the summary line (`.  15 files` / `  ask-user.ts list-view.ts …`). A list that had to stop says so
  (`# … 4 more`). `# deeper: outline digest <dir>` names the largest directory to open next; it is deliberately not
  `# next:`, which is the truncation marker, and a complete map must not read as a shortened one. The header says
  why the map replaced the declarations (`declarations exceed the N-char limit; showing the file list`) rather than
  claiming the returned text was over limit.
- **Paging.** A cut result ends with `# next: offset=N` *and* how many body lines remain, because the step between
  pages is set by the character budget rather than a line count: `# next: offset=19 · 111 of 130 line(s) left · raise
  limit to fit more per call`. When a page stops inside a block, `# omitted N more block(s) after this body` names the
  blocks it never reached, and a multi-symbol `show` prints one index line per resolved symbol before any body, so a
  cut body cannot make a symbol look missing. For a body over roughly 40 lines, the cheaper path is the span: every
  header carries `path:start-end`, and `read offset=start limit=n` fetches it in one call.
- `show` defaults to `full` for functions/fields and `signatures` for containers; `detail` overrides that.
  Containers in signatures mode show only public members. `show` keeps signatures intact, while digest shortens
  long ones. Extracted source is dedented by the declaration's own indentation so nested members read cleanly;
  relative indentation inside the body is preserved, and a dedented body is preceded by
  `# dedented: read <path>:<start-end> for the exact indentation before editing`, because a replacement copied
  from it may not match the file. A directory target pairs declarations and definitions; a
  file target stays scoped to that file.
  When a symbol has same-signature definitions in more than one file (e.g. per-example `main` functions),
  `show` lists the locations instead of choosing one. When several overloads match, it appends a note with a
  concrete parameterized selector; narrowing to one overload removes the note.
- `usages` matches by the selector's last component, because call sites normally say
  `socket.connect(...)`, not `Socket::connect(...)`. **A row is a line, not an occurrence**: `state.scrollOffset =
  scrollOffset` names the symbol twice on one line and is one place to look, so repeats on the same line and tag
  collapse into one row while the header keeps counting occurrences (`· 74 matches on 66 line(s) ·`); the `on N
  line(s)` half appears only when the two differ. A definition and a call that share a line keep separate rows,
  because the tag is part of the key. It is **syntactic**: overloads, generics, templates, macros,
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
  is or how many files match. A comment inside a declaration is reachable as a `[body]` row on the enclosing
  declaration; one outside every declaration is a `comment` row instead, both only for a text-shaped query. Search hits are cached per parsed file and normalized query (a
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

**A related-led page keeps one slot for the strongest literal row.** When the lexical pass has no precise evidence
the related rows lead, because a doc tier that merely saw every content word somewhere is not an answer. A full
`TAIL_ROWS` of guesses could then fill the leading page and push the query's *only* literal match onto the next one,
leaving a `# more:` note that points at the one row that was evidence. So the leading page keeps its slot: seven
related rows, then the literal rows, then the tail's weakest guess (`relatedLedPage` in `search.ts`). A short tail
changes nothing, since the literal rows already follow it. Because a slot can still sit below the fold, a displaced
literal row is named in the footer (`# also: literal row follows the related guesses · path:range kind name`) rather
than being left to a page the caller may never open.

**Guesses are not matches.** The summary counts literal rows only: `3 matches` over three similarity guesses was the
most dangerous number the tool printed, because an agent reads it as "the identifier exists". With no literal row the
summary says `no literal matches · N related guesses`, and the `matches` field carries the literal count.

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
rejected unless `header.dims === profile.dims` (the namespace hash carries model id and text version, not dims), and a
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

**One runtime: llama.cpp, one server per model directory.** The channel spawns `llama-server --embeddings` from a
pinned llama.cpp release (`semantic/llamacpp.ts`, `semantic/server.ts`) and posts texts to its `/v1/embeddings`, so
the model loads once and every search and build shares it — the ONNX path used to hold one copy of the weights per
worker, and needed two runtimes (a native binding plus an ort-web fallback with three Node workarounds) to do it. The
release publishes a `RUNPATH=$ORIGIN` bundle, so the ~60 shared libraries need no environment; it is unpacked from a
hash-pinned tarball into the state directory.

The model is a **profile** (`semantic/profiles.ts`): Qwen3-Embedding-0.6B by default, with embeddinggemma-2 and
LFM2.5-Embedding-350M selectable by `PI_CODER_OUTLINE_MODEL`. A profile owns the GGUF download, the vector width, and
the asymmetric prefixes (`Instruct: …\nQuery:` for Qwen3, `query: `/`document: ` for LFM2.5, none for documents
otherwise) — and because its id is part of the namespace and of every entry key, switching builds a new index rather
than mixing widths, and switching back finds the old one.

**Backend selection is per role.** Queries keep a warm CPU server; builds take a GPU when one is present, through a
server that is started for the import and killed when it ends — so VRAM is borrowed only while a build the user asked
for is running, never at query time (measured: 1.76 GB appears and disappears around an import). The Vulkan bundle is
asked `--list-devices` and a software-only answer falls back to the CPU bundle; a Vulkan start that fails on allocation
is retried on the CPU for that build. A GPU server is pinned to one device (`-dev Vulkan0 -sm none`, chosen by free
VRAM, or named by `PI_CODER_OUTLINE_VULKAN_DEVICE`): `-ngl` alone offloads to every device and splits layers across
them, which is slower than one card on a multi-GPU machine. `PI_CODER_OUTLINE_QUERY_DEVICE` / `PI_CODER_OUTLINE_BUILD_DEVICE` set a role
(`cpu|vulkan|auto`, defaults `cpu` and `auto`) and `PI_CODER_OUTLINE_DEVICE` pins both. CPU and Vulkan vectors score
cosine 0.9994–0.9998 for the same text, so an index built on one is queried on the other without a penalty. Only
linux-x64 has a measured bundle, so other platforms are BM25-only — where the ONNX path still had wasm.

**Builds are requests, not children.** The server serialises them, so `buildConcurrency()` is a queue depth (four,
`PI_CODER_OUTLINE_WORKERS` to override, eight at most) that keeps a GPU busy between short requests, and drops to one
on a CPU where extra requests would only queue in front of the user's next search. The parent writes the shards, so a
query and a build share one code path. Measured on 1,502 declarations (1,754 vectors, Q8_0): **18 s / 96.6 vectors per
second on a Vulkan device, 363 s / 4.8 on 8 CPU threads**; a warm query is 13 ms and 56 ms respectively, after a ~0.8 s
model load.

Background refreshes stay capped at `refreshConcurrency()` (half the cores, at most four), and the cap matters more
than it did: with one shared queue, the only thing keeping a refresh from stalling a search is that its queue is short.

**One writer per namespace.** A refresh, a foreground build, and another pi session on the same root all publish to
the same manifest, and each build reads it once and writes its whole in-memory view at the end — so two overlapping
builds drop each other's shard records, and a pruning one deletes shard files the other just wrote. `buildIndex`
therefore takes `build.lock` in the namespace directory (pid + ownership token, taken over when the holder's pid is
dead or the file is older than two hours), holds it across read → plan → embed → publish, and releases it in a
`finally`. A build that finds it held throws; a search-triggered refresh checks first and reports "not indexed"
instead of scheduling a refresh that would bounce. Readers never take the lock: `writeManifest` publishes with a
randomly named temp file and a rename, and the journal replay tolerates a truncated final line, so a killed build
loses at most its unfinished shard.

The semantic half is downloaded, not installed: no npm dependency, ~700 MB of pinned and hash-verified artifacts for
the default profile (one GGUF that carries its own tokenizer, plus two small runtime archives) under the pi-coder state
directory, and a content-hash shard index. `docs/outline-search.md` records the artifact manifest, the device
selection, the index layout, and the measured build cost (~10 ms per vector on a GPU, ~210 ms on a CPU core).
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
- `test/tools/code/blocks.test.ts` — the `block` kind: the literal-plus-callback discriminator and what it
  rejects, the nested test tree, `show` on a suite vs a case, title search, usage grouping, duplicate titles,
  and the empty-digest signpost.
- `test/tools/code/flow.test.ts` — call-site rows, scope ownership, query narrowing, the per-scope cap,
  offset continuation, and the no-calls result.
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