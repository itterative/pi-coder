/**
 * Payload fingerprinting for the compaction trace.
 *
 * Provider usage numbers cannot answer the prefix question on their own. `cacheRead: 0` is reported both when
 * the request body diverged at the first token and when the endpoint simply will not serve a cache entry to a
 * request that extends or rewinds the conversation. So a request is reduced to hashes and counts here, and
 * `chain.ts` retains those per turn: our rebuilt body is then matched against what pi actually sent, at the
 * exact depth where the two stop agreeing.
 *
 * Payloads are shaped per API (`system` string for Anthropic-style, a system/developer message for
 * OpenAI-style; `tools` with `input_schema` or `parameters`), so nothing here assumes one: fields are read
 * best-effort and anything unrecognized is compared by hash, which is exactly what a cache key does.
 */

import { createHash } from "node:crypto";

import type { ChainShape } from "./chain";

/** A short head of each side of a divergence, so the report says *what* differs, not just where. */
const EXCERPT_CHARS = 320;

export interface PayloadFingerprint {
    /** Top-level body keys, sorted: catches `prompt_cache_key` or marker differences. */
    keys: string[];
    model: string;
    system: string;
    systemChars: number;
    /** Hash of the whole system text. `system` above is only an excerpt, so hashing it would miss any drift past the excerpt boundary. */
    systemFullHash: string;
    toolNames: string[];
    toolsHash: string;
    /** One hash per message in body order, including role-only entries. */
    messageHashes: string[];
    messageRoles: string[];
    /** Decode and content-shape values, shared with `ChainShape`. `null` means the body carried no such field. */
    maxTokens: number | null;
    enableThinking: boolean | null;
    reasoningEffort: string | null;
    imageBlocks: number | null;
}

/** First top-level key in `names` holding a number, else null: absent and zero are different facts. */
function numberField(record: Record<string, unknown>, names: string[]): number | null {
    for (const name of names) {
        const value = record[name];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }

    return null;
}

function stringField(record: Record<string, unknown>, names: string[]): string | null {
    for (const name of names) {
        const value = record[name];
        if (typeof value === "string") {
            return value;
        }
    }

    return null;
}

/**
 * The thinking switch, from either shape servers use: a top-level `enable_thinking` (qwen-compatible) or the
 * nested chat-template kwarg (vLLM, SGLang). Nothing found is null, not false.
 */
function thinkingSwitch(record: Record<string, unknown>): boolean | null {
    const direct = record.enable_thinking;
    if (typeof direct === "boolean") {
        return direct;
    }

    const kwargs = asRecord(record.chat_template_kwargs);
    return typeof kwargs.enable_thinking === "boolean" ? kwargs.enable_thinking : null;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * sha256 truncated to 16 hex characters - the same digest the chain uses for heads and shape keys.
 *
 * This was FNV-1a-32, which was fair when the job was comparing two known bodies inside one process. The
 * value now decides whether a retained ladder is compared at all, it is persisted, and it is joined across
 * processes - so a collision would surface as a false `verified=N/N` rather than a cosmetic mix-up.
 */
function hash(value: unknown): string {
    const text = typeof value === "string" ? value : safeStringify(value);
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return String(value);
    }
}

