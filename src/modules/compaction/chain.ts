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
 * body. `systemHash` covers the whole prompt, unlike the 320-char excerpt the trace prints for humans.
 */
export interface ChainShape {
    systemHash: string;
    toolsHash: string;
    systemChars: number;
    toolNames: string[];
    keys: string[];
    model: string;
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

/** One entry per observed request, newest last, pruned from the front past the cap. */
export class RequestChain {
    private readonly observations: ChainObservation[] = [];
    private droppedCount = 0;
    private lastToolsHash: string | undefined;
    private lastSystemHash: string | undefined;

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
    }): void {
        const ladder = messageLadder(input.messages);
        const head = ladder.get(input.messages.length) ?? "";
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

        if (this.observations.length > MAX_OBSERVATIONS) {
            this.observations.splice(0, this.observations.length - MAX_OBSERVATIONS);
            this.droppedCount += 1;
        }
    }

    /**
     * Match a rebuilt request against the observations that belong to this branch.
     *
     * `pathIds` is the root-to-leaf id set from `getBranch()`, which is what makes the answer branch-correct
     * without any invalidation logic: an observation taken on a branch that was navigated away from simply has
     * a leaf id that is not on the path, so it cannot be chosen as a reference. Depth order decides among the
     * rest, because the deepest usable reference is the one that covers the most messages.
     */
    match(input: {
        ladder: Map<number, string>;
        pathIds: Set<string>;
        shape: ChainShape;
    }): ChainMatch {
        const onPath = this.observations.filter(
            (observation) => observation.leafId !== null && input.pathIds.has(observation.leafId),
        );

        const deepest = onPath.reduce((best, observation) => Math.max(best, observation.depth), -1);

        if (onPath.length === 0 || deepest < 1) {
            return {
                reference: "none",
                verifiedTo: -1,
                referenceDepth: deepest,
                firstMismatchDepth: null,
                compared: 0,
                truncatedHistory: this.droppedCount > 0,
                parameters: [],
                modelDivergence: null,
                referenceLeafId: null,
            };
        }

        let verifiedTo = -1;
        let firstMismatchDepth: number | null = null;
        let compared = 0;
        let reference: ChainObservation | undefined;

        for (const observation of onPath) {
            if (observation.systemHash !== input.shape.systemHash) {
                continue;
            }
            if (observation.toolsHash !== input.shape.toolsHash) {
                continue;
            }

            compared += 1;
            // Newest wins for the informational comparisons; depth order handles the rest.
            reference = observation;
            const ours = input.ladder.get(observation.depth);
            if (ours === undefined) {
                // Our rebuild is shorter than this reference, so it cannot say anything about depth d.
                continue;
            }

            if (ours === observation.head) {
                verifiedTo = Math.max(verifiedTo, observation.depth);
                continue;
            }

            if (firstMismatchDepth === null || observation.depth < firstMismatchDepth) {
                firstMismatchDepth = observation.depth;
            }
        }

        return {
            reference: "chain",
            verifiedTo,
            referenceDepth: deepest,
            firstMismatchDepth,
            compared,
            truncatedHistory: this.droppedCount > 0,
            parameters: parameterDelta(input.shape.keys, reference?.keys ?? []),
            modelDivergence:
                reference !== undefined && reference.model !== input.shape.model
                    ? `${reference.model} -> ${input.shape.model}`
                    : null,
            referenceLeafId: reference?.leafId ?? null,
        };
    }

    /** Diagnostics only: the observations a lookup would consider, oldest first. */
    branchObservations(pathIds: Set<string>): ChainObservation[] {
        return this.observations.filter(
            (observation) => observation.leafId !== null && pathIds.has(observation.leafId),
        );
    }
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
