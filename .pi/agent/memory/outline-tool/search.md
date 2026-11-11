---
name: search
description: Search ranking tiers, the BM25 relevance tail, and the opt-in wasm embedding channel for src/tools/code.
category: architecture
priority: 7
keep_updated: true
---

# Search ranking

`search` is layered, and a lower layer never displaces a higher one: exact name, name prefix, name substring,
doc comment (all query tokens, any order), then the **relevance tail** — BM25 always, embeddings when enabled —
then fuzzy identifier matching. Tail rows carry `[related]` and a footer saying they were ranked, not matched.

The tail runs only when the literal pass produced fewer than `TAIL_MIN_LITERAL` (3) rows, and never when a fuzzy
match exists: an identifier typo is precise evidence, a relevance guess is not. BM25 and embedding lists are
fused with reciprocal rank fusion (`k = 60`), which is where the measured gain came from — the channels' score
scales never have to agree.

## BM25

`semantic/bm25.ts`: camel/acronym/digit tokenization plus a small English stoplist, `tf = 3·name + doc +
signature`, `k1 = 1.2`, `b = 0.75`, length normalization over doc tokens only. Header/definition pairs collapse
to the definition via `pairKey`. Per-file token counts live in a `WeakMap<ParsedFile, …>`; document frequencies
are recomputed per call. Ordering is deterministic (score, path, line, name), which is what the snapshot tests
rely on.

## Embedding channel (opt-in)

Invisible when it works: `SEMANTIC_HINT` ("`/outline on` downloads a ~211 MB model…") rides on tail rows only
while the channel is off or declined, and `prepareSemantic` passes `hint: undefined` in hybrid. So a hybrid search
shows nothing but the ordinary `[related]` footer, and an agent cannot tell from output whether embeddings ran —
which is why the tool guide names the tail and does not claim literal-only matching.

Fully dynamic: **no npm dependency**. Pinned, SHA-256-verified artifacts are downloaded from a pinned CDN/HF
revision into `<agent-dir>/pi-coder/outline/semantic/`, never into `node_modules` (pi's `git clean -fdx` would
delete them). ~211 MB total, ~197 MB of it model + tokenizer. `PI_CODER_OUTLINE_SEMANTIC=off|bm25|hybrid`
(default `bm25`), `/outline on|off|status|build|purge`, and a one-time consent dialog at the first
search of a session. `/outline build <path>` counts what is missing before spending anything, asks for
confirmation above 200 declarations or when the 211 MB download is still needed, then embeds across
cores-capped-by-memory child processes (`PI_CODER_OUTLINE_WORKERS` overrides): 177 declarations took 59.6 s on 4
workers, and an incremental build against a warm index runs without a dialog. The
build UI is a `CancellableLoader` (`Building embeddings for 12 files (42 left; estimate ~1 min)`, with `esc cancels`) wired to an `AbortSignal`; Escape kills the
children and keeps published shards. Background downloads and refreshes use the footer status entry instead.

Three ort-web-in-Node constraints in `embed-worker.mjs`, each verified: a `file:` fetch shim (Node's fetch
rejects `file:`), `numThreads = 1` (threading bootstraps a `blob:` import that Node refuses), and an explicit
`externalData` mount for the q4 weights plus `[0, 512]` dummy modality inputs. Because the session is
single-threaded, a build runs one child per core (memory-capped, each with its own model copy); the parent
merges their shards into the manifest once all children finish. Job files are JSONL.

Index (`semantic/store.ts`): namespace = `sha256(source.kind \0 root \0 modelId \0 textVersion)`, so container
and host views never share vectors; entry key = hash of the embedded text, never path or mtime; one shard per
source file per build, so a rebuild appends and pruning deletes orphans. Width is outside that key chain: the
namespace hash has no `dims`, so the exact and the ancestor lookups both verify `header.dims === MODEL_DIMS`, and a
vector whose length differs from the query vector is counted as missing instead of scored, because `cosine`
truncates with `Math.min` rather than failing — a width mismatch would otherwise look like a plausible ranking.
Finished shards are appended to
`manifest.jsonl` itself (header line, then one line per shard) and `readManifest` replays it, so a killed build
keeps what it finished and later shards override earlier keys. A pruning build compacts the file once; incremental
refreshes only append, so the growing index is never rewritten. `builtAt` is reporting metadata only.

