import fs from "node:fs";
import path from "node:path";

import { artifactsPresent } from "./artifacts";
import { rankBm25 } from "./bm25";
import { MODEL_DIMS, MODEL_ID, type SemanticMode } from "./config";
import { TAIL_ROWS, fuseRankings, type RankedDeclaration } from "./rank";
import {
    createEmbedRuntime,
    refreshWorkerCount,
    splitJobs,
    type BuildFile,
    type EmbedRuntime,
} from "./runtime";
import {
    cosine,
    emptyManifest,
    hashKey,
    indexDir,
    namespaceFor,
    pruneManifest,
    readManifest,
    readManifestHeader,
    readVectors,
    appendManifestShard,
    replaceShard,
    shardForFile,
    shouldCompact,
    writeManifest,
    type IndexManifest,
} from "./store";
import { acquireIndexLock, indexLockHeld } from "./lock";
import type { SemanticQuery, SemanticSearch } from "./types";
import { EMBED_TEXT_VERSION, embedTextOf } from "../text";
import type { ParsedFile } from "../types";

/** The content key of one declaration's vector; version and model are part of it, so they cannot collide. */
export function embeddingKey(file: ParsedFile, declaration: ParsedFile["all"][number]): string {
    return hashKey(`${EMBED_TEXT_VERSION}\u0000${MODEL_ID}\u0000${embedTextOf(file, declaration)}`);
}

export interface SemanticDeps {
    mode: SemanticMode;
    modelDir: string;
    /** Injected in tests; production lazily spawns the wasm child. */
    runtime?: EmbedRuntime;
    /** Footer offered while the embedding channel is not enabled yet. */
    hint?: string;
    /** Called when the index has vectors to catch up on; `refreshing` says whether a refresh started. */
    onStale?: (stale: SemanticStaleness) => void;
    /** Called once a scheduled refresh settled, so the caller can clear a status line. */
    onRefreshDone?: () => void;
    /** Tests turn this off to keep a ranking call free of background writes. */
    autoRefresh?: boolean;
    /** Tests replace the artifact probe because the real files are ~211 MB. */
    artifactsReady?: () => boolean;
    /** Tests lower the first-build bound instead of synthesizing a tree that large. */
    initialBuildLimit?: number;
}

/** What a search found stale in the index for the files it just parsed. */
export interface SemanticStaleness {
    /** Declarations whose content key has no vector yet. */
    missing: number;
    /** Whether background work was scheduled for them. */
    refreshing: boolean;
    /** True when the root had no usable index, so this is its first build rather than a catch-up. */
    initial?: boolean;
}

/**
 * How many declarations one search may re-embed on its own.
 *
 * Editing a few functions is the common case and costs seconds; a refactor that changes hundreds should be an
 * explicit build with the estimate and progress, not a surprise background job.
 */
const AUTO_REFRESH_LIMIT = 64;

/**
 * How large a first build one search may start on its own.
 *
 * A refresh is bounded by `AUTO_REFRESH_LIMIT` because a refactor that changed hundreds of declarations should be an
 * explicit build. A root with *no* index has nothing to catch up with: refusing it means the root never becomes
 * searchable at all, which is why a declared or explicitly searched tree (a memory directory, a package outside the
 * repo) stayed lexical forever. The bound is a guard against pointing `path` at something enormous, not a policy:
 * discovery already caps a tree at `MAX_FILES`, and the largest real case here — this repo — is ~11k declarations.
 */
const INITIAL_BUILD_LIMIT = 20_000;

/**
 * Builds already running in this process, keyed by model dir + namespace.
 *
 * Two searches finishing together would otherwise embed the same missing declarations twice and race on the
 * manifest; the first one wins and the second sees the result when it runs.
 */
const refreshing = new Map<string, Promise<void>>();

/**
 * The warm embedding child, one per model directory and shared by every search.
 *
 * The tool calls `createSemanticSearch` per search, for its config and consent, so a runtime owned by that
 * factory would be a fresh child per search: ~1.9 s of model load every time, and one resident copy of the
 * weights per search until the runtime's idle timeout. Sharing by model dir is what makes the child warm.
 */
const runtimes = new Map<string, EmbedRuntime>();

/** The shared runtime for a model dir. Constructing it does not spawn anything; the child is lazy. */
export function sharedEmbedRuntime(modelDir: string): EmbedRuntime {
    const existing = runtimes.get(modelDir);

    if (existing !== undefined) {
        return existing;
    }

    const created = createEmbedRuntime({ modelDir });

    runtimes.set(modelDir, created);

    return created;
}

