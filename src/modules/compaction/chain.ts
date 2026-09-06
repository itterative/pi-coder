import { createHash } from "node:crypto";

/**
 * A fingerprint of every request pi has sent in this session, kept as hashes instead of bodies.
 *
 * Stage 1 only pays off when the request it builds is byte-identical to the prefix pi already sent, and the
 * only witness to that was the request body itself — megabytes per turn, one turn deep, gone on restart, and
 * blind to which branch it came from. A cumulative hash collapses the same fact to 16 hex characters: fold
 * one hash per message into a running head, and `head(d)` proves everything up to depth `d` in one
 * comparison. Because pi's own depth grows by one or two messages per request, the heads collected over a
 * session cover nearly every depth, so a later rebuild can be matched to the exact message where it stops
 * agreeing.
 *
 * What is kept per request: the leaf id it was built for, its depth, the running head, and the system/tools
 * shape. That is roughly seventy bytes rather than two megabytes, which is why this can hold a session's
 * whole request history instead of its last body. What is lost against holding the body: the ability to show
 * the text that differed, so a mismatch names a depth and the operator goes and looks.
 *
 * Nothing here gates compaction. Every field is a diagnostic; the request is built and sent the same way
 * whether or not any observation exists.
 */

/** Memory bound, not a correctness bound: 2000 observations is ~140 KB of hex. */
const MAX_OBSERVATIONS = 2000;

/**
 * How many recent requests keep their whole ladder, not just their final head.
 *
 * A stage-1 span is truncated at the cut point, so it is routinely *shorter* than every request pi made in
 * this process - which is what happened on the first llama.cpp run after this shipped: ten observations, none
 * of them at a depth our 64-message span could meet, and a verdict of "unusable" for a request that was
 * probably fine. The ladder is computed anyway, so retaining the newest few costs about twenty bytes per
 * message and turns "cannot tell" back into an exact answer.
 */
const LADDER_RETENTION = 2;

/** Short enough to keep records readable, long enough that a 64-bit space will not collide by accident. */
const HEAD_CHARS = 16;

export interface ChainObservation {
    /** Session entry id that was the leaf when pi built this request. */
    leafId: string | null;
    /** How many messages the body carried. */
    depth: number;
    /** Running hash over `messages[0..depth-1]` in body order. */
    head: string;
    systemHash: string;
    toolsHash: string;
    systemChars: number;
    /** Tool names, recorded only when the tools shape changed, so a drift names its boundary. */
    toolNames?: string[];
    /** Top-level body keys, sorted: catches `prompt_cache_key` and marker differences. */
    keys: string[];
    model: string;
    /** Decode scalars, mirrored from `ChainShape`. See its field docs for what `null` does and does not mean. */
    maxTokens: number | null;
    enableThinking: boolean | null;
    reasoningEffort: string | null;
    imageBlocks: number | null;
    ts: number;
}

