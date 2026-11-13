---
name: models
description: "Measured evaluations of outline search models: KURE-Sparse-nano rejected (export recipe, quantisation failure modes, cost/quality) and the Qwen3-Embedding-0.6B candidate."
category: architecture
priority: 6
keep_updated: true
---

# Outline search: model evaluations

Decision 2026-11-13: **the runtime is now llama.cpp and the default profile is Qwen3-Embedding-0.6B Q8_0**
(peak: `MODEL_ID`/`MODEL_DIMS` are gone — `semantic/profiles.ts` owns three profiles, selected by
`PI_CODER_OUTLINE_MODEL=gemma|qwen3|lfm2`, each a single GGUF with its width and asymmetric prefixes; the id is part of
the namespace so switching builds a new index). **KURE-Sparse-nano rejected**; **Qwen3-Embedding-0.6B adopted** — its
quality holds up, and its build-cost objection was a CPU-only objection (~2 min on a GPU, ~40 on a CPU);
**LFM2.5-Embedding-350M measured and not better** than the incumbent at depth, but kept as a selectable profile
because it is the fastest of the three. The sections below are the measurements that decided this; the runtime that
executes them is described in `search.md` (`semantic/llamacpp.ts`, `server.ts`, `profiles.ts`). KURE was rejected
because the incumbent is good
enough, **not** because it measured badly — it beats the dense channel on this corpus, but it loses to the BM25
tail, and a second lexical channel cannot decorrelate (RRF with it never beat BM25 alone). Anything that replaces
the channel has to beat BM25 on the tail's own turf, then keep the paraphrase regime that dense currently owns.

## KURE-Sparse-nano (rejected)

Learned sparse, 36,282 canonical terms, ModernBERT 22 layers / hidden 768 / vocab 50,002, `[Q]`=50000,
`[D]`=50001. Pooling is `log1p(relu(logit − 10))` per position → **max** over positions → max-fold onto terms;
`top_k` is null and `chunk_size` is only a PyTorch memory bound, so one `amax` is equivalent. Similarity is
**dot**, not cosine. Upstream ships no ONNX.

The export (fp32 `ModernBertForMaskedLM` + the pooling forward traced as one module, opset 18, dynamic seq,
output `sentence_embedding` `[1, 36282]`) is exact: max |Δ| 1.2e-05 over all dims with identical support against
PyTorch, **on the shipped engines** — the pinned native binding 1.31.1 and the ort-web bundle. Pooling has to be
inside the graph: raw logits are `[1, S, 50002]`, i.e. 205 MB at 1024 tokens. Its WordPiece `tokenizer.json`
loads in the shipped `@huggingface/tokenizers` and yields the same ids as Python, so a model swap changes only
the tokenizer *data*, never the worker's tokenizer code.

Failure modes, each measured and each an hour to rediscover:

- **Dynamic int8 destroys it.** Cosine 0.20 on a code document, and an all-zero vector on a 2,403-token text.
  `logit_shift = 10` plus `relu` is a hard support threshold: 8-bit activations bias logits below it and terms
  stop firing entirely. Weight-only quantisation (`com.microsoft.MatMulNBits`) survives because activations stay
  fp32.
- **bf16 cannot run.** ORT's CPU EP raises `NOT_IMPLEMENTED ... MatMul(13)`; ort-web has no bf16 kernels at all.
  A bf16 checkpoint is a storage dtype, not a runnable one.
- **fp16 conversion** with `keep_io_types=True` yields an invalid graph (type mismatch on a `Cast`); not worth
  pursuing on CPU.
- **q8 weight-only is the slowest variant** from 64 tokens up — dequantisation costs more than the bandwidth it
  saves at these shapes. q4 is the only competitive quantisation.

