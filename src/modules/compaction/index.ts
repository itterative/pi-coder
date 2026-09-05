import type {
    CompactionResult,
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import { type CompactionConfig, loadCompactionConfig } from "./config";
import {
    activeToolDefinitions,
    buildNativeContext,
    liveContextMessages,
    nativeRequestFits,
} from "./native-request";
import { nativeSummarizationInstruction } from "./prompt";
import { serializeConversationMinimal, serializerOptions } from "./serialize";
import {
    analyzeSpan,
    buildSupplementarySections,
    computeFileLists,
    formatFileLists,
} from "./sections";
import { summarizeNatively, summarizeSerializedTranscript } from "./summarize";
import { summarizedSpan, type CompactionPreparation } from "./types";

/**
 * Compaction that reads the conversation instead of a retyped copy of it.
 *
 * pi's default path serializes the summarized span to text — thinking blocks untruncated, tool results at
 * a fixed 2000 characters, no overall budget — and sends it as a one-off request with caching explicitly
 * disabled, so all of that bulk is billed as fresh input. This module replaces that with a cascade:
 *
 * 1. **native** — re-send the live context (same system prompt, same tools in the same order, same
 *    messages) with one appended instruction and `toolChoice: "none"`, so the model summarizes instead of
 *    continuing. The provider's cached prefix covers nearly the whole request, and the model reads real
 *    tool calls and results rather than a lossy paraphrase of them.
 * 2. **serialized** — a minimized text transcript under an explicit token ceiling, used when the reason is
 *    `overflow` (the live context is by definition too large to re-send) or when the native attempt comes
 *    back unusable, for example a provider that ignores `tool_choice`.
 * 3. **pi's default** — return `undefined` and let core compact the old way.
 *
 * The third rung is why nothing here may throw: a defect in this module should cost the quality of a
 * summary, never a session that can no longer be compacted.
 */

/**
 * Stored in `CompactionEntry.details`. The file lists keep pi's own key names, because core extracts them
 * from the previous compaction entry to build the cumulative ledger; renaming them would silently break
 * that tracking rather than fail loudly.
 */
interface PiCoderCompactionDetails {
    version: 1;
    strategy: "native" | "serialized";
    provider: string;
    model: string;
    readFiles: string[];
    modifiedFiles: string[];
    summarizedMessages: number;
    droppedBlocks: number;
}

interface StrategyInput {
    pi: ExtensionAPI;
    ctx: ExtensionContext;
    preparation: CompactionPreparation;
    customInstructions?: string;
    config: CompactionConfig;
    maxTokens: number;
    signal: AbortSignal;
}

type StrategyOutcome =
    { ok: true; result: CompactionResult; droppedBlocks: number } | { ok: false; detail: string };

/** pi's own budget for a history summary: most of the reserved window, capped by the model's output limit. */
function summaryBudget(reserveTokens: number, modelMaxTokens: number): number {
    const fromReserve = Math.floor(reserveTokens * 0.8);
    if (!Number.isFinite(modelMaxTokens) || modelMaxTokens <= 0) {
        return fromReserve;
    }
    return Math.min(fromReserve, modelMaxTokens);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
    if (!ctx.hasUI) {
        return;
    }
    ctx.ui.notify(message, level);
}

/** Entries still in context after compaction, for the instruction's "do not restate these" line. */
function retainedEntryCount(ctx: ExtensionContext, firstKeptEntryId: string): number {
    const entries = ctx.sessionManager.getBranch();
    const index = entries.findIndex((entry) => entry.id === firstKeptEntryId);
    if (index < 0) {
        return 0;
    }
    return entries.length - index;
}

function composeResult(
    preparation: CompactionPreparation,
    text: string,
    usage: CompactionResult["usage"],
    details: Omit<PiCoderCompactionDetails, "readFiles" | "modifiedFiles" | "summarizedMessages">,
): CompactionResult {
    const analysis = analyzeSpan(summarizedSpan(preparation));
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const sections = buildSupplementarySections({
        analysis,
        firstKeptEntryId: preparation.firstKeptEntryId,
        droppedBlocks: details.droppedBlocks,
    });
    const summary = `${[text, sections].filter(Boolean).join("\n\n")}${formatFileLists(readFiles, modifiedFiles)}`;
    return {
        summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        usage,
        details: {
            ...details,
            readFiles,
            modifiedFiles,
            summarizedMessages: analysis.messageCount,
        },
    };
}

function detailsFor(
    model: { provider: string; id: string },
    strategy: PiCoderCompactionDetails["strategy"],
    droppedBlocks: number,
): Omit<PiCoderCompactionDetails, "readFiles" | "modifiedFiles" | "summarizedMessages"> {
    return { version: 1, strategy, provider: model.provider, model: model.id, droppedBlocks };
}

async function tryNative(input: StrategyInput): Promise<StrategyOutcome> {
    const { pi, ctx, preparation, maxTokens, signal } = input;
    if (!ctx.model) {
        return { ok: false, detail: "no model selected" };
    }
    const model = ctx.model;
    const context = buildNativeContext({
        systemPrompt: ctx.getSystemPrompt(),
        tools: activeToolDefinitions(pi),
        messages: liveContextMessages(ctx),
        instruction: nativeSummarizationInstruction({
            preparation,
            customInstructions: input.customInstructions,
            retainedMessageCount: retainedEntryCount(ctx, preparation.firstKeptEntryId),
        }),
        timestamp: Date.now(),
    });
    if (!nativeRequestFits(context, model.contextWindow, maxTokens)) {
        return { ok: false, detail: "live context plus instruction does not fit the window" };
    }
    const attempt = await summarizeNatively(
        {
            registry: ctx.modelRegistry,
            model,
            maxTokens,
            signal,
            sessionId: ctx.sessionManager.getSessionId(),
        },
        context,
    );
    if (!attempt.ok) {
        return { ok: false, detail: attempt.detail ?? "unusable summary" };
    }
    return {
        ok: true,
        result: composeResult(
            preparation,
            attempt.text,
            attempt.usage,
            detailsFor(model, "native", 0),
        ),
        droppedBlocks: 0,
    };
}

async function trySerialized(input: StrategyInput): Promise<StrategyOutcome> {
    const { ctx, preparation, config, maxTokens, signal } = input;
    if (!ctx.model) {
        return { ok: false, detail: "no model selected" };
    }
    const model = ctx.model;
    const serialized = serializeConversationMinimal(
        summarizedSpan(preparation),
        serializerOptions(config),
    );
    const attempt = await summarizeSerializedTranscript(
        { registry: ctx.modelRegistry, model, maxTokens, signal },
        {
            conversationText: serialized.text,
            previousSummary: preparation.previousSummary,
            customInstructions: input.customInstructions,
        },
    );
    if (!attempt.ok) {
        return { ok: false, detail: attempt.detail ?? "unusable summary" };
    }
    return {
        ok: true,
        result: composeResult(
            preparation,
            attempt.text,
            attempt.usage,
            detailsFor(model, "serialized", serialized.droppedBlocks),
        ),
        droppedBlocks: serialized.droppedBlocks,
    };
}

async function compactWithPiCoder(
    pi: ExtensionAPI,
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
): Promise<{ cancel: true } | { compaction: CompactionResult } | undefined> {
    const config = loadCompactionConfig(ctx.cwd);
    if (!config.enabled) {
        return undefined;
    }
    if (event.signal.aborted) {
        // The user cancelled this compaction. Say so, rather than letting core run a doomed request
        // against an already-aborted controller.
        return { cancel: true };
    }
    const preparation = event.preparation;
    const maxTokens = summaryBudget(
        preparation.settings.reserveTokens,
        ctx.model?.maxTokens ?? Number.POSITIVE_INFINITY,
    );
    const strategyInput: StrategyInput = {
        pi,
        ctx,
        preparation,
        customInstructions: event.customInstructions,
        config,
        maxTokens,
        signal: event.signal,
    };
    const failures: string[] = [];

    if (event.reason !== "overflow") {
        const native = await tryNative(strategyInput);
        if (native.ok) {
            return { compaction: native.result };
        }
        failures.push(`native: ${native.detail}`);
    }

    const serialized = await trySerialized(strategyInput);
    if (serialized.ok) {
        notify(
            ctx,
            serialized.droppedBlocks > 0
                ? `pi-coder compaction: minimized transcript used, ` +
                      `${String(serialized.droppedBlocks)} older blocks dropped`
                : "pi-coder compaction: minimized transcript used",
        );
        return { compaction: serialized.result };
    }
    failures.push(`serialized: ${serialized.detail}`);

    notify(ctx, `pi-coder compaction fell back to pi's default: ${failures.join("; ")}`, "warning");
    return undefined;
}

/** Registered for the parent session and for every delegated child. */
export function registerCompactionExtension(pi: ExtensionAPI): void {
    pi.on("session_before_compact", async (event, ctx) => {
        try {
            return await compactWithPiCoder(pi, event, ctx);
        } catch (error) {
            // Never let a defect here abort the compaction pi is already committed to running.
            const message = error instanceof Error ? error.message : String(error);
            notify(ctx, `pi-coder compaction failed; using pi's default: ${message}`, "warning");
            return undefined;
        }
    });
}
