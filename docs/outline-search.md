# Outline search: tiers, BM25, and the semantic tail

`outline search` answers "where is this in the code" in layers. Each layer is cheaper and more trustworthy than
the one below it, and a lower layer never displaces a higher one.

| tier | channel                                  | needs                   | trust                                  |
| ---- | ---------------------------------------- | ----------------------- | -------------------------------------- |
| 0    | exact name                               | nothing                 | a declaration with that name           |
| 1    | name prefix                              | nothing                 | a declaration                          |
| 2    | name substring                           | nothing                 | a declaration                          |
| 3    | doc comment (all tokens, any order)      | nothing                 | a declaration whose comment says it    |
| 4    | literal body text                        | nothing                 | the declaration that contains the text |
| 5    | BM25 over name + doc + signature         | nothing                 | _related_: ranked by relevance         |
| 6    | embedding cosine, fused with BM25 by RRF | opt-in download + index | _related_                              |

Tiers 0–4 are the literal pass. Tier 5–6 is the **relevance tail**; it runs only when the literal pass produced
fewer than `TAIL_MIN_LITERAL` (3) rows. A fuzzy identifier match (Damerau, ≤2 edits) pre-empts the tail: a typo of
an identifier is precise evidence, a relevance guess is not, so when one exists the tail does not run at all. Tail
rows carry `[related]` and a footer saying they were ranked rather than matched.

## Literal body text

`search` reads declaration bodies (`bodyRange`) for text-shaped queries — at least two whitespace-separated words —
and reports the innermost declaration that contains the match, one row per declaration with an evidence line and an
occurrence count. The shape gate is what keeps it from being a second grep: a single word is an identifier question,
and every body that mentions `connect` would otherwise flood a result `usages` answers properly. Markdown files are
skipped because their prose is the doc channel already.

The cap is a budget decision rather than an evidence one (`semantic/rank.ts`'s tail gate is about spending a query
embedding; a body hit is a literal scan that has already run): `BODY_ROWS` (20) when the name and doc channels found
less than three rows and no doc match, `BODY_ROWS_WHEN_LED` (3) when they already lead, and a footer naming what was
withheld so the count never reads as complete. Body rows count as literal evidence for the related gate, so a
text-shaped query with body hits keeps the lexical rows first.

Cost: one lowercased pass over each parsed file rejects the files that cannot match, then each candidate declaration
body is scanned for the query tokens. Per-file body hits are cached in a `WeakMap<ParsedFile, …>` keyed by query,
exactly like the lexical hits, so a cached parse pays once and pagination is free.

## Dependency scope

`within` on `search`/`usages` intersects the candidate files with one file's direct imports
(`within="src/x.ts"`) or direct importers (`within="dependents:src/x.ts"`); the anchor is relative to the literal
prefix of `path`, the directory a scoped pattern starts in. The anchor is always kept, the `path` pattern still
bounds the tree, and the `# within:` footer names the direction, the anchor, the file count, and any neighbour that
fell outside the searched path. Edges come from `imports.ts` (`scope.ts` builds the index), so the
scope is exactly the `deps` graph, one hop deep; a neighbour whose target the scan cannot see does not exist.
Unlike `deps`, the scope does not change discovery: the searched root is parsed as usual, and the neighbourhood is
an intersection over those parses plus the anchor. With a `path` pattern, a second unfiltered discovery supplies the
resolution index, because the pattern bounds what is searched, not which imports are real.

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

No npm dependency: the llama.cpp release archives and the model are fetched into
`<agent-dir>/pi-coder/outline/semantic/` (`$PI_CODER_STATE_DIR` relocates it). The default matters — pi wipes a
git-installed package with `git clean -fdx`, so anything under `node_modules` would be re-downloaded on update.

`semantic/artifacts.ts` pins every file's URL, size, and SHA-256. Downloads stream to `.part` while hashing and
rename only after both match. A `verified.json` records size+mtime+digest so a warm start skips hashing the weights.
Total is ~700 MB for the default profile: one model file and two small runtime archives.

