---
name: internals
description: The machinery under src/tools/code - filesystem seam and confinement, parse-buffer vs IR pipeline, parsed-file cache, large-file worker, yielding, and adding a language.
category: architecture
priority: 7
keep_updated: true
---

# Internals

## Invariants

- **One filesystem view.** All I/O goes through `CodeSource` (`source.ts`). With a container active,
  `ContainerCodeSource` uses the session's `fs`/`spawn` and never host `fs`; the source is chosen per call from
  `ContainerState.sessionFor`, because a session can move onto a container after an image build.
- **Local confinement is per file.** `assertReadable` realpaths every file before parsing, so a symlink below the
  root cannot escape the cwd.
- **The parse buffer is not the output buffer.** `adapters.ts` is the one language registry (grammar, preprocessor,
  parser, `usages` call sites). Only C++/HIP preprocesses (`preprocess.ts`), blanking qualifiers, launches, macros,
  attributes, and `= {}` defaults with **same-length** replacements; directives are copied verbatim, and `cpp.ts`
  parses that buffer but slices from the original, so offsets and `__global__` survive. Markdown is line-scanned,
  and a heading's doc text is its own prose (`outline-tool/search.md`).
- **The declaration IR is not an AST.** Adapters emit `Declaration` (kind, qualified name, ranges, signature,
  parameter types, access, children) through `visitor.ts`; parser node types never reach an action or the
  formatter. Body walkers also extract inner functions and arrow/function constants (JS/TS), named lambdas (C++),
  and Python nested `def`s. Module-level bindings are declarations too: JS/TS `const`/`let`, Go/Rust/Java/C#/PHP
  constants, Python module assignments, and Ruby capitalised constants (a lowercase Ruby assignment is a local).
  Nested names are `outer::inner`.
- **No persistent index.** Parsed files live in a disposable 2Q cache (2,000 entries / 64 MiB, keyed by path +
  mtime + size); eviction only costs a reparse. Search hits and the usage index hang off `ParsedFile` in
  `WeakMap`s, so a changed file drops them with the object.
- **`usages` reuses a per-file identifier index.** Built once from plain data, then the WASM tree is released;
  later symbols filter it instead of reparsing. Files ≥256 KiB index in the parser worker; Markdown has none.
- **Large files leave the main thread.** `worker.ts` lazily starts one `parse-worker.mjs` for files ≥256 KiB,
  loading parsers through jiti; abort terminates it rather than waiting for a synchronous parse. A missing loader
  or worker error falls back to inline parsing, and small files never pay the startup cost.
- **Loops yield.** `common/async.ts`'s `yieldToEventLoop` sits between parsed files and at index/search boundaries
  with `AbortSignal` checks, so a long scan does not starve the TUI.
- **A search-triggered index refresh runs on the CPU by design.** That path pins `device: "cpu"` and
  `refreshConcurrency()` (cores/2, capped) because it runs while the user is working, and borrowing VRAM then is not
  defensible; a foreground build uses `devicePreference("build")`, which is `auto` and takes the GPU when there is
  one. The idle refresh omits `device` and inherits `auto`. So a large delta is genuinely slower than a purge +
  rebuild — that is a deliberate trade, not a regression. Numbers: `outline-tool/models.md`.

## Adding a language

`@vscode/tree-sitter-wasm` bundles the runtime and grammars. A new language is a grammar id plus an extraction
adapter registered in `adapters.ts`, which `parse.ts` and `usages.ts` both consume. Bash, CSS, INI, regex, and
PowerShell are deferred; resolved references would be a future provider.