Cost, 4 threads on the native binding: fp32 601 MB / q8 282 MB / q4 226 MB. Query at 16 tokens ≈ 22–27 ms for
*every* variant (q4 fastest at 22.4), so query latency is a wash; documents are 275–369 ms at 256 tokens and
1.87–2.39 s at 1024, against gemma-q4's 253 ms and 1.33 s — **15–47% slower per document**, and 0.61–0.90 s
versus 0.22 s session load.

Quality, over 805 declarations from `docs/` + `.pi/agent/memory` embedded with the tool's own `embedTextOf`:

| query set | bm25 | gemma-dense | kure-sparse |
| --- | --- | --- | --- |
| mechanical, n=504 (prose words, heading excluded) | **0.685 / 0.837** | 0.236 / 0.440 | 0.274 / 0.480 |
| paraphrased, n=21 (hand-authored) | 2/21 | 1/21 | 3/21 |

R@1 / R@3 on the first row; the second is too small to be evidence. Dot beats cosine for this model (cosine
loses 0.07 R@1 on the large set and scores 0 on the small one) — the card's stated metric is the right one.
`rrf(bm25+kure)` is 0.474 R@1 against BM25's 0.685: fusing a weaker lexical channel costs more than it adds.

## Evaluation traps

- **`loadParsedFiles` returns files in completion order**, so a hash of its output is not deterministic — key an
  embedding cache by text, and guard it by coverage rather than by a corpus digest.
- **Section-level gold understates every channel** on a corpus with duplicated prose (memory index files restate
  their nested docs; `docs/` restates memories). Use it for channel-versus-channel, never for an absolute rate.
- **Keep query regimes separate.** Mechanical term-overlap and paraphrased sets favour different channels, and a
  merged score flatters whichever the mix happens to suit. 21 queries cannot separate a 1–2 query difference;
  say so instead of reporting a lead.
- **A query built from its target's own words measures nothing.** It hands the answer's vocabulary to both
  sides, so BM25 wins by construction (0.688 R@1 on such a set versus 0.058 on real information needs). The
  same corpus, read and queried by hand, reverses the ranking. Author queries from a *need*, not from prose.
- The harness is `~/.cache/pi-coder/kure-export/eval/{gate,compare,bench}.ts` with `queries.json` and a warm
  `embed-cache.json` (gate re-runs in ~90 s); the export and quantisation scripts sit next to it. `~/.cache` is
  not source — re-derive it if it is gone rather than trusting a stale path.
- The llama.cpp comparisons are `eval/gguf-eval.ts` (`embed <gemma|qwen3|lfm2> <port>` then `score`) with
  `gguf-*.json` vector caches, `eval/bench-embed-ladder.mjs` for ms/token, and `eval/bench-llama-batch.mjs` for
  the batching question. `score` prints R@1/R@3/R@10/MRR plus the paired exact-binomial test.

## Candidate: Qwen3-Embedding-0.6B

`onnx-community/Qwen3-Embedding-0.6B-ONNX` (transformers.js export). Dense, 1024 dims (MRL-truncatable),
Qwen3Model 28 layers, hidden 1024, 32k context, vocab 151,669 — the embedding table dominates the file. Only
`model_q4f16.onnx` (567 MB) is size-plausible; int8/uint8/quantized are 613 MB, q4 914 MB, fp16 1.2 GB, and
`tokenizer.json` is 11.4 MB.

Measured 2026-11-13 on 52 hand-authored queries over `docs/` + `.pi/agent/memory` (exact-section gold, plus
`file@3` for the right file in the top 3):

| channel | R@1 | R@3 | MRR | file@3 |
| --- | --- | --- | --- | --- |
| bm25 | 0.058 | 0.231 | 0.164 | 0.308 |
| gemma-dense (incumbent) | 0.135 | 0.192 | 0.207 | 0.500 |
| **qwen3-dense** | **0.173** | **0.404** | **0.309** | **0.635** |
| rrf(bm25+qwen3) | 0.192 | 0.308 | 0.277 | 0.462 |

