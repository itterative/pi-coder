import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/** One resolved entry: the row pi stored plus the messages it contributes after context edits. */
export type ProjectedSpanEntry = ReturnType<
    SessionManager["buildSessionProjection"]
>["entries"][number];

/** The span stage 1 should read, plus whether the cut point was actually found. */
export interface SpanCut {
    entries: ProjectedSpanEntry[];
    /**
     * False when `firstKeptEntryId` named no entry on this branch, so the slice came back as the whole resolved
     * context instead of the span. Not derivable from the length: a long span and an uncut span look identical
     * here, and the prefix record's `truncated` compares message counts against a *reference*, so it cannot tell
     * the two apart either. This is the only place the fact exists.
     */
    cutFound: boolean;
}

/**
 * The stage-1 span: pi's resolved context up to the cut.
 *
 * The projection already does everything the old file-order window plus seeding did by hand: it hoists the newest
 * checkpoint to the front, drops entries older than the previous fold's boundary, and applies `context_edit`
 * omissions and replacements to the messages. Taking `.messages` from it means stage 1 sends exactly the prefix
 * of the parent request, with no builder to re-hoist and no edits to reattach.
 *
 * `projection` must be built from the branch as it stood for the parent request (the leaf before pi writes this
 * fold's own row), which is what the caller passes.
 */
export function stageOneSpanEntries(
    projection: ReturnType<SessionManager["buildSessionProjection"]>,
    firstKeptEntryId: string,
): SpanCut {
    const cutIndex = projection.entries.findIndex(
        (entry) => entry.sourceEntry.id === firstKeptEntryId,
    );
    if (cutIndex < 0) {
        return { entries: projection.entries, cutFound: false };
    }

    return { entries: projection.entries.slice(0, cutIndex), cutFound: true };
}

/** The messages stage 1 sends, in pi's resolved order. */
export function cutMessages(span: SpanCut): ProjectedSpanEntry["messages"] {
    return span.entries.flatMap((entry) => entry.messages);
}

/**
 * Where the span window starts: the entry the previous fold kept first, or nothing when there is no previous fold.
 *
 * The projection already applies this boundary; the id is still needed by the ledger, which sizes the body from
 * fold rows and counted replies rather than from the projection itself.
 */
export function previousFoldWindowStart(branch: readonly SessionEntry[]): string | undefined {
    const newest = branch.findLast((entry) => entry.type === "compaction");

    return newest?.type === "compaction" ? newest.firstKeptEntryId : undefined;
}

/**
 * The ledger's view of the same span: pi-shaped entries with the resolved messages baked in.
 *
 * The sizing and ledger tiers walk `SessionEntry` lists and re-derive text with `sessionEntryToContextMessages`,
 * which would ignore a `context_edit` and count the row the model never saw. Mapping each projected entry onto a
 * `message` entry carrying its resolved message keeps those tiers unchanged while making them count exactly what
 * stage 1 sends. The rows that change a count basis (folds, model and thinking changes) stay as they are; rows
 * with no resolved message (an omitted entry, a label, a usage record) contribute nothing and are dropped.
 */
export function sizingEntries(entries: readonly ProjectedSpanEntry[]): SessionEntry[] {
    const sized: SessionEntry[] = [];

    for (const { sourceEntry, messages } of entries) {
        if (
            sourceEntry.type === "compaction" ||
            sourceEntry.type === "branch_summary" ||
            sourceEntry.type === "model_change" ||
            sourceEntry.type === "thinking_level_change"
        ) {
            sized.push(sourceEntry);
            continue;
        }
        if (messages.length === 0) {
            continue;
        }

        messages.forEach((message, index) => {
            sized.push({
                ...sourceEntry,
                id: index === 0 ? sourceEntry.id : `${sourceEntry.id}#${String(index)}`,
                type: "message",
                message,
            });
        });
    }

    return sized;
}

/**
 * The same view in file order.
 *
 * The ledger solves its head from the *newest* fold, which it finds as the last compaction row in the list. The
 * projection hoists that row to index 0, so its order cannot be passed to `headAt`; sorting the projected entries
 * back by their branch position keeps the fold and row arithmetic on the branch's own order while still carrying
 * the resolved messages.
 */
export function fileOrderSizingEntries(
    entries: readonly ProjectedSpanEntry[],
    branch: readonly SessionEntry[],
): SessionEntry[] {
    const position = new Map(branch.map((entry, index) => [entry.id, index]));
    const sorted = entries.toSorted(
        (left, right) =>
            (position.get(left.sourceEntry.id) ?? -1) - (position.get(right.sourceEntry.id) ?? -1),
    );

    return sizingEntries(sorted);
}
