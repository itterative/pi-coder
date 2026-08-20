/**
 * Text utilities for formatting and truncating multi-line text.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Options for indenting lines
export interface IndentLinesOptions {
    // Prefix for the first line
    firstLinePrefix: string;
    // Prefix for continuation lines (default: same as firstLinePrefix)
    continuationPrefix?: string;
}

// Indent multi-line text with different prefixes for first and continuation lines
export function indentLines(text: string, options: IndentLinesOptions): string {
    const { firstLinePrefix, continuationPrefix = firstLinePrefix } = options;
    const lines = text.split("\n");

    if (lines.length === 0) {
        return firstLinePrefix;
    }

    if (lines.length === 1) {
        return firstLinePrefix + lines[0];
    }

    return (
        firstLinePrefix +
        lines[0] +
        "\n" +
        lines
            .slice(1)
            .map((line) => continuationPrefix + line)
            .join("\n")
    );
}

// Options for truncating lines
export interface TruncateLinesOptions {
    // Maximum number of lines to keep (default: no limit)
    maxLines?: number;
    // Maximum length of each line (default: no limit)
    maxLineLength?: number;
    // Extra characters to account for on first line (e.g., prefix/suffix length)
    firstLineLengthReduction?: number;
    // String to append when line is truncated (default: "...")
    truncationSuffix?: string;
}

// Truncate multi-line text to fit within line/length limits
// Uses ANSI-aware width calculation and truncation
export function truncateLines(text: string, options: TruncateLinesOptions = {}): string {
    const {
        maxLines,
        maxLineLength,
        firstLineLengthReduction = 0,
        truncationSuffix = "...",
    } = options;

    const lines = text.split("\n");
    const result: string[] = [];

    const limit = maxLines ?? lines.length;

    for (let i = 0; i < Math.min(lines.length, limit); i++) {
        let line = lines[i];
        if (!line) continue;

        // First line may have less available space due to prefix/suffix
        const maxLen = i === 0
            ? (maxLineLength ?? Infinity) - firstLineLengthReduction
            : maxLineLength ?? Infinity;

        if (maxLen !== Infinity && visibleWidth(line) > maxLen) {
            line = truncateToWidth(line, maxLen, truncationSuffix);
        }
        result.push(line);
    }

    // Add indicator if lines were truncated
    if (maxLines !== undefined && lines.length > maxLines) {
        result.push(`... (${lines.length - maxLines} more lines)`);
    }

    return result.join("\n");
}

/** Find the string index at which to hard-break `text` at the given visible width. */
function findHardBreakIndex(text: string, width: number): number {
    let hv = 0;
    for (let si = 0; si < text.length; si++) {
        const ch = text.codePointAt(si)!;
        if (ch === 0x1b && text[si + 1] === "[") {
            const endSeq = text.indexOf("m", si + 2);
            if (endSeq !== -1) {
                si = endSeq;
                continue;
            }
        }
        const cw = ch > 0xffff ? 2 : 1;
        if (hv + cw > width) return si;
        hv += cw;
        if (ch > 0xffff) si++; // skip low surrogate
    }
    return text.length;
}

/**
 * Wrap a single-line string at word boundaries, preserving trailing spaces.
 * Unlike wrapTextWithAnsi which trims trailing whitespace on wrapped lines,
 * this function keeps spaces intact so in-progress typing (e.g. trailing
 * spaces) remains visible in the edit buffer.
 */
export function wrapPreservingSpaces(text: string, width: number): string[] {
    if (width <= 0) return [text || ""];
    const visLen = visibleWidth(text);
    if (visLen <= width) return [text];

    const lines: string[] = [];
    let remaining = text;

    while (visibleWidth(remaining) > width) {
        let lastSpaceStrIdx = -1;
        let visPos = 0;

        for (let si = 0; si < remaining.length; si++) {
            const ch = remaining.codePointAt(si)!;
            // Skip over ANSI escape sequences
            if (ch === 0x1b && remaining[si + 1] === "[") {
                const endSeq = remaining.indexOf("m", si + 2);
                if (endSeq !== -1) {
                    si = endSeq;
                    continue;
                }
            }
            const charWidth = ch > 0xffff ? 2 : 1;
            visPos += charWidth;
            // Skip low surrogate
            if (ch > 0xffff) si++;

            if (visPos > width) {
                break;
            }

            if (ch === 32) {
                lastSpaceStrIdx = si + 1;
            }
        }

        if (lastSpaceStrIdx > 0) {
            lines.push(remaining.substring(0, lastSpaceStrIdx));
            remaining = remaining.substring(lastSpaceStrIdx);
        } else {
            // Hard break at width
            const idx = findHardBreakIndex(remaining, width);
            lines.push(remaining.substring(0, idx));
            remaining = remaining.substring(idx);
        }
    }

    if (remaining.length > 0) {
        lines.push(remaining);
    }

    return lines.length > 0 ? lines : [""];
}