/** Drop a shared runtime after it was disposed, so the next search spawns a fresh child. */
export function forgetSharedRuntime(modelDir: string, runtime: EmbedRuntime): void {
    if (runtimes.get(modelDir) === runtime) {
        runtimes.delete(modelDir);
    }
}

/**
 * Build the search tail: BM25 always, embeddings when they are enabled and the index is warm.
 *
 * Every embedding failure degrades to BM25 rather than failing the search: the index may be mid-build, the
 * artifacts may be absent, or the runtime may have died, and none of those should cost the agent its result.
 */
export function createSemanticSearch(deps: SemanticDeps): SemanticSearch {
    let runtime = deps.runtime;

    const runtimeFor = (): EmbedRuntime => {
        runtime ??= deps.runtime ?? sharedEmbedRuntime(deps.modelDir);

        return runtime;
    };

    return {
        hint: deps.hint,
        dispose() {
            const used = runtime;

            used?.dispose();

            if (used !== undefined) {
                forgetSharedRuntime(deps.modelDir, used);
            }

            runtime = undefined;
        },
        async rank(request: SemanticQuery, signal?: AbortSignal): Promise<RankedDeclaration[]> {
            const lexical = rankBm25(request.files, request.query, TAIL_ROWS * 4).map((hit) => ({
                file: hit.file,
                declaration: hit.declaration,
            }));

            if (deps.mode !== "hybrid") {
                return lexical;
            }

            let dense: RankedDeclaration[];

            try {
                const ranked = await denseRanking(
                    request,
                    deps.modelDir,
                    runtimeFor(),
                    signal,
                    deps.artifactsReady,
                );

                dense = ranked.hits;

                const coversRoot = ranked.refreshCoversRoot === true;
                const compact = coversRoot && shouldCompact(ranked.dead, ranked.live);
                const initial = ranked.initial === true;
                const affordable = initial
                    ? ranked.live <= (deps.initialBuildLimit ?? INITIAL_BUILD_LIMIT)
                    : ranked.missing <= AUTO_REFRESH_LIMIT;

                if (ranked.missing > 0 && ranked.refreshRoot !== undefined) {
                    const scheduled =
                        deps.autoRefresh !== false && affordable
                            ? scheduleBuild(deps, request, ranked.refreshRoot, coversRoot)
                            : false;

                    deps.onStale?.({ missing: ranked.missing, refreshing: scheduled, initial });
                } else if (compact && ranked.refreshRoot !== undefined) {
                    // Nothing to embed, but the index is carrying enough dead vectors to be worth compacting. The
                    // build has no jobs, so this is a manifest rewrite and a few unlinks: no model, no parse.
                    scheduleBuild(deps, request, ranked.refreshRoot, true);
                }
            } catch {
                // Absent artifacts, a missing index, or a dead child: lexical ranking is still an answer.
                dense = [];
            }

            if (dense.length === 0) {
                return lexical;
            }

            // A prose query is answered by similarity: fusing the lexical ranks in measured worse, because those rows
            // matched a word or two rather than the meaning.
            return request.similarityOnly === true ? dense : fuseRankings([lexical, dense]);
        },
    };
}

/**
 * Build the declarations this search found missing, without blocking the search.
 *
 * Additive unless `prune` is set: a search of a subdirectory must never prune vectors that belong to the rest of
 * the index, so only a build whose file set covers the namespace root may compact. The build reports through
 * nothing visible; the caller already told the user it is happening.
 */
function scheduleBuild(
    deps: SemanticDeps,
    request: SemanticQuery,
    root: string,
    prune: boolean,
): boolean {
    const namespace = namespaceFor(request.sourceKind, root, MODEL_ID, EMBED_TEXT_VERSION);
    const key = `${deps.modelDir}\u0000${namespace}`;

    if (refreshing.has(key)) {
        return true;
    }

    // Another process may be building this namespace (a second session, or a foreground build). Nothing is scheduled
    // then, so the caller reports "not indexed" rather than claiming a refresh that would immediately bounce.
    if (indexLockHeld(indexDir(deps.modelDir, namespace))) {
        return false;
    }

    const task = buildIndex({
        sourceKind: request.sourceKind,
        root,
        modelDir: deps.modelDir,
        files: request.files,
        runtime: deps.runtime,
        prune: false,
        coversRoot: prune,
        maxWorkers: refreshWorkerCount(),
    })
        .then(
            () => undefined,
            () => undefined,
        )
        .finally(() => {
            refreshing.delete(key);
            deps.onRefreshDone?.();
        });

    refreshing.set(key, task);

    return true;
}

