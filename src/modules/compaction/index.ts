import type { Api, Model } from "@earendil-works/pi-ai";
import type {
    CompactionResult,
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import { estimateTextTokens } from "./text";
import { type CompactionConfig, loadCompactionConfig } from "./config";
import {
    activeToolDefinitions,
    buildNativeContext,
    estimateRequestTokens,
    liveContextMessages,
    nativeRequestFits,
} from "./native-request";
import { nativeSummarizationInstruction, serializedSummarizationRequest } from "./prompt";
import { serializeConversationMinimal, serializerOptions } from "./serialize";
import {
    analyzeSpan,
    buildSupplementarySections,
    computeFileLists,
    formatFileLists,
} from "./sections";
import {
    summarizeNatively,
    summarizeSerializedTranscript,
    type SummarizationAttemptResult,
    type SummarizationStrategy,
} from "./summarize";
import {
    type CompactionAttemptFields,
    compactionTraceTarget,
    createCompactionTraceRecorder,
    type CompactionTraceRecorder,
} from "./trace";
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
    trace: CompactionTraceRecorder;
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

/** One strategy attempt: run it, then record what went out, what came back, and what was persisted. */
const DOES_NOT_FIT = "live context plus instruction does not fit the window";

/** The request-side numbers every attempt record carries, whatever strategy ran. */
function attemptFields(
    model: Model<Api>,
    maxTokens: number,
    extra: Partial<CompactionAttemptFields>,
): CompactionAttemptFields {
    return {
        provider: model.provider,
        model: model.id,
        maxTokens,
        contextWindow: model.contextWindow,
        ...extra,
    };
}

/** Run one strategy, then record what it sent, what came back, and what was persisted. */
async function runAttempt(
    input: StrategyInput,
    model: Model<Api>,
    strategy: SummarizationStrategy,
    fields: CompactionAttemptFields,
    call: () => Promise<SummarizationAttemptResult>,
    droppedBlocks: number,
): Promise<StrategyOutcome> {
    const { preparation, trace } = input;
    const attempt = await call();
    if (!attempt.ok) {
        const detail = attempt.detail ?? "unusable summary";
        trace.attempt(strategy, fields, { outcome: "rejected", detail, usage: attempt.usage });
        return { ok: false, detail };
    }

    trace.attempt(strategy, fields, { outcome: "accepted", usage: attempt.usage });
    trace.modelResponse(strategy, attempt.text, attempt.usage);

    const result = composeResult(
        preparation,
        attempt.text,
        attempt.usage,
        detailsFor(model, strategy, droppedBlocks),
    );
    const details = result.details as PiCoderCompactionDetails;
    trace.final(strategy, result.summary, {
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        summarizedMessages: details.summarizedMessages,
        droppedBlocks: details.droppedBlocks,
        readFiles: details.readFiles.length,
        modifiedFiles: details.modifiedFiles.length,
    });
    return { ok: true, result, droppedBlocks };
}

async function tryNative(input: StrategyInput): Promise<StrategyOutcome> {
    const { pi, ctx, preparation, maxTokens, signal, trace } = input;
    if (!ctx.model) {
        return { ok: false, detail: "no model selected" };
    }
    const model = ctx.model;
    const messages = liveContextMessages(ctx);
    const tools = activeToolDefinitions(pi);
    const context = buildNativeContext({
        systemPrompt: ctx.getSystemPrompt(),
        tools,
        messages,
        instruction: nativeSummarizationInstruction({
            preparation,
            customInstructions: input.customInstructions,
            retainedMessageCount: retainedEntryCount(ctx, preparation.firstKeptEntryId),
        }),
        timestamp: Date.now(),
    });
    const fields = attemptFields(model, maxTokens, {
        estimatedTokens: estimateRequestTokens(context),
        toolCount: tools.length,
        messageCount: messages.length,
        customInstructions: input.customInstructions,
        previousSummaryChars: preparation.previousSummary?.length ?? 0,
    });
    if (!nativeRequestFits(context, model.contextWindow, maxTokens)) {
        trace.attempt("native", fields, { outcome: "skipped", detail: DOES_NOT_FIT });
        return { ok: false, detail: DOES_NOT_FIT };
    }
    return runAttempt(
        input,
        model,
        "native",
        fields,
        () =>
            summarizeNatively(
                {
                    registry: ctx.modelRegistry,
                    model,
                    maxTokens,
                    signal,
                    sessionId: ctx.sessionManager.getSessionId(),
                },
                context,
            ),
        0,
    );
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
    const requestText = serializedSummarizationRequest({
        conversationText: serialized.text,
        previousSummary: preparation.previousSummary,
        customInstructions: input.customInstructions,
    });
    const fields = attemptFields(model, maxTokens, {
        estimatedTokens: estimateTextTokens(requestText),
        // The transcript still names the tools it describes, so report the real active set.
        toolCount: activeToolDefinitions(input.pi).length,
        messageCount: 1,
        serializedChars: serialized.text.length,
        droppedBlocks: serialized.droppedBlocks,
        customInstructions: input.customInstructions,
        previousSummaryChars: preparation.previousSummary?.length ?? 0,
    });
    return runAttempt(
        input,
        model,
        "serialized",
        fields,
        () =>
            summarizeSerializedTranscript(
                { registry: ctx.modelRegistry, model, maxTokens, signal },
                { conversationText: serialized.text, requestText },
            ),
        serialized.droppedBlocks,
    );
}

async function compactWithPiCoder(
    pi: ExtensionAPI,
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
): Promise<{ cancel: true } | { compaction: CompactionResult } | undefined> {
    const config = loadCompactionConfig(ctx.cwd);
    const trace = createCompactionTraceRecorder(
        {
            cwd: ctx.cwd,
            session: ctx.sessionManager.getSessionId(),
            reason: event.reason,
            willRetry: event.willRetry,
        },
        compactionTraceTarget(config),
    );
    if (!config.enabled) {
        trace.outcome("disabled");
        return undefined;
    }
    if (event.signal.aborted) {
        // The user cancelled this compaction. Say so, rather than letting core run a doomed request
        // against an already-aborted controller.
        trace.outcome("cancelled");
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
        trace,
    };
    const failures: string[] = [];

    if (event.reason !== "overflow") {
        const native = await tryNative(strategyInput);
        if (native.ok) {
            trace.outcome("native");
            return { compaction: native.result };
        }
        failures.push(`native: ${native.detail}`);
    }

    const serialized = await trySerialized(strategyInput);
    if (serialized.ok) {
        trace.outcome("serialized");
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

    trace.outcome("core-default", failures.join("; "));
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
