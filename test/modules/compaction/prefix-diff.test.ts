import { describe, expect, it } from "vitest";

import {
    fingerprintPayload,
    fingerprintSummary,
    requestMessages,
    requestShape,
} from "../../../src/modules/compaction/prefix-diff";
import { shapeKey } from "../../../src/modules/compaction/chain";

/**
 * These fixtures are deliberately payload-shaped, not `Context`-shaped: the module's whole job is reading a
 * body pi already serialized, whose shape differs per API.
 */

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

describe("request shape fingerprinting", () => {
    it("reads the system prompt from an Anthropic-style body", () => {
        const shape = requestShape(anthropicBody({ system: "be terse" }));
        expect(shape.systemChars).toBe("be terse".length);
        expect(shape.model).toBe("claude-sonnet");
        expect(shape.toolNames).toEqual(["read"]);
    });

    it("finds the system prompt inside an OpenAI-style message array", () => {
        const shape = requestShape(openaiBody({ system: "be terse" }));
        expect(shape.systemChars).toBe("be terse".length);
        expect(shape.toolNames).toEqual(["read"]);
        expect(shape.model).toBe("qwen3.8-flash");
    });

    it("hashes the whole system prompt, not the printed window", () => {
        // A 24 KB prompt that differs only at character 9000 must not look unchanged, which is why both hashes
        // read raw text while the human-facing excerpt stays short.
        // Same length on purpose: a windowed hash would call these identical, and a length check too.
        const head = "a".repeat(4000);
        const before = requestShape(anthropicBody({ system: `${head}first` }));
        const after = requestShape(anthropicBody({ system: `${head}other` }));

        expect(before.systemHash).not.toBe(after.systemHash);
        expect(before.systemChars).toBe(after.systemChars);
        expect(fingerprintPayload(anthropicBody({ system: head })).system).toContain("…");

        // The record's own field must carry the same guarantee. It used to hash the 320-char excerpt, which
        // reported `6e84662c` unchanged across a session whose prompt grew from 12,817 to 24,813 chars - a field
        // that cannot see what it is named for reads as evidence of stability while contradicting it.
        const summaryBefore = fingerprintSummary(
            fingerprintPayload(anthropicBody({ system: `${head}first` })),
        );
        const summaryAfter = fingerprintSummary(
            fingerprintPayload(anthropicBody({ system: `${head}other` })),
        );
        expect(summaryBefore.systemHash).not.toBe(summaryAfter.systemHash);
        expect(summaryBefore.systemChars).toBe(summaryAfter.systemChars);
        // One name, one meaning: the recorded hash is the hash the chain compares on, so a reader can join a
        // `prefix.ourRequest.systemHash` to a retained shape without translating between the two.
        expect(summaryBefore.systemHash).toBe(before.systemHash);
    });

    it("separates a changed tool body from a changed tool set", () => {
        const sameNames = requestShape(
            anthropicBody({ tools: [{ name: "read", input_schema: { type: "object" } }] }),
        );
        const reshaped = requestShape(
            anthropicBody({ tools: [{ name: "read", input_schema: { type: "string" } }] }),
        );
        const renamed = requestShape(
            anthropicBody({ tools: [{ name: "grep", input_schema: { type: "object" } }] }),
        );

        expect(sameNames.toolsHash).not.toBe(reshaped.toolsHash);
        expect(sameNames.toolNames).toEqual(reshaped.toolNames);
        expect(renamed.toolNames).not.toEqual(sameNames.toolNames);
    });

    it("reads decode values that key presence cannot express", () => {
        // Both bodies below carry `enable_thinking`: only the value says one request thinks and the other does
        // not, which on the templating servers is a prefix difference the key set is blind to.
        const shape = requestShape({
            ...openaiBody({}),
            enable_thinking: true,
            reasoning_effort: "high",
            max_completion_tokens: 4096,
        });
        expect(shape).toMatchObject({
            enableThinking: true,
            reasoningEffort: "high",
            maxTokens: 4096,
        });

        const off = requestShape({ ...openaiBody({}), enable_thinking: false });
        expect(off.enableThinking).toBe(false);
        // Absent, not "low": a body that never sent the effort must not read as any particular level.
        expect(off.reasoningEffort).toBeNull();
        expect(off.maxTokens).toBeNull();
    });

    it("finds the thinking switch and effort where other servers put them", () => {
        // vLLM and SGLang take the switch as a chat-template kwarg; Anthropic's adaptive shape calls the level
        // `effort` and puts the cap in `max_tokens`.
        const kwargs = requestShape({
            ...openaiBody({}),
            chat_template_kwargs: { enable_thinking: true },
            effort: "medium",
        });
        expect(kwargs.enableThinking).toBe(true);
        expect(kwargs.reasoningEffort).toBe("medium");

        const anthropic = requestShape(anthropicBody({ system: "p" }));
        expect(anthropic.maxTokens).toBe(1000);
    });

    it("counts image blocks across content shapes", () => {
        const shape = requestShape(
            openaiBody({
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "look" },
                            { type: "image_url", image_url: { url: "data:image/png;base64,…" } },
                        ],
                    },
                    { role: "user", content: "string content has no blocks" },
                    { role: "assistant", content: [{ type: "image", source: {} }] },
                ],
            }),
        );

        expect(shape.imageBlocks).toBe(2);
    });

    it("keeps scalar differences out of the shape key", () => {
        // A thinking toggle has to stay comparable. Folding the scalars into the shape would turn "these two
        // requests differ in a parameter that moves the prefix" into "these two requests cannot be compared",
        // which is a shrug where the diagnosis belongs.
        const thinking = requestShape({
            ...openaiBody({}),
            enable_thinking: true,
            reasoning_effort: "high",
            max_completion_tokens: 100,
        });
        const plain = requestShape({ ...openaiBody({}), enable_thinking: false });

        expect(shapeKey(thinking)).toBe(shapeKey(plain));
    });

    it("sorts body keys so a parameter difference reads as a set difference", () => {
        const shape = requestShape(anthropicBody({ extra: { presence_penalty: 0.5 } }));
        expect(shape.keys).toEqual([...shape.keys].sort((a, b) => a.localeCompare(b)));
        expect(shape.keys).toContain("presence_penalty");
    });

    it("survives a payload it cannot understand", () => {
        for (const junk of [undefined, null, "text", 7, [], {}]) {
            const shape = requestShape(junk);
            expect(shape.systemHash).toBeTruthy();
            expect(shape.toolsHash).toBeTruthy();
            expect(shape.toolNames).toEqual([]);
            expect(shape.keys).toEqual([]);
            expect(requestMessages(junk)).toEqual([]);
        }
    });

    it("summarizes a fingerprint without any conversation text", () => {
        const summary = fingerprintSummary(
            fingerprintPayload(
                anthropicBody({
                    system: "the prompt",
                    messages: [{ role: "user", content: "secret" }],
                }),
            ),
        );

        expect(summary).toMatchObject({
            model: "claude-sonnet",
            systemChars: "the prompt".length,
            toolCount: 1,
            messageCount: 1,
            lastMessageRole: "user",
        });
        expect(JSON.stringify(summary)).not.toContain("secret");
        expect(typeof summary.systemHash).toBe("string");
    });

    it("returns the message array exactly as it was sent", () => {
        const messages = [{ role: "user", content: "first" }];
        expect(requestMessages(anthropicBody({ messages }))).toBe(messages);
    });
});