interface DenseResult {
    hits: RankedDeclaration[];
    /** Declarations in this search whose content key has no stored vector. */
    missing: number;
    /** Declarations this search asked about: the complete live set when it covered the namespace root. */
    live: number;
    /** Namespace entries none of those declarations claim. Dead vectors, not stale answers: they cannot match. */
    dead: number;
    /** Build root a refresh should append to; undefined when the index predates root recording. */
    refreshRoot?: string;
    /** Whether `files` was the whole namespace root, which is what makes a compaction safe. */
    refreshCoversRoot: boolean;
    /** The root had no usable index of its own, so the build would be its first rather than a catch-up. */
    initial?: boolean;
}

interface ResolvedIndex {
    dir: string;
    manifest: IndexManifest;
    /** The recorded build root, absent in indexes written before the field existed. */
    root?: string;
}

/** True when `target` is `root` itself or below it. */
function isAncestor(root: string, target: string): boolean {
    const base = path.resolve(root);
    const child = path.resolve(target);

    return child === base || child.startsWith(`${base}${path.sep}`);
}

/**
 * The index to rank against.
 *
 * A build names its scope, but a search names a subdirectory of it, and the namespace hashes the root. So an
 * exact miss falls back to an index whose recorded root is an ancestor of the searched root. Indexes written
 * before `root` was recorded are used as a last resort: their keys embed absolute paths, so a foreign index
 * simply contributes no matching vectors, and the caller suppresses refresh and staleness for them.
 */
function resolveIndex(modelDir: string, request: SemanticQuery): ResolvedIndex | undefined {
    const namespace = namespaceFor(request.sourceKind, request.root, MODEL_ID, EMBED_TEXT_VERSION);
    const exactDir = indexDir(modelDir, namespace);
    const exact = readManifest(exactDir);

    // The namespace hash does not include the vector width, so the exact path has to check it too: an index
    // written by a model of another width is unusable, and `cosine` would truncate rather than complain.
    if (exact !== undefined && exact.dims === MODEL_DIMS) {
        return { dir: exactDir, manifest: exact, root: exact.root ?? request.root };
    }

    const indexRoot = path.join(modelDir, "index");
    let legacy: ResolvedIndex | undefined;
    let best: ResolvedIndex | undefined;
    let namespaces: string[];

    try {
        namespaces = fs.readdirSync(indexRoot);
    } catch {
        return undefined;
    }

    for (const name of namespaces) {
        const dir = path.join(indexRoot, name);
        const header = readManifestHeader(dir);

        if (header === undefined) {
            continue;
        }

        if (
            header.modelId !== MODEL_ID ||
            header.textVersion !== EMBED_TEXT_VERSION ||
            header.dims !== MODEL_DIMS
        ) {
            continue;
        }

        if (header.sourceKind !== undefined && header.sourceKind !== request.sourceKind) {
            continue;
        }

        if (header.root === undefined) {
            if (legacy === undefined) {
                const manifest = readManifest(dir);

                if (manifest !== undefined) {
                    legacy = { dir, manifest };
                }
            }

            continue;
        }

        if (!isAncestor(header.root, request.root)) {
            continue;
        }

        const manifest = readManifest(dir);

        if (manifest === undefined) {
            continue;
        }

        if (best === undefined || header.root.length > (best.root?.length ?? -1)) {
            best = { dir, manifest, root: header.root };
        }
    }

    return best ?? legacy;
}

/** Declarations a request covers, which is what a first build would embed. */
function declarationCount(request: SemanticQuery): number {
    return request.files.reduce((total, file) => total + file.all.length, 0);
}

/** Whether this exact namespace exists but was written by a model of another width. */
function hasIncompatibleIndex(modelDir: string, request: SemanticQuery): boolean {
    const manifest = readManifest(
        indexDir(
            modelDir,
            namespaceFor(request.sourceKind, request.root, MODEL_ID, EMBED_TEXT_VERSION),
        ),
    );

    return manifest !== undefined && manifest.dims !== MODEL_DIMS;
}