/** Result of matching a rebuilt request against the observations on the current branch. */
export interface ChainMatch {
    /**
     * Which reference answered: `chain` when an observation on the current branch was compared, `none` when
     * nothing usable was retained. A verdict with `none` must not claim the prefix was unusable.
     */
    reference: "chain" | "none";
    /** Deepest reference depth our rebuild agreed with. -1 when nothing agreed. */
    verifiedTo: number;
    /** Deepest reference depth available on this branch. */
    referenceDepth: number;
    /**
     * Shallowest disagreement **inside the credited reference**, or null when it agreed throughout.
     *
     * Scoped to one reference deliberately. Heads are cumulative, so a reference that disagrees at depth k
     * disagrees at every depth past k too: inside one reference the mismatch is always deeper than the
     * agreement, and `firstMismatchDepth > verifiedTo` is the only shape it can take. The aggregate this
     * replaced printed `verified 728/728` beside a divergence at message 59 because the two numbers came from
     * different references - a figure describing two measurements is not a measurement.
     */
    firstMismatchDepth: number | null;
    /**
     * Deepest depth the credited reference was long enough to compare.
     *
     * This is what separates "the prefix mismatched" from "we could not check". A stage-1 span is truncated at
     * the cut point, so it can be shorter than every request pi made in this process - which is exactly what
     * the first version of this code mistook for a divergence, reporting `prefixUsable: false` for a run whose
     * request was in fact fine.
     */
    comparableDepth: number;
    /** Observations on this branch that were comparable (same system and tools shape). */
    compared: number;
    /**
     * Comparable references that disagreed somewhere, excluding the credited one.
     *
     * Where a stale pre-compaction ladder surfaces: it still passes the branch and shape filters, so it
     * disagrees at a depth the live prefix never reached. Counted rather than merged, so the printed depths
     * stay about one request and the disagreement is not hidden either. Exclusion is by identity, not leaf id:
     * a retained ladder and its own observation share a leaf and are separate references.
     */
    disagreeingReferences: number;
    /** Whether the credited reference was an observed request or one of the retained ladders. */
    referenceSource: "observation" | "ladder" | null;
    /** True when observations were dropped by the cap, so shallow depths may be unverifiable. */
    truncatedHistory: boolean;
    /**
     * Body keys only one side sent, against the credited reference. Informational, and empty both when the
     * bodies matched and when no reference could be credited - the trace says which by whether `reference`
     * is `chain`.
     */
    parameters: string[];
    /** The credited reference's model, when it differed from ours. */
    modelDivergence: string | null;
    /** Leaf id of the reference these depths were taken from; null when nothing was credited. */
    referenceLeafId: string | null;
    /**
     * The credited reference's own row, so every comparison in a verdict is against one request.
     *
     * Null when the credited reference was a ladder whose paired observation has since been pruned, or when
     * nothing was credited at all. Callers that mirror or diff against "the parent request" must use this and
     * say so when it is absent - diffing against a *different* request than the one that set the depths is how
     * `firstDivergence` and `verifiedTo` came to disagree with each other in a live record.
     */
    referenceObservation: ChainObservation | null;
}

/**
 * The parts of a request that are not its messages, small enough to retain for every turn.
 *
 * `keys` is what preserves the lesson that an extra body key is a parameter rather than a prefix verdict: the
 * symmetric difference against a reference body still shows which knobs one side sent, without holding that
 * body. `systemHash` covers the whole prompt, which is the same quantity `fingerprintSummary()` records for
 * humans, so the two can be joined without translating between them.
 *
 * The scalars below are **deliberately not part of `shapeKey()`**. A thinking toggle or an image-block count
 * changing is exactly the thing the verdict should be able to *see*, and folding it into the shape would turn
 * "these two requests differ in a parameter that moves the prefix" into "these two requests are not comparable"
 * - which is the difference between a diagnosis and a shrug.
 */
export interface ChainShape {
    systemHash: string;
    toolsHash: string;
    systemChars: number;
    toolNames: string[];
    keys: string[];
    model: string;
    /**
     * Decode and content-shape scalars, as values rather than key presence.
     *
     * `keys` can say that both sides sent `enable_thinking`; only these can say one sent `true` and the other
     * `false`, which on the templating servers is a prefix difference the key set cannot express. `null` means
     * the body carried no such field - or, for a row persisted by an older build, that the value was never
     * recorded. Both read as unknown, never as a measurement.
     */
    maxTokens: number | null;
    enableThinking: boolean | null;
    reasoningEffort: string | null;
    imageBlocks: number | null;
}

/** Identifies the system prompt, tool set and model a ladder was folded under. */
export function shapeKey(shape: ChainShape): string {
    return digest(`${shape.systemHash}\u001f${shape.toolsHash}\u001f${shape.model}`);
}

/** sha256 over the concatenation, truncated. */
function digest(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, HEAD_CHARS);
}

function canonical(value: unknown): string {
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return String(value);
    }
}

/**
 * Fold a message into the running head.
 *
 * The separator is not cosmetic: without it `[a, b]` and `[ab]` would hash alike, and message boundaries are
 * exactly the thing being verified.
 */
function fold(head: string, message: unknown): string {
    return digest(`${head}\u001f${canonical(message)}`);
}