| file                                    | size     | why                                                |
| --------------------------------------- | -------- | -------------------------------------------------- |
| `qwen3-embedding-0.6b-q8.gguf`          | 639.2 MB | the model, tokenizer included                      |
| `llama/b12360/ubuntu-x64.tar.gz`        | 23.3 MB  | llama.cpp release, CPU backend (61 files unpacked) |
| `llama/b12360/ubuntu-vulkan-x64.tar.gz` | 36.2 MB  | the same release built for Vulkan devices          |

One file carries the tokenizer, so the 30.7 MB `tokenizer.json`, its 100 KB of JavaScript, the ONNX graph and its
external-data sidecar, and 24 MB of ort-web are all gone. The release tarballs unpack into
`llama/<tag>/<flavour>/`, where the executables find their ~60 libraries through `RUNPATH=$ORIGIN` — no environment
to set up. Extraction is a ~60-line tar reader plus node's own gunzip (`semantic/llamacpp.ts`), because neither a
`tar` binary nor a dependency is available inside a pi session; entries that escape the destination are dropped.

### One runtime: llama.cpp

`llama.cpp` has no in-process binding we could ship without a compiler or a third-party dependency, and its server
already speaks OpenAI's `/v1/embeddings` shape, so the runtime is a **child process**: `semantic/server.ts` spawns
`llama-server --embeddings`, polls `/health`, and posts one text at a time. The model loads once per model directory
instead of once per worker, which is the memory story as well as the simplicity story: a 16-worker build used to hold
sixteen copies of the weights.

**One server, shared by queries and builds.** A query and a build draw on the same loaded model and the same queue, so
a build request in flight delays a query by at most one text — which is why a background refresh is capped at
`refreshConcurrency()` (half the cores, never more than four) and a CPU build keeps exactly one request in flight.

**Device selection is per role, and the GPU server is transient.** Queries run on the CPU by default; builds run on a
GPU when there is one. A query is one short text, where a GPU saves ~40 ms; a batch import is thousands of them, where
it is 20x. The asymmetry is what lets the build server be _killed when the build ends_, so the GPU is borrowed only for
the import the user asked for and never held at query time — a user doing their own GPU work does not have to reserve
VRAM for a search tool. Measured: 1.76 GB of VRAM appears for an import and is gone when it finishes; the query server
stays in RAM.

- `PI_CODER_OUTLINE_QUERY_DEVICE` / `PI_CODER_OUTLINE_BUILD_DEVICE` = `cpu|vulkan|auto` per role, default `cpu` and
  `auto`; `PI_CODER_OUTLINE_DEVICE` pins both, and a role variable wins over it.
- The Vulkan bundle is asked `--list-devices`, and a software-only answer (`llvmpipe`, `swiftshader`, …) falls back to
  the CPU bundle, because a software Vulkan device is strictly slower than the CPU backend.
- **A GPU server is pinned to exactly one device** (`-dev Vulkan0 -sm none`). `-ngl` on its own offloads to _every_
  visible device, and the default `--split-mode layer` splits the model's layers across them — so on a two-GPU machine a
  640 MB embedding model is pipelined over PCIe and ends up slower than one card and slower than the CPU. The device is
  the one with the most free VRAM, not the first in the list, because the first is usually the integrated GPU;
  `PI_CODER_OUTLINE_VULKAN_DEVICE=Vulkan1` names one explicitly.
- A Vulkan server that cannot start — VRAM already taken, a driver upgraded mid-session — is retried on the CPU bundle
  for that build, with one stderr line saying so. A machine whose VRAM is in use is a normal state, not a failure.
- Mixing backends is safe: CPU and Vulkan vectors for the same text score cosine 0.9994–0.9998 (same weights, different
  accumulation order), and entry keys are text hashes, so an index built on the GPU ranks identically when queried on
  the CPU.
- Only linux-x64 has a measured bundle; any other platform falls back to BM25 only, where the ONNX path used to offer
  wasm everywhere. `PI_CODER_OUTLINE_LLAMA_SERVER` replaces the binary outright (tests use it).

### Index

`semantic/store.ts`. Layout:

```
<root>/index/<namespace>/manifest.jsonl
<root>/index/<namespace>/shards/<shard>.bin
```

- `namespace = sha256(source.kind \0 root \0 modelId \0 embed-text-version)` — a container view and the host
  view never share vectors.