/**
 * The result for a root that has no index of its own: every candidate is missing, and the build target is the root.
 *
 * `refreshRoot` is the searched root rather than an ancestor because a namespace is keyed by its root; building it
 * here is what gives a declared tree (`.pi/agent/memory`, a package outside the checkout) its own refresh lane
 * instead of making every search re-derive it from the parent index.
 */
function initialBuild(request: SemanticQuery, live: number): DenseResult {
    return {
        hits: [],
        missing: live,
        live,
        dead: 0,
        refreshRoot: request.root,
        refreshCoversRoot: true,
        initial: true,
    };
}

async function denseRanking(
    request: SemanticQuery,
    modelDir: string,
    runtime: EmbedRuntime,
    signal?: AbortSignal,
    artifactsReady?: () => boolean,
): Promise<DenseResult> {
    const empty: DenseResult = { hits: [], missing: 0, live: 0, dead: 0, refreshCoversRoot: false };

    if (!(artifactsReady?.() ?? artifactsPresent(modelDir))) {
        return empty;
    }

    const resolved = resolveIndex(modelDir, request);

    if (resolved === undefined) {
        // A namespace written by a model of another width is unusable, not absent: it is the user's explicit
        // remedy (`/outline build`) that rewrites it, and silently rebuilding under it would mix two vector spaces.
        return hasIncompatibleIndex(modelDir, request)
            ? empty
            : initialBuild(request, declarationCount(request));
    }

    const { dir, manifest } = resolved;

    const candidates: Array<{
        file: ParsedFile;
        declaration: ParsedFile["all"][number];
        key: string;
    }> = [];
    const seen = new Set<string>();

    for (const file of request.files) {
        for (const declaration of file.all) {
            const key = embeddingKey(file, declaration);

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            candidates.push({ file, declaration, key });
        }
    }

    const vectors = readVectors(
        dir,
        manifest,
        candidates.map((candidate) => candidate.key),
    );
    // Without a recorded root the namespace is a guess; never advertise staleness or refresh it.
    let missing = resolved.root === undefined ? 0 : candidates.length - vectors.size;
    // A dead entry is one the namespace holds that no candidate claims. That is only the *complete* dead set when
    // the search covered the whole root; a subdirectory search would count every other file's vectors as dead.
    const coversRoot =
        resolved.root !== undefined && resolved.root === request.root && request.truncated !== true;
    const liveKeys = new Set(candidates.map((candidate) => candidate.key));
    let dead = 0;

    if (coversRoot) {
        for (const key of Object.keys(manifest.entries)) {
            if (!liveKeys.has(key)) {
                dead += 1;
            }
        }
    }
    const live = candidates.length;

    if (vectors.size === 0) {
        // An ancestor index that holds none of these declarations never covered this tree — a gitignored memory
        // directory, or a package the walk cannot reach. Appending to it would bury a small tree in the parent's
        // namespace and keep every later search there lexical, so the searched root gets its own.
        const borrowed = resolved.root !== undefined && resolved.root !== request.root;

        if (borrowed && candidates.length > 0) {
            return initialBuild(request, live);
        }

        return {
            hits: [],
            missing,
            live,
            dead,
            refreshRoot: resolved.root,
            refreshCoversRoot: coversRoot,
            initial: live > 0,
        };
    }

    const queryVector = await runtime.embedQuery(request.query, signal);
    // A stored vector of another width cannot be compared with this query: `cosine` truncates to the shorter length
    // and returns a plausible-looking score for the wrong pair of floats. Widths only drift when the model changes
    // under a namespace that kept its id (see the `dims` check in `resolveIndex`), so this is defense in depth — but
    // treating them as absent is what lets the refresh path re-embed them instead of ranking garbage.
    let anomalous = 0;

    for (const [key, vector] of vectors) {
        if (vector.length !== queryVector.length) {
            vectors.delete(key);
            anomalous += 1;
        }
    }

    if (anomalous > 0) {
        missing += anomalous;

        if (vectors.size === 0) {
            return {
                hits: [],
                missing,
                live,
                dead,
                refreshRoot: resolved.root,
                refreshCoversRoot: coversRoot,
            };
        }
    }

    const hits = candidates
        .flatMap((candidate) => {
            const vector = vectors.get(candidate.key);

            return vector === undefined
                ? []
                : [{ ...candidate, score: cosine(vector, queryVector) }];
        })
        .toSorted(
            (left, right) =>
                right.score - left.score ||
                left.file.path.localeCompare(right.file.path) ||
                left.declaration.range.startLine - right.declaration.range.startLine,
        )
        .slice(0, TAIL_ROWS * 4)
        .map((candidate) => ({
            file: candidate.file,
            declaration: candidate.declaration,
        }));

    return { hits, missing, live, dead, refreshRoot: resolved.root, refreshCoversRoot: coversRoot };
}