R@3 is 21/52 against 10/52 for the incumbent, 13 discordant pairs to 2 (McNemar p ≈ 0.007); R@1 is not
significant. It is the first candidate with a measured gain in the regime the channel exists for. The corpus is
**prose, not code**, so the channel's main population is unmeasured — and a declaration-level query set was
deliberately not built, because a query that names the declaration is answered by the literal tiers and a
comment-prose set would repeat this one.

**Speed, same day, on the shipped native binding.** Query latency is fine; the build is the problem.

| tokens | gemma-q4 | qwen3 q4f16 | ratio |
| --- | --- | --- | --- |
| 16 (query) | 26 ms | 50 ms | 1.9× |
| 128 | 119 ms | 349 ms | 2.9× |
| 256 | 248 ms | 735 ms | 3.0× |
| 512 | 554 ms | 1,610 ms | 2.9× |
| 1024 | 1,327 ms | 3,759 ms | 2.8× |

- **~3× per token, flat** (1.51 vs 4.20 ms/token between 512 and 1024), not a superlinear blowup.
- **Build**: 2.3 texts/s vs 7.0 at 256 tokens with 8 threads; this repo's 11.3k declarations are **83 min vs
  27 min** on one worker, ~10 vs ~3.4 min across 8.
- **Threads**: 1→2 1.92×, 4 3.55×, **8 6.02×, 16 5.50×** — cap the native plan at 8, not at cores.
- **Memory**: **923 MB vs 154 MB RSS per child** — at the repo's `BYTES_PER_WORKER` (1 GiB), so build parallelism
  drops on a small machine even though it is unchanged on a large one.
- **Session load**: 1.54 s vs 0.22 s per child; 8 children pay ~11 s before the first embedding.
- **wasm fallback**: it runs (`MultiHeadAttention`/`RotaryEmbedding`/`MatMulNBits` are all supported) but at
  **1.73 s for a 16-token text vs 50 ms native, ~35×** — effectively native-only, unlike Gemma.
- No quantisation workaround is needed: `q4f16` is already weight-only, so KURE's int8-activation collapse cannot
  happen here (there is no shift-and-relu threshold in the graph).

### Runtime comparison: ORT vs llama.cpp, CPU (2026-11-13)

Neither runtime is the bottleneck — the model is. At **equal 4-bit precision**, 8 threads, 200 tokens: **ORT
q4f16 341 ms (1.70 ms/token) vs llama.cpp Q4_K_M 327 ms (1.63 ms/token)**, a 4% gap. A prebuilt CPU llama.cpp
(b12360) plus a GGUF is not a speed fix, so the ~3× cost against Gemma is the model's size and architecture, not
ONNX Runtime.

- **llama.cpp does not parallelise `/v1/embeddings` in this build.** One batched request of 4, four concurrent
  requests, and four sequential requests all cost ~4× a single request (1,243 / 1,276 / 1,251 ms at 200 tokens),
  and `-np 1` matches `-np 4` exactly. Swept `-ub 512` and `-ub 2048` with 35- and 200-token texts: every
  configuration is 3.8–4.0× the single request, including 4 × 35 tokens, which fits one 512-token ubatch. The
  ubatch size is not the lever, so there is no build-throughput advantage: parallelise with processes, the same as
  the ORT path already does.
- **Measurement trap that caused a wrong claim**: `usage.prompt_tokens` on a batched request is the **sum** over
  inputs, not the per-text count. Dividing that total by the input count makes a purely sequential batch look
  like a 4× speedup. Single-text baselines must be measured at the same token count as the batch, never inferred
  from a neighbouring size.
- **llama.cpp does not append EOS**, while the reference pooling relies on the tokenizer's post-processor to add
  `<|endoftext|>`. Pooling the last content token instead shifts the vector materially: cosine **0.88** between
  ONNX-with-EOS and ONNX-without-EOS on a 17-token text. With EOS appended, GGUF Q8_0 and ONNX q4f16 agree at
  **0.95** (quantisation, not pooling).
