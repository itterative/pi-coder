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

/**
 * The context entries before the cut point.
 *
 * `firstKeptEntryId` is where pi's retained tail starts, so everything before it is what stage 1 should see
 * and everything from it onward is what stage 1 must not re-read.
 */
export function spanContextEntries(
    contextEntries: SessionEntry[],
    firstKeptEntryId: string,
): SessionEntry[] {
    const cut = contextEntries.findIndex((entry) => entry.id === firstKeptEntryId);
    if (cut < 0) {
        return contextEntries;
    }
    return contextEntries.slice(0, cut);
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
