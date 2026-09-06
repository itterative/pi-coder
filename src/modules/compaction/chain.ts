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
    /** Shallowest disagreement between the two, when there was one. */
    firstMismatchDepth: number | null;
    /**
     * Deepest reference depth our rebuild was even long enough to compare.
     *
     * This is what separates "the prefix mismatched" from "we could not check". A stage-1 span is truncated at
     * the cut point, so it can be shorter than every request pi made in this process - which is exactly what
     * the first version of this code mistook for a divergence, reporting `prefixUsable: false` for a run whose
     * request was in fact fine.
     */
    comparableDepth: number;
    /** Observations on this branch that were comparable (same system and tools shape). */
    compared: number;
    /** True when observations were dropped by the cap, so shallow depths may be unverifiable. */
    truncatedHistory: boolean;
    /** Body keys only one side sent, against the newest comparable reference. Informational. */
    parameters: string[];
    /** The reference's model, when it differed from ours. */
    modelDivergence: string | null;
    /** Leaf id of the observation the verdict was taken from. */
    referenceLeafId: string | null;
}

/**
 * The parts of a request that are not its messages, small enough to retain for every turn.
 *
 * `keys` is what preserves the lesson that `tool_choice` is a parameter rather than a prefix verdict: the
 * symmetric difference against a reference body still shows which knobs one side sent, without holding that
 * body. `systemHash` covers the whole prompt, which is the same quantity `fingerprintSummary()` records for
 * humans, so the two can be joined without translating between them.
 */
export interface ChainShape {
    systemHash: string;
    toolsHash: string;
    systemChars: number;
    toolNames: string[];
    keys: string[];
    model: string;
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
                referenceDepth,
                truncatedHistory: this.droppedCount > 0,
                parameters: [],
                modelDivergence: null,
                referenceLeafId: null,
            };
        }

        const ladders = this.matchRetainedLadders(input);
        const heads = this.matchObservations(input, onPath);
        const merged = mergeComparisons(ladders, heads);

        return {
            reference: "chain",
            ...merged,
            referenceDepth,
            truncatedHistory: this.droppedCount > 0,
            // A reference whose keys are unknown is not a reference that sent nothing: reporting
            // `+messages,+model,+tools` for that case would be an invented measurement.
            parameters:
                heads.reference === undefined
                    ? []
                    : parameterDelta(input.shape.keys, heads.reference.keys),
            modelDivergence:
                heads.reference !== undefined && heads.reference.model !== input.shape.model
                    ? `${heads.reference.model} -> ${input.shape.model}`
                    : null,
            referenceLeafId: heads.reference?.leafId ?? null,
        };
    }

    /**
     * Compare at every depth of the retained ladders.
     *
     * These carry the verdict for a truncated span, which is why they are worth retaining: a span cut to 64
     * messages meets nothing in a set of per-request heads that all sit at depth 70 or deeper.
     */
    private matchRetainedLadders(input: {
        spanLadder: Map<number, string>;
        pathIds: Set<string>;
        shape: ChainShape;
    }): DepthComparison {
        let current = { ...EMPTY_COMPARISON };
        const wanted = shapeKey(input.shape);

        for (const retained of this.ladders) {
            if (retained.leafId === null || !input.pathIds.has(retained.leafId)) {
                continue;
            }
            if (retained.shapeKey !== wanted) {
                continue;
            }

            for (const [depth, head] of retained.heads) {
                const ours = input.spanLadder.get(depth);
                if (ours === undefined) {
                    continue;
                }

                current = foldDepth(current, depth, ours === head);
            }
        }

        return current;
    }

    /** Compare the single head each observed request ended at, and keep the newest for the shape report. */
    private matchObservations(
        input: { spanLadder: Map<number, string>; shape: ChainShape },
        onPath: ChainObservation[],
    ): DepthComparison & { reference?: ChainObservation } {
        let current = { ...EMPTY_COMPARISON };
        let reference: ChainObservation | undefined;

        for (const observation of onPath) {
            if (observation.systemHash !== input.shape.systemHash) {
                continue;
            }
            if (observation.toolsHash !== input.shape.toolsHash) {
                continue;
            }

            // Newest wins for the informational fields; depth order carries the verdict.
            reference = observation;
            current = { ...current, compared: current.compared + 1 };

            const ours = input.spanLadder.get(observation.depth);
            if (ours === undefined) {
                // Our span is shorter than this request, so it can say nothing about that depth.
                continue;
            }

            current = foldDepth(current, observation.depth, ours === observation.head);
        }

        return { ...current, reference };
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

/** Combine the two reference sources: any agreement counts, the shallowest disagreement wins. */
function mergeComparisons(a: DepthComparison, b: DepthComparison): DepthComparison {
    const mismatches = [a.firstMismatchDepth, b.firstMismatchDepth].filter(
        (depth): depth is number => depth !== null,
    );

    return {
        verifiedTo: Math.max(a.verifiedTo, b.verifiedTo),
        comparableDepth: Math.max(a.comparableDepth, b.comparableDepth),
        firstMismatchDepth: mismatches.length > 0 ? Math.min(...mismatches) : null,
        compared: a.compared + b.compared,
    };
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
