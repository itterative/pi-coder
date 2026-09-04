import { describe, expect, it } from "vitest";

import type {
    AgentRunCheckpointIntent,
    ChildAgentHandle,
} from "../../src/tools/agent/contracts/runs";
import { BUILTIN_SCOUT } from "../../src/tools/agent/definitions/discovery";
import { AgentRunManager, ZERO_USAGE } from "../../src/tools/agent/runs/manager";
import { partialPersistence } from "../helpers/agent-doubles";

/**
 * Reproduces, without a provider call, the checkpoint fan-out measured live on 2026-09-04: one short
 * background worker run cost 9 snapshot rows and 9 markers, and a crashed-then-continued run cost 18,
 * where `docs/agent-snapshot-gc.md` §4.2 predicts ~3 and ~4. Every boundary turned out to write 3-5
 * checkpoints, which is now the dominant per-run cost - the per-save growth that work removed.
 *
 * Each write is recorded with the manager-owned frames on its stack, so a duplicate is attributable to
 * a call site rather than to a guess.
 */

/** Usage the stub child reports, so "a frame may not lose usage" is a checked property. */
const SPENT_USAGE = {
    ...ZERO_USAGE,
    input: 1234,
    output: 77,
    totalTokens: 1311,
    cost: { ...ZERO_USAGE.cost, input: 0.01, output: 0.02, total: 0.03 },
};

interface Write {
    intent: AgentRunCheckpointIntent;
    status: string;
    /** `usageCheckpoint` in the durable payload - the delta baseline `checkpointOutcome` maintains. */
    usageTotal: number;
    /** `usageSnapshot` in the durable payload - the cumulative spend a lifecycle write records. */
    usageSnapshotTotal: number;
    /** The leaf the write carried: tells "the same boundary twice" from "two boundaries in one tick". */
    leaf: string | null | undefined;
    /** Our own frames, innermost first, as `member@line`. */
    callers: string[];
}

function ourCallers(): string[] {
    return (new Error("fan-out").stack ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /manager\.ts|child-setup\.ts/.test(line))
        .map((line) => {
            const member = /at\s+(?:AgentRunManager\.|Object\.)?([\w<>]+)/.exec(line)?.[1] ?? "?";
            const at = /(?:manager|child-setup)\.ts:(\d+)/.exec(line)?.[1];
            return at ? `${member}@${at}` : member;
        });
}

function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Accept -> child transcript -> operation -> one settled prompt that advances the leaf, carrying a
 * progress frame -> terminal outcome.
 *
 * `background-cancel` follows the path Run 1 used: `start` resolves at the accepted checkpoint, and the
 * parent cancels while the child is still inside its prompt.
 */
async function driveRun(mode: "foreground-complete" | "background-cancel"): Promise<Write[]> {
    const writes: Write[] = [];
    const persistence = partialPersistence({
        usesSnapshotMarkers: true,
        save: async (record, intent = "checkpoint") => {
            writes.push({
                intent,
                status: record.status,
                usageTotal: record.usageCheckpoint?.cost?.total ?? 0,
                usageSnapshotTotal: record.usageSnapshot?.cost?.total ?? 0,
                leaf: record.childSessionLeafId,
                callers: ourCallers(),
            });
            return true;
        },
    });

    let leafSequence = 1;
    let releasePrompt = () => {};
    const promptGate = new Promise<void>((resolve) => {
        releasePrompt = resolve;
    });
    let factoryContext: Parameters<ConstructorParameters<typeof AgentRunManager>[0]>[0];
    const child: ChildAgentHandle = {
        prompt: async () => {
            leafSequence = 2;
            factoryContext.onProgress?.({ output: "thinking", recentActivity: [] });
            await settle();
            if (mode === "background-cancel") {
                await promptGate;
            }
        },
        abort: async () => {},
        dispose: () => {},
        takeParentQuestion: () => undefined,
        getProgress: () => ({ output: "thinking", recentActivity: [] }),
        getFinalOutput: () => "done",
        getError: () => undefined,
        getUsage: () => ({ ...SPENT_USAGE, cost: { ...SPENT_USAGE.cost } }),
        getSessionLeafId: () => `leaf-${leafSequence}`,
    };

    const manager = new AgentRunManager(async (context) => {
        factoryContext = context;
        context.onSessionCreated?.("/tmp/agent-sessions/child.jsonl", "leaf-1");
        return child;
    }, 4);
    manager.setPersistence(persistence);

    if (mode === "foreground-complete") {
        const outcome = await manager.start(
            BUILTIN_SCOUT,
            "Attribute the fan-out",
            { cwd: process.cwd(), parentContext: {} },
            {},
        );
        await manager.shutdown();
        expect(outcome.details.status).toBe("completed");
        return writes;
    }

    const accepted = await manager.start(
        BUILTIN_SCOUT,
        "Attribute the fan-out",
        { cwd: process.cwd(), parentContext: {} },
        { background: true },
    );
    await settle();
    const canceling = manager.cancel(accepted.details.runId);
    releasePrompt();
    const canceled = await canceling;
    await manager.shutdown();
    expect(canceled.details.status).toBe("canceled");
    return writes;
}

function checkpoints(writes: Write[]): string[] {
    return writes
        .filter((write) => write.intent === "checkpoint")
        .map((write) => `${write.status}:${write.leaf ?? "(none)"}`);
}