/**
 * Record `sourceKind` and `root` in an index written before the header carried them.
 *
 * The vectors are already correct (keys are content hashes), so this is one manifest rewrite and no embedding.
 * Without it an old index keeps working through the legacy fallback but cannot report staleness or refresh.
 */
export function ensureIndexMetadata(options: {
    sourceKind: string;
    root: string;
    modelDir: string;
}): boolean {
    const dir = indexDirFor(options);
    const manifest = readManifest(dir);

    if (manifest === undefined || manifest.root === options.root) {
        return false;
    }

    const lock = acquireIndexLock(dir);

    if (lock === undefined) {
        return false;
    }

    try {
        // Re-read under the lock: another writer may have published since the check above.
        const current = readManifest(dir);

        if (current === undefined || current.root === options.root) {
            return false;
        }

        writeManifest(dir, { ...current, sourceKind: options.sourceKind, root: options.root });

        return true;
    } finally {
        lock.release();
    }
}

export interface BuildIndexOptions {
    sourceKind: string;
    root: string;
    modelDir: string;
    files: readonly ParsedFile[];
    runtime?: EmbedRuntime;
    onProgress?: (done: number, total: number) => void;
    /** Fires as each source file's shard is durably written, for file-level progress. */
    onFile?: (done: number, total: number) => void;
    signal?: AbortSignal;
    /** Defaults to true. An incremental refresh passes false so it cannot prune the rest of the index. */
    prune?: boolean;
    /**
     * Upper bound on build children. A background refresh passes `refreshWorkerCount()` so a query embedding keeps
     * most of the machine; an explicit build leaves it unset and scales with cores and memory.
     */
    maxWorkers?: number;
    /**
     * Whether `files` is the whole namespace root rather than one searched subdirectory.
     *
     * Only then is `liveKeys` the complete set for the namespace, which is what makes pruning — and the dead-key
     * count that decides it — meaningful for a refresh that passes `prune: false`.
     */
    coversRoot?: boolean;
}

interface EmbeddingPlan {
    liveKeys: Set<string>;
    jobs: BuildFile[];
    missing: number;
}

function indexDirFor(options: { sourceKind: string; root: string; modelDir: string }): string {
    const namespace = namespaceFor(options.sourceKind, options.root, MODEL_ID, EMBED_TEXT_VERSION);

    return indexDir(options.modelDir, namespace);
}

/** The manifest of this namespace with its scope recorded; a build takes the lock before calling this. */
function manifestFor(
    options: { sourceKind: string; root: string; modelDir: string },
    dir: string,
): IndexManifest {
    const manifest = readManifest(dir) ?? emptyManifest(MODEL_ID, MODEL_DIMS, EMBED_TEXT_VERSION);

    return { ...manifest, sourceKind: options.sourceKind, root: options.root };
}

/** `builtAt` is reporting metadata only: it is never hashed into a key and never decides freshness. */
function stamped(manifest: IndexManifest): IndexManifest {
    return { ...manifest, builtAt: new Date().toISOString() };
}

function planEmbeddings(files: readonly ParsedFile[], manifest: IndexManifest): EmbeddingPlan {
    const liveKeys = new Set<string>();
    const jobs: BuildFile[] = [];
    let missing = 0;

    for (const file of files) {
        const entries: BuildFile["entries"] = [];

        for (const declaration of file.all) {
            const key = embeddingKey(file, declaration);

            liveKeys.add(key);

            if (manifest.entries[key] !== undefined) {
                continue;
            }

            entries.push({ key, text: embedTextOf(file, declaration) });
        }

        missing += entries.length;

        if (entries.length > 0) {
            jobs.push(
                // A job line is what one build child takes at a time, so a file whose declaration count dwarfs the
                // rest of the tree (`nlohmann/json.hpp` has 1587) is split instead of becoming the build's serial tail.
                ...splitJobs([
                    {
                        shard: `${Date.now().toString(36)}-${shardForFile(file.path)}`,
                        entries,
                    },
                ]),
            );
        }
    }

    return { liveKeys, jobs, missing };
}

