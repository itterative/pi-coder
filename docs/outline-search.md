# Outline search: tiers, BM25, and the semantic tail

`outline search` answers "where is this in the code" in layers. Each layer is cheaper and more trustworthy than
the one below it, and a lower layer never displaces a higher one.

| tier | channel                                  | needs                   | trust                               |
| ---- | ---------------------------------------- | ----------------------- | ----------------------------------- |
| 0    | exact name                               | nothing                 | a declaration with that name        |
| 1    | name prefix                              | nothing                 | a declaration                       |
| 2    | name substring                           | nothing                 | a declaration                       |
| 3    | doc comment (all tokens, any order)      | nothing                 | a declaration whose comment says it |
| 4    | BM25 over name + doc + signature         | nothing                 | _related_: ranked by relevance      |
| 5    | embedding cosine, fused with BM25 by RRF | opt-in download + index | _related_                           |

Tiers 0–3 are the literal pass and are unchanged. Tier 4–5 is the **relevance tail**; it runs only when the
literal pass produced fewer than `TAIL_MIN_LITERAL` (3) rows. A fuzzy identifier match (Damerau, ≤2 edits)
pre-empts the tail: a typo of an identifier is precise evidence, a relevance guess is not, so when one exists
the tail does not run at all. Tail rows carry `[related]` and a footer saying they were ranked rather than
matched.

## BM25 (always on)

`semantic/bm25.ts`. Terms are split at camel humps, acronym runs, digits, and separators; a small English
stoplist is dropped. `tf = 3·name + doc + signature`, `k1 = 1.2`, `b = 0.75`, length normalization over the doc
tokens only. Header/definition pairs collapse to their definition (`pairKey`). Ordering is deterministic:
score, path, line, qualified name.

Per-file token counts live in a `WeakMap<ParsedFile, DocEntry[]>`, so a cached parse is tokenized once; document
frequencies are recomputed per call over the parsed set (well under 100 ms for 8k declarations).

## The semantic channel (opt-in)

Disabled by default. `PI_CODER_OUTLINE_SEMANTIC=off|bm25|hybrid` (default `bm25`), or `/outline on`.
Enabling is never implied by a build: `build` prices the work and asks before it downloads or embeds a large
scope, and an incremental build against a warm index is the only case that runs without a dialog.

### Artifacts are downloaded, never installed

No npm dependency: the wasm runtime, the tokenizer, and the model are fetched into
`<agent-dir>/pi-coder/outline/semantic/` (`$PI_CODER_STATE_DIR` relocates it). The default matters — pi wipes a
git-installed package with `git clean -fdx`, so anything under `node_modules` would be re-downloaded on update.

`semantic/artifacts.ts` pins every file's URL, size, and SHA-256. Downloads stream to `.part` while hashing and
rename only after both match. A `verified.json` records size+mtime+digest so a warm start skips the 200 MB hash
pass. Total is ~211 MB, of which ~197 MB is the model and tokenizer.

| file                                                     | size     |
| -------------------------------------------------------- | -------- |
| `ort.wasm.bundle.min.mjs` + `ort-wasm-simd-threaded.mjs` | 0.1 MB   |
| `ort-wasm-simd-threaded.wasm`                            | 13.6 MB  |
| `onnxruntime_binding.node` + `libonnxruntime.so.1`       | 48.1 MB  |
| `tokenizers.mjs` (zero-dependency JS tokenizer)          | 0.1 MB   |
| `model_q4.onnx` + `_data`                                | 166.5 MB |
| `tokenizer.json`                                         | 30.7 MB  |
| config/tokenizer_config                                  | 7 KB     |

The native pair comes from the pinned `onnxruntime-node` tarball by way of unpkg (`semantic/native.ts`), into
`native/<platform>-<arch>/`. It is optional: `artifactsPresent` only requires the wasm set, the download loop at the
end of `ensureArtifacts` swallows a native failure, and the worker falls back to wasm whenever
`PI_OUTLINE_NATIVE_DIR` is unset or the two files are not the pinned sizes. Only linux-x64 is measured; adding a
platform means measuring its library name and hashes, not just listing it.

### Two runtimes, one vector space

