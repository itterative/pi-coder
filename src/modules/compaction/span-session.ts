import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * The stage-1 transcript: pi's own context entries, truncated where compaction is about to cut.
 *
 * Stage 1 asks the model to summarize the span it is about to lose, using the real message objects rather
 * than a re-serialization of them. Building that request by slicing converted messages means guessing which
 * entries produce which messages (custom entries, compaction boundaries, `excludeFromContext` bash runs,
 * branch summaries), so instead the entries are copied into an in-memory transcript and pi's
 * `buildSessionContext()` resolves it. The result is a strict prefix of what the parent already sent, which
 * is the whole point: the retained tail is not re-read, and the provider's cached prefix still covers it.
 *
 * pi 0.84 exposes no public append for `branch_summary` entries (its own comment references an
 * `appendBranchSummary()` that does not exist), so those are reported as skipped rather than faked. Stage 2's
 * minimized transcript is built from `preparation.messagesToSummarize`, which still contains them, so the
 * summarizer does not lose the branch context — only stage 1's view of it is narrower.
 */

/** Entry types an in-memory transcript can be rebuilt from through a public append. */
const COPYABLE_TYPES = new Set([
    "message",
    "compaction",
    "custom_message",
    "custom",
    "model_change",
    "thinking_level_change",
]);

export interface SpanSession {
    sessionManager: SessionManager;
    copiedEntries: number;
    /** Counts per entry type that could not be copied, newest reason for a narrower stage-1 context. */
    skippedEntries: Record<string, number>;
}

/** The span stage 1 should read, plus whether the cut point was actually found. */
export interface SpanCut {
    entries: SessionEntry[];
    /**
     * False when `firstKeptEntryId` named no entry on this branch, so the slice came back as the whole
     * transcript. Not derivable from the length: a long span and an uncut span look identical here, and the
     * prefix record's `truncated` compares message counts against a *reference*, so it cannot tell the two
     * apart either. This is the only place the fact exists.
     */
    cutFound: boolean;
}

/**
 * The context entries before the cut point.
 *
 * `firstKeptEntryId` is where pi's retained tail starts, so everything before it is what stage 1 should see
 * and everything from it onward is what stage 1 must not re-read.
 */
export function spanContextEntries(
    contextEntries: SessionEntry[],
    firstKeptEntryId: string,
    windowStartEntryId?: string,
): SpanCut {
    const cut = contextEntries.findIndex((entry) => entry.id === firstKeptEntryId);
    if (cut < 0) {
        return { entries: contextEntries, cutFound: false };
    }

    // An id the list does not contain keeps the whole window rather than narrowing it: the caller asked for less,
    // and dropping entries nobody named is the one mistake a stage-1 transcript cannot take back.
    const named =
        windowStartEntryId === undefined
            ? 0
            : contextEntries.findIndex((entry) => entry.id === windowStartEntryId);
    const start = Math.max(0, named);
    return { entries: contextEntries.slice(start, cut), cutFound: true };
}

/**
 * Where the span window starts: the entry the previous fold kept first, or nothing when there is no previous fold.
 *
 * pi's resolved context begins there and drops everything older, so a span that reaches past it would re-read
 * text no provider has cached. Pair it with the file-order branch: the window is what core's own
 * `prepareCompaction` walks (`boundaryStart` to the cut), and copying it in that order lets pi's summary hoisting
 * run exactly once instead of a second time on an already-hoisted list.
 */
export function previousFoldWindowStart(branch: readonly SessionEntry[]): string | undefined {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry?.type === "compaction") {
            return entry.firstKeptEntryId;
        }
    }

    return undefined;
}

/**
 * Stage 1's span: the file-order window core itself walks, from the previous fold's boundary to the cut.
 *
 * The two arguments belong together and a caller that splits them is how the depth-2 divergence happened. pi's
 * resolved context hoists the newest summary to the front and lets older ones ride inline; slice *that* list and
 * copy it into a fresh session and pi's hoisting runs a second time on already-hoisted input, promoting the older
 * summary instead. Feeding the chronological window instead runs the hoist once and reproduces pi's order, so the
 * body stays a prefix of what the provider cached. `previousFoldWindowStart` also drops entries older than the
 * last fold, which no provider has cached and stage 1 has no business re-reading.
 */
export function stageOneSpanEntries(branch: SessionEntry[], firstKeptEntryId: string): SpanCut {
    return spanContextEntries(branch, firstKeptEntryId, previousFoldWindowStart(branch));
}

export function buildSpanSession(entries: SessionEntry[], cwd: string): SpanSession {
    const sessionManager = SessionManager.inMemory(cwd);
    const skippedEntries: Record<string, number> = {};
    let copiedEntries = 0;
    let firstCopiedId: string | undefined;

    for (const entry of entries) {
        if (!COPYABLE_TYPES.has(entry.type)) {
            skippedEntries[entry.type] = (skippedEntries[entry.type] ?? 0) + 1;
            continue;
        }
        const appended = appendSpanEntry(sessionManager, entry, firstCopiedId);
        if (appended === undefined) {
            skippedEntries[entry.type] = (skippedEntries[entry.type] ?? 0) + 1;
            continue;
        }
        firstCopiedId ??= appended;
        copiedEntries += 1;
    }

    return { sessionManager, copiedEntries, skippedEntries };
}

/**
 * Copy one entry, returning its id in the new transcript, or undefined when it could not be copied.
 *
 * `firstCopiedId` matters for compaction entries: the parent's `firstKeptEntryId` names an entry this
 * transcript never saw, and an unmatched id makes pi keep everything from the compaction entry onward while
 * *also* keeping everything before it — which is exactly the resolved context stage 1 is meant to read. When
 * the compaction entry is itself first, nothing precedes it to preserve, so the original id is harmless.
 */
function appendSpanEntry(
    sessionManager: SessionManager,
    entry: SessionEntry,
    firstCopiedId: string | undefined,
): string | undefined {
    switch (entry.type) {
        case "message": {
            const message = entry.message;
            // Summary roles live in their own entry types; a stray message-shaped one is refused rather
            // than silently dropped, because `appendMessage` throws on them.
            if (message.role === "compactionSummary" || message.role === "branchSummary") {
                return undefined;
            }
            return sessionManager.appendMessage(message);
        }
        case "compaction":
            return sessionManager.appendCompaction(
                entry.summary,
                firstCopiedId ?? entry.firstKeptEntryId,
                entry.tokensBefore,
                entry.details,
                entry.fromHook,
                entry.usage,
            );
        case "custom_message":
            return sessionManager.appendCustomMessageEntry(
                entry.customType,
                entry.content,
                entry.display,
                entry.details,
            );
        case "custom":
            return sessionManager.appendCustomEntry(entry.customType, entry.data);
        case "model_change":
            return sessionManager.appendModelChange(entry.provider, entry.modelId);
        case "thinking_level_change":
            return sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
        default:
            return undefined;
    }
}

/** Sum of the entries stage 1 could not see because no public append exists for them. */
export function skippedEntryCount(skipped: Record<string, number>): number {
    return Object.values(skipped).reduce((total, count) => total + count, 0);
}