/**
 * How much an index build would embed, without embedding anything.
 *
 * The command uses it to price the build (declarations × seconds-per-declaration ÷ workers) and ask for
 * confirmation before spending minutes of CPU or a 200 MB download on an accidental `.` target.
 */
export function countEmbeddings(options: {
    sourceKind: string;
    root: string;
    modelDir: string;
    files: readonly ParsedFile[];
}): { live: number; missing: number; files: number } {
    const plan = planEmbeddings(options.files, manifestFor(options, indexDirFor(options)));

    return { live: plan.liveKeys.size, missing: plan.missing, files: plan.jobs.length };
}

/**
 * Embed every declaration whose content hash is not in the index yet.
 *
 * Shards are written per build rather than per file, so a rebuild never has to read or rewrite an existing
 * shard: it appends new ones, and pruning deletes the ones whose keys disappeared. The manifest is published
 * as shards arrive (every 200 shards or 10 s), which is what makes an interrupted build resumable — everything
 * it already finished is in the index and the next build sees it as present.
 */
export async function buildIndex(options: BuildIndexOptions): Promise<{
    embedded: number;
    live: number;
    /** Entries of the namespace that this build's file set no longer contains. */
    dead: number;
    /** Whether the manifest was compacted (and the orphaned shards deleted). */
    pruned: boolean;
}> {
    const dir = indexDirFor(options);
    const lock = acquireIndexLock(dir);

    // One writer per namespace: a refresh, a foreground build, and another session on the same root all share this
    // directory, and each reads the manifest once and publishes its whole in-memory view at the end. The read has to
    // happen under the lock, or a writer could publish between our read and our write.
    if (lock === undefined) {
        throw new Error("another outline build is already running for this root");
    }

    try {
        return await buildLocked(options, dir, manifestFor(options, dir));
    } finally {
        lock.release();
    }
}

async function buildLocked(
    options: BuildIndexOptions,
    dir: string,
    manifest: IndexManifest,
): Promise<{
    embedded: number;
    live: number;
    dead: number;
    pruned: boolean;
}> {
    const { liveKeys, jobs, missing } = planEmbeddings(options.files, manifest);
    // Dead entries are keys the namespace holds that no live declaration claims — a set difference, not a length
    // subtraction: a refresh that replaces every declaration keeps the same count while orphaning all the old keys.
    let dead = 0;

    for (const key of Object.keys(manifest.entries)) {
        if (!liveKeys.has(key)) {
            dead += 1;
        }
    }
    // An explicit build prunes. A refresh may not, because a subdirectory search would delete the rest of the
    // index — unless the search covered the whole root, in which case the live set is complete and enough stale
    // entries make a compaction worth the manifest rewrite.
    const prune =
        options.prune !== false ||
        (options.coversRoot === true && shouldCompact(dead, liveKeys.size));

    if (jobs.length === 0) {
        if (prune) {
            writeManifest(dir, stamped(pruneManifest(dir, manifest, liveKeys)));
        }

        return { embedded: 0, live: liveKeys.size, dead, pruned: prune };
    }

    // A build never touches the warm serve child: `build` spawns one `--build` child per batch, and each child
    // loads the model once for its own batch. A fresh coordinator here therefore costs nothing (construction is
    // lazy), and routing a build through `sharedEmbedRuntime` would only couple builds to a serve child that may
    // have died. Keep queries on the shared runtime and builds on their own.
    const runtime = options.runtime ?? createEmbedRuntime({ modelDir: options.modelDir });
    let next = manifest;
    let filesDone = 0;

    const shards = await runtime.build(
        dir,
        jobs,
        options.onProgress ?? (() => undefined),
        options.signal,
        (shard) => {
            next = replaceShard(next, shard.shard, shard.keys);
            filesDone += 1;
            options.onFile?.(filesDone, jobs.length);
            appendManifestShard(dir, manifest, shard.shard, shard.keys);
        },
        options.maxWorkers,
    );

    // A runtime that reports shards only on completion (test doubles, older workers) still merges here;
    // replaceShard is idempotent, so shards already journaled by the callback are not duplicated.
    for (const shard of shards) {
        next = replaceShard(next, shard.shard, shard.keys);
    }

    // Incremental refreshes only append; a pruning build compacts the journal into its canonical form.
    if (prune) {
        writeManifest(dir, stamped(pruneManifest(dir, next, liveKeys)));
    }

    return { embedded: missing, live: liveKeys.size, dead, pruned: prune };
}