/** Running head at every depth of `messages`, so a rebuild can be compared at any depth. */
export function messageLadder(messages: readonly unknown[]): Map<number, string> {
    const ladder = new Map<number, string>();
    let head = digest("pi-coder/compaction-chain/v1");

    for (let index = 0; index < messages.length; index++) {
        head = fold(head, messages[index]);
        ladder.set(index + 1, head);
    }

    return ladder;
}

/** A retained ladder as it comes back from a previous process. */
export interface RestoredLadder {
    leafId: string | null;
    heads: Map<number, string>;
    shapeKey: string;
}

/** What one `observe` call produced, so a caller can persist it without rehashing the body. */
export interface ChainRecorded {
    observation: ChainObservation;
    /** Heads for depths 1..depth, in depth order: index 0 is depth 1. */
    heads: string[];
}

/** One entry per observed request, newest last, pruned from the front past the cap. */
export class RequestChain {
    private readonly observations: ChainObservation[] = [];
    private readonly ladders: {
        leafId: string | null;
        heads: Map<number, string>;
        shapeKey?: string;
    }[] = [];
    private droppedCount = 0;
    private lastToolsHash: string | undefined;
    private lastSystemHash: string | undefined;
    /**
     * Hydration health, reported next to verdicts.
     *
     * A scan that stopped early holds a *floor* of rows, and a read that failed holds nothing that deserves to be
     * read as evidence. Both have to be tellable apart from "this session never made a request", which is the only
     * reason the funnel counts exist.
     */
    private scanComplete = true;
    private loadFailed = false;
    private restoredMalformed = 0;

    get hydration(): { scanComplete: boolean; loadFailed: boolean; malformed: number } {
        return {
            scanComplete: this.scanComplete,
            loadFailed: this.loadFailed,
            malformed: this.restoredMalformed,
        };
    }

    get size(): number {
        return this.observations.length;
    }

    get dropped(): number {
        return this.droppedCount;
    }

    /**
     * Record what pi just sent, then forget the body.
     *
     * This re-hashes the whole message array on every provider request. At ~1.3 MB of JSON for an 880-message
     * session that is single-digit milliseconds next to a multi-second provider round trip, and it is gated by
     * tracing being on, so it buys branch-correct history without retaining any conversation bytes.
     */
    observe(input: {
        leafId: string | null;
        messages: readonly unknown[];
        shape: ChainShape;
    }): ChainRecorded {
        const ladder = messageLadder(input.messages);
        const head = ladder.get(input.messages.length) ?? "";

        this.ladders.unshift({
            leafId: input.leafId,
            heads: ladder,
            shapeKey: shapeKey(input.shape),
        });
        if (this.ladders.length > LADDER_RETENTION) {
            this.ladders.length = LADDER_RETENTION;
        }
        const toolsChanged = input.shape.toolsHash !== this.lastToolsHash;
        const systemChanged = input.shape.systemHash !== this.lastSystemHash;

        this.lastToolsHash = input.shape.toolsHash;
        this.lastSystemHash = input.shape.systemHash;

        this.observations.push({
            leafId: input.leafId,
            depth: input.messages.length,
            head,
            systemHash: input.shape.systemHash,
            toolsHash: input.shape.toolsHash,
            systemChars: input.shape.systemChars,
            keys: input.shape.keys,
            model: input.shape.model,
            maxTokens: input.shape.maxTokens,
            enableThinking: input.shape.enableThinking,
            reasoningEffort: input.shape.reasoningEffort,
            imageBlocks: input.shape.imageBlocks,
            toolNames: toolsChanged || systemChanged ? input.shape.toolNames : undefined,
            ts: Date.now(),
        });

        const recorded = this.observations[this.observations.length - 1];

        if (this.observations.length > MAX_OBSERVATIONS) {
            const excess = this.observations.length - MAX_OBSERVATIONS;
            this.observations.splice(0, excess);
            this.droppedCount += excess;
        }

        return { observation: recorded, heads: [...ladder.values()] };
    }