- Server costs: load 0.73 s vs ORT's 1.54 s, RSS 1,163 MB (Q8_0, 4 slots, 8k ctx) vs 923 MB, and **no wasm
  build exists** — a llama.cpp port would be native-only.

### Still open before a port

- **Truncation.** The 1024-token cut is inherited from Gemma and it hurts this model specifically: on the 46
  mechanical-set rows whose text exceeded it, R@1 was **0.022 for qwen3 against 0.413 for bm25** (the vector is
  built from the first 1024 tokens, so anything past the cut is invisible). Qwen3 allows 32k, so the cut has to be
  chosen for it — and it is the main lever on build cost, at ~3.7 s per 1024-token text.
- **The fusion rule.** `rrf(bm25+qwen3)` at equal weight raises R@1 (0.192) but *lowers* R@3 (0.308 vs 0.404) and
  file@3 (0.462 vs 0.635), so adopting the model means revisiting how the lexical list is weighted, not only
  swapping the embedder.
- **Answered already, do not re-check**: the graph needs last-token pooling + L2 norm (it emits
  `last_hidden_state`, unlike the Gemma graph), queries take `Instruct: <task>\nQuery:<query>` while documents take
  none, and the cost is the table above.

## Three-way accuracy on llama.cpp (2026-11-13)

All three at **Q8_0** through llama.cpp b12360 (`--embeddings`), same 813-document `docs/` + memory corpus, same
document text (`embedTextOf`), same 52 hand-authored prose queries and the 507 mechanical ones. Only the model and
its prompt format differ: Gemma keeps the tool's `task: code retrieval | query:`, Qwen3 takes
`Instruct: …\nQuery:`, LFM2.5 takes `query: ` / `document: `.

| model | prose R@1 | R@3 | R@10 | MRR | mech R@1 | R@3 | R@10 | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemma-2 (incumbent) | 0.115 | 0.231 | 0.442 | 0.222 | 0.238 | 0.426 | 0.679 | 0.379 |
| qwen3-0.6B | **0.192** | **0.365** | **0.673** | **0.315** | 0.253 | **0.476** | **0.771** | 0.409 |
| lfm2.5-350M | 0.115 | 0.288 | 0.423 | 0.227 | **0.269** | 0.469 | 0.721 | **0.415** |

Paired on the 52 prose queries (exact binomial, discordant counts): **Qwen3 beats Gemma at R@3 (1 vs 8, p=0.039)
and R@10 (4 vs 16, p=0.012), and beats LFM2 at R@10 (16 vs 3, p=0.004)**. Gemma vs LFM2 is never significant
(R@10 7 vs 6, p=1.0), and R@1 separates nothing (5 vs 1, p=0.22).

- **Qwen3's advantage is depth, not top-1 luck**: 35/52 answers inside the top 10, against 23 (Gemma) and 22
  (LFM2). R@3 is where it stops being ambiguous: 19/52 vs 15 vs 12.
- **LFM2.5 is shallow.** It beats Gemma at R@3 (0.288 vs 0.231) and is *identical* at R@10 (0.423 vs 0.442), so
  its extra top-3 hits buy nothing deeper: a Gemma-equivalent on this corpus, not an upgrade.
- **Absolute numbers stay bad** — the best model puts only 10/52 prose needs at rank 1 — and BM25 still wins the
  term-overlap regime outright (0.688 R@1). The semantic channel is a tail, never an answer.
- Report **R@10 alongside R@3**: R@3 is the tool's real budget (`TAIL_ROWS`), but two models tied at R@3 can
  differ hugely at depth, and only R@10 exposed the LFM2/Qwen3 split above.