Search resolves the exact namespace first, then the longest **ancestor** build root (manifest headers record
`sourceKind` and `root`), so a subdirectory search uses an index built at the repo root. Legacy indexes without a
recorded root still rank but never refresh or report staleness; `/outline build` with nothing missing rewrites the
header to record it (no embedding). `SemanticSearch.dispose()` kills the warm child:
scripts and tests need it or they linger until the 5-minute idle timeout.

Freshness is automatic within a bound: a hybrid search counts the keys missing from the declarations it already
parsed and, at ≤64, schedules one build after returning results; single-flight is per model dir + namespace. Larger
drift is reported with a `/outline build <path>` hint, never started silently. `prune` is only safe when the
search's file set is the whole namespace root (`resolved.root === request.root && !truncated`), which is what the
`refreshCoversRoot`/`coversRoot` plumbing carries; a subdirectory search stays additive or it would delete the rest
of the index.

**Dead keys compact themselves now** (2026-11-11). Growth is per edit, not per query: a refresh embeds only keys
the manifest lacks (`planEmbeddings` skips present ones), and it appends a shard per touched file while the old
shard with the old keys survives — 3,072 B per vector (768 × 4, measured exact) plus ~70 B of manifest per entry.
A root-covering search counts entries no live declaration claims and, when they pass `shouldCompact` (≥64 **and**
≥10% of live), schedules a prune-only build: jobs are empty, so no model, no parse — a manifest rewrite and a few
unlinks. Dead → live is a *set* difference, not `entries − liveKeys` (a wholesale replacement keeps the same count
and orphans every key; that bug shipped into the first draft and a test caught it). Still unbounded: a superseded
**namespace** is never removed — the v1 index was 42 MB left behind by the v2 bump — so a text-version or model
change costs a full new namespace and the old one needs manual deletion. **Pruning is root-scoped** — build a whole
root, never a hand-picked subset of its files. Embedding failures always degrade to BM25.

Measured on the container CPU: ~1.1 s per declaration cold (single-threaded wasm), ~0.65 s per query once the
child is warm, 6.6 ms to scan 8k×768 vectors in pure JS. The evaluation that chose this design is in the session
scratchpad's `embedding-experiment.md`: BM25 R@1 0.68, embeddings 0.73, RRF 0.68/R@3 0.91, tiers+RRF 0.77/0.91.

## Markdown and memory trees

A heading is a declaration whose range runs to the next same-or-higher heading. Its **doc text is its own prose**
(from the end of the heading line to the next heading of *any* level) since 2026-11-11 / text version v2. That one
field feeds the doc tier, BM25, and `embedTextOf`, so a memory is findable by its content: doc tokens match in any
order, all required, so `Run npm install` hits a section whose prose says it, and a body phrase needs no contiguous
title match any more. Before v2 the doc range was unset and only heading titles were searchable — do not reintroduce
that; body text is the bulk of a memory.

The doc tier's tokens come from `tokenize` in `semantic/bm25.ts`, stoplist included — not a second tokenizer. It
used to normalize-and-split with no stoplist, so every `the`/`from`/`why`/`do` in a natural-language query became a
*required* substring and the tier almost never fired: `strip comment markers from the doc text` returned 0 doc hits
and paid the tail while the same query minus two stopwords hit `declarationDoc` directly. One tokenizer, one notion
of a content word.

Deliberately *not* the section range: a parent whose doc were the whole section would repeat every subsection in
the doc tier, the BM25 document, and its vector. A heading with no prose before its first child gets no `docRange`
at all. Setext underlines are excluded from the prose; a fenced block is prose (it is searchable content). Markdown
skips the comment-marker stripping the code path uses, or `*` bullets and `**bold**` would be eaten.

`show` still prints a section exactly once: `sourceForDeclaration` renders a doc range only when it precedes the
declaration range, so Markdown's in-range prose is not duplicated. Frontmatter `description:` is still *not*
indexed — it lives outside every heading's prose.

Useful workflow: `search` a phrase, then `show` it (which returns the whole section) or `digest` the cluster — a
9-file compaction cluster maps in ~3.3 KB. Point `path` at a memory tree directly; `.pi/agent` also walks `git/`
clones and `node_modules` and hits the 2k-file discovery cap.