function excerpt(value: unknown): string {
    const text = typeof value === "string" ? value : safeStringify(value);
    return text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS)}…`;
}

const SYSTEM_ROLES = new Set(["system", "developer"]);

/** Raw text, not an excerpt: the hash over it must cover drift past what the record prints. */
function systemText(payload: Record<string, unknown>): { text: string; chars: number } {
    const direct = payload.system;
    if (typeof direct === "string") {
        return { text: direct, chars: direct.length };
    }
    if (direct !== undefined && direct !== null) {
        const text = safeStringify(direct);
        return { text, chars: text.length };
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    for (const entry of messages) {
        const message = asRecord(entry);
        if (typeof message.role === "string" && SYSTEM_ROLES.has(message.role)) {
            const text =
                typeof message.content === "string"
                    ? message.content
                    : safeStringify(message.content);
            return { text, chars: text.length };
        }
    }
    return { text: "", chars: 0 };
}

function toolsOf(payload: Record<string, unknown>): unknown[] {
    return Array.isArray(payload.tools) ? payload.tools : [];
}

function nestedName(value: unknown): string | undefined {
    const record = asRecord(value);
    return typeof record.name === "string" ? record.name : undefined;
}

/** Tool entries are `{ name }` for Anthropic-style bodies and `{ function: { name } }` for OpenAI-style. */
function toolName(tool: unknown): string {
    return nestedName(tool) ?? nestedName(asRecord(tool).function) ?? "<unnamed>";
}

/**
 * Image blocks in the message array, counted not sampled.
 *
 * The reason this is worth a field: pi applies its own per-turn rewrite when the user disables image reading,
 * replacing each block with a short text placeholder, and no extension API reports that setting. A rebuilt
 * prefix that diverges at message k while the two sides count different numbers of images is that case, and a
 * count is the only form of it this module is allowed to keep.
 */
function countImageBlocks(messages: readonly unknown[]): number {
    let count = 0;

    for (const entry of messages) {
        const content = asRecord(entry).content;
        if (!Array.isArray(content)) {
            continue;
        }

        for (const block of content) {
            const type = asRecord(block).type;
            if (type === "image" || type === "image_url") {
                count++;
            }
        }
    }

    return count;
}

export function fingerprintPayload(payload: unknown): PayloadFingerprint {
    const record = asRecord(payload);
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const system = systemText(record);
    const tools = toolsOf(record);
    return {
        keys: Object.keys(record).sort(),
        model: typeof record.model === "string" ? record.model : "",
        system: excerpt(system.text),
        systemChars: system.chars,
        systemFullHash: hash(system.text),
        toolNames: tools.map(toolName),
        toolsHash: hash(tools),
        messageHashes: messages.map((message) => hash(message)),
        messageRoles: messages.map((message) => String(asRecord(message).role ?? "?")),
        maxTokens: numberField(record, ["max_completion_tokens", "max_tokens"]),
        enableThinking: thinkingSwitch(record),
        reasoningEffort: stringField(record, ["reasoning_effort", "effort"]),
        imageBlocks: countImageBlocks(messages),
    };
}

/**
 * Everything about a request worth retaining forever: hashes, counts, and names, never content.
 *
 * This is the unit `RequestChain` keeps per turn. It reports the whole system-prompt hash, unlike the
 * human-facing summary below, because its job is to notice drift rather than to describe it.
 */
export function requestShape(payload: unknown): ChainShape {
    const record = asRecord(payload);
    const system = systemText(record);
    const tools = toolsOf(record);

    return {
        systemHash: hash(system.text),
        toolsHash: hash(tools),
        systemChars: system.chars,
        toolNames: tools.map(toolName),
        keys: Object.keys(record).sort(),
        model: typeof record.model === "string" ? record.model : "",
        maxTokens: numberField(record, ["max_completion_tokens", "max_tokens"]),
        enableThinking: thinkingSwitch(record),
        reasoningEffort: stringField(record, ["reasoning_effort", "effort"]),
        imageBlocks: countImageBlocks(messagesOf(record)),
    };
}

/** The message array exactly as the provider receives it, so hashing it means the same thing on both sides. */
function messagesOf(record: Record<string, unknown>): unknown[] {
    return Array.isArray(record.messages) ? record.messages : [];
}

/** The message array exactly as the provider receives it, so hashing it means the same thing on both sides. */
export function requestMessages(payload: unknown): unknown[] {
    const record = asRecord(payload);
    return Array.isArray(record.messages) ? record.messages : [];
}

/** A compact, loggable summary of a fingerprint: never the payload itself. */
export function fingerprintSummary(fingerprint: PayloadFingerprint): Record<string, unknown> {
    return {
        model: fingerprint.model,
        keys: fingerprint.keys,
        systemChars: fingerprint.systemChars,
        // Whole-text hash, so this field means the same thing as `requestShape().systemHash`. It used to hash
        // the 320-char excerpt, which reported `6e84662c` unchanged across a prompt that grew from 12817 to
        // 24813 chars - a field that cannot see the thing it is named for is worse than no field.
        systemHash: fingerprint.systemFullHash,
        toolsHash: fingerprint.toolsHash,
        toolCount: fingerprint.toolNames.length,
        messageCount: fingerprint.messageHashes.length,
        lastMessageRole: fingerprint.messageRoles[fingerprint.messageRoles.length - 1],
        // Values, not key presence: `keys` reports `enable_thinking` on both sides whether it is true or false.
        maxTokens: fingerprint.maxTokens,
        enableThinking: fingerprint.enableThinking,
        reasoningEffort: fingerprint.reasoningEffort,
        imageBlocks: fingerprint.imageBlocks,
    };
}