    /**
     * Rebuild the chain from persisted records, oldest first.
     *
     * Restoring is worth having because it replays facts about bytes that were actually sent. Recomputing heads
     * from the session is not equivalent and never will be: a reconstructed context is not byte-stable, since pi
     * stamps timestamps into it, so recomputed hashes would disagree with the provider's cache and the verdict
     * would fail in the one direction that looks like success.
     */
    restore(input: {
        observations: readonly ChainObservation[];
        ladders: readonly RestoredLadder[];
        scanComplete?: boolean;
        loadFailed?: boolean;
        malformed?: number;
    }): void {
        this.scanComplete = input.scanComplete ?? true;
        this.loadFailed = input.loadFailed ?? false;
        this.restoredMalformed = input.malformed ?? 0;

        if (input.observations.length === 0 && input.ladders.length === 0) {
            return;
        }

        const wasEmpty = this.observations.length === 0;

        // Restored rows are older by definition: hydration runs when the chain is created, before this process
        // has written a row of its own, so no overlap is possible. The newest-wins rule in `matchObservations`
        // walks the list forward, which makes this order load-bearing.
        this.observations.unshift(...input.observations);

        // Memory stacks ladders newest first, so restored ones belong behind what this process already kept.
        this.ladders.push(...input.ladders);
        if (this.ladders.length > LADDER_RETENTION) {
            this.ladders.length = LADDER_RETENTION;
        }

        if (this.observations.length > MAX_OBSERVATIONS) {
            const excess = this.observations.length - MAX_OBSERVATIONS;
            this.observations.splice(0, excess);
            this.droppedCount += excess;
        }

        // Seed the change detectors only for a chain that had not seen a request yet. Otherwise the restored
        // rows would set the baseline and a shape change this process did make would read as no change.
        if (wasEmpty) {
            const newest = this.observations[this.observations.length - 1];
            if (newest !== undefined) {
                this.lastSystemHash = newest.systemHash;
                this.lastToolsHash = newest.toolsHash;
            }
        }
    }

    /**
     * Match a rebuilt request against the references that belong to this branch.
     *
     * `pathIds` is the root-to-leaf id set from `getBranch()`, which is what makes the answer branch-correct
     * without any invalidation logic: a request observed on a branch that was navigated away from has a leaf id
     * that is not on the path, so it cannot be chosen as a reference. Depth order decides among the rest,
     * because the deepest usable reference covers the most messages.
     *
     * @param spanLadder heads for the messages that will actually be sent, **excluding** whatever the caller
     * appends on top of them. Including an appended instruction guarantees a mismatch at the caller's own last
     * depth, since no reference ever sent it.
     */
    match(input: {
        spanLadder: Map<number, string>;
        pathIds: Set<string>;
        shape: ChainShape;
    }): ChainMatch {
        const onPath = this.observations.filter(
            (observation) => observation.leafId !== null && input.pathIds.has(observation.leafId),
        );
        const referenceDepth = onPath.reduce((best, o) => Math.max(best, o.depth), -1);

        // A depth-0 row - a payload with no messages array - stays on the `"chain"` path, where it reports
        // `comparableDepth: -1`. That is a reference able to say nothing, which is not the same state as no
        // reference, and collapsing the two would put an unfaithful value behind `reference: "none"`.
        if (onPath.length === 0) {
            return {
                reference: "none",
                ...EMPTY_COMPARISON,
                compared: 0,
                disagreeingReferences: 0,
                referenceSource: null,
                referenceDepth,
                truncatedHistory: this.droppedCount > 0,
                parameters: [],
                modelDivergence: null,
                referenceLeafId: null,
                referenceObservation: null,
            };
        }

        // Each reference is compared on its own, then one of them is credited with the verdict. Averaging or
        // min/max-ing across references is what let a live 728-deep agreement and a stale ladder's mismatch at 59
        // print as one verdict.
        const candidates: ReferenceComparison[] = [];
        let compared = 0;

        for (const ladder of this.ladders) {
            const result = this.compareLadder(input, ladder);
            if (result !== null) {
                candidates.push(result);
            }
        }

        for (const [ordinal, observation] of onPath.entries()) {
            const result = this.compareObservation(input, observation, ordinal);
            if (result === null) {
                continue;
            }
            candidates.push(result);

            // `compared` keeps the meaning the trace already reports: comparable observations, not derived ladders.
            compared++;
        }

        const credited = pickCreditedReference(candidates);
        // A retained ladder describes a request that was also observed, so the paired row is where the key set
        // and model come from. Absent one (pruned past the cap) leaves the deltas unknown, not empty-by-agreement.
        const creditedObservation =
            credited === null
                ? undefined
                : onPath.find((observation) => observation.leafId === credited.leafId);

        return {
            reference: "chain",
            verifiedTo: credited?.verifiedTo ?? -1,
            comparableDepth: credited?.comparableDepth ?? -1,
            firstMismatchDepth: credited?.firstMismatchDepth ?? null,
            compared,
            disagreeingReferences: candidates.filter(
                (candidate) => candidate.firstMismatchDepth !== null && candidate !== credited,
            ).length,
            referenceSource: credited?.source ?? null,
            referenceDepth,
            truncatedHistory: this.droppedCount > 0,
            // A reference whose keys are unknown is not a reference that sent nothing: reporting
            // `+messages,+model,+tools` for that case would be an invented measurement.
            parameters:
                creditedObservation === undefined
                    ? []
                    : parameterDelta(input.shape.keys, creditedObservation.keys),
            modelDivergence:
                creditedObservation !== undefined && creditedObservation.model !== input.shape.model
                    ? `${creditedObservation.model} -> ${input.shape.model}`
                    : null,
            referenceLeafId: credited?.leafId ?? null,
            referenceObservation: creditedObservation ?? null,
        };
    }