LFM2.5-Embedding-350M: 350M params, **1024 dims**, 11 languages, hybrid LFM2 backbone, GGUF-only artifacts
(Q4_K_M 229 MB, Q8_0 379 MB, F16 711 MB). Fastest of the three on CPU — **0.90–1.07 ms/token** at 8 threads from
300 to 2,320 tokens, load 0.42 s — but that is its only advantage. Both asymmetric prefixes are required (the
repo's `dense-retrieve.py` is the reference). `-b`/`-ub` must exceed the longest document: at 4096 a single
5,147-token section failed with "increase the physical batch size", which reads like a context error and is not.

## GPU: llama.cpp Vulkan on RDNA4 (2026-11-13)

There is no GPU path in the shipped stack — ONNX Runtime ships CPU and wasm only, and this extension never had a
Vulkan/CUDA EP. Everything here is a **llama.cpp** measurement, so it only becomes usable if a llama.cpp runtime
ships beside the ORT artifacts, which is a distribution change nobody has made.

ROCm is not an option in the sandbox: the image has no ROCm userspace, there is no root to install one, and a HIP
build can never be self-contained (llama.cpp's libs are separate `.so`s, and rocBLAS loads its Tensile kernels from
`/opt/rocm` at runtime). Mesa's **RADV** is: `libvulkan1` + `mesa-vulkan-drivers` + `vulkan-tools` in
`.pi/Containerfile`, and the host's `1002:7550` (Navi 48, **gfx1201**) comes up as
`AMD Radeon Graphics (RADV GFX1201)`, Mesa 25.0.7, beside `llvmpipe` — pick the discrete device explicitly.

Qwen3-Embedding-0.6B Q4_K_M on that GPU, `-ngl 99 -c 8192`, **load 3.2 s**, **+0.53 GB VRAM** (396 MB weights +
buffers, inside a 2.7 GB budget), RSS no longer 923 MB because the weights are device-side:

| tokens | 18 | 293 | 577 | 1150 | 2256 |
| --- | --- | --- | --- | --- | --- |
| CPU llama.cpp Q4_K_M | 50 ms | — | — | — | 1,610 ms (ORT q4f16) |
| **GPU Vulkan Q4_K_M** | **13.4 ms** | **44.2 ms** | **68.6 ms** | **105.6 ms** | **198.1 ms** |

- **0.09 ms/token** at long inputs, marginal **0.078 ms/token**, against 1.63 on CPU — **≈11–20×**. A fixed ~13 ms
  per request dominates a query, which is still below Gemma's 26 ms on ORT.
- **Build**: 813 documents + 549 queries in **35 s**, ≈39 ms per 257-token text, so this repo's 11.3k
  declarations are **~7 min on one worker** against 83 min on CPU (and ~5 min with 4 concurrent requests).
- **Concurrency does help on GPU**, unlike CPU where it was strictly serial: 4 concurrent requests are 1.38×
  faster than 4 sequential at 257 tokens, 1.16× at 1,025. One process with 4 slots beats extra instances.
- **Accuracy is backend-independent**: re-embedding the whole corpus on GPU gives R@1 0.192 / R@3 0.327 / R@10
  0.654 against Q8_0-on-CPU's 0.192 / 0.365 / 0.673 — two queries, which is the Q4-versus-Q8 quantisation gap.
  Vector cosine between the same texts on the two precisions is 0.93–0.98 (median 0.97), and norms are exactly 1.
- On the same GPU the incumbent is still cheaper, just less so: at ~300 tokens Gemma-Q8_0 is 25.9 ms vs Qwen3's
  44.2 (1.7×, not the 3× seen on CPU); at ~2.2k tokens 258.7 vs 198.1, where Qwen3 is *faster*. LFM2.5 Q4_K_M is
  9.2 ms at 14 tokens and 25.1 at 297.

## Targeted references

- `outline-tool/search.md` — the channel these models feed, and the tiers they compete with.
- `outline-tool/internals.md` — artifact pinning, the worker protocol, and what a model swap touches.