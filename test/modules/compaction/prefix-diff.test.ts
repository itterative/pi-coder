import { describe, expect, it } from "vitest";

import {
    diffRequestPrefixes,
    fingerprintPayload,
    fingerprintSummary,
} from "../../../src/modules/compaction/prefix-diff";

/** Anthropic-style body: `system` is a top-level string and tools carry `input_schema`. */
function anthropicBody(input: {
    system?: string;
    tools?: unknown[];
    messages?: unknown[];
    extra?: Record<string, unknown>;
}) {
    return {
        model: "claude-sonnet",
        max_tokens: 1000,
        system: input.system ?? "the prompt",
        tools: input.tools ?? [{ name: "read", input_schema: { type: "object" } }],
        messages: input.messages ?? [
            { role: "user", content: "first" },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
        ...input.extra,
    };
}

/** OpenAI-compatible body: the prompt arrives as a `role: "system"` message and tools are nested. */
function openaiBody(input: { system?: string; tools?: unknown[]; messages?: unknown[] }) {
    return {
        model: "qwen3.8-flash",
        messages: [
            { role: "system", content: input.system ?? "the prompt" },
            ...(input.messages ?? [{ role: "user", content: "first" }]),
        ],
        tools: input.tools ?? [{ type: "function", function: { name: "read" } }],
    };
}

function fingerprint(body: unknown) {
    return fingerprintPayload(body);
}

describe("request prefix diffing", () => {
    it("treats an appended instruction as a usable prefix", () => {
        const parent = fingerprint(anthropicBody({}));
        const ours = fingerprint(
            anthropicBody({
                messages: [
                    { role: "user", content: "first" },
                    { role: "assistant", content: [{ type: "text", text: "ok" }] },
                    { role: "user", content: "summarize this" },
                ],
            }),
        );

        expect(diffRequestPrefixes(parent, ours)).toMatchObject({
            prefixUsable: true,
            firstDivergence: "tail",
            parentMessageCount: 2,
            ourMessageCount: 3,
            commonPrefixMessages: 2,
        });
    });

    it("names a system prompt divergence with both excerpts", () => {
        const parent = fingerprint(anthropicBody({ system: "prompt with the memory block" }));
        const ours = fingerprint(anthropicBody({ system: "prompt without it" }));
        const diff = diffRequestPrefixes(parent, ours);

        expect(diff.prefixUsable).toBe(false);
        expect(diff.firstDivergence).toBe("system");
        expect(diff.parent).toContain("memory block");
        expect(diff.ours).toContain("without it");
    });

    it("sees the system prompt inside an OpenAI-style body", () => {
        const parent = fingerprint(openaiBody({ system: "alpha" }));
        const ours = fingerprint(openaiBody({ system: "beta" }));
        const diff = diffRequestPrefixes(parent, ours);

        expect(diff.firstDivergence).toBe("system");
        expect(diff.parent).toContain("alpha");
    });

    it("separates a changed tool body from a changed tool set", () => {
        const marked = fingerprint(
            anthropicBody({
                tools: [
                    {
                        name: "read",
                        input_schema: { type: "object" },
                        cache_control: { type: "ephemeral" },
                    },
                ],
            }),
        );
        const plain = fingerprint(anthropicBody({}));
        expect(diffRequestPrefixes(plain, marked).firstDivergence).toBe("tools(body)");

        const reordered = fingerprint(
            anthropicBody({
                tools: [
                    { name: "bash", input_schema: { type: "object" } },
                    { name: "read", input_schema: { type: "object" } },
                ],
            }),
        );
        expect(diffRequestPrefixes(plain, reordered).firstDivergence).toContain("tools(names)");
    });

    it("reports a parameter difference without calling it a prefix break", () => {
        const parent = fingerprint(anthropicBody({ extra: { prompt_cache_key: "session-1" } }));
        const ours = fingerprint(anthropicBody({ extra: { tool_choice: "none" } }));
        const diff = diffRequestPrefixes(parent, ours);

        // llama.cpp served a 34k cache read on a request that carried `tool_choice` and pi's did not, so a
        // parameter difference must never be reported as the reason a prefix was unusable.
        expect(diff.prefixUsable).toBe(true);
        expect(diff.firstDivergence).toBe("tail");
        expect(diff.parameters).toEqual(["+tool_choice", "-prompt_cache_key"]);
        expect(diff.divergences).toEqual([]);
    });

    it("lists every content divergence instead of stopping at the first", () => {
        const parent = fingerprint(anthropicBody({ system: "prompt a" }));
        const ours = fingerprint(
            anthropicBody({
                system: "prompt b",
                tools: [{ name: "other", input_schema: { type: "object" } }],
                messages: [
                    { role: "user", content: "changed" },
                    { role: "assistant", content: [{ type: "text", text: "ok" }] },
                ],
            }),
        );
        const diff = diffRequestPrefixes(parent, ours);

        expect(diff.divergences).toEqual([
            "system",
            "tools(names): read vs other",
            "messages[0] (user)",
        ]);
        expect(diff.firstDivergence).toBe("system");
        expect(diff.prefixUsable).toBe(false);
        expect(diff.commonPrefixMessages).toBe(0);
    });

    it("points at the first message that differs", () => {
        const parent = fingerprint(anthropicBody({}));
        const ours = fingerprint(
            anthropicBody({
                messages: [
                    { role: "user", content: "first" },
                    {
                        role: "assistant",
                        content: [{ type: "text", text: "edited after the fact" }],
                    },
                ],
            }),
        );
        const diff = diffRequestPrefixes(parent, ours);

        expect(diff.firstDivergence).toBe("messages[1] (assistant)");
        expect(diff.commonPrefixMessages).toBe(1);
    });

    it("flags a rewind, which cannot reuse an extended prefix", () => {
        const parent = fingerprint(
            anthropicBody({
                messages: [
                    { role: "user", content: "first" },
                    { role: "assistant", content: [{ type: "text", text: "ok" }] },
                ],
            }),
        );
        const ours = fingerprint(anthropicBody({ messages: [{ role: "user", content: "first" }] }));
        const diff = diffRequestPrefixes(parent, ours);

        expect(diff.prefixUsable).toBe(false);
        expect(diff.firstDivergence).toBe("rewind");
    });

    it("fingerprints nested OpenAI tool names", () => {
        const summary = fingerprintSummary(fingerprintPayload(openaiBody({})));
        expect(summary).toMatchObject({
            model: "qwen3.8-flash",
            toolCount: 1,
            messageCount: 2,
            lastMessageRole: "user",
        });
        expect(summary.systemChars).toBe("the prompt".length);
    });

    it("survives a payload it cannot understand", () => {
        expect(fingerprintSummary(fingerprintPayload(undefined))).toMatchObject({
            model: "",
            toolCount: 0,
            messageCount: 0,
        });
        expect(fingerprintSummary(fingerprintPayload("not an object")).keys).toEqual([]);
    });
});
