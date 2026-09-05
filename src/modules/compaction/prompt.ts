import type { CompactionPreparation } from "./types";

/**
 * The prompts both compaction stages send.
 *
 * Stage 1 is a continuation of the conversation itself: the model has its tools, its working context, and a
 * reason to keep going, so most of this length is spent closing that off — no tools, no continuation, and
 * only the part that is about to be dropped. Stage 2 is a standalone reduce over a minimized transcript plus
 * stage 1's output, where the framing has to say what each input is for.
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

const FORMAT = ["Use this exact format:", "", PI_SECTIONS, "", OWNERSHIP].join("\n");

/** Extra focus from `/compact <instructions>`, or undefined when the caller gave none. */
function focusLines(customInstructions?: string): string | undefined {
    const trimmed = customInstructions?.trim();
    if (!trimmed) {
        return undefined;
    }
    return `Additional focus: ${trimmed}`;
}

export interface SegmentInstructionInput {
    preparation: CompactionPreparation;
    customInstructions?: string;
}

/**
 * Stage 1: appended to the truncated live conversation, whose tools are deliberately left intact so the
 * request stays a strict prefix of what the provider already cached. `tool_choice: "none"` carries the
 * prohibition; the wording below is the backstop for endpoints that ignore that field.
 */
export function segmentSummaryInstruction(input: SegmentInstructionInput): string {
    const { preparation } = input;
    const previous: string | undefined = preparation.previousSummary
        ? [
              "An earlier compaction summary is part of this conversation. Carry forward everything in it",
              "that still matters, move finished items from In Progress to Done, and drop what is genuinely",
              "obsolete.",
          ].join(" ")
        : undefined;
    const splitTurn: string | undefined = preparation.isSplitTurn
        ? "This span ends partway through a turn whose remainder is retained verbatim; summarize only the" +
          " part shown here."
        : undefined;

    return [
        "Everything above is about to be dropped from this conversation and replaced by a checkpoint.",
        "The most recent turns are retained as-is and are not included here.",
        "",
        "Do not call any tool. Do not continue the work, do not re-read files, do not ask questions.",
        "Reply with text only: the checkpoint itself, nothing before or after it.",
        "",
        "Write that checkpoint now, for a fresh context that will see only this text plus the recent turns.",
        previous,
        splitTurn,
        "",
        FORMAT,
        focusLines(input.customInstructions),
    ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
}

export const SERIALIZATION_SYSTEM_PROMPT = [
    "You are a context summarization assistant. You read a conversation transcript and the segment",
    "checkpoint an earlier pass wrote about it, then output one structured checkpoint summary in the exact",
    "format requested.",
    "You have no tools in this request. Do not continue the conversation, do not respond to questions in",
    "it, and do not emit tool calls. Output only the structured summary.",
].join("\n");

export interface SerializedRequestInput {
    conversationText: string;
    /** Stage 1's output, when the native pass produced one. */
    segmentSummary?: string;
    previousSummary?: string;
    customInstructions?: string;
}

/**
 * Stage 2: the reduce. It sees the minimized transcript, stage 1's native reading of the same span, and the
 * previous checkpoint, and has to reconcile them into one.
 */
export function serializedSummarizationRequest(input: SerializedRequestInput): string {
    const previous: string | undefined = input.previousSummary
        ? `<previous-summary>\n${input.previousSummary}\n</previous-summary>\n`
        : undefined;
    const segment: string | undefined = input.segmentSummary
        ? `<segment-checkpoint>\n${input.segmentSummary}\n</segment-checkpoint>\n`
        : undefined;

    const lead = input.segmentSummary
        ? [
              "<segment-checkpoint> is a summary of the same conversation written by the assistant that",
              "holds it in context; <conversation> is a minimized transcript of it. Prefer the transcript",
              "where they disagree, and use the checkpoint where the transcript was compressed away.",
          ].join(" ")
        : "The transcript is the whole conversation to summarize; it has been minimized, so tool output may";

    const merge = input.previousSummary
        ? "The transcript holds only NEW messages since <previous-summary>. Merge everything into it," +
          " preserving existing content that still matters."
        : `${lead}. No prior checkpoint exists.`;

    return [
        `<conversation>\n${input.conversationText}\n</conversation>\n`,
        segment,
        previous,
        merge,
        focusLines(input.customInstructions),
        "",
        FORMAT,
    ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
}