    /**
     * Compare at every depth of one retained ladder.
     *
     * These carry the verdict for a truncated span, which is why they are worth retaining: a span cut to 64
     * messages meets nothing in a set of per-request heads that all sit at depth 70 or deeper.
     */
    private compareLadder(
        input: { spanLadder: Map<number, string>; pathIds: Set<string>; shape: ChainShape },
        ladder: { leafId: string | null; heads: Map<number, string>; shapeKey?: string },
    ): ReferenceComparison | null {
        // Branch-correctness first: a ladder folded on a branch that was navigated away from cannot be a
        // reference for this one, however well its heads match.
        if (ladder.leafId === null || !input.pathIds.has(ladder.leafId)) {
            return null;
        }
        if (ladder.shapeKey !== shapeKey(input.shape)) {
            return null;
        }

        let current = { ...EMPTY_COMPARISON };

        for (const [depth, head] of ladder.heads) {
            const ours = input.spanLadder.get(depth);
            if (ours === undefined) {
                continue;
            }

            current = foldDepth(current, depth, ours === head);
        }

        return { ...current, leafId: ladder.leafId, source: "ladder", ordinal: -1 };
    }

    /** Compare the single head one observed request ended at. */
    private compareObservation(
        input: { spanLadder: Map<number, string>; shape: ChainShape },
        observation: ChainObservation,
        ordinal: number,
    ): ReferenceComparison | null {
        if (observation.systemHash !== input.shape.systemHash) {
            return null;
        }
        if (observation.toolsHash !== input.shape.toolsHash) {
            return null;
        }

        let current = { ...EMPTY_COMPARISON };
        const ours = input.spanLadder.get(observation.depth);

        if (ours !== undefined) {
            // Our span is shorter than this request, so it says nothing about that depth.
            current = foldDepth(current, observation.depth, ours === observation.head);
        }

        return { ...current, leafId: observation.leafId, source: "observation", ordinal };
    }

    /**
     * Heads at every depth of the retained requests, newest first.
     *
     * Only these make a truncated span checkable, because they are the only entries that carry a head at a
     * depth pi never sent a full request at.
     */
    retainedLadders(): { leafId: string | null; heads: Map<number, string>; shapeKey: string }[] {
        return this.ladders.map((ladder) => ({
            leafId: ladder.leafId,
            heads: ladder.heads,
            shapeKey: ladder.shapeKey ?? "",
        }));
    }

