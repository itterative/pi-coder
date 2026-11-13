---
name: deps
description: The `deps` action — text-based import extraction, three-state resolution, and the whole-tree dependents scan in src/tools/code/imports.ts and deps.ts.
category: architecture
priority: 6
keep_updated: true
---

# `deps`

`imports.ts` owns extraction and resolution; `deps.ts` owns the action. File-level only.

## Extraction

Text-based on comment-masked source (`comments.ts` → `maskComments`), not tree-sitter: imports are a small, regular
surface in every supported language, and the parse tree is released by the time a dependents scan asks for them.
Offsets are preserved through masking, so a reported line is the original line. Two filters keep false edges out:

- a match whose **start offset** falls inside a string literal is dropped (`stringRanges`), so `const doc = "\nimport
  x from './y'"` is not an edge; the specifier itself is inside a string, but the keyword that starts the statement is
  not;
- commented-out imports are blanked before matching.

Per language: JS/TS `import`/`export … from`/`require()`, C/C++ `#include "x"` and `<x>`, Python `import`/`from`,
Rust `use`, Java `import`, C# `using`, Go single and block imports, PHP `use`, Ruby `require`/`require_relative`.
Dedupe is by (specifier, style, relative) with the first line winning. Out of scope by design: dynamic `import()`,
re-export chasing, type-only imports, and PHP trait `use` (it is a class-scope import; it shows up as `external`).

## Resolution

Three states, never guessed: `local` (a file in the scanned tree), `external` (a module or namespace outside it), and
`unresolved` (a relative path that matched no parsed file). `local` vs `external` is the distinction that makes the
graph honest; `unresolved` is the only state that means "this looks broken".

- **Relative paths.** JS/TS try the exact path, then `.ts/.tsx/.js/.jsx/.mjs/.cjs/.json`, then `index.*`. C/C++
  quoted includes try the file's directory, then the scan root, then the `include/` directory of every ancestor;
  angle includes (`<vibes/core/x.hpp>`) resolve only through those `include/` roots, which is what makes a CMake
  project's headers local rather than external. Python counts leading dots up from the file's
  directory. Ruby tries `x` and `x.rb`. Rust: `crate` starts at the nearest `src` directory, `self` at the file's
  directory, `super` one level up, and the longest module prefix is tried first so a trailing type still resolves.
- **Symbol names.** Java FQCN → a file ending `a/b/C.java` (a `.*` import → the package directory). C#/PHP match a
  declared namespace (exact or prefix) or a declaration's qualified name; PHP backslashes are normalized to dots for
  comparison. Go package paths match the longest discovered **directory suffix**, so
  `github.com/acme/repo/pkg/x` resolves to `pkg/x`. Python absolute modules are tried from the file's directory and
  from the scan root. Everything else is `external` (npm packages, `serde::…`, `<vector>`).

## Dependents and cost

`dependentsOf` resolves every parsed file's imports and keeps those whose target is the subject — a whole-tree scan,
so it costs what `usages` costs, and the parse cache is what makes it cheap. Two rules matter:

- the subject is always parsed (the file is the question); a pattern is rejected rather than guessed at;
- the scan root is the cwd when the subject is inside it, otherwise the subject's own directory. A file's imports are
  local to it, but "who imports it" is a question about the tree, and scanning only the subject's directory would
  answer "nobody" for every file whose dependents live elsewhere.
- when the cwd walk **skips** the subject (a gitignored tree, `.pi/local/…`), the nearest enclosing project root is
  scanned literally instead (`CMakeLists.txt`, `Makefile`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`,
  `pom.xml`, `build.gradle`, `.git`), stopping before the cwd itself. Without it, such a subject resolved every import
  to `external` and reported zero dependents — live-tested on `.pi/local/code-tree-tests/vibes`.

Imports are cached per `ParsedFile` in a `WeakMap`, so an edited parse drops them with the file.

## Surfacing

`deps` prints `imports` (state, specifier, line, resolved target — a Go target is a directory) and `dependents`
(path, line). There is no narrowing filter: the subject must be a literal file (a `path` pattern is rejected) and the
dependents scan covers the whole scan root. The resolve index must see that whole root, never a narrowed parse set:
filtering it made every `include/` target `external` the moment a caller asked only for dependents under one subtree
(live-tested on `vibes`; no live filter remains, but the invariant is why resolution is built from discovery). The
footer says imports only, not a call graph (`usages`), and names the three states. `matches` is imports + dependents;
`files` is the parsed scan set.