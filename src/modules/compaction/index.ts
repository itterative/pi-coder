import type { Api, Message, Model, Usage } from "@earendil-works/pi-ai";
import type {
    CompactionResult,
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

import { isAgentTraceEnabled } from "../../common/trace";
import { type CompactionConfig, loadCompactionConfig } from "./config";
import {
    activeToolDefinitions,
    buildNativeContext,
    estimateRequestTokens,
    nativeRequestFits,
} from "./native-request";
import { diffRequestPrefixes, fingerprintPayload, fingerprintSummary } from "./prefix-diff";
import { segmentSummaryInstruction, serializedSummarizationRequest } from "./prompt";
import {
    serializeConversationMinimal,
    serializerOptions,
    type SerializedConversation,
} from "./serialize";
import {
    analyzeSpan,
    buildSupplementarySections,
    computeFileLists,
    formatFileLists,
} from "./sections";
import { buildSpanSession, skippedEntryCount, spanContextEntries } from "./span-session";
import { summarizeNatively, summarizeSerializedTranscript } from "./summarize";
import {
    type CompactionAttemptFields,
    compactionTraceTarget,
    createCompactionTraceRecorder,
    type CompactionTraceOutcome,
    type CompactionTraceRecorder,
} from "./trace";
import { summarizedSpan, type CompactionPreparation } from "./types";
import { estimateTextTokens } from "./text";

/**
 * Compaction in two stages: read the conversation, then compress what was read.
 *
 * pi's default path serializes the summarized span to text — thinking blocks untruncated, tool results at a
 * fixed 2000 characters, no overall budget — and sends it as a one-off request with caching explicitly
 * disabled, so all of that bulk is billed as fresh input. Here:
 *
 * 1. **segment (native)** — the span the session is about to lose, as real message objects, resolved by pi
 *    from an in-memory transcript truncated at the cut point. The model reads its own tool calls and results
 *    instead of a paraphrase of them, and because the system prompt and tool array are the parent's, the
 *    request stays a strict prefix of what the provider already cached. Tools are forbidden by
 *    `tool_choice: "none"` rather than removed, since removing them would move the prefix.
 * 2. **reduce (serialized)** — one bounded, text-only call over the minimized transcript plus stage 1's
 *    checkpoint plus the previous one, producing the summary that gets persisted.
 * 3. **pi's default** — return `undefined` and let core compact the old way.
 *
 * `overflow` skips stage 1: the span by definition no longer fits. If stage 1 fails alone, stage 2 still
 * runs with no segment checkpoint; if stage 2 fails but stage 1 succeeded, stage 1's own text is persisted.
 * The third rung is why nothing here may throw: a defect in this module should cost the quality of a
 * summary, never a session that can no longer be compacted.
 */

/** Which stages produced the persisted summary. */
export type CompactionRoute = "two-stage" | "native" | "serialized";

/**
 * Stored in `CompactionEntry.details`. The file lists keep pi's own key names, because core extracts them
 * from the previous compaction entry to build the cumulative ledger; renaming them would silently break
 * that tracking rather than fail loudly.
 */
interface PiCoderCompactionDetails {
    version: 1;
    route: CompactionRoute;
    provider: string;
    model: string;
    readFiles: string[];
    modifiedFiles: string[];
    summarizedMessages: number;
    droppedBlocks: number;
}

interface StageContext {
    pi: ExtensionAPI;
    ctx: ExtensionContext;
    preparation: CompactionPreparation;
    customInstructions?: string;
    config: CompactionConfig;
    maxTokens: number;
    signal: AbortSignal;
    trace: CompactionTraceRecorder;
}

type StageResult = { ok: true; text: string; usage?: Usage } | { ok: false; detail: string };

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

/**
 * The parent's most recent real request body, per session.
 *
 * Only ever populated while tracing is on, and it holds one reference rather than a copy: the payload is
 * what pi built for its own request, so retaining it until the next compaction is the cheapest way to ask
 * "did my rebuilt request share that cached prefix?".
 */
const lastParentPayload = new WeakMap<object, unknown>();

function prefixDiffAgainstParent(sessionManager: object, ourPayload: unknown) {
    const ours = fingerprintPayload(ourPayload);
    const parentPayload = lastParentPayload.get(sessionManager);
    if (parentPayload === undefined) {
        return {
            prefixUsable: false,
            firstDivergence: "no-parent-payload-captured",
            divergences: ["no-parent-payload-captured"],
            parameters: [],
            parentMessageCount: 0,
            ourMessageCount: ours.messageHashes.length,
            commonPrefixMessages: 0,
            ourRequest: fingerprintSummary(ours),
        };
    }
    const parent = fingerprintPayload(parentPayload);
    return {
        ...diffRequestPrefixes(parent, ours),
        parentRequest: fingerprintSummary(parent),
        ourRequest: fingerprintSummary(ours),
    };
}

/** The request-side numbers every attempt record carries, whatever stage ran. */
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

/** Entries the span covers, resolved by pi rather than by slicing converted messages by hand. */
function spanMessages(input: StageContext): {
    messages: Message[];
    fields: Partial<CompactionAttemptFields>;
} {
    const { ctx, preparation } = input;
    const truncated = spanContextEntries(
        ctx.sessionManager.buildContextEntries(),
        preparation.firstKeptEntryId,
    );
    const span = buildSpanSession(truncated, ctx.cwd);
    const messages = convertToLlm(span.sessionManager.buildSessionContext().messages);
    return {
        messages,
        fields: {
            copiedEntries: span.copiedEntries,
            skippedEntries: skippedEntryCount(span.skippedEntries),
        },
    };
}

/** Stage 1: the model reads the span it is about to lose, as real messages, with tools forbidden. */
async function runSegmentStage(input: StageContext, model: Model<Api>): Promise<StageResult> {
    const { pi, ctx, preparation, maxTokens, signal, trace } = input;
    const span = spanMessages(input);
    const tools = activeToolDefinitions(pi);
    const context = buildNativeContext({
        systemPrompt: ctx.getSystemPrompt(),
        tools,
        messages: span.messages,
        instruction: segmentSummaryInstruction({
            preparation,
            customInstructions: input.customInstructions,
        }),
        timestamp: Date.now(),
    });
    const fields = attemptFields(model, maxTokens, {
        estimatedTokens: estimateRequestTokens(context),
        toolCount: tools.length,
        messageCount: span.messages.length,
        copiedEntries: span.fields.copiedEntries,
        skippedEntries: span.fields.skippedEntries,
        customInstructions: input.customInstructions,
        previousSummaryChars: preparation.previousSummary?.length ?? 0,
    });

    if (!nativeRequestFits(context, model.contextWindow, maxTokens)) {
        const detail = "segment context plus instruction does not fit the window";
        trace.attempt("native", fields, { outcome: "skipped", detail });
        return { ok: false, detail };
    }

    const attempt = await summarizeNatively(
        {
            registry: ctx.modelRegistry,
            model,
            maxTokens,
            signal,
            sessionId: ctx.sessionManager.getSessionId(),
            onPayload: trace.enabled
                ? (payload) => {
                      trace.prefix(prefixDiffAgainstParent(ctx.sessionManager, payload));
                  }
                : undefined,
        },
        context,
    );

    if (!attempt.ok) {
        const detail = attempt.detail ?? "unusable segment checkpoint";
        trace.attempt("native", fields, { outcome: "rejected", detail, usage: attempt.usage });
        return { ok: false, detail };
    }

    trace.attempt("native", fields, { outcome: "accepted", usage: attempt.usage });
    trace.modelResponse("native", attempt.text, attempt.usage);
    return { ok: true, text: attempt.text, usage: attempt.usage };
}

/** Stage 2: one bounded text-only call that reconciles the transcript with stage 1's checkpoint. */
async function runReduceStage(
    input: StageContext,
    model: Model<Api>,
    transcript: SerializedConversation,
    segment: StageResult | undefined,
): Promise<StageResult> {
    const { ctx, preparation, maxTokens, signal, trace } = input;
    const segmentText = segment?.ok ? segment.text : undefined;
    const requestText = serializedSummarizationRequest({
        conversationText: transcript.text,
        segmentSummary: segmentText,
        previousSummary: preparation.previousSummary,
        customInstructions: input.customInstructions,
    });
    const fields = attemptFields(model, maxTokens, {
        estimatedTokens: estimateTextTokens(requestText),
        // Stage 2 sends no tools at all: nothing to call, no prefix to protect.
        toolCount: 0,
        messageCount: 1,
        serializedChars: transcript.text.length,
        droppedBlocks: transcript.droppedBlocks,
        segmentSummaryChars: segmentText?.length ?? 0,
        customInstructions: input.customInstructions,
        previousSummaryChars: preparation.previousSummary?.length ?? 0,
    });

    const attempt = await summarizeSerializedTranscript(
        { registry: ctx.modelRegistry, model, maxTokens, signal },
        { conversationText: transcript.text, requestText },
    );

    if (!attempt.ok) {
        const detail = attempt.detail ?? "unusable checkpoint";
        trace.attempt("serialized", fields, { outcome: "rejected", detail, usage: attempt.usage });
        return { ok: false, detail };
    }
    trace.attempt("serialized", fields, { outcome: "accepted", usage: attempt.usage });
    trace.modelResponse("serialized", attempt.text, attempt.usage);
    return {
        ok: true,
        text: attempt.text,
        usage: attempt.usage ?? (segment?.ok ? segment.usage : undefined),
    };
}

function composeResult(
    preparation: CompactionPreparation,
    text: string,
    usage: Usage | undefined,
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

function routeFor(
    segment: StageResult | undefined,
    reduced: StageResult | undefined,
): CompactionRoute {
    const segmentOk = segment?.ok === true;
    if (reduced?.ok) {
        return segmentOk ? "two-stage" : "serialized";
    }
    return segmentOk ? "native" : "serialized";
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
    const model = ctx.model;
    if (!model) {
        trace.outcome("core-default", "no model selected");
        return undefined;
    }

    const preparation = event.preparation;
    const maxTokens = summaryBudget(preparation.settings.reserveTokens, model.maxTokens);
    const span = summarizedSpan(preparation);
    const transcript = serializeConversationMinimal(span, serializerOptions(config));
    const stage: StageContext = {
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
    const segment =
        event.reason === "overflow"
            ? undefined
            : await runSegmentStage(stage, model).then((result) => {
                  if (!result.ok) {
                      failures.push(`segment: ${result.detail}`);
                  }
                  return result;
              });
    if (event.reason === "overflow") {
        failures.push("segment: skipped (context overflow)");
    }

    const reduced = await runReduceStage(stage, model, transcript, segment).then((result) => {
        if (!result.ok) {
            failures.push(`reduce: ${result.detail}`);
        }
        return result;
    });

    const route = routeFor(segment, reduced);
    const produced = reduced?.ok ? reduced : segment?.ok ? segment : undefined;

    if (!produced) {
        trace.outcome("core-default", failures.join("; "));
        notify(
            ctx,
            `pi-coder compaction fell back to pi's default: ${failures.join("; ")}`,
            "warning",
        );
        return undefined;
    }

    const result = composeResult(preparation, produced.text, produced.usage, {
        version: 1,
        route,
        provider: model.provider,
        model: model.id,
        droppedBlocks: transcript.droppedBlocks,
    });
    const details = result.details as PiCoderCompactionDetails;
    trace.final(reduced?.ok ? "serialized" : "native", result.summary, {
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        summarizedMessages: details.summarizedMessages,
        droppedBlocks: details.droppedBlocks,
        readFiles: details.readFiles.length,
        modifiedFiles: details.modifiedFiles.length,
    });
    trace.outcome(outcomeFor(route));
    if (route === "native" && reduced && !reduced.ok) {
        notify(
            ctx,
            "pi-coder compaction: reduce stage failed, persisted the segment checkpoint",
            "warning",
        );
    }
    if (route === "serialized" && transcript.droppedBlocks > 0) {
        notify(
            ctx,
            `pi-coder compaction: minimized transcript used, ${String(transcript.droppedBlocks)} older blocks dropped`,
        );
    }
    return { compaction: result };
}

function outcomeFor(route: CompactionRoute): CompactionTraceOutcome {
    if (route === "two-stage") {
        return "two-stage";
    }
    return route;
}

/** Registered for the parent session and for every delegated child. */
export function registerCompactionExtension(pi: ExtensionAPI): void {
    if (isAgentTraceEnabled()) {
        // Dev diagnostic: keep the body pi built for its own last request so a later stage-1 request can
        // tell a rebuilt-prefix mismatch from a provider that simply will not serve the cache.
        pi.on("before_provider_request", (event, ctx) => {
            lastParentPayload.set(ctx.sessionManager, event.payload);
        });
    }

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