- Text is capped at **12,000 characters** before embedding (`MAX_TEXT_CHARS`), which is roughly 3,000 tokens of
  prose and inside the server's 8k context and 4k physical batch. The old runtime cut at 1,024 tokens because
  attention cost was superlinear and every sixth layer attended fully; with llama.cpp the server tolerates far more
  and a long section only costs its own build time, so the cap exists to keep one pathological section from
  monopolising the queue. A text that still exceeds the physical batch halves itself and retries rather than losing
  the vector.
- Entry key = `sha256(embed-text-version \0 modelId \0 embedText)`. A declaration contributes a **head**,
  `"title: <path> | text: <kind> <qualifiedName>. <doc> <inline comments> <signature>"` (v4 added the inline
  comments), and, when its body is at least 800 characters, one entry per **body chunk**,
  `"title: <path> | text: <kind> <qualifiedName> (§i/n) <signature>. <body>"`. Chunks are planned by
  `semantic/chunks.ts`: split at direct child declarations (a chunked child collapses to its signature line), pack to
  a 1,600-character target, cut an oversized
  block at line boundaries with 8 lines of overlap, and merge adjacent chunks past the 12-chunk cap. The plan is
  deterministic and cached per parsed file, and the policy is part of `embed-text-version`. Vectors are
  L2-normalized at write time, so cosine is a dot product.
- The live set is heads _plus_ chunks: a prune keeps them, a refresh fills them, and an idle scan counts chunk keys
  (a body-only edit moves chunk keys without changing the head text). Ranking takes a declaration's best vector and
  reports the chunk that won, which is what the `§i/n :start-end` row line names. On this repository, ≈8.7k
  declarations become ≈9.9k entries (+14%) with ≈1.8 MB of chunk text.
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
  `header.dims === profile.dims`; a vector whose length differs from the query vector is treated as missing rather
  than scored, because `cosine` truncates with `Math.min` instead of failing. Indexes written before `root` was
  recorded still rank (keys embed absolute paths) but never trigger a refresh or a staleness notice.
- **Pruning is root-scoped.** Building a root prunes keys outside the parsed set. Always build a whole root
  (`/outline build <dir>`), not a hand-picked subset of its files.

### Build

`/outline build <path>` parses the target first, counts what the index is missing (no model needed), and prices
it before spending anything: declarations ÷ concurrency × ~0.45 s, a deliberate underestimate of a Vulkan device and
a fair estimate for a CPU one. A build over `BUILD_CONFIRM_THRESHOLD` (200) declarations, or one that still needs the
download, asks for confirmation with that estimate; only a small incremental build proceeds silently. The consent
dialog covers a build that has to download, so the first `/outline build .` cannot spend bandwidth behind the user's
back.

While it runs, a `CancellableLoader` component (from `@earendil-works/pi-tui`) owns the interactive area and shows
`Building embeddings for 12 files (42 left; estimate ~1 min)`; Escape aborts through the `AbortSignal` that
`buildIndex` passes down, so in-flight requests are abandoned and every shard already written stays in the index.
Non-TUI modes keep the build running and report through notifications, and a closed custom area never cancels it.

Embedding is now **requests, not processes** (`semantic/runtime.ts`). The server serialises them, so
`buildConcurrency()` — four by default, `PI_CODER_OUTLINE_WORKERS` to override, eight at most — is a queue depth,
not a worker count: on a GPU it keeps the device busy between short requests (1.38× over sequential at 257 tokens)
and on a CPU it collapses to one, because extra requests would only queue in front of the user's next query. The
parent writes the shard files itself (`indexDir/shards/<shard>.bin`, float32 in key order), which is why query and
build now share one code path.

**Cost, measured end to end on this repo** (`src/tools/code`, 1,502 declarations → 1,754 vectors, Qwen3-Embedding at
Q8_0):

| device         | build                 | warm query                    | first query                  |
| -------------- | --------------------- | ----------------------------- | ---------------------------- |
| Vulkan (RDNA4) | 18 s — 96.6 vectors/s | 13 ms (if queried on the GPU) | 0.76 s (model load included) |
| CPU, 8 threads | 363 s — 4.8 vectors/s | 56 ms (the default)           | 1.2 s                        |