/** Runs of consecutive identical checkpoints: the writes §4.2 does not account for. */
function redundant(sequence: string[]): string[] {
    const out: string[] = [];
    let index = 0;
    while (index < sequence.length) {
        let last = index;
        while (last + 1 < sequence.length && sequence[last + 1] === sequence[index]) {
            last += 1;
        }
        const count = last - index + 1;
        if (count > 1) {
            out.push(`${sequence[index]} (x${count})`);
        }
        index = last + 1;
    }
    return out;
}

function report(writes: Write[]): string {
    return writes
        .map(
            (write, index) =>
                `${index + 1} [${write.intent}] ${write.status}:${write.leaf ?? "(none)"} ` +
                `via ${write.callers.slice(0, 3).join(" <- ")}`,
        )
        .join("\n");
}

describe("delegated-run checkpoint fan-out", () => {
    /**
     * Pins one completed foreground run. Entries 2 and 3 are the same boundary twice: `child-setup.ts`
     * persists from the `onSessionCreated` hook - fire-and-forget, and unordered against the awaited
     * durability gate in `createChildSession`, which then writes identical content again. The hook write
     * is kept rather than deleted because it is the only record of the child transcript inside that
     * crash window; the fix is to make the pair idempotent, and this test is what notices a regression.
     */
    it("writes the pinned sequence for a completed foreground run", async () => {
        const writes = await driveRun("foreground-complete");
        expect(checkpoints(writes), report(writes)).toEqual([
            "starting:(none)", // createRun: the accepted start reserves the head
            "starting:leaf-1", // child-setup onSessionCreated hook
            "starting:leaf-1", // createChildSession: awaited durability gate (duplicate above)
            "running:leaf-1", // beginOperation: status transition
            "running:leaf-2", // drive: the prompt settled and the leaf advanced
            "removed:leaf-2", // removeRun: terminal eviction tombstone
        ]);
        expect(writes.filter((write) => write.intent === "intermediate")).toHaveLength(1);
        // Foreground completion still checkpoints usage through the lifecycle write that follows it.
        expect(checkpoints(writes).at(-1)).toBe("removed:leaf-2");
        expect(
            writes.filter((write) => write.intent === "checkpoint").at(-1)?.usageSnapshotTotal,
        ).toBe(0.03);
    });

    /**
     * The row Run 1 wrote to the production database, reproduced without a provider call. It cost nine
     * checkpoints; this is the shape after `checkpointOutcome` was reclassified as a frame, so seven remain
     * against §4.2's six boundaries. The single surviving duplicate is the `onSessionCreated` pair, which is
     * kept on purpose:
     *
     * - `child-setup.ts:87` persists the transcript path fire-and-forget, and `createChildSession`
     *   (manager.ts:1135) then awaits the same content. Both are `checkpoint` because §4.4's overlay refuses a
     *   working row whose checkpoint names no child transcript, so downgrading the hook write would reopen a
     *   real crash window to save one row.
     * - `checkpointOutcome` (manager.ts:1916) is fixed: it records usage and its comment has always said the
     *   write must not advance the run, but with the default intent it was appending markers. It now writes
     *   frames, which is why `starting` appears once below instead of three times and `canceled` once instead
     *   of twice. The lifecycle checkpoint that follows carries the same `usageCheckpoint`, so usage loses
     *   nothing durable.
     *
     * Two of the three frames below would be *dropped* by the real writer rather than stored: a frame whose
     * status is a checkpoint boundary is refused by design (`canceled` at index 3 here), and the stub cannot
     * show that. The working-state suite covers it.
     */
    it("reproduces the live canceled-run fan-out at seven checkpoints", async () => {
        const writes = await driveRun("background-cancel");
        const sequence = checkpoints(writes);
        expect(sequence, report(writes)).toEqual([
            "starting:(none)", //  createRun - accepted start reserves the head
            "starting:leaf-1", //  child-setup onSessionCreated hook
            "starting:leaf-1", //  createChildSession awaited durability gate
            "running:leaf-1", //  beginOperation - status transition
            "running:leaf-2", //  drive - prompt settled, leaf advanced
            "canceled:leaf-2", //  retainBackgroundResult - the only terminal write
            "removed:leaf-2", //  removeRun - eviction tombstone
        ]);
        expect(redundant(sequence)).toEqual(["starting:leaf-1 (x2)"]);
        expect(
            writes
                .filter((write) => write.intent === "intermediate")
                .map((write) => `${write.status}:${write.leaf ?? "(none)"}`),
        ).toEqual(["starting:leaf-1", "running:leaf-2", "canceled:leaf-2"]);
    });

    /**
     * The point of reclassifying `checkpointOutcome`: a usage write must stop appending markers without
     * stopping being durable. The frame records it, and the lifecycle checkpoint that follows carries the
     * same `usageCheckpoint` into the journal, so the last checkpoint still reports the spend.
     */
    it("keeps usage durable through the checkpoint that follows the frame", async () => {
        const writes = await driveRun("background-cancel");
        const frames = writes.filter((write) => write.intent === "intermediate");
        const lastCheckpoint = writes.filter((write) => write.intent === "checkpoint").at(-1);

        expect(frames.some((frame) => frame.usageTotal > 0)).toBe(true);
        expect(lastCheckpoint?.status).toBe("removed");
        expect(lastCheckpoint?.usageTotal).toBeGreaterThan(0);
    });
});