**The v2 text change invalidates the whole index**: `EMBED_TEXT_VERSION` is in the namespace hash *and* the header
check (`resolveIndex` rejects a manifest with a different `textVersion`). Code declarations also embed doc *and*
signature now, so nothing can be reused: ~515 declarations for the memory trees (≈5 min), 11.3k for this repo
(≈1 h, background). Until a rebuild, `search` degrades to BM25 + doc tier, which for memories is now the good path
anyway.

## Measured latency

Measured 2026-11-11 on this checkout (warm session, `.state` state dir), with scratch scripts under the session
scratchpad (`measure-search.ts`, `measure-container.ts`, `measure-semantic.ts`, `measure-embed.ts`,
`measure-rank.ts`):

| phase | cost |
|---|---|
| literal search, warm cache | 9 ms (memory tree) / 23 ms (repo) |
| container fs op through a live dispatcher | 0.1 ms stat, 0.2 ms readFile — not a factor |
| cold parse of the repo (734 files) | ~2.0 s |
| `readManifest` replay, per tail search | **1.54 s** before the fix; now 15 ms first read, 0.2 ms cached |
| query embedding, warm wasm child | 0.61 s (cold child adds ~2.0 s) |
| whole tail rank | 2.15 s (memory) / 2.29 s (repo) before the fix; 0.62 s / 0.79 s after |

So a search that finds ≥3 names/doc comments is already ~25 ms; the 1–2 s cases are exactly the ones that fall
through to the tail. Batched searches serialize on the single embed child, so N tail searches cost N × the tail
cost.

**The tail is now gated on evidence, not just row count** (`wantsTail` in `semantic/rank.ts`, 2026-11-11): it runs
only below 3 literal rows *and* with zero doc-tier matches. Measured on the memory tree after that fix plus the
tokenizer fix: a doc hit answers in 10–15 ms warm (75–320 ms when the parse itself is cold), where the equivalent
query previously paid 0.6–3.2 s (`tail` 98% of `totalMs`) and got 8 `[related]` rows under an already-correct
first row. One body-only word: 627 → 11 ms. One body-only phrase: 3209 → 75 ms. A natural-language question whose
filler words are now stoplisted: 1285 ms with the right section at #3 → 10 ms with it at #1 (live: 263 ms on the
first call, 13.9 ms warm). Queries the doc tier genuinely cannot reach — one content word that no doc contains, or
the wrong vocabulary for the codebase — still take the tail: live 2611 ms with a cold model child, 683 ms warm.

