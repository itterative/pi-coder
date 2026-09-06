import { convertToLlm, findCutPoint, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { chooseSpanCut } from "../../../src/modules/compaction/cut";
import { spanSizer } from "../../../src/modules/compaction/ledger";
import {
    countBoundary,
    countSpanTokens,
    estimateAnchoredSpanTokens,
    estimateRequestTokens,
    nativeRequestFits,
} from "../../../src/modules/compaction/native-request";
import { previousFoldWindowStart } from "../../../src/modules/compaction/span-session";
import {
    assistantMessage,
    compactionMarker,
    messageChain,
    toolResultMessage,
    userMessage,
} from "../../helpers/compaction-doubles";
import { countedUsage } from "../../helpers/agent-doubles";
import type { ContextMessage } from "../../../src/modules/compaction/types";

/**
 * The cut rules as properties, not examples.
 *
 * `cut-shapes.test.ts` catalogues the five shapes a cut can have; this file is what makes the catalogue
 * trustworthy, because every one of those shapes is an argument about a *pair* of rows and a pair-argument is
 * exactly the kind of thing that survives a changed role, a new entry type, or a metadata row wedged between a
 * call and its result. So the invariants run over every short sequence exhaustively and over long random ones
 * from a fixed seed - fixed, not random per run, because a failure has to be reproducible from the report.
 *
 * The invariants are deliberately split by who owns them:
 *
 *  - "a tail that begins with a tool result dangles" and "a tail that begins anywhere else resolves" are what
 *    make the shape table mean something. pi's `isCutPointMessage` is the only thing enforcing them today
 *    (`compaction.js:236`), and we depend on it without stating it.
 *  - "exact-cut equals the kept row's count" is ours, and it must hold for every branch, not the recorded one.
 */

/** Small deterministic LCG: no dependency, and a seed in the failure message rebuilds the case exactly. */
function rng(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;

        return state / 0x1_0000_0000;
    };
}

/** ids and timestamps that put rows in a chosen order relative to a boundary. */
function toEntries(messages: ContextMessage[], at: string): SessionEntry[] {
    return messageChain(messages.map((message, index) => ({ id: `e-${index}`, message, at })));
}

/** The same rows with strictly increasing timestamps, so a boundary can fall between any two of them. */
function toTimedEntries(messages: ContextMessage[]): SessionEntry[] {
    return messageChain(
        messages.map((message, index) => ({
            id: `e-${index}`,
            message,
            at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        })),
    );
}

/** A metadata row: context-invisible, and reachable as a cut point by pi's own backwards metadata scan. */
function metadataRow(id: string, parentId: string | null, at: string): SessionEntry {
    return {
        type: "model_change",
        id,
        parentId,
        timestamp: at,
        provider: "anthropic",
        modelId: "same-model",
    } as SessionEntry;
}

/** A conversation whose tool results always follow their own call - what pi can actually write. */
function wellFormedMessages(next: () => number): ContextMessage[] {
    const messages: ContextMessage[] = [];
    const turns = 1 + Math.floor(next() * 6);

    for (let turn = 0; turn < turns; turn += 1) {
        messages.push(userMessage(`ask ${String(turn)}`));
        let pending: string[] = [];
        const steps = 1 + Math.floor(next() * 4);
        for (let step = 0; step < steps; step += 1) {
            const calls =
                pending.length > 0
                    ? []
                    : [{ id: `call-${String(turn)}-${String(step)}`, name: "read" }];
            messages.push(
                assistantMessage({
                    text: `reply ${String(turn)}-${String(step)}`,
                    calls,
                    usage: countedUsage(
                        1000 + Math.floor(next() * 9000),
                        100 + Math.floor(next() * 900),
                    ),
                }),
            );
            pending = calls.map((call) => call.id);
            // A metadata row between the call and its result: real in pi-coder sessions, and the reason the
            // shape tests look at roles rather than positions.
            if (next() < 0.25) {
                messages.push(
                    toolResultMessage({ callId: pending[0], tool: "bash", text: "meta" }),
                );
                pending = [];
            }
            for (const callId of pending) {
                messages.push(
                    toolResultMessage({
                        callId,
                        tool: "read",
                        text: "x".repeat(Math.floor(next() * 500)),
                        details:
                            next() < 0.4
                                ? { truncation: { content: "y".repeat(1000) } }
                                : undefined,
                    }),
                );
            }
            pending = [];
        }
    }

    return messages;
}

