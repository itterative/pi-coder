---
name: outline-tool
description: The `outline` tool - digest/search/show/usages/deps/flow, `block` titles for tests and routes, body text, patterns, kind filters.
category: architecture
priority: 7
keep_updated: true
---

# `outline` tool

`digest` maps a file or directory, `search` finds declarations by partial name, `show` returns exact source for
named declarations, `usages` lists syntactic occurrences, `deps` reports one file's imports and dependents, and
`flow` lists the call sites of a file or scope by scope. Test suites and routes are visible because a `block` kind
covers a statement-level call with a literal name and a callback body.
Registered from `src/index.ts`; design notes: `src/tools/code/README.md`.

## Invariants

- **One filesystem view.** All I/O goes through `CodeSource` (`source.ts`): a container session reads through its
  own `fs`/`spawn`, never host `fs`, and the source is chosen per call (`outline-tool/internals.md`).
- **No persistent index.** Parsed files live in a disposable cache, so a changed file drops its hits and usage
  index with it; eviction only costs a reparse (`outline-tool/internals.md`).
- **One registry, one IR.** Ten languages share a single adapter registry and a single `Declaration` IR, so
  parser node types never reach an action or the formatter (`outline-tool/internals.md`).
- **No action guesses.** `usages` is syntactic, `deps` is a file graph, `show` never picks between candidates, and
  a heading is matched as prose. Every filter or detail rule that hid something says so
  (`outline-tool/actions.md`).
- **Routing lives in an `outline_tool_guide` section, not in the description** — and the limitation it states must
  be the literal one (`outline-tool/actions.md`).
- **Prose has a name of its own.** A Markdown heading and a `block` title match a selector by prefix and substring,
  reporting every candidate; a symbol still matches exactly (`outline-tool/blocks-and-flow.md`).

## Defaults

4,000-character `limit`, 1 MB file cap, 2k mapped files, and build/out/cmake-build/third_party/generated ignored.
Cuts are resumable: every action takes `offset` in rendered body lines and a cut ends `# next: offset=N`. Details,
including `[huge]` files, the directory map, and heading matching: `outline-tool/actions.md`.

## Targeted references

- `outline-tool/actions.md` — per-action output semantics: detail modes, the directory map, heading and comma
  matching, one-row-per-line `usages`, offset cuts, narrowing filters, and the guide's routing rules.
- `outline-tool/blocks-and-flow.md` — the `block` kind (the literal-plus-callback discriminator, what it rejects, and
  the identity/container/tag rules it must keep), the `flow` action's scope ownership and caps, and the digest
  empty state.
- `outline-tool/internals.md` — source seam and confinement, the parse-buffer/IR pipeline, the parsed-file cache,
  the large-file worker, yielding, and how to add a language.
- `outline-tool/search.md` — search tiers, BM25 parameters, the semantic tail, artifact/index layout, build cost.
- `outline-tool/models.md` — measured model evaluations and the switch they produced: three selectable profiles
  (Qwen3-Embedding-0.6B default, embeddinggemma-2, LFM2.5), KURE-Sparse-nano rejected, the GPU/Vulkan numbers, and the
  eval traps that cost a rerun.
- `outline-tool/deps.md` — import extraction, resolution states, and the dependents scan.
- `src/tools/code/README.md` — action semantics, per-language behavior, preprocessor rules, limits, tests.
- `src/tools/code/adapters.ts` — language registry: grammar, preprocessor, parser, call sites.
- `src/tools/code/visitor.ts` — shared declaration bookkeeping for new adapters.
- `src/tools/code/parse.ts` — parse dispatch through the registry.
- `src/tools/code/cpp.ts` — C++/HIP extraction and the `declarationStart()` prefix-macro recovery.
- `src/tools/code/typescript.ts` — JavaScript/TypeScript/TSX extraction.
- `src/tools/code/java.ts`, `csharp.ts`, `go.ts`, `rust.ts`, `python.ts`, `php.ts`, `ruby.ts` — per-language
  extraction and scope/access rules.
- `src/tools/code/markdown.ts` — heading extraction without a grammar.
- `src/tools/code/preprocess.ts` — the byte-preserving HIP/CUDA and macro neutralizer.
- `src/tools/code/search.ts`, `body.ts`, `fuzzy.ts` — name/doc search, literal body text, and the typo fallback.
- `src/tools/code/source.ts` — container/local filesystem seam and confinement.
- `src/tools/code/cache.ts` — the 2Q parsed-file cache and its entry/byte eviction policy.
- `src/tools/code/usages.ts` — syntactic identifier indexing and scope/tag classification.
- `src/tools/code/imports.ts`, `deps.ts` — import extraction, resolution states, and the dependents scan.
- `src/tools/code/worker.ts`, `parse-worker.mjs` — the lazy large-file worker and its jiti bootstrap.
- `test/tools/code/`, `test/helpers/code-source.ts` — parser/action, source, cache, worker, registration coverage.