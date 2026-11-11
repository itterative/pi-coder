import { performance } from "node:perf_hooks";

/**
 * The phases a call times directly.
 *
 * `work` is not measured: it is whatever the phases above do not account for, so the total stays honest without
 * instrumenting every early return inside every action.
 */
export type TimingPhase = "source" | "semantic" | "discover" | "parse" | "search" | "tail";

/** Where one call spent its time, and the counts that explain the numbers. */
export interface CodeTiming {
    /** Whole call: source creation, semantic setup, the action, and result assembly. */
    totalMs: number;
    /** `createCodeSource`: a local handle, or the session's container view. */
    sourceMs: number;
    /** Semantic channel setup for `search`: config, consent, artifacts, and the index handle. */
    semanticMs: number;
    /** Glob discovery of candidate files. */
    discoverMs: number;
    /** Reading and parsing the files that were not already in the parse cache. */
    parseMs: number;
    /** Declarations selected by the query, header/definition pairing, and the usage index. */
    searchMs: number;
    /** The relevance tail; zero when it did not run. */
    tailMs: number;
    /** Everything the phases above do not cover: formatting, truncation, and the call's own overhead. */
    workMs: number;
    files: number;
    /** Files served from the parse cache, and files read and parsed in this call. */
    cached: number;
    parsed: number;
    tooLarge: number;
    parseErrors: number;
}

const PHASES: readonly TimingPhase[] = [
    "source",
    "semantic",
    "discover",
    "parse",
    "search",
    "tail",
];

function round(ms: number): number {
    return Math.round(ms * 10) / 10;
}

/**
 * One line describing where a call spent its time.
 *
 * Phases under a millisecond are dropped: they are rounding, not information. The counts follow because they are
 * what turns "parse 1.9 s" into an explanation (a cold cache) or makes it suspicious (every file cached).
 */
export function describeTiming(timing: CodeTiming): string {
    const phases: Array<[string, number]> = [
        ["parse", timing.parseMs],
        ["search", timing.searchMs],
        ["discover", timing.discoverMs],
        ["tail", timing.tailMs],
        ["semantic", timing.semanticMs],
        ["source", timing.sourceMs],
        ["work", timing.workMs],
    ];
    const parts = [`${Math.round(timing.totalMs)} ms`];

    for (const [name, ms] of phases
        .filter(([, value]) => value >= 1)
        .toSorted((left, right) => right[1] - left[1])) {
        parts.push(`${name} ${Math.round(ms)}`);
    }

    parts.push(`files ${timing.files}`);

    if (timing.cached > 0) {
        parts.push(timing.parsed > 0 ? `cached ${timing.cached}` : "all cached");
    }

    if (timing.parsed > 0) {
        parts.push(`parsed ${timing.parsed}`);
    }

    if (timing.tooLarge > 0) {
        parts.push(`too large ${timing.tooLarge}`);
    }

    if (timing.parseErrors > 0) {
        parts.push(`parse errors ${timing.parseErrors}`);
    }

    return `timing: ${parts.join(" · ")}`;
}

/**
 * Collects where one tool call spent its time.
 *
 * Phases accumulate, so work measured twice (a `show` that looks a symbol up in a second directory) reports the
 * sum. The clock starts when the call starts, which is what lets `workMs` be a remainder rather than another
 * instrumented span.
 */
export class CallTiming {
    private readonly startedAt = performance.now();
    private readonly phases = new Map<TimingPhase, number>();
    private readonly counts = { files: 0, cached: 0, parsed: 0, tooLarge: 0, parseErrors: 0 };

    async measure<T>(phase: TimingPhase, work: () => Promise<T> | T): Promise<T> {
        const started = performance.now();

        try {
            return await work();
        } finally {
            this.phases.set(phase, (this.phases.get(phase) ?? 0) + (performance.now() - started));
        }
    }

    /** Counts accumulate too: a call that parses two directories reports both. */
    record(counts: Partial<typeof this.counts>): void {
        this.counts.files += counts.files ?? 0;
        this.counts.cached += counts.cached ?? 0;
        this.counts.parsed += counts.parsed ?? 0;
        this.counts.tooLarge += counts.tooLarge ?? 0;
        this.counts.parseErrors += counts.parseErrors ?? 0;
    }

    /** The files a load produced, for `record`: cache hits, fresh parses, and what was skipped. */
    recordLoad(
        batch: {
            cached: number;
            fresh: number;
            tooLarge: number;
            errors: readonly string[];
        },
        files: number,
    ): void {
        this.record({
            files,
            cached: batch.cached,
            parsed: batch.fresh,
            tooLarge: batch.tooLarge,
            parseErrors: batch.errors.length,
        });
    }

    snapshot(): CodeTiming {
        const totalMs = performance.now() - this.startedAt;
        const measured = PHASES.reduce((sum, phase) => sum + (this.phases.get(phase) ?? 0), 0);

        return {
            totalMs: round(totalMs),
            sourceMs: round(this.phases.get("source") ?? 0),
            semanticMs: round(this.phases.get("semantic") ?? 0),
            discoverMs: round(this.phases.get("discover") ?? 0),
            parseMs: round(this.phases.get("parse") ?? 0),
            searchMs: round(this.phases.get("search") ?? 0),
            tailMs: round(this.phases.get("tail") ?? 0),
            workMs: round(Math.max(0, totalMs - measured)),
            ...this.counts,
        };
    }
}