/** True when a tool result appears before the assistant row that made its call. */
/** Every ordering of a small alphabet - six for three rows, which is all a shape claim needs. */
function* orderings<T>(items: readonly T[]): Generator<T[]> {
    if (items.length <= 1) {
        yield [...items];
        return;
    }

    for (let index = 0; index < items.length; index += 1) {
        const rest = [...items.slice(0, index), ...items.slice(index + 1)];
        for (const tail of orderings(rest)) {
            yield [items[index], ...tail];
        }
    }
}

function firstResultPrecedesCall(messages: ContextMessage[]): boolean {
    const made = new Set<string>();
    for (const message of messages) {
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "toolCall") {
                    made.add(block.id);
                }
            }
        }
        if (message.role === "toolResult" && !made.has(message.toolCallId)) {
            return true;
        }
    }

    return false;
}

function keptIsAssistant(entry: SessionEntry): boolean {
    return entry.type === "message" && entry.message.role === "assistant";
}

/** The newest reply in the window with a usage a count could be taken from. */
function newestUsableTotal(entries: SessionEntry[]): number {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }
        const usage = entry.message.usage;
        if (usage === undefined || usage.totalTokens <= 0) {
            continue;
        }

        return usage.totalTokens;
    }

    return 0;
}

function roleAt(entry: SessionEntry): string {
    return entry.type === "message" ? entry.message.role : entry.type;
}

function callIds(messages: ReturnType<typeof convertToLlm>): {
    made: Set<string>;
    taken: string[];
} {
    const made = new Set<string>();
    const taken: string[] = [];
    for (const message of messages) {
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "toolCall") {
                    made.add(block.id);
                }
            }
        }
        if (message.role === "toolResult") {
            taken.push(message.toolCallId);
        }
    }

    return { made, taken };
}

/** Every call id a tail answers that the tail itself never made. */
function danglingIds(entries: SessionEntry[]): string[] {
    const messages = convertToLlm(
        entries.flatMap((entry) => (entry.type === "message" ? [entry.message as never] : [])),
    );
    const { made, taken } = callIds(messages);

    return taken.filter((id) => !made.has(id));
}

function headRole(entries: SessionEntry[]): string {
    for (const entry of entries) {
        if (entry.type === "message") {
            return entry.message.role;
        }
    }

    return "<no messages>";
}

const SEEDS = [1, 7, 13, 42, 99, 2026, 611, 40991];