    /** Diagnostics only: the observations a lookup would consider, oldest first. */
    branchObservations(pathIds: Set<string>): ChainObservation[] {
        return this.observations.filter(
            (observation) => observation.leafId !== null && pathIds.has(observation.leafId),
        );
    }
}

/** What comparing one depth can tell us, independent of which reference source supplied it. */
interface DepthComparison {
    /** Deepest depth that agreed. */
    verifiedTo: number;
    /** Deepest depth that was comparable at all, agreement aside. */
    comparableDepth: number;
    /** Shallowest disagreement. */
    firstMismatchDepth: number | null;
    /** References considered after the shape filter. */
    compared: number;
}

/** One reference's answer, kept whole so a verdict can name the reference it came from. */
interface ReferenceComparison extends DepthComparison {
    leafId: string | null;
    /** Whether this came from an observed request or a derived ladder. */
    source: "observation" | "ladder";
    /** Position among the on-branch observations, oldest first; ladders carry no ordinal. */
    ordinal: number;
}

const EMPTY_COMPARISON: DepthComparison = {
    verifiedTo: -1,
    comparableDepth: -1,
    firstMismatchDepth: null,
    compared: 0,
};

/** Fold one depth comparison. A disagreement is still comparable, and matters for where to look next. */
function foldDepth(current: DepthComparison, depth: number, agrees: boolean): DepthComparison {
    const comparable = Math.max(current.comparableDepth, depth);

    if (agrees) {
        return {
            ...current,
            comparableDepth: comparable,
            verifiedTo: Math.max(current.verifiedTo, depth),
        };
    }

    return {
        ...current,
        comparableDepth: comparable,
        firstMismatchDepth:
            current.firstMismatchDepth === null
                ? depth
                : Math.min(current.firstMismatchDepth, depth),
    };
}

/**
 * The reference the verdict is taken from: the deepest agreement, and among equals the one that saw most.
 *
 * Order is deliberate. Depth first because that is the claim being made - the deepest agreement is the best
 * evidence about the cache. Coverage second because among references that agreed equally far, the one that
 * compared more can say more: preferring a *clean* reference instead, as an earlier draft did, made the
 * shallowest reference win by default and hid the mismatch that was the whole point of the run. Everything that
 * loses is still counted in `disagreeingReferences`, so nothing is discarded by this choice.
 */
function pickCreditedReference(
    candidates: readonly ReferenceComparison[],
): ReferenceComparison | null {
    let best: ReferenceComparison | null = null;

    for (const candidate of candidates) {
        best = best === null ? candidate : creditWinner(candidate, best);
    }

    return best;
}

function creditWinner(
    candidate: ReferenceComparison,
    best: ReferenceComparison,
): ReferenceComparison {
    if (candidate.verifiedTo !== best.verifiedTo) {
        return candidate.verifiedTo > best.verifiedTo ? candidate : best;
    }

    if (candidate.comparableDepth !== best.comparableDepth) {
        return candidate.comparableDepth > best.comparableDepth ? candidate : best;
    }

    // An observed request is the thing that was actually sent; a ladder is derived from one.
    if (candidate.source !== best.source) {
        return candidate.source === "observation" ? candidate : best;
    }

    // Newest wins last, matching the oldest-first order the observations are stored in.
    return candidate.ordinal >= best.ordinal ? candidate : best;
}

/** `+key` was sent only by us, `-key` only by the reference. Mirrors the old body-to-body report. */
function parameterDelta(ours: readonly string[], theirs: readonly string[]): string[] {
    const out: string[] = [];
    const ourSet = new Set(ours);
    const theirSet = new Set(theirs);

    for (const key of ourSet) {
        if (!theirSet.has(key)) {
            out.push(`+${key}`);
        }
    }
    for (const key of theirSet) {
        if (!ourSet.has(key)) {
            out.push(`-${key}`);
        }
    }

    return out.sort();
}

/** Ids from the session root to the current leaf, the set a branch-correct lookup needs. */
export function pathIdSet(entries: readonly { id: string }[]): Set<string> {
    const ids = new Set<string>();
    for (const entry of entries) {
        ids.add(entry.id);
    }

    return ids;
}
