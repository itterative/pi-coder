import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentRunOutcome } from "../contracts/runs";
import { MAX_AGENT_RESPONSE_CHARS } from "../runs/run-state";

/** Directory under the parent scratchpad root that holds spilled delegated responses. */
export const RESPONSE_SPILL_DIRECTORY = "agents";

/** Number of lines in `text`, counting a trailing newline as a terminator rather than a new line. */
function countLines(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    const newlines = text.match(/\n/g)?.length ?? 0;
    return text.endsWith("\n") ? newlines : newlines + 1;
}

function truncationNote(filePath: string, kept: string, full: string): string {
    const totalLines = countLines(full);
    if (!kept.endsWith("\n")) {
        const detail =
            totalLines === 1
                ? "showing part of its single line"
                : `showing part of line 1 of ${totalLines}`;
        return `\n\n[Output truncated: ${detail}. Full response saved to ${filePath}]`;
    }
    return `\n\n[Output truncated: showing ${countLines(kept)} lines out of ${totalLines}. Full response saved to ${filePath}]`;
}

/**
 * Largest prefix of `text` that ends at a line boundary and fits within `maxChars`.
 *
 * A single line longer than the whole budget has no boundary to cut at, so the prefix falls back
 * to a hard character cut inside that line.
 */
function completeLinePrefix(text: string, maxChars: number): string {
    const window = text.slice(0, maxChars);
    const lastNewline = window.lastIndexOf("\n");
    if (lastNewline === -1) {
        return window;
    }
    return window.slice(0, lastNewline + 1);
}

/**
 * Bound a delegated response and spill the full text into the parent scratchpad.
 *
 * The complete response is written to `<scratchpad>/agents/<runId>-<collectSequence>.out` so the
 * parent can `read` it on demand and a continuation's later result cannot overwrite an earlier one.
 * The parent context keeps only the complete lines that fit in the response budget. The outcome is
 * returned unchanged when the response already fits, when no scratchpad exists, or when the spill
 * cannot be written: truncation must never lose output.
 */
export async function constrainAgentResponse(
    outcome: AgentRunOutcome,
    scratchpadPath: string | undefined,
): Promise<AgentRunOutcome> {
    const full = outcome.content;
    if (!scratchpadPath || full.length <= MAX_AGENT_RESPONSE_CHARS) {
        return outcome;
    }

    const sequence = outcome.details.collectSequence ?? 1;
    const filePath = path.join(
        scratchpadPath,
        RESPONSE_SPILL_DIRECTORY,
        `${outcome.details.runId}-${sequence}.out`,
    );
    try {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFile(filePath, full, { mode: 0o600 });
    } catch {
        return outcome;
    }

    const kept = completeLinePrefix(full, MAX_AGENT_RESPONSE_CHARS);
    return {
        ...outcome,
        content: `${kept}${truncationNote(filePath, kept, full)}`,
    };
}
