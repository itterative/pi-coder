import type { CompactionPreparation } from "./types";

/**
 * The prompts both summarization strategies send.
 *
 * Two different requests need two different framings. The native one is a continuation of a live
 * conversation whose model already has tools, a working context, and a reason to keep going, so most of its
 * length is spent closing that off: no tools, no continuation, summarize what precedes the retained tail.
 * The serialized one is a standalone call about a text transcript, where pi's "do not continue the
 * conversation" framing is enough on its own.
 */

/** pi's own section skeleton, kept comparable so existing renderers and readers keep working. */
const PI_SECTIONS = `## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]`;

/** The sections this module fills in deterministically, so the model must not guess at them. */
const OWNERSHIP = [
    "Write only the sections above. The harness appends these itself, so leave them out:",
    "- Verbatim Recent Requests, Tool Ledger, Delegated Runs, Dropped Context",
    "- <read-files> and <modified-files> blocks",
    "",
    "Keep each section concise. Preserve exact file paths, function names, symbols, commands, error",
    "messages, and identifiers: they are the parts that cannot be reconstructed later.",
].join("\n");

export interface SummarizationDirectiveInput {
    preparation: CompactionPreparation;
    customInstructions?: string;
}

/** Extra focus from `/compact <instructions>`, or undefined when the caller gave none. */
function focusLines(customInstructions?: string): string | undefined {
    const trimmed = customInstructions?.trim();
    if (!trimmed) {
        return undefined;
    }
    return `Additional focus: ${trimmed}`;
}

/**
 * Instruction appended to the live conversation for the native strategy.
 *
 * The retained tail is named explicitly: without it the model summarizes the recent turns it can still see
 * verbatim, and the checkpoint pays twice for the same content.
 */
export function nativeSummarizationInstruction(
    input: SummarizationDirectiveInput & { retainedMessageCount: number },
): string {
    const { preparation, retainedMessageCount } = input;
    const previous: string | undefined = preparation.previousSummary
        ? [
              "A compaction summary of earlier work is already in this conversation.",
              "Carry forward everything from it that still matters, move finished items from In Progress to",
              "Done, and drop what is genuinely obsolete.",
          ].join(" ")
        : undefined;
    const splitTurn: string | undefined = preparation.isSplitTurn
        ? "Part of the current turn is retained verbatim: summarize its earlier half and stop where the retained half begins."
        : undefined;
    return [
        "The conversation above is being compacted into a checkpoint that a fresh context will rely on.",
        "Do not call any tool. Do not continue the work, do not re-read files, and do not ask questions.",
        "Reply with text only: the summary itself, nothing before or after it.",
        "",
        `The last ~${String(retainedMessageCount)} messages are retained verbatim after compaction, so`,
        "summarize only what precedes them. Do not restate their contents.",
        previous,
        splitTurn,
        "",
        "Use this exact format:",
        "",
        PI_SECTIONS,
        "",
        OWNERSHIP,
        focusLines(input.customInstructions),
    ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
}

export const SERIALIZATION_SYSTEM_PROMPT = [
    "You are a context summarization assistant. You read a conversation between a user and an AI coding",
    "agent, then output a structured checkpoint summary in the exact format requested.",
    "You have no tools in this request. Do not continue the conversation, do not respond to questions in",
    "it, and do not emit tool calls. Output only the structured summary.",
].join("\n");

export interface SerializedRequestInput {
    conversationText: string;
    previousSummary?: string;
    customInstructions?: string;
}

/** Standalone request over a minimized transcript, used for overflow recovery and strategy fallback. */
export function serializedSummarizationRequest(input: SerializedRequestInput): string {
    const previous: string | undefined = input.previousSummary
        ? `<previous-summary>\n${input.previousSummary}\n</previous-summary>\n`
        : undefined;
    const merge = input.previousSummary
        ? "The transcript holds only NEW messages since <previous-summary>. Merge them into it, preserving" +
          " existing content that still matters."
        : "No prior summary exists, so this transcript is the whole history to summarize.";
    return [
        `<conversation>\n${input.conversationText}\n</conversation>\n`,
        previous,
        merge,
        focusLines(input.customInstructions),
        "",
        "Use this exact format:",
        "",
        PI_SECTIONS,
        "",
        OWNERSHIP,
    ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
}
