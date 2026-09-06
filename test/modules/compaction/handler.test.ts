import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionPreparation } from "../../../src/modules/compaction/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    assistantMessage,
    createCompactionHarness,
    failedResponse,
    messageChain,
    messageEntry,
    sampleKept,
    sampleSpan,
    summaryResponse,
    toolCallResponse,
    userMessage,
} from "../../helpers/compaction-doubles";
import { countedUsage } from "../../helpers/agent-doubles";
import { stubModel } from "../../helpers/pi-stub";

const SYSTEM_PROMPT = "the live system prompt";
const SESSION_ID = "session-1";
const KEPT_TEXT = "and keep this turn in context";

/** Long enough that the fallback's per-result cap bites, so the two stages visibly differ. */
const READ_BODY = "export const registerCompactionExtension = () => {};\n".repeat(40);

type ResponseFactory = () => Promise<ReturnType<typeof summaryResponse>>;

describe("compaction stages", () => {
    let root = "";

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "pi-coder-compaction-"));
        // Pin both config locations, so no suite can read the developer's own ~/.pi/compaction-config.json or a
        // file left in this checkout. The project location exists and zeroes the retry budget: the backoff is
        // real time, and a suite that slept on it would be slow and flaky. The schedule itself is pinned in
        // summarize.test.ts, where the sleep is injected.
        const defaults = path.join(root, "test-defaults.json");
        writeFileSync(defaults, JSON.stringify({ retryMaxRetries: 0 }));
        vi.stubEnv("COMPACTION_CONFIG_PATH", defaults);
        vi.stubEnv("COMPACTION_CONFIG_PATH_GLOBAL", path.join(root, "absent-global.json"));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
    });

    function build(
        input: {
            responses: ResponseFactory[];
            notify?: (message: string, level?: "info" | "warning" | "error") => void;
            hasUI?: boolean;
            contextWindow?: number;
            /** The model's own output ceiling, which is what the summarization cap is bounded by. */
            maxTokens?: number;
            /** Override the parent's system prompt, to charge a large fixed prefix against the cap. */
            systemPrompt?: string;
            branch?: SessionEntry[];
            span?: ReturnType<typeof sampleSpan>;
            kept?: ReturnType<typeof sampleKept>;
            preparation?: Partial<CompactionPreparation>;
            config?: Record<string, unknown>;
            signal?: AbortSignal;
            activeTools?: string[];
            branchThrows?: Error;
            contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
            /** Reasoning-capable model, for the tests about what goes on the wire for thinking. */
            reasoningModel?: boolean;
            /** Sampling parameters configured on the model, for the merge that `complete()` bypasses. */
            samplingParams?: Record<string, unknown>;
        } = { responses: [] },
    ) {
        if (input.config) {
            const configPath = path.join(root, "compaction-config.json");
            writeFileSync(configPath, JSON.stringify({ retryMaxRetries: 0, ...input.config }));
            vi.stubEnv("COMPACTION_CONFIG_PATH", configPath);
        }
        return createCompactionHarness({
            cwd: root,
            responses: input.responses,
            systemPrompt: input.systemPrompt ?? SYSTEM_PROMPT,
            sessionId: SESSION_ID,
            notify: input.notify,
            hasUI: input.hasUI,
            span: input.span ?? sampleSpan(READ_BODY),
            kept: input.kept,
            preparation: input.preparation,
            branch: input.branch,
            signal: input.signal,
            activeTools: input.activeTools,
            branchThrows: input.branchThrows,
            contextUsage: input.contextUsage,
            model: stubModel({
                ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
                ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
                ...(input.reasoningModel ? { reasoning: true } : {}),
                ...(input.samplingParams ? { samplingParams: input.samplingParams } : {}),
            }),
        });
    }

    const segmentSummary = async () =>
        summaryResponse(
            "## Goal\n\nsegment checkpoint from stage one\n\n## Progress\n\n- [x] segment checkpoint from stage one",
        );
    const reducedSummary = async () =>
        summaryResponse(
            "## Goal\n\nreduced final checkpoint\n\n## Progress\n\n- [x] reduced final checkpoint",
        );

    it("stage 1 reads the discarded span and not the retained tail", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(2);
        expect(h.sentText(0)).toContain("fix the compaction module");
        expect(h.sentText(0)).not.toContain(KEPT_TEXT);
        expect(h.trailingInstruction(0)).toContain("retained as-is and are not included here");
        expect(payload?.summary).toContain("reduced final checkpoint");
        expect(payload?.details.route).toBe("two-stage");
    });

    it("stage 1 keeps the parent's system prompt, tools, and session, and adds no tool_choice", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        await h.compact();

        const { context } = h.calls[0];
        expect(context.systemPrompt).toBe(SYSTEM_PROMPT);
        expect(context.tools?.map((tool) => tool.name)).toEqual(["bash", "read"]);
        // Not sent at all: it was the one body key our request carried that pi's does not, and on a server that
        // parses in-band calls by grammar, suppressing the parser is worse than not calling one. The stage 1
        // instruction forbids tool calls in words, and a parsed call in the response rejects this rung.
        expect(h.optionField(0, "toolChoice")).toBeUndefined();
        expect(h.optionField(0, "cacheRetention")).toBeUndefined();
        expect(h.optionField(0, "sessionId")).toBe(SESSION_ID);
        // Both rungs get the same cap: what this request can afford to answer with, from the model's own output
        // ceiling and the room the window has left. Stage 1 used to get a third of a reserve-derived number, which
        // is the cap that truncated a live 94-event checkpoint.
        expect(h.optionField(0, "maxTokens")).toBe(8_192);
        expect(h.trailingInstruction(0)).toContain("Do not call any tool");
        expect(h.trailingInstruction(0)).toContain("## Key Decisions");
    });

    it("stage 1 sends the session thinking level, and stage 2 does not", async () => {
        // The cache entry stage 1 is trying to hit was made by a pi turn request that carried these parameters,
        // and on the compatible branches pi-ai renders `enable_thinking` from this option's truthiness - so a
        // silent omission is a different request, not the same one truncated.
        const h = build({ responses: [segmentSummary, reducedSummary], reasoningModel: true });
        h.piStub.thinkingSurface.level = "high";
        await h.compact();

        expect(h.optionField(0, "reasoningEffort")).toBe("high");
        // Stage 2 has no cached prefix, and thinking tokens would compete with the budget of the one rung that
        // keeps a `length`-truncated answer.
        expect(h.optionField(1, "reasoningEffort")).toBeUndefined();
    });

    it("sends no thinking parameter when the model cannot reason or the level is off", async () => {
        // The guard is pi's own, because the wire shape has to be pi's too: "off" means pi drops the option and
        // renders enable_thinking false, while a literal "off" passed through would do the opposite.
        const off = build({ responses: [segmentSummary, reducedSummary], reasoningModel: true });
        off.piStub.thinkingSurface.level = "off";
        await off.compact();
        expect(off.optionField(0, "reasoningEffort")).toBeUndefined();

        const plain = build({ responses: [segmentSummary, reducedSummary] });
        plain.piStub.thinkingSurface.level = "high";
        await plain.compact();
        expect(plain.optionField(0, "reasoningEffort")).toBeUndefined();
    });

    it("compacts normally on a runtime that provides no thinking level", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary], reasoningModel: true });
        h.piStub.thinkingSurface.unsupported = true;

        const payload = await h.compact();

        expect(h.optionField(0, "reasoningEffort")).toBeUndefined();
        expect(payload?.details.route).toBe("two-stage");
    });

    it("both rungs carry the model's configured sampling parameters", async () => {
        // pi merges these in buildBaseOptions and our complete() path skips that layer, so without the merge a
        // llama.cpp or vLLM config would land in pi's body and not ours: a prefix break on the servers that fold
        // them into the chat template, and ignored decode settings everywhere else.
        const h = build({
            responses: [segmentSummary, reducedSummary],
            samplingParams: { top_p: 0.9, min_p: 0.05 },
        });
        await h.compact();

        expect(h.optionField(0, "samplingParams")).toEqual({ top_p: 0.9, min_p: 0.05 });
        expect(h.optionField(1, "samplingParams")).toEqual({ top_p: 0.9, min_p: 0.05 });

        // Absent rather than empty: a model that configures nothing should not add an option to assign.
        const plain = build({ responses: [segmentSummary, reducedSummary] });
        await plain.compact();
        expect(plain.optionField(0, "samplingParams")).toBeUndefined();
    });

    it("sends the real tool call and its untruncated result to stage 1", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        await h.compact();

        const sent = h.calls[0].context.messages;
        const withCall = sent.find(
            (message) =>
                message.role === "assistant" &&
                message.content.some((block) => block.type === "toolCall"),
        );
        const result = sent.find((message) => message.role === "toolResult");
        expect(withCall).toBeDefined();
        expect(result?.role === "toolResult" && textOf(result.content)).toBe(READ_BODY);
    });

    it("stage 2 receives the minimized transcript plus stage 1's checkpoint", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        await h.compact();

        const { context } = h.calls[1];
        expect(context.systemPrompt).not.toBe(SYSTEM_PROMPT);
        expect(context.tools).toBeUndefined();
        expect(h.optionField(1, "cacheRetention")).toBe("none");
        expect(h.optionField(1, "sessionId")).not.toBe(SESSION_ID);

        const request = h.requestText(1);
        expect(request).toContain("[User]: fix the compaction module");
        expect(request).toContain("more characters truncated]");
        expect(request).not.toContain("reasoning the fallback must not carry");
        expect(request).toContain(
            "<segment-checkpoint>\n## Goal\n\nsegment checkpoint from stage one",
        );
        expect(request).toContain("Prefer the transcript where they disagree");
        expect(request).not.toContain("<previous-summary>");
    });

    it("appends the deterministic sections and keeps pi's file-list keys", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        const payload = await h.compact();

        expect(payload?.summary).toContain("## Verbatim Recent Requests");
        expect(payload?.summary).toContain('- "fix the compaction module"');
        expect(payload?.summary).toContain("## Tool Ledger");
        expect(payload?.summary).toContain("read x1");
        expect(payload?.summary).toContain("## Dropped Context");
        expect(payload?.summary).toContain("context resumes at entry kept-1");
        expect(payload?.summary).toContain("<read-files>\nsrc/index.ts\n</read-files>");
        expect(payload?.summary).toContain(
            "<modified-files>\nsrc/modules/compaction/index.ts\n</modified-files>",
        );
        expect(payload?.firstKeptEntryId).toBe("kept-1");
        expect(payload?.tokensBefore).toBe(190_000);
        expect(payload?.usage).toBeDefined();

        expect(payload?.details).toMatchObject({
            route: "two-stage",
            version: 1,
            model: "stub-model",
            provider: "anthropic",
            readFiles: ["src/index.ts"],
            modifiedFiles: ["src/modules/compaction/index.ts"],
            summarizedMessages: 4,
        });
    });

    it("attempts stage 1 on an overflow compaction, with the span it can actually send", async () => {
        // The old contract here was "overflow skips stage 1 entirely", on the reasoning that the live context
        // provably does not fit. That is true of the live context and false of a shorter prefix of it - which is
        // what the cut walk looks for - so the run is now made and only the fit gate can refuse it.
        const h = build({ responses: [segmentSummary, reducedSummary] });
        const payload = await h.compact({ reason: "overflow", willRetry: true });

        expect(h.calls).toHaveLength(2);
        expect(h.calls[0].context.tools).toHaveLength(2);
        expect(h.requestText(1)).toContain("<segment-checkpoint>");
        expect(payload?.details.route).toBe("two-stage");
    });

    it("falls to the reduce on overflow when no earlier boundary fits either", async () => {
        // The other half of that change: attempting stage 1 must not mean sending an oversized request. A window
        // this small leaves no room for a reply at all once the request is in it, so the fit gate stops it and the
        // rung degrades exactly as it used to.
        const h = build({ responses: [reducedSummary], contextWindow: 1_600 });
        const payload = await h.compact({ reason: "overflow", willRetry: true });

        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].context.tools).toBeUndefined();
        expect(h.requestText(0)).not.toContain("<segment-checkpoint>");
        expect(payload?.details.route).toBe("serialized");
    });

    it("passes a big model's own output ceiling through to the request", async () => {
        // The defect this whole change answers: `qwen3.8-flash` reports 65,536 in ~/.pi/agent/models-store.json
        // against a million-token window, and the request went out capped at 4,369 because the number came from
        // pi's reserveTokens instead. A clamp anywhere on the reserve-derived figure is invisible at the stub's
        // 8,192 default, so the ceiling has to be tested where it is above every other candidate limit.
        const h = build({ responses: [segmentSummary, reducedSummary], maxTokens: 65_536 });
        await h.compact();

        expect(h.optionField(0, "maxTokens")).toBe(65_536);
        expect(h.optionField(1, "maxTokens")).toBe(65_536);
    });

    it("skips stage 1 on a window that cannot afford a request plus any legal reply", async () => {
        // The floor that keeps a request legal (1,024 output tokens) is what makes this window refuse rather than
        // send: the ~1.3k request fits in 2,000 on its own, but a request plus the smallest answerable reply does
        // not. Without the floor the ask goes out at zero tokens, which is a provider error rather than a skip.
        const h = build({ responses: [reducedSummary], contextWindow: 2_000 });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(1);
        expect(payload?.details.route).toBe("serialized");
    });

    it("does not send a zero-token ask when the count and the estimate disagree about the window", async () => {
        // The case the floor is for, and the direction the disagreement has to go: a span that estimates at ~300k
        // tokens by chars/4 leaves a 6,000-token window no budget at all, while the provider's own count of that
        // same body (5,000) looks like it fits. Both numbers are in play at once - the estimate sizes the budget,
        // the count decides the gate - and dropping the floor would ask for zero output tokens, which the
        // provider answers with an error instead of a skip. It genuinely does not fit either way: 5,000 + 1,024
        // is over the window.
        const h = build({
            responses: [reducedSummary],
            span: [userMessage("q".repeat(1_200_000))],
            contextUsage: { tokens: 5_000, contextWindow: 6_000, percent: 83 },
            contextWindow: 6_000,
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(1);
        expect(payload?.details.route).toBe("serialized");
    });

    it("charges the system prompt and tool schemas against the cap instead of refusing the run", async () => {
        // The units bug the multiplier masked: subtracting only the span leaves the system prompt and tool schemas
        // unbudgeted, so the model's whole ceiling gets demanded and a run that fits looks unfittable.
        const h = build({
            responses: [segmentSummary, reducedSummary],
            contextWindow: 80_000,
            maxTokens: 65_536,
            systemPrompt: "s".repeat(240_000),
        });
        await h.compact();

        expect(h.calls).toHaveLength(2);
        const cap = h.optionField(0, "maxTokens") as number;
        expect(cap).toBeLessThan(65_536);
    });

    it("gives both stages the same output cap, so no cap can truncate a checkpoint", async () => {
        // The rule this replaces was "a third of the final budget", where the final budget was itself derived from
        // pi's reserveTokens: 4,369 tokens on a route whose model reports 65,536. A cap can only ever bind, and the
        // recorded replies (2,821t for 9 events, 2,313t for the reduce) stopped well short of any of these numbers.
        // What the fraction protected - a generous intermediate becomes a competing summary - is now carried by the
        // instruction below and the report's checkpoint/summary ratio rather than by rationing the fatal direction.
        const h = build({ responses: [segmentSummary, reducedSummary] });
        await h.compact();

        expect(h.optionField(0, "maxTokens")).toBe(8_192);
        expect(h.optionField(1, "maxTokens")).toBe(8_192);
        expect(h.trailingInstruction(0)).toContain("This is an intermediate pass");
        expect(h.requestText(1)).toContain("must be no longer than the checkpoint you were given");
    });

    it("lets stage 1 merge the previous checkpoint, so the reduce is not handed it twice", async () => {
        const h = build({
            responses: [segmentSummary, reducedSummary],
            preparation: { previousSummary: "## Goal\n\nthe earlier checkpoint" },
        });
        await h.compact();

        expect(h.trailingInstruction(0)).toContain(
            "An earlier compaction summary is part of this conversation",
        );
        expect(h.requestText(1)).not.toContain("<previous-summary>");
        expect(h.requestText(1)).toContain("<segment-checkpoint>");
    });

    it("hands the previous checkpoint to the reduce when stage 1 did not run", async () => {
        // Stage 1 is skipped here by the fit gate rather than by the compaction reason: since overflow started
        // attempting the native rung, "the reason was overflow" no longer implies "there is no checkpoint".
        const h = build({
            responses: [reducedSummary],
            contextWindow: 1_600,
            preparation: { previousSummary: "## Goal\n\nthe earlier checkpoint" },
        });
        await h.compact({ reason: "threshold" });

        expect(h.calls).toHaveLength(1);
        const request = h.requestText(0);
        expect(request).toContain(
            "<previous-summary>\n## Goal\n\nthe earlier checkpoint\n</previous-summary>",
        );
        expect(request).toContain("Merge everything into it");
        expect(request).not.toContain("<segment-checkpoint>");
    });

    it("gates the fit on the provider's own token count, not the chars/4 estimate", async () => {
        // A 1.2M-character span estimates at ~300k tokens, which would skip stage 1 on a 200k window. The
        // provider reports 40k, which is the truth the gate should use.
        const huge = messageChain([
            { id: "big-1", message: userMessage("q".repeat(1_200_000)) },
            { id: "kept-1", message: userMessage(KEPT_TEXT) },
        ]);
        const trusting = build({
            responses: [segmentSummary, reducedSummary],
            branch: huge,
            contextUsage: { tokens: 40_000, contextWindow: 200_000, percent: 20 },
        });
        await trusting.compact();
        expect(trusting.calls).toHaveLength(2);

        const overflowing = build({
            responses: [reducedSummary],
            branch: huge,
            contextUsage: { tokens: 199_000, contextWindow: 200_000, percent: 100 },
        });
        const payload = await overflowing.compact();
        expect(overflowing.calls).toHaveLength(1);
        expect(payload?.details.route).toBe("serialized");
    });

    it("sends stage 1 when the span fits, even though the live context does not", async () => {
        // The retained tail is the whole difference: `getContextUsage()` counts it and stage 1 drops it, so a
        // gate that trusts only the live count can skip a request that would have fitted. Anchoring on the
        // provider's count of a request *inside* the span is what tells the two situations apart.
        const contextUsage = { tokens: 199_000, contextWindow: 200_000, percent: 100 };
        const tail = userMessage("tail".repeat(300_000));
        const countedSpan = messageChain([
            { id: "u1", message: userMessage("the ask") },
            {
                id: "a1",
                message: assistantMessage({
                    text: "answered while the provider counted it",
                    usage: countedUsage(6_000, 400, 14_000),
                }),
            },
            { id: "kept-1", message: tail },
        ]);
        const uncountedSpan = messageChain([
            { id: "u1", message: userMessage("the ask") },
            // Zero usage is no anchor at all, which is what a record before this sizing looked like.
            {
                id: "a1",
                message: assistantMessage({ text: "answered while the provider counted it" }),
            },
            { id: "kept-1", message: tail },
        ]);

        const anchored = build({
            responses: [segmentSummary, reducedSummary],
            branch: countedSpan,
            contextUsage,
        });
        await anchored.compact();

        expect(anchored.calls).toHaveLength(2);
        // Stage 1 is the rung that attaches tools, so this is what identifies the first call as the native one.
        expect(anchored.calls[0]?.context.tools).toHaveLength(2);

        const withoutAnchor = build({
            responses: [reducedSummary],
            branch: uncountedSpan,
            contextUsage,
        });
        const payload = await withoutAnchor.compact();

        expect(withoutAnchor.calls).toHaveLength(1);
        expect(payload?.details.route).toBe("serialized");
    });

    it("reduces without a segment checkpoint when stage 1 answers with a tool call", async () => {
        const h = build({
            responses: [async () => toolCallResponse("read"), reducedSummary],
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(2);
        // Stage 1 is the rung that sends tools, so this is what identifies the rejected call as the native one.
        expect(h.calls[0].context.tools).toHaveLength(2);
        expect(h.requestText(1)).not.toContain("<segment-checkpoint>");
        expect(payload?.summary).toContain("reduced final checkpoint");
        expect(payload?.details.route).toBe("serialized");
    });

    it("persists stage 1's own checkpoint when the reduce fails", async () => {
        const notices: string[] = [];
        const h = build({
            hasUI: true,
            notify: (message) => notices.push(String(message)),
            responses: [segmentSummary, async () => summaryResponse("   ")],
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(2);
        expect(payload?.summary).toContain("segment checkpoint from stage one");
        expect(payload?.details.route).toBe("native");
        expect(notices[0]).toContain("reduce stage failed");
    });

    it("skips stage 1 when the span plus instruction will not fit", async () => {
        // Margin, not a coincidence: the request is ~1.3k tokens (the checkpoint instruction is most of it) and
        // the smallest reply this module will ask for is the 1,024-token request floor, so the window has to leave
        // less than ~2.3k for the gate to bite. `budget.test.ts` pins the arithmetic behind the floor.
        const h = build({
            responses: [reducedSummary],
            contextWindow: 1_100,
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].context.tools).toBeUndefined();
        expect(payload?.details.route).toBe("serialized");
    });

    it("persists the boundary it chose, not the one it was handed", async () => {
        // The whole point of the repair, and the only place it can be checked: core rebuilds the retained
        // context from the id in this result, so a span shortened for the window and a tail still starting where
        // core said would split the session's history in two places at once.
        const branch = messageChain([
            { id: "s0", message: userMessage("open the module") },
            {
                id: "s1",
                message: assistantMessage({
                    text: "a counted reply",
                    usage: countedUsage(4_000, 200),
                }),
            },
            { id: "s2", message: userMessage("next task") },
            {
                id: "kept-1",
                message: assistantMessage({
                    text: "the reply core cut at",
                    usage: countedUsage(199_000, 100),
                }),
            },
        ]);
        const h = build({
            responses: [segmentSummary, reducedSummary],
            branch,
            span: [userMessage("open the module"), assistantMessage({ text: "a counted reply" })],
            contextUsage: { tokens: 210_000, contextWindow: 200_000, percent: null },
        });
        const payload = await h.compact();

        // Core's boundary sits on a reply whose own request measured 199k, which cannot leave a 200k window with
        // stage 1's answer attached. The earlier whole-turn boundary is countable from `s1`'s 4,200 and fits, so
        // that is where the span ends - and it is what core is told to keep from.
        expect(payload?.firstKeptEntryId).toBe("s2");
        expect(h.calls).toHaveLength(2);
        // Two span rows plus the instruction: the shorter span actually went out, not just a shorter claim.
        expect(h.calls[0].context.messages).toHaveLength(3);
        // Passed through untouched, and correct to be: core's number sizes the whole live context, which a
        // different boundary does not change. Re-deriving it from the new span would understate the session.
        expect(payload?.tokensBefore).toBe(190_000);
    });

    it("governs the gate with the kept reply's own count, when the transcript's shape disagrees", async () => {
        // The provider counted 199k tokens for the request whose body was this span, so this span *is* 199k,
        // however few characters the stored rows hold. Charged by shape the same request is ~1.3k and would be
        // sent straight into a context that cannot take it.
        const counted = [
            assistantMessage({ text: KEPT_TEXT, usage: countedUsage(199_000, 100) }),
            assistantMessage({ text: "acknowledged" }),
        ];
        const tooBig = build({ responses: [reducedSummary], kept: counted });
        const payload = await tooBig.compact();

        expect(tooBig.calls).toHaveLength(1);
        expect(tooBig.calls[0].context.tools).toBeUndefined();
        expect(payload?.details.route).toBe("serialized");

        // The same fixture 9k smaller fits the same window with room to spare, so the line above was the count
        // deciding and not a floor that rejects every request this strategy could ever make.
        const fits = [
            assistantMessage({ text: KEPT_TEXT, usage: countedUsage(190_000, 100) }),
            assistantMessage({ text: "acknowledged" }),
        ];
        const ok = build({ responses: [segmentSummary, reducedSummary], kept: fits });
        const twoStage = await ok.compact();

        expect(ok.calls).toHaveLength(2);
        expect(ok.calls[0].context.tools).toHaveLength(2);
        expect(twoStage?.details.route).toBe("two-stage");
    });

    it("refuses the kept reply's count when stage 1 could not copy everything before it", async () => {
        // The count at the cut point is only the span's size if our span *is* that reply's body. A row pi
        // exposes but this module cannot append (branch_summary has no public append in pi 0.84) narrows the
        // span, and a narrowed span is not the body that number measured - it is smaller, so believing the
        // count would over-size the request for no reason the trace could explain afterwards.
        const ask = userMessage("fix the compaction module");
        const readCall = assistantMessage({ text: "on it", calls: [{ id: "c1", name: "read" }] });
        const keptReply = assistantMessage({ text: KEPT_TEXT, usage: countedUsage(199_000, 100) });
        const branch: SessionEntry[] = [
            messageEntry("span-0", ask, null),
            messageEntry("span-1", readCall, "span-0"),
            {
                type: "branch_summary",
                id: "bs-1",
                parentId: "span-1",
                timestamp: "1970-01-01T00:00:00.000Z",
                fromId: "span-1",
                summary: "a branch stage 1 has no way to represent",
            },
            messageEntry("kept-1", keptReply, "bs-1"),
            messageEntry("kept-2", assistantMessage({ text: "acknowledged" }), "kept-1"),
        ];
        const h = build({
            responses: [segmentSummary, reducedSummary],
            branch,
            span: [ask, readCall],
        });
        const payload = await h.compact();

        // Same 199k count the previous test had the gate obey, and here it is ignored: `skippedEnt=1` is what
        // separates the two.
        expect(h.calls).toHaveLength(2);
        expect(h.calls[0].context.tools).toHaveLength(2);
        expect(payload?.details.route).toBe("two-stage");
    });

    it("sizes from the anchor when the kept entry cannot vouch for the span", async () => {
        // pi's own first kept entry is a user turn here, so no provider request had exactly this body: the
        // anchored tier has to guess the part after its own anchor, which is the pre-existing behavior and is
        // worth pinning against a change that quietly starts trusting the wrong row.
        const h = build({ responses: [segmentSummary, reducedSummary] });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(2);
        expect(payload?.details.route).toBe("two-stage");
    });

    it("still runs stage 1 when only the retained tail is too large to resend", async () => {
        // A 1.2M-character retained tail estimates at ~300k tokens, so a stage that re-sent the whole live
        // context would skip itself here. Truncating at the cut point is what keeps it runnable.
        const hugeKept = userMessage("k".repeat(1_200_000));
        const branch = messageChain([
            { id: "span-0", message: userMessage("fix the compaction module") },
            { id: "kept-1", message: hugeKept },
        ]);
        const h = build({
            responses: [segmentSummary, reducedSummary],
            branch,
            span: [userMessage("fix the compaction module")],
            kept: [hugeKept],
        });
        const payload = await h.compact();

        expect(h.calls).toHaveLength(2);
        expect(h.sentText(0)).not.toContain("kkkk");
        expect(payload?.details.route).toBe("two-stage");
    });

    it("reports to pi's default compaction when both stages fail", async () => {
        const notices: Array<{ message: string; level: string | undefined }> = [];
        const h = build({
            hasUI: true,
            notify: (message, level) => notices.push({ message, level }),
            responses: [
                async () => {
                    throw new Error("stage one unavailable");
                },
                async () => summaryResponse("   "),
            ],
        });

        expect(await h.compact()).toBeUndefined();
        expect(h.calls).toHaveLength(2);
        expect(notices[0]?.message).toContain("fell back to pi's default");
        expect(notices[0]?.message).toContain("segment: stage one unavailable");
        expect(notices[0]?.message).toContain("reduce: summarization returned an empty summary");
        expect(notices[0]?.level).toBe("warning");
    });

    it("never lets a defect escape the handler", async () => {
        const notices: string[] = [];
        const h = build({
            hasUI: true,
            notify: (message) => notices.push(String(message)),
            responses: [segmentSummary],
            branchThrows: new Error("session unreadable"),
        });

        expect(await h.compact()).toBeUndefined();
        expect(h.calls).toHaveLength(0);
        expect(notices[0]).toContain("using pi's default");
        expect(notices[0]).toContain("session unreadable");
    });

    it("cancels a compaction whose signal was already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const h = build({
            responses: [
                async () => {
                    throw new TypeError("no provider call is allowed after an abort");
                },
            ],
            signal: controller.signal,
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(h.calls).toHaveLength(0);
    });

    it("cancels rather than falling back when an abort arrives mid-stage", async () => {
        // The warning this used to emit claimed pi's default had taken over. It had not: the user stopped the
        // compaction, and returning undefined would have let pi fire another summarization call on the same
        // dead controller.
        const controller = new AbortController();
        const notes: string[] = [];
        const h = build({
            responses: [
                async () => {
                    controller.abort();
                    return failedResponse("aborted", "Request was aborted");
                },
                async () => {
                    throw new TypeError("reduce must not run on an aborted controller");
                },
            ],
            signal: controller.signal,
            notify: (message) => notes.push(message),
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        // One provider call, not two: the reduce is skipped once the controller is dead.
        expect(h.calls).toHaveLength(1);
        expect(notes).toEqual([]);
    });

    it("sends no reduce request when stage 1 itself reports an abort", async () => {
        // The cause policy treats an aborted reply as the user stopping, so the cascade ends here rather than
        // putting a second request on a controller that may already be dead. It stays silent: nothing was handed
        // over and nothing went wrong.
        const notes: string[] = [];
        const h = build({
            responses: [
                async () => failedResponse("aborted", "Request was aborted"),
                async () => {
                    throw new TypeError("reduce must not run after an aborted stage 1");
                },
            ],
            notify: (message) => notes.push(message),
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(h.calls).toHaveLength(1);
        expect(notes).toEqual([]);
    });

    it("cancels rather than falling back when the abort arrives during the reduce", async () => {
        // Stage 1 fails on something the policy keeps cascading, so it is the reduce that meets the abort - the
        // case the pre-reduce guard cannot see.
        const controller = new AbortController();
        const notes: string[] = [];
        const h = build({
            responses: [
                async () => toolCallResponse("read"),
                async () => {
                    controller.abort();
                    return failedResponse("aborted", "This operation was aborted");
                },
            ],
            signal: controller.signal,
            notify: (message) => notes.push(message),
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(h.calls).toHaveLength(2);
        expect(notes).toEqual([]);
    });

    /**
     * A quota or rate-limit failure is about the account, not the request, so the whole cascade stops: stage 2
     * would send the same credentials to the same limit, and core's default path a third time. `{ cancel: true }`
     * is the only return value that means stop, and it leaves the session exactly as it was.
     */
    it("stops the cascade when the account is the problem, and says which problem it was", async () => {
        const notes: string[] = [];
        const h = build({
            hasUI: true,
            responses: [
                async () =>
                    failedResponse(
                        "error",
                        "429 insufficient_quota: You exceeded your current quota, please check your plan and billing details",
                    ),
                async () => {
                    throw new TypeError("reduce must not run on a quota limit");
                },
            ],
            notify: (message) => notes.push(message),
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(h.calls).toHaveLength(1);
        // Quota is named even though the status was 429: the block-list is checked before the throttle pattern.
        expect(notes.join("\n")).toContain("compaction stopped: quota");
    });

    it("stops on a bare throttle as well, even though pi would have retried it", async () => {
        const notes: string[] = [];
        const h = build({
            hasUI: true,
            responses: [
                async () => failedResponse("error", "429 Too Many Requests"),
                async () => summaryResponse("## Goal\n\nsalvaged\n\n## Progress\n\n- [x] salvaged"),
            ],
            notify: (message) => notes.push(message),
        });

        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(h.calls).toHaveLength(1);
        expect(notes.join("\n")).toContain("compaction stopped: rate-limit");
    });

    it("keeps cascading a transient failure once its retry budget is spent", async () => {
        const h = build({
            responses: [
                async () => failedResponse("error", "500 internal server error"),
                async () => summaryResponse("## Goal\n\nsalvaged\n\n## Progress\n\n- [x] salvaged"),
            ],
        });

        // `retryMaxRetries: 0` comes from the suite's config defaults, so the budget is spent immediately and
        // the cascade is what remains; the schedule itself is pinned in summarize.test.ts.
        const payload = await h.compact();
        expect(payload?.details.route).toBe("serialized");
        expect(h.calls).toHaveLength(2);
    });

    it("abandons rather than handing over when the reduce is stopped by the account", async () => {
        const notes: string[] = [];
        const h = build({
            hasUI: true,
            responses: [
                async () => toolCallResponse("read"),
                async () => failedResponse("error", "401 authentication_error: Invalid API key"),
            ],
            notify: (message) => notes.push(message),
        });

        // Returning undefined here would let core spend its own summarization request on rejected credentials.
        await expect(h.invoke()).resolves.toEqual({ cancel: true });
        expect(notes.join("\n")).toContain("compaction stopped: auth");
    });

    it("installs only the compaction hook plus the payload capture it diffs against", () => {
        const h = build();
        expect(h.piStub.order).toEqual(["on:before_provider_request", "on:session_before_compact"]);
        expect(h.piStub.handlersFor("session_before_compact")).toHaveLength(1);
    });

    it("stays out of the way when disabled by config", async () => {
        const h = build({ responses: [segmentSummary], config: { enabled: false } });

        expect(await h.compact()).toBeUndefined();
        expect(h.calls).toHaveLength(0);
    });

    it("honors the serialized limits from config", async () => {
        const h = build({
            responses: [segmentSummary, reducedSummary],
            config: { keepThinking: true, serializedToolResultChars: 20, serializedNoteChars: 0 },
        });
        await h.compact();

        const request = h.requestText(1);
        expect(request).toContain("reasoning the fallback must not carry");
        expect(request).toContain("more characters truncated]");
    });

    it("passes manual /compact instructions to both stages", async () => {
        const h = build({ responses: [segmentSummary, reducedSummary] });
        await h.compact({ customInstructions: "keep the database migration notes" });

        expect(h.trailingInstruction(0)).toContain(
            "Additional focus: keep the database migration notes",
        );
        expect(h.requestText(1)).toContain("Additional focus: keep the database migration notes");
    });
});

function textOf(content: string | (TextContent | ImageContent)[]): string {
    if (typeof content === "string") {
        return content;
    }
    return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");
}