Native (`onnxruntime-node`'s CPU binding, driven directly — `initOrtOnce`, `InferenceSession.loadModel`, `run`) is
used when present. It cannot use `onnxruntime-web`'s JS layer, and does not need it: the binding's whole surface is
those three calls plus a `Tensor` class it wraps outputs in, which is ~30 lines in `embed-worker.mjs`. Measured on 16
cores, same artifacts: query 673 ms → 27 ms (4 threads), 93-token document 1589 ms → 90 ms, session start 2.5 s →
0.2 s, resident 767 MB → 486 MB. Vectors are identical (cosine 1.000000).

### Three constraints of running ort-web wasm in Node

Only the wasm fallback has them; all three were verified against the real model and each is load-bearing in
`embed-worker.mjs`:

1. **`file:` fetch shim.** ort-web is a browser build: it resolves the wasm and the model through `fetch`, and
   Node's fetch rejects `file:` URLs.
2. **`numThreads = 1`.** Multithreading bootstraps a worker through a `blob:` module import, which Node's ESM
   loader refuses — verified again against `numThreads = 2`, which fails session creation outright.
3. **`externalData` mount.** The q4 graph keeps its weights in `model_q4.onnx_data`; the wasm backend needs them
   mounted explicitly, and the modality inputs (`image/video/audio_features`) still need `[0, 512]` dummies. The
   native side reads the external data next to the graph and takes the same dummies.

### Index

`semantic/store.ts`. Layout:

```
<root>/index/<namespace>/manifest.jsonl
<root>/index/<namespace>/shards/<shard>.bin
```

- `namespace = sha256(source.kind \0 root \0 modelId \0 embed-text-version)` — a container view and the host
  view never share vectors.
- Entry key = `sha256(embed-text-version \0 modelId \0 embedText)`, where
  `embedText = "title: <path> | text: <kind> <qualifiedName>. <doc ?? signature>"`. Vectors are L2-normalized at
  write time, so cosine is a dot product.
- A build writes one shard per source file, named with a build timestamp, so a rebuild never rewrites an
  existing shard; pruning deletes shards whose keys disappeared. Each finished shard is appended to
  `manifest.jsonl` itself: a header line, then one line per finished shard (name + keys). `readManifest`
  replays it, so a killed build keeps everything it finished and a later shard overrides an earlier one for
  the same key. A pruning build compacts the file once; an incremental refresh only appends, so the growing
  index is never rewritten.
- Query time recomputes each candidate's key and uses only vectors whose key matches; stale declarations are
  simply absent and the next build embeds them.
- **Compaction is automatic within a bound.** A refresh appends, so dead keys and their shards accumulate; a search
  whose file set covers the whole namespace root counts them and, once they clear 64 entries and 10% of the live
  set (`shouldCompact` in `store.ts`), schedules a prune-only build: no jobs means no model, no parse, just a
  manifest rewrite and the orphaned shards deleted. A subdirectory search never compacts, because its live set is a
  fragment of the namespace.
- A manifest records its `sourceKind`, build `root`, and vector `dims`. A search resolves the exact namespace
  first, then the longest **ancestor** build root, so `outline search src/tools/code` ranks against an index built
  at `.`. The namespace hash carries the model id and text version but not the width, so both lookups also require
  `header.dims === MODEL_DIMS`; a vector whose length differs from the query vector is treated as missing rather
  than scored, because `cosine` truncates with `Math.min` instead of failing. Indexes written before `root` was
  recorded still rank (keys embed absolute paths) but never trigger a refresh or a staleness notice.
- **Pruning is root-scoped.** Building a root prunes keys outside the parsed set. Always build a whole root
  (`/outline build <dir>`), not a hand-picked subset of its files.

### Build

`/outline build <path>` parses the target first, counts what the index is missing (no model needed), and prices
it before spending anything: declarations ÷ workers × ~1.1 s. A build over `BUILD_CONFIRM_THRESHOLD` (200)
declarations, or one that still needs the 211 MB download, asks for confirmation with that estimate; only a small
incremental build proceeds silently. The consent dialog covers a build that has to download, so the first `/outline
build .` cannot spend bandwidth behind the user's back.

While it runs, a `CancellableLoader` component (from `@earendil-works/pi-tui`) owns the interactive area and shows
`Building embeddings for 12 files (42 left; estimate ~1 min)`; Escape aborts through the `AbortSignal` that `buildIndex` passes to its children,
so the `--build` processes die immediately and every shard already published stays in the index. Non-TUI modes
keep the build running and report through notifications, and a closed custom area never cancels it.

Embedding runs in child processes (`embed-worker.mjs --build`, one JSONL job file per worker: a header line,
then one line per source file). **Native** splits work as one or two processes of up to eight intra-op threads each
(`nativeBuildPlan`); a process costs 0.2 s to start and shares a single copy of the weights, so threads are cheaper
than processes. The **wasm** fallback is single-threaded, so there the only way to use more than one core is more
processes: `buildWorkerCount()` defaults to cores capped by available memory (≈1 GiB per child, `MemAvailable` when
Linux exposes it) and `PI_CODER_OUTLINE_WORKERS` overrides it. Files are assigned whole to the least-loaded worker,
and the parent merges the shards into the manifest once every child finished.

**Builds are exclusive per namespace** (`semantic/lock.ts`). Every writer — a search refresh, a foreground
`/outline build`, another pi session on the same root — reads the manifest once and publishes its whole in-memory
view at the end, so overlapping builds would drop each other's shard records and a pruning build would delete shard
files the other one just wrote. `buildIndex` takes `build.lock` (pid + ownership token) before reading the manifest
and releases it in a `finally`; a holder whose pid is gone, or a lock older than two hours, is taken over. A second
foreground build fails with "another outline build is already running for this root"; a refresh checks the lock and
reports "not indexed" rather than queueing. Readers never lock: publication is a random-named temp file plus a
rename, and journal replay skips a truncated final line, so a killed build loses at most its unfinished shard.

Cold cost measured on this machine: **~1.1 s per declaration per worker**, so 200 declarations are ~4 minutes on
one worker and ~15 seconds on sixteen. Incremental edits cost ~1 s each. An interrupted build keeps every shard it
already wrote.

**A background refresh is capped at `refreshWorkerCount()`** — half the cores, never more than four — because it
runs while the user keeps querying and each extra child competes with the warm serve child for cores. Measured on 16
cores, reference query 677 ms idle: 4 workers cost it 9%, 8 workers 20%, 16 workers (512 declarations) 124%, while
the extra workers buy little because every child loads ~1.85 s of model before embedding anything. Explicit
`/outline build` keeps the full scaling: it is user-initiated and blocking.

Batch size stays at one: feeding 16 or 32 declarations through a single `session.run` measured _slower_ (1.34 and
1.36 s/declaration versus 1.10) — the vectors were identical, but padding each row to the longest text in the
batch costs more than the per-call overhead it saves. The session itself is already reused across declarations.

### Freshness and invalidation

Vectors are keyed by the declaration's embedded text, never by path or mtime, so invalidation is implicit:

- editing a declaration produces a new key with no vector — the old one becomes unreachable, never wrong;
- deleting or renaming a declaration does the same (a rename also changes the `title:` path);
- dead keys are pruned only by a full build of that root; until then they cost bytes, not results.

Freshness is automatic within a bound. A hybrid search already has the parsed declarations, so it counts the
keys that have no vector, and when that count is ≤64 it schedules **one additive build** after returning the
results. Additive matters: `prune: false` means a search under `src/a` can never delete the vectors for `src/b`.
Concurrent searches share a single in-flight build per model dir + namespace. A larger drift is reported instead
(`N declarations are not indexed; /outline build <path>`), so a big refactor never queues an hour of hidden CPU.
`builtAt` in the manifest is reporting metadata for `/outline status`; it is never part of a key.

Query embedding costs ~0.65 s once a `--serve` child is warm; that is why the tail only runs on near-empty
literal results. The query child is separate from the build children and exits after five idle minutes.

### Failure policy

Every embedding failure degrades to BM25: absent artifacts, a missing index, a dead child, or a timeout all
produce `[]` from the dense channel. Search never fails because of the semantic layer.

## Tests

`test/tools/code/semantic-*.test.ts` and `search-tail.test.ts`. No test downloads anything or loads the model:
the store, build, fusion, and rendering paths run against a deterministic fake runtime, and the artifact
downloader against an injected `fetch`.
