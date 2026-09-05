/**
 * Payload-level prefix diffing, to answer one question: did the summarization request share the
 * conversation's cached prefix, or did it diverge before the messages did?
 *
 * Provider usage numbers cannot answer that. `cacheRead: 0` is reported both when the request body
 * diverged at the first token and when the endpoint simply will not serve a cache entry to a request that
 * extends or rewinds the conversation. So this module compares the two bodies pi actually built — the
 * parent's last real request, captured at `before_provider_request`, and our own, captured at the
 * `onPayload` option — and reports the first divergence by name: system prompt, tool array, a specific
 * message, or only the tail we added.
 *
 * Payloads are shaped per API (`system` string for Anthropic-style, a system/developer message for
 * OpenAI-style; `tools` with `input_schema` or `parameters`), so nothing here assumes one: fields are read
 * best-effort and anything unrecognized is compared by hash, which is exactly what a cache key does.
 */

/** A short head of each side of a divergence, so the report says *what* differs, not just where. */
const EXCERPT_CHARS = 320;

export interface PayloadFingerprint {
    /** Top-level body keys, sorted: catches `prompt_cache_key` or marker differences. */
    keys: string[];
    model: string;
    system: string;
    systemChars: number;
    toolNames: string[];
    toolsHash: string;
    /** One hash per message in body order, including role-only entries. */
    messageHashes: string[];
    messageRoles: string[];
}

export interface PrefixDiff {
    /** True when nothing but the appended tail differs, i.e. the cached prefix should have been usable. */
    prefixUsable: boolean;
    /** The first content divergence: "model", "system", "tools...", "messages[n]", "rewind", or "tail". */
    firstDivergence: string;
    /** Every content divergence found. Checking all of them, rather than the first, is the whole point. */
    divergences: string[];
    /**
     * True when we sent fewer messages than the parent's last request. That is stage 1 working as designed:
     * the span is truncated at the cut point, so the retained tail is absent. Informational, never a
     * divergence.
     */
    truncated: boolean;
    /**
     * Top-level body keys only one side sent. Informational, never a verdict: `tool_choice` is a request
     * parameter, not prefix content, and a provider that reports a 34k cache read alongside it proves the
     * distinction matters.
     */
    parameters: string[];
    parent?: string;
    ours?: string;
    parentMessageCount: number;
    ourMessageCount: number;
    /** How many leading messages were identical. */
    commonPrefixMessages: number;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function hash(value: unknown): string {
    const text = typeof value === "string" ? value : safeStringify(value);
    // FNV-1a: collisions are irrelevant here, this is a dev diagnostic comparing two known bodies.
    let result = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        result ^= text.charCodeAt(index);
        result = Math.imul(result, 0x01000193);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
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

function systemText(payload: Record<string, unknown>): { text: string; chars: number } {
    const direct = payload.system;
    if (typeof direct === "string") {
        return { text: excerpt(direct), chars: direct.length };
    }
    if (direct !== undefined && direct !== null) {
        const text = safeStringify(direct);
        return { text: excerpt(text), chars: text.length };
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    for (const entry of messages) {
        const message = asRecord(entry);
        if (typeof message.role === "string" && SYSTEM_ROLES.has(message.role)) {
            const text =
                typeof message.content === "string"
                    ? message.content
                    : safeStringify(message.content);
            return { text: excerpt(text), chars: text.length };
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

export function fingerprintPayload(payload: unknown): PayloadFingerprint {
    const record = asRecord(payload);
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const system = systemText(record);
    const tools = toolsOf(record);
    return {
        keys: Object.keys(record).sort(),
        model: typeof record.model === "string" ? record.model : "",
        system: system.text,
        systemChars: system.chars,
        toolNames: tools.map(toolName),
        toolsHash: hash(tools),
        messageHashes: messages.map((message) => hash(message)),
        messageRoles: messages.map((message) => String(asRecord(message).role ?? "?")),
    };
}

/**
 * Compare the parent request with ours.
 *
 * Ours is expected to differ at the very end: we append one user instruction, and pi's own cache markers
 * move with it. Anything that diverges before that endangers the whole prefix, because these providers hash
 * a prefix rather than a suffix.
 */
export function diffRequestPrefixes(
    parent: PayloadFingerprint,
    ours: PayloadFingerprint,
): PrefixDiff {
    const divergences: string[] = [];
    const shared = Math.min(parent.messageHashes.length, ours.messageHashes.length);
    let commonPrefixMessages = 0;
    let firstDetail: { parent?: string; ours?: string } = {};

    if (parent.model !== ours.model) {
        divergences.push("model");
        firstDetail = { parent: parent.model, ours: ours.model };
    }
    if (parent.systemChars !== ours.systemChars || parent.system !== ours.system) {
        divergences.push("system");
        firstDetail = firstDetail.parent
            ? firstDetail
            : {
                  parent: `${String(parent.systemChars)} chars: ${parent.system}`,
                  ours: `${String(ours.systemChars)} chars: ${ours.system}`,
              };
    }
    if (parent.toolsHash !== ours.toolsHash) {
        divergences.push(
            parent.toolNames.join(",") === ours.toolNames.join(",")
                ? "tools(body)"
                : `tools(names): ${parent.toolNames.join(",")} vs ${ours.toolNames.join(",")}`,
        );
    }

    for (let index = 0; index < shared; index += 1) {
        if (parent.messageHashes[index] === ours.messageHashes[index]) {
            commonPrefixMessages += 1;
            continue;
        }
        divergences.push(`messages[${String(index)}] (${parent.messageRoles[index]})`);
        break;
    }
    const truncated = ours.messageHashes.length < parent.messageHashes.length;

    // Our request is expected to differ where our instruction begins: a truncated stage-1 body that matches
    // the parent all the way to its own last message is the designed shape, not a mismatch. The `truncated`
    // test is what separates that from a genuine rewrite of the last shared message, which is the same index
    // arithmetic and must keep failing.
    if (
        truncated &&
        divergences.length === 1 &&
        commonPrefixMessages === ours.messageHashes.length - 1
    ) {
        divergences.length = 0;
    }

    const contentMismatch = divergences.length > 0;
    return {
        prefixUsable: !contentMismatch,
        firstDivergence: contentMismatch ? (divergences[0] as string) : "tail",
        divergences,
        truncated,
        parameters: parameterDifferences(parent.keys, ours.keys),
        ...firstDetail,
        parentMessageCount: parent.messageHashes.length,
        ourMessageCount: ours.messageHashes.length,
        commonPrefixMessages,
    };
}

function parameterDifferences(parent: string[], ours: string[]): string[] {
    const parentSet = new Set(parent);
    const ourSet = new Set(ours);
    const added = [...ourSet].filter((key) => !parentSet.has(key)).map((key) => `+${key}`);
    const removed = [...parentSet].filter((key) => !ourSet.has(key)).map((key) => `-${key}`);
    return [...added, ...removed];
}

/** A compact, loggable summary of a fingerprint: never the payload itself. */
export function fingerprintSummary(fingerprint: PayloadFingerprint): Record<string, unknown> {
    return {
        model: fingerprint.model,
        keys: fingerprint.keys,
        systemChars: fingerprint.systemChars,
        systemHash: hash(fingerprint.system),
        toolsHash: fingerprint.toolsHash,
        toolCount: fingerprint.toolNames.length,
        messageCount: fingerprint.messageHashes.length,
        lastMessageRole: fingerprint.messageRoles[fingerprint.messageRoles.length - 1],
    };
}
