/** Kept separate from the module surface so both the serializer and the fit gate share one heuristic. */

/** pi's own conservative estimate: four characters per token, rounded up. */
export function estimateTextTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Keep the head of a block and say how much fell off, so a summary model can tell a short answer from a
 * clipped one instead of assuming the text ended where it reads.
 */
export function truncateHead(text: string, maxChars: number): string {
    if (maxChars <= 0) {
        return "";
    }
    if (text.length <= maxChars) {
        return text;
    }
    const dropped = text.length - maxChars;
    return `${text.slice(0, maxChars)} [... ${dropped} more characters truncated]`;
}

/** Single-line a multi-line block for use inside a ledger bullet. */
export function collapseWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}