With the default role split a build uses the first row and a query the second: an 11.3k-declaration tree is ~2 minutes
of GPU time (VRAM held only while it runs) and a search costs 56 ms on a warm CPU server. Incremental edits cost one
text each.

**A background refresh is capped at `refreshConcurrency()`** — half the cores, never more than four — because it runs
while the user keeps querying and shares the one model with that query. The cap matters more than it used to: the
requests are now a single queue, so the only reason a refresh cannot stall a search is that its queue stays short.

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

**A root without an index starts one.** The 64-declaration cap is a rule about _catching up_: a refactor that
changed hundreds of declarations should be an explicit build. A root that has no index at all has nothing to catch
up on, and refusing it means it never becomes searchable — which is what happened to every tree the repo-wide walk
could not reach (a gitignored `.pi/agent/memory`, a package outside the checkout). So `denseRanking` reports the
candidates as missing with `refreshRoot` set to the _searched_ root, and the first build is allowed up to
`INITIAL_BUILD_LIMIT` (20k declarations). The same rule fires when a borrowed ancestor index holds none of the
search's declarations: the searched root gets its own namespace instead of appending a handful of vectors into an
11k-entry repo index. A namespace written by a model of another width is _not_ rebuilt this way — it is ignored, and
`/outline build` is the explicit remedy, because rebuilding under it would mix two vector spaces.

A query costs 13 ms against a warm server on a GPU and 56 ms on a CPU, after a one-off model load of ~0.8 s (again:
one server, so a build in flight and a search share the load). It exits after five idle minutes, and `dispose()` kills
it — a leaked server holds hundreds of MB of VRAM, which is why the child is also killed on `process.exit`.

### Measured: what the dense channel actually adds

Run on 2026-11-11 with the artifacts of the time (ORT + embeddinggemma), on an 8-declaration C++ fixture, to answer
the one claim the guide could not back: _does hybrid find a doc comment whose words differ from the query?_ The
fixture and the conclusions below are about a fused tail, not about a specific model, but the absolute cosines are
that model's and do not transfer to the current profile.

| query                                                                        | best declaration                                                                        | cosine | lexical (BM25 tail) | hybrid             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------ | ------------------- | ------------------ |
| "graphics card idle when work is split across thread blocks"                 | `schedule_window` ("Splits the window across workgroups so the last stage can overlap") | 0.747  | rank 1              | rank 1             |
| "how much padding does a four-byte alignment need" (no answer in the corpus) | —                                                                                       | 0.680  | no match            | 8 `[related]` rows |
| "how long did that step take"                                                | `log_duration`                                                                          | 0.719  | rank 1              | rank 1             |

Two things follow, and both are worth knowing before trusting the label:

- **Dense added nothing on the rows that mattered.** BM25 already ranked the answer first in every answered case,
  because a partial term overlap is enough for a _tail_ (the tail does not require every token, only the doc tier
  does). What hybrid reliably changes is the row _count_: the dense list scores every declaration, so RRF fills the
  tail to `TAIL_ROWS` (8) where BM25 returned one row. That is the cost the `wantsTail` gate exists to contain.
- **A score floor is not available.** Cosines are compressed into 0.6–0.75 for this model and corpus: the best row
  for a query with _no_ answer (0.680) outscores the seventh row of a query that has one (0.622). Absolute thresholds
  therefore cannot separate relevance here, and a relative margin is one fixture's guess. The honest signals stay the
  ones already in the output: the `[related]` tag, the footer naming the channels, and the row cap.

A comment **inside** a function body is invisible to all of it: promoting that comment to the adjacent doc block is
what changes the outcome, which is the boundary the guide now states.

### Failure policy

Every embedding failure degrades to BM25: absent artifacts, a missing index, a dead child, or a timeout all
produce `[]` from the dense channel. Search never fails because of the semantic layer.

## Tests

`test/tools/code/semantic-*.test.ts` and `search-tail.test.ts`. No test downloads anything or loads the model:
the store, build, fusion, and rendering paths run against a deterministic fake runtime, and the artifact
downloader against an injected `fetch`.