describe("cut invariants (fuzz)", () => {
    it("a tail dangles if and only if its first message row is a tool result", () => {
        for (const seed of SEEDS) {
            const next = rng(seed);
            const messages = wellFormedMessages(next);
            const entries = toEntries(messages, "2026-01-01T00:00:00.000Z");

            for (let cut = 1; cut < entries.length; cut += 1) {
                const tail = entries.slice(cut);
                const dangles = danglingIds(tail).length > 0;

                // Both directions, because the shape table is a biconditional claim: a `toolResult` head is the
                // only way to orphan a call, and it always does.
                expect(dangles, `seed ${String(seed)} cut ${String(cut)}`).toBe(
                    headRole(tail) === "toolResult",
                );
            }
        }
    });

    it("pi's own cut point is never a tool result, on random branches and on every short sequence", () => {
        const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
        const check = (entries: SessionEntry[], label: string) => {
            if (entries.length < 2) {
                return;
            }

            const cut = findCutPoint(entries, 0, entries.length, settings.keepRecentTokens);
            const kept = entries[cut.firstKeptEntryIndex];
            expect(kept, label).toBeDefined();
            expect(roleAt(kept), `${label} kept a tool result`).not.toBe("toolResult");
            // The consequence that matters, for branches where a call's result cannot be separated from it:
            // whatever survives resolves.
            expect(danglingIds(entries.slice(cut.firstKeptEntryIndex)), `${label} tail`).toEqual(
                [],
            );
        };

        for (const seed of SEEDS) {
            check(
                toEntries(wellFormedMessages(rng(seed)), "2026-01-01T00:00:00.000Z"),
                `seed ${String(seed)}`,
            );
        }

        // Exhaustive over the alphabet that composes a turn, in every ordering in which a result still follows
        // its own call. The orderings where it does not are the finding, and they have their own case below -
        // mixing them in here would only ever say "pi cannot cut at a tool result", which is not the property
        // the shape table depends on.
        const alphabet: ContextMessage[] = [
            userMessage("u"),
            assistantMessage({ text: "a", calls: [{ id: "c1", name: "read" }] }),
            toolResultMessage({ callId: "c1", tool: "read", text: "t" }),
        ];
        for (let mask = 0; mask < 3 ** 5; mask += 1) {
            const messages: ContextMessage[] = [];
            let rest = mask;
            for (let index = 0; index < 5; index += 1) {
                messages.push(alphabet[rest % 3]);
                rest = Math.floor(rest / 3);
            }
            if (firstResultPrecedesCall(messages)) {
                continue;
            }
            check(toEntries(messages, "2026-01-01T00:00:00.000Z"), `seq ${String(mask)}`);
        }
    });

    it("an out-of-order result orphans a tail that pi's role rule still accepts, so ids are the check", () => {
        // Reachable in a real session: a tool still running while the user speaks writes [call][user][result],
        // and pi's guard refuses to *cut at* a tool result but never asks whether the results below the cut
        // belong to calls above it. Cutting at the user row here is a legal cut point and an impossible request:
        // the surviving result cites a call id the provider has never seen. This is why an admissibility rule
        // has to resolve ids rather than classify roles, and why "pi would never produce it" is not a proof.
        const entries = toEntries(
            [
                assistantMessage({
                    text: "working",
                    calls: [{ id: "c1", name: "bash" }],
                    usage: countedUsage(2_000, 100),
                }),
                userMessage("actually, stop"),
                toolResultMessage({ callId: "c1", tool: "bash", text: "late output" }),
                assistantMessage({ text: "stopped", usage: countedUsage(3_000, 100) }),
            ],
            "2026-01-01T00:00:00.000Z",
        );

        const cutAtUser = 1;
        expect(roleAt(entries[cutAtUser])).toBe("user");
        expect(danglingIds(entries.slice(cutAtUser))).toEqual(["c1"]);

        // And pi agrees the position is cuttable: with a keep budget that is crossed exactly at the user row,
        // `findCutPoint` snaps to it, because a user message is a perfectly valid cut point and nothing in the
        // rule looks underneath it. 8 tokens sits above the 5 the last two rows hold and below the 9 including
        // the user row, which is what forces the crossing there.
        const chosen = findCutPoint(entries, 0, entries.length, 8);
        expect(chosen.firstKeptEntryIndex).toBe(cutAtUser);
    });

    it("exact-cut fires exactly on an assistant kept row that was counted, and equals that count", () => {
        for (const seed of SEEDS) {
            const entries = toEntries(wellFormedMessages(rng(seed)), "2026-01-01T00:00:00.000Z");
            // Non-zero, because a tier defined as "the count plus the instruction" is free to lose the second
            // term when every probe passes zero - and the instruction is the only part of the request no
            // provider ever counted.
            const instructionTokens = 1 + (seed % 700);

            for (let cut = 1; cut < entries.length; cut += 1) {
                const kept = entries[cut];
                const usage =
                    kept.type === "message" && kept.message.role === "assistant"
                        ? kept.message.usage
                        : undefined;
                const prompt = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
                const counted = countSpanTokens({
                    spanEntries: entries.slice(0, cut),
                    keptEntry: kept,
                    extraTokens: instructionTokens,
                });

                const expectExact = keptIsAssistant(kept) && prompt > 0;
                expect(counted.source, `seed ${String(seed)} cut ${String(cut)}`).not.toBe("none");
                if (expectExact) {
                    // Not a band: the tier is defined as that number plus the instruction, so any drift means
                    // something else started being believed.
                    expect(counted.tokens).toBe(prompt + instructionTokens);
                    expect(counted.source).toBe("exact-cut");
                    continue;
                }

                // Two labels for the fallback, and which one is right is a fact about the span rather than a
                // preference: with an empty tail the anchor already covers the whole body.
                const anchorTotal = newestUsableTotal(entries.slice(0, cut));
                if (counted.source === "exact-anchor") {
                    expect(counted.tokens).toBe(anchorTotal + instructionTokens);
                } else {
                    expect(counted.source).toBe("usage-anchor");
                    expect(counted.tokens).toBeGreaterThan(anchorTotal + instructionTokens);
                }
            }
        }
    });

    it("a metadata row at the cut is never treated as a counted reply", () => {
        // pi's `findCutPoint` ends by walking the cut index *backwards* over "adjacent metadata entries that do
        // not affect context" (`compaction.js:339-348`), so the first kept entry can be a row that produces no
        // message at all. Those rows are not assistant replies, and pi's `CompactionEntry` and
        // `BranchSummaryEntry` carry an optional `usage` of their own - so a tier that only asked "is there a
        // count here" would find one and report it as the size of a body it never measured.
        const messages = wellFormedMessages(rng(11));
        for (let position = 0; position < messages.length; position += 1) {
            const entries = toEntries(messages, "2026-01-01T00:00:00.000Z");
            entries.splice(
                position,
                0,
                metadataRow("meta", entries[0]?.id ?? null, "2026-01-01T00:00:00.000Z"),
            );

            const counted = countSpanTokens({
                spanEntries: entries.slice(0, position),
                keptEntry: entries[position],
                extraTokens: 0,
            });

            expect(roleAt(entries[position])).toBe("model_change");
            expect(counted.source, `metadata row at ${String(position)} claimed a count`).not.toBe(
                "exact-cut",
            );
        }
    });

    it("a boundary either admits the rows after it or rejects every one of them, with nothing between", () => {
        // The two mutations this kills: a boundary that is ignored (everything stays usable) and a boundary that
        // over-reaches (a null while a live count sits after it). Stated as a pair of directions rather than as
        // a count, because a bookkeeping-only assertion passes with the filter deleted.
        for (const seed of SEEDS) {
            const entries = toTimedEntries(wellFormedMessages(rng(seed)));

            for (let cut = 1; cut < entries.length; cut += 1) {
                const kept = entries[cut];
                const span = entries.slice(0, cut);
                const countedRows = span.filter(
                    (entry) => entry.type === "message" && entry.message.role === "assistant",
                ).length;
                const keptIsCountedAssistant =
                    kept.type === "message" &&
                    kept.message.role === "assistant" &&
                    (kept.message.usage?.input ?? 0) +
                        (kept.message.usage?.cacheRead ?? 0) +
                        (kept.message.usage?.cacheWrite ?? 0) >
                        0;

                // Boundary exactly at the kept row: that row and everything older are stale, so nothing in this
                // window can be believed and every counted row must show up in `staleAnchors`.
                const atKept = countSpanTokens({
                    spanEntries: span,
                    keptEntry: kept,
                    boundary: Date.parse(kept.timestamp),
                    extraTokens: 0,
                });
                expect(
                    atKept.tokens,
                    `boundary at cut ${String(cut)} left a count behind`,
                ).toBeNull();
                expect(atKept.staleAnchors).toBe(countedRows + (keptIsCountedAssistant ? 1 : 0));

                // Boundary one row older: the kept row is now the newest usable thing in the window, so a
                // counted assistant there must produce its exact number and nothing may be reported stale.
                const older = countSpanTokens({
                    spanEntries: span,
                    keptEntry: kept,
                    boundary: Date.parse(span[span.length - 1].timestamp),
                    extraTokens: 0,
                });
                if (keptIsCountedAssistant) {
                    expect(older.source).toBe("exact-cut");
                    expect(older.staleAnchors).toBe(countedRows);
                } else {
                    expect(older.source).not.toBe("exact-cut");
                }
            }
        }
    });

    it("estimates ignore everything the provider never receives, whatever it holds", () => {
        const next = rng(5);
        for (const size of [0, 1, 500, 20_000, 200_000]) {
            const messages = wellFormedMessages(rng(3));
            const baseline = countSpanTokens({
                spanEntries: toEntries(messages, "2026-01-01T00:00:00.000Z"),
                extraTokens: 0,
            });
            const polluted = messages.map((message) => {
                if (message.role !== "toolResult") {
                    return message;
                }

                return {
                    ...message,
                    details: { truncation: { content: "z".repeat(size), seed: next() } },
                };
            });
            const withDetails = countSpanTokens({
                spanEntries: toEntries(polluted, "2026-01-01T00:00:00.000Z"),
                extraTokens: 0,
            });

            // Up to 200k characters of harness bookkeeping: an anchored number must not move at all, which is
            // the assertion that fails the moment `JSON.stringify(storedMessage)` comes back.
            expect(withDetails.tokens, `details of ${String(size)} chars`).toBe(baseline.tokens);

            const pollutedContext = {
                systemPrompt: "s".repeat(100),
                tools: [],
                messages: convertToLlm(polluted.map((message) => message as never)),
            };
            const cleanContext = {
                systemPrompt: "s".repeat(100),
                tools: [],
                messages: convertToLlm(messages.map((message) => message as never)),
            };
            // Same for the whole-body tier, which is the number the gate falls back to in the window right
            // after a fold - and so the one that most needs to stop growing with bookkeeping.
            expect(estimateRequestTokens(pollutedContext)).toBe(
                estimateRequestTokens(cleanContext),
            );
        }
    });

    it("the fit gate is monotone in the count it is given", () => {
        // Earlier-only cut repair terminates because of this property and nothing else: if growing the count
        // could ever make a request fit, walking to a shorter span would not be a one-way descent.
        const context = { systemPrompt: "s", messages: [], tools: [] };
        const window = 200_000;
        const output = 4_369;
        const ascending = [1_000, 50_000, 120_000, 190_000, 195_000, 196_000, 200_000, 400_000];
        const verdicts = ascending.map((tokens) =>
            nativeRequestFits(context, window, output, null, tokens),
        );

        expect(verdicts.filter((fit) => fit).length).toBeGreaterThan(0);
        expect(verdicts.filter((fit) => !fit).length).toBeGreaterThan(0);
        // Once false, always false as the count grows.
        const firstRejection = verdicts.indexOf(false);
        expect(verdicts.slice(firstRejection)).toEqual(
            verdicts.slice(firstRejection).map(() => false),
        );
    });

    it("an anchored number never claims less than the anchor it read", () => {
        for (const seed of SEEDS) {
            const messages = wellFormedMessages(rng(seed));
            const entries = toEntries(messages, "2026-01-01T00:00:00.000Z");
            for (let cut = 1; cut < entries.length; cut += 1) {
                const span = entries.slice(0, cut);
                const anchored = estimateAnchoredSpanTokens(span, 0);
                if (anchored === null) {
                    continue;
                }
                // The tier's definition is "the newest usable count, plus a non-negative tail", so compare it
                // against the newest usable row rather than the largest: an older row may legitimately carry a
                // bigger number, and a random generator makes that common.
                expect(anchored, `seed ${String(seed)} cut ${String(cut)}`).toBeGreaterThanOrEqual(
                    newestUsableTotal(span),
                );
            }
        }
    });
    it("the walk never chooses a boundary under the window, and always names what refused core's", () => {
        // The two cross-field claims C2 puts on the repair path. First, the window: `stageOneSpanEntries` builds
        // from the newest fold's `firstKeptEntryId`, so a chosen cut under it is not a smaller span but a body
        // nobody can assemble - the guard replaced an incidental one (expired counts used to keep the walk out
        // of that stretch by accident), and a guard that only holds on the fixtures is not a guard.
        //
        // Second, the cause: a move means core's own position was refused by some condition, and a refusal
        // recorded without a move means the walk saw it and stayed put anyway. Both directions are the report's
        // `moved-without-cause` / `cause-without-move` invariants, checked here over generated branches so a
        // future condition added to the walk cannot silently break the pairing.
        const check = (branch: SessionEntry[], label: string) => {
            const windowStartId = previousFoldWindowStart(branch);
            const sizer = spanSizer(branch, {
                windowStartId,
                boundary: countBoundary(branch),
            });
            const windowStart = sizer?.windowStartIndex ?? 0;

            for (let proposed = 1; proposed < branch.length; proposed += 1) {
                for (const keep of [0, 500, 20_000]) {
                    const decision = chooseSpanCut({
                        branch,
                        proposedFirstKeptEntryId: branch[proposed].id,
                        boundary: countBoundary(branch),
                        liveTokens: sizer?.live().tokens ?? null,
                        keepRecentTokens: keep,
                        contextWindow: 200_000,
                        outputBudgetTokens: 1_024,
                        instructionTokens: 100,
                        sizer,
                    });
                    const at = `${label} proposed ${String(proposed)} keep ${String(keep)}`;

                    expect(decision.movedEarlier === decision.movedRows > 0, at).toBe(true);
                    // One direction, because the converse is the abstain path: core's boundary refused, nothing
                    // better admissible, and the run ships the refusal anyway. That pairing is `refused-cut-shipped`
                    // in the report - a suspect about the outcome, not a contradiction in the record.
                    if (decision.movedEarlier) {
                        expect(decision.proposedRejection, at).not.toBeNull();
                    }
                    // An admissible boundary is inside the window and carries a measured span: no basis, no
                    // number, and the walk has chosen something it cannot size.
                    if (decision.spanTokens !== null) {
                        expect(
                            branch.findIndex((entry) => entry.id === decision.firstKeptEntryId),
                            at,
                        ).toBeGreaterThanOrEqual(windowStart);
                        expect(decision.spanBasis, at).not.toBeNull();
                        // The span carries the instruction, so the tail is the live size minus the whole thing:
                        // asserting the arithmetic rather than a constant is what keeps this honest when the
                        // instruction's own estimate moves.
                        expect(decision.tailTokens, at).toBe(
                            (sizer?.live().tokens ?? 0) - decision.spanTokens,
                        );
                    }
                }
            }
        };

        for (const seed of SEEDS) {
            check(toTimedEntries(wellFormedMessages(rng(seed))), `seed ${String(seed)}`);
        }

        // Exhaustive over the short branches too, with a fold spliced at every position: a generated branch with
        // no fold in it cannot reach the window guard at all, and the whole point of the guard is the fold.
        const alphabet: ContextMessage[] = [
            userMessage("u"),
            assistantMessage({ text: "a", usage: countedUsage(1_000, 100) }),
            assistantMessage({ text: "b", usage: countedUsage(4_000, 200) }),
        ];
        for (const shape of orderings(alphabet)) {
            const entries = toTimedEntries(shape);
            check(entries, "no fold");
            for (let splice = 0; splice < entries.length; splice += 1) {
                const fold = compactionMarker("f", {
                    at: entries[splice].timestamp,
                    firstKeptEntryId: entries[splice].id,
                });
                check(
                    [...entries.slice(0, splice), fold, ...entries.slice(splice)],
                    `fold at ${String(splice)}`,
                );
            }
        }
    });
});