Do not quote a probe query verbatim in a memory. The memory then becomes a doc hit for that query and outranks the
section that actually answers it (observed: a benchmark note ranked #2 for the question it was measuring).

**The 1.54 s was a quadratic replay, not I/O — fixed 2026-11-11.** `readManifest` replayed 664 shard lines
through `replaceShard`, which rebuilt the entire `entries` object per line (11,238 entries → ~7.4M property
copies). Measured: JSON.parse of the whole file 2 ms, the old replay 1585 ms, an in-place replay 2 ms. The store
now replays in place (`applyShardRecord` + a per-shard key list, so a replayed shard drops its own earlier keys
without scanning) and keeps exported `replaceShard` pure for its other call sites and the immutability test.

`readManifest` also caches the parsed manifest per directory, invalidated by a stat (exists/size/mtime/inode) of
all three files it reads, so `resolveIndex`'s per-search read costs 0.2 ms instead of re-parsing 784 KB. The
stamps are taken *before* the read, so a write that lands mid-read is picked up next call. Bounded at 8
directories and skipped above 100k entries; the cache hands out a shared object, so callers must treat the
manifest as read-only (all current ones copy with `{ ...manifest }` before writing).

After the fix, a warm tail search is 0.62 s (memory tree) / 0.79 s (repo) — dominated by the 0.61 s query
embedding, which is the model's own cost. A test replays a 1200×150-shard manifest, sized so the old replay
would time out.

**Every call now reports its own breakdown**, so this table is a starting point rather than the only view:
`details.timing` (and the `timing:` line the TUI renders under a result, which the text output never carries) has
`totalMs`, `sourceMs`, `semanticMs`, `discoverMs`, `parseMs`, `searchMs`, `tailMs`, `workMs`, plus `files`,
`cached`, `parsed`, `tooLarge`, `parseErrors`. `workMs` is the remainder, so the phases add up. Read that line
before theorizing: `parsed` > 0 is a cold parse, `all cached` with a high total is somewhere else, and `tailMs`
is the embedding channel. `parseMs` wraps `loadParsedFiles`, so on a fully cached call its few tens of ms are the
cache-key stat for every file (737 files ≈ 73 ms), not parsing.

**The tail also used to pay a cold model per search.** `prepareSemantic` builds a fresh `SemanticSearch` on every
search, and the runtime was a variable inside that factory, so each tail search spawned its own embedding child:
measured 2.5 s per search (1.9 s of model load every time) and one resident copy of the ~197 MB weights per
search until the child's idle timeout. The runtime is now module-level, shared per model dir
(`sharedEmbedRuntime`), which is what makes the documented "kept warm" behaviour true: the same query went
2.5 s → 0.64 s, cold 2.5 s only on the first tail search of a process (observed 704 ms warm in-session). The
timing line is what made this visible — `tail 2525` twice in a row.

**A refresh must not starve a query.** Separate children mean a refresh never *blocks* a query, but it competes for
cores: measured 2026-11-11 on 16 cores (`measure-contention.ts`), reference query 677 ms idle — 64 declarations at
1 worker 59 s, query +1%; 2 → 31 s, +3%; 4 → 17 s, +9%; 8 → 13 s, +20%. 512 declarations: 4 → 127 s, +9%; 8 → 71 s,
+71%; 16 → 65 s, +124%. Extra workers stop paying because each child loads ~1.85 s of model first (cold
`embedQuery` 2521 ms vs 675 ms warm). So a *background* refresh passes `maxWorkers: refreshWorkerCount()` =
`min(4, cores/2)` while explicit builds keep full scaling; the batch splitter already assigns files to the
least-loaded worker. Raising the serve child's 5-minute idle timeout, not round-robin across several serve
children, is what would remove the 2.5 s cold-tail pause — each extra serve child costs ~200–400 MB and never helps
sequential tool calls.

**One writer per namespace** (`semantic/lock.ts`, 2026-11-11). `writeManifest` publishes via a random-named temp file
plus `rename`, and journal replay skips a truncated last line, so *readers* were never at risk and never take the
lock. Writers were: each build reads the manifest once and publishes its whole in-memory view at the end, so a
search refresh, a foreground `/outline build`, and another session on the same root could interleave — losing each
other's shard records, and a pruning build deleting shard files the other just recorded (`readVectors` then treats
them as absent: silent vector loss). `buildIndex` now takes `build.lock` (pid + ownership token; taken over when the
pid is dead or the file is older than 2 h, which outlasts the ~1 h worst-case build) *before* reading the manifest
and releases it in a `finally`. A foreground build throws "another outline build is already running for this root";
a refresh checks `indexLockHeld` first and reports "not indexed" instead of scheduling a build that would bounce.
The temp-file name is `${pid}.${randomUUID()}` because `${pid}` alone collided for two in-process builds.

**Builds never had that defect and must not acquire it.** `EmbedRuntime.build` does not touch the serve child; it
spawns `--build` children, one worker per ~8 declarations capped by cores, each loading the model once for its
batch. So `buildIndex`'s `options.runtime ?? createEmbedRuntime(...)` coordinator is free (construction is lazy),
and `deps.runtime` exists for tests to inject a fake. Do not route builds through `sharedEmbedRuntime`: that would
couple them to a serve child that may have died. Manifest cost in the build path is now the same linear, stat-cached
`readManifest`; a pruning build rewrites the file, which changes the inode and invalidates the cache once.

## Targeted references

- `docs/outline-search.md` — the full design: tiers, artifact manifest, wasm constraints, index, build cost.
- `src/tools/code/semantic/*.ts` and `embed-worker.mjs` — bm25, rank, store, artifacts, runtime, worker.
- `test/tools/code/semantic-*.test.ts`, `test/tools/code/search-tail.test.ts` — no test downloads or loads the
  model; the fake runtime exercises build, fusion, and rendering.