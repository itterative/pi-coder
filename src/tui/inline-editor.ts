/**
 * Inline Editor
 *
 * A reusable, theme-free single-field text editor engine for dialog
 * components (ask-user, select-with-message, ...). It owns:
 *
 * - a segment-based edit buffer (typed text + atomic paste placeholders)
 * - bracketed-paste input handling
 * - cursor movement (char / word / visual line) matching pi-tui's editor
 * - word deletion matching pi-tui's editor
 * - display↔content position mapping (paste placeholders collapse content)
 * - windowed rendering with a hardware cursor marker
 *
 * It deliberately knows nothing about themes or Container/Text: renderLines()
 * returns plain strings and the caller wraps them in Text components and
 * supplies pre-styled prefixes/placeholders. This keeps the editor composable
 * into any dialog layout (inline label, stacked label, standalone field).
 *
 * Navigation caveat: up/down movement uses the visual-line state computed by
 * the most recent renderLines() call, so callers must render once before
 * vertical movement can work (always true in practice: input is processed
 * after the first render).
 */

import { CURSOR_MARKER, matchesKey } from "@earendil-works/pi-tui";
import { wrapPreservingSpaces } from "../common/text";

// Character count above which an inline paste becomes a placeholder segment
export const LARGE_PASTE_THRESHOLD = 150;

// ASCII punctuation treated as its own word-stop boundary, matching pi-tui's
// editor word navigation (e.g. "foo.bar" stops at foo, ".", bar).
const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

// Shared Unicode word segmenter, matching pi-tui's editor. Used for word
// movement/deletion in the inline edit field.
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

// True when an Intl.Segmenter word segment is entirely whitespace.
function isWhitespaceSegment(segment: string): boolean {
    return segment.length === 0 || /^\s+$/.test(segment);
}

// Edit buffer segment: typed text or a large paste shown as placeholder
export type EditSegment =
    { type: "text"; content: string } | { type: "paste"; content: string; display: string };

// Visual line info for cursor navigation
export interface EditVisLine {
    dispStart: number; // start offset in display string
    dispEnd: number; // end offset (exclusive) in display string
    text: string; // visible text (plain, no prefix)
}

// Result of handling an edit-mode key
// - "submit":   Enter pressed — caller confirms
// - "cancel":   Escape pressed — caller exits edit mode
// - "consumed": key handled by the editor (movement/deletion/insertion)
export type EditKeyResult = "submit" | "cancel" | "consumed";

// Result of handlePasteInput
export interface PasteResult {
    // True if the key was consumed by paste handling
    consumed: boolean;
    // True if the buffer changed (caller should invalidate)
    changed: boolean;
    // Leftover input after the paste end marker — caller should re-dispatch
    // it through its normal input handling
    remaining?: string;
}

// Options for renderLines
export interface RenderEditLinesOptions {
    // Wrap width for the edit text (caller accounts for its own prefixes)
    width: number;
    // Max visible visual lines before truncating with "…" (default: 3).
    // MUST be >= 3 so the cursor always has a safe middle line between the
    // truncated first/last lines (cursor is never placed on those).
    maxLines?: number;
    // Pre-styled placeholder shown when the buffer is empty
    placeholder?: string;
    // Pre-styled text rendered before the edit text on the FIRST visible
    // line (e.g. an accent-styled "Label: ")
    firstLinePrefix?: string;
    // Leading prefix for each rendered line by window index (e.g. arrow on
    // the first line, indentation on continuation lines). Default: none.
    linePrefixFor?: (windowIndex: number) => string;
}

/**
 * InlineEditor - a composable inline text editing engine.
 *
 * Typical usage in a dialog component:
 *
 *   handleInput(key) {
 *       const paste = this.editor.handlePasteInput(key, this.editing);
 *       if (paste.consumed) {
 *           if (paste.changed) this.invalidate();
 *           if (paste.remaining) this.handleInput(paste.remaining);
 *           return;
 *       }
 *       if (this.editing) {
 *           const result = this.editor.handleKey(key);
 *           if (result === "submit") { this.confirm(); return; }
 *           if (result === "cancel") { this.editing = false; this.editor.clear(); }
 *           this.invalidate();
 *           return;
 *       }
 *       // ... selection-mode keys
 *   }
 */
export class InlineEditor {
    // Set by the host when the TUI focus changes; controls whether the
    // hardware CURSOR_MARKER is emitted during rendering.
    focused = false;

    // ── Edit buffer (segment-based) ──
    private segments: EditSegment[] = [];
    private cursorPos = 0;
    private desiredCol: number | null = null;

    // ── Paste input state ──
    private pasteBuffer = "";
    private isInPaste = false;

    // ── Navigation state (computed during renderLines) ──
    private allVisLines: EditVisLine[] = [];
    private dispToContent: number[] = [];
    private cursorDispOff = 0;
    private cursorVisLineIdx = 0;

    // ── Public buffer API ────────────────────────────────────────────

    /** The full text content (paste placeholders expanded to real content). */
    get text(): string {
        return this.segments.map((s) => s.content).join("");
    }

    get isEmpty(): boolean {
        return this.segments.length === 0 || this.getContentLength() === 0;
    }

    /** Reset the buffer and cursor. */
    clear(): void {
        this.segments = [];
        this.cursorPos = 0;
        this.desiredCol = null;
    }

    /** Programmatically set the buffer to plain text, cursor at end. */
    setText(text: string): void {
        this.segments = text.length > 0 ? [{ type: "text", content: text }] : [];
        this.cursorPos = text.length;
        this.desiredCol = null;
    }

    // ── Input handling ───────────────────────────────────────────────

    /**
     * Handle bracketed paste input.
     * @param key    raw input data
     * @param active whether edit mode is active; pastes received while
     *               inactive are consumed and discarded
     */
    handlePasteInput(key: string, active: boolean): PasteResult {
        const hasPasteStart = key.includes("\x1b[200~");

        // Not in paste and no start marker — not paste input
        if (!this.isInPaste && !hasPasteStart) return { consumed: false, changed: false };

        // Paste start received while inactive — consume and discard
        if (hasPasteStart && !active) {
            const stripped = key.replace("\x1b[200~", "");
            // If the end marker is in the same chunk, consume entirely
            if (stripped.includes("\x1b[201~")) return { consumed: true, changed: false };
            // Otherwise enter discard mode to consume the rest
            this.isInPaste = true;
            this.pasteBuffer = "";
            return { consumed: true, changed: false };
        }

        // Paste start in active mode — begin buffering
        if (hasPasteStart) {
            this.isInPaste = true;
            this.pasteBuffer = "";
            key = key.replace("\x1b[200~", "");
        }

        this.pasteBuffer += key;
        const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
        if (endIndex === -1) return { consumed: true, changed: false }; // still buffering

        // Paste complete
        const pasteContent = this.pasteBuffer.substring(0, endIndex);
        this.isInPaste = false;
        const remaining = this.pasteBuffer.substring(endIndex + 6);
        this.pasteBuffer = "";

        let changed = false;
        if (active) {
            const cleanText = pasteContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            const isLarge = cleanText.includes("\n") || cleanText.length > LARGE_PASTE_THRESHOLD;
            if (isLarge) {
                const lineCount = cleanText.split("\n").length;
                const display =
                    lineCount > 1
                        ? `[Pasted ${lineCount} lines]`
                        : `[Pasted ${cleanText.length} chars]`;
                this.insertSegmentAtCursor({ type: "paste", content: cleanText, display });
            } else {
                this.insertAtCursor(cleanText);
            }
            changed = true;
        }

        return remaining ? { consumed: true, changed, remaining } : { consumed: true, changed };
    }

    /**
     * Handle an edit-mode key. Enter/Escape are reported back to the caller
     * (as "submit"/"cancel"); everything else is consumed by the editor.
     */
    handleKey(key: string): EditKeyResult {
        if (matchesKey(key, "escape")) {
            return "cancel";
        }

        if (matchesKey(key, "enter")) {
            return "submit";
        }

        // Word deletion (matches pi-tui editor: Ctrl+W / Alt+Backspace, Alt+D / Alt+Delete)
        if (matchesKey(key, "ctrl+w") || matchesKey(key, "alt+backspace")) {
            this.deleteWordBeforeCursor();
            return "consumed";
        }

        if (matchesKey(key, "alt+d") || matchesKey(key, "alt+delete")) {
            this.deleteWordAfterCursor();
            return "consumed";
        }

        if (matchesKey(key, "backspace")) {
            this.deleteBeforeCursor();
            return "consumed";
        }

        if (matchesKey(key, "delete")) {
            this.deleteAfterCursor();
            return "consumed";
        }

        // Word movement (matches pi-tui editor: Alt/Ctrl+Left/Right, Alt+B/F)
        if (
            matchesKey(key, "alt+left") ||
            matchesKey(key, "ctrl+left") ||
            matchesKey(key, "alt+b")
        ) {
            this.moveCursorWordLeft();
            return "consumed";
        }

        if (
            matchesKey(key, "alt+right") ||
            matchesKey(key, "ctrl+right") ||
            matchesKey(key, "alt+f")
        ) {
            this.moveCursorWordRight();
            return "consumed";
        }

        if (matchesKey(key, "left")) {
            this.moveCursorLeft();
            return "consumed";
        }

        if (matchesKey(key, "right")) {
            this.moveCursorRight();
            return "consumed";
        }

        if (matchesKey(key, "up")) {
            this.moveCursorUp();
            return "consumed";
        }

        if (matchesKey(key, "down")) {
            this.moveCursorDown();
            return "consumed";
        }

        if (key.length === 1 && key.charCodeAt(0) >= 32) {
            this.insertAtCursor(key);
            this.desiredCol = null;
        }
        return "consumed";
    }

    // ── Rendering ────────────────────────────────────────────────────

    /**
     * Render the edit area as plain strings (one per visual line), updating
     * the navigation state used by up/down cursor movement.
     *
     * Handles: paste-placeholder display mapping, word wrapping, windowed
     * truncation with "…" indicators, and cursor marker insertion. The
     * caller supplies all styling via pre-styled prefixes/placeholder and
     * wraps the returned strings in Text components.
     */
    renderLines(options: RenderEditLinesOptions): string[] {
        const {
            width,
            maxLines = 3,
            placeholder = "",
            firstLinePrefix = "",
            linePrefixFor = () => "",
        } = options;

        const buffer = this.text;
        const hasContent = buffer.length > 0;
        const marker = this.focused ? CURSOR_MARKER : "";
        const visualCursor = "\x1b[7m \x1b[27m";
        const isAtEnd = this.cursorPos >= buffer.length;

        if (!hasContent) {
            // Empty buffer — cursor at start
            this.allVisLines = [];
            this.dispToContent = [];
            this.cursorDispOff = 0;
            this.cursorVisLineIdx = 0;
            return [`${linePrefixFor(0)}${firstLinePrefix}${marker}${visualCursor}${placeholder}`];
        }

        // Build display buffer with content↔display mapping
        const { display, contentToDisp, dispToContent } = this.buildDisplayMapping();

        // Store for up/down navigation
        this.dispToContent = dispToContent;
        this.cursorDispOff = contentToDisp[this.cursorPos] ?? display.length;

        // Build visual lines
        const { allVisLines, cursorVisLineIdx } = this.buildEditVisualLines(
            display,
            this.cursorDispOff,
            width,
        );

        // Apply line limit: show window that includes cursor's visual line.
        // Offset by 1 so the cursor is never on the first visible line when
        // top-truncated (or the last when bottom-truncated). With maxLines
        // >= 3 the cursor is always in the safe middle.
        let startLine: number;
        if (allVisLines.length <= maxLines) {
            startLine = 0;
        } else {
            startLine = Math.max(0, Math.min(cursorVisLineIdx - 1, allVisLines.length - maxLines));
        }
        const endLine = Math.min(allVisLines.length, startLine + maxLines);
        const visibleVisLines = allVisLines.slice(startLine, endLine);

        // Store navigation state
        this.allVisLines = allVisLines;
        this.cursorVisLineIdx = cursorVisLineIdx;

        const isTruncatedTop = startLine > 0;
        const isTruncatedBottom = endLine < allVisLines.length;

        const lines: string[] = [];

        for (let vi = 0; vi < visibleVisLines.length; vi++) {
            const vl = visibleVisLines[vi]!;
            const isCursorLine = startLine + vi === cursorVisLineIdx;
            const isFirst = vi === 0;
            const isLast = vi === visibleVisLines.length - 1;

            const linePrefix = linePrefixFor(vi);

            // Top truncation indicator (content hidden above this window)
            // sits on the first visible line, right before its text; the
            // bottom indicator sits at the end of the last visible line.
            // Neither ever costs an extra line.
            const topEllipsis = isFirst && isTruncatedTop ? "…" : "";
            const suffixText = isLast && isTruncatedBottom ? "…" : "";

            const beforeCursor = (isFirst ? firstLinePrefix : "") + topEllipsis;

            if (isCursorLine) {
                // Cursor is never on a truncated line, so displayText is the
                // full text of the visual line
                const displayText = vl.text;
                const cursorColInText = this.cursorDispOff - vl.dispStart;
                const insertAt =
                    beforeCursor.length + Math.min(cursorColInText, displayText.length);

                if (isAtEnd) {
                    // Cursor at end of buffer — append marker + visual cursor + suffix
                    lines.push(
                        `${linePrefix}${beforeCursor}${displayText}${suffixText}${marker}${visualCursor}`,
                    );
                } else {
                    // Cursor mid-line — highlight the character under the cursor
                    const full = beforeCursor + displayText + suffixText;
                    const charUnderCursor = full[insertAt];
                    if (charUnderCursor) {
                        const highlighted = `\x1b[7m${charUnderCursor}\x1b[27m`;
                        lines.push(
                            `${linePrefix}${full.slice(0, insertAt)}${marker}${highlighted}${full.slice(insertAt + 1)}`,
                        );
                    } else {
                        lines.push(`${linePrefix}${full}${marker}${visualCursor}`);
                    }
                }
            } else {
                // For truncated lines, slice off one char at each end an
                // ellipsis occupies so the line keeps its width.
                let displayText = vl.text;
                if (topEllipsis) {
                    displayText = displayText.slice(1);
                }
                if (suffixText) {
                    displayText = displayText.slice(0, displayText.length - 1);
                }
                lines.push(`${linePrefix}${beforeCursor}${displayText}${suffixText}`);
            }
        }

        return lines;
    }

    // ── Segment / cursor helpers ─────────────────────────────────────

    private getContentLength(): number {
        return this.segments.reduce((sum, s) => sum + s.content.length, 0);
    }

    /** Map flat content position to (segmentIndex, offset within segment). */
    private getSegmentAtPos(pos: number): { segIdx: number; offset: number } {
        let accumulated = 0;
        for (let i = 0; i < this.segments.length; i++) {
            const segLen = this.segments[i]!.content.length;
            if (pos <= accumulated + segLen) {
                return { segIdx: i, offset: pos - accumulated };
            }
            accumulated += segLen;
        }
        // Past the end — clamp to end of last segment
        const lastIdx = Math.max(0, this.segments.length - 1);
        return { segIdx: lastIdx, offset: this.segments[lastIdx]?.content.length ?? 0 };
    }

    /** Map (segmentIndex, offset) to flat content position. */
    private getFlatPos(segIdx: number, offset: number): number {
        let pos = 0;
        for (let i = 0; i < segIdx; i++) {
            pos += this.segments[i]!.content.length;
        }
        return pos + offset;
    }

    // ── Cursor movement ──────────────────────────────────────────────

    private moveCursorLeft(): void {
        if (this.cursorPos <= 0) return;
        this.cursorPos--;
        this.desiredCol = null;
        // If landed inside a paste segment, jump to its start
        const { segIdx } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.segments[segIdx];
        if (seg?.type === "paste") {
            this.cursorPos = this.getFlatPos(segIdx, 0);
        }
    }

    private moveCursorRight(): void {
        const totalLen = this.getContentLength();
        if (this.cursorPos >= totalLen) return;
        this.cursorPos++;
        this.desiredCol = null;
        // If landed inside a paste segment, jump to its end
        const { segIdx } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.segments[segIdx];
        if (seg?.type === "paste") {
            this.cursorPos = this.getFlatPos(segIdx, seg.content.length);
        }
    }

    private moveCursorUp(): void {
        if (this.allVisLines.length === 0) return;

        const curLine = this.cursorVisLineIdx;
        if (curLine <= 0) {
            // Already on absolute first line — move to start
            this.cursorPos = 0;
            this.desiredCol = null;
            return;
        }

        const curVl = this.allVisLines[curLine]!;
        const curCol = this.desiredCol ?? this.cursorDispOff - curVl.dispStart;
        this.desiredCol = curCol;

        const prev = this.allVisLines[curLine - 1]!;
        let targetDispOff = Math.min(prev.dispStart + curCol, prev.dispEnd);
        // Avoid boundary: prev.dispEnd == next.dispStart, which the visual line
        // finder (< dispEnd) assigns to the next line. Step inside prev.
        if (targetDispOff === prev.dispEnd && prev.dispEnd > prev.dispStart) {
            targetDispOff--;
        }
        this.cursorPos = this.dispToContent[targetDispOff] ?? 0;
    }

    private moveCursorDown(): void {
        if (this.allVisLines.length === 0) return;

        const curLine = this.cursorVisLineIdx;
        if (curLine === -1 || curLine >= this.allVisLines.length - 1) {
            // Already on absolute last line — move to end
            this.cursorPos = this.getContentLength();
            this.desiredCol = null;
            return;
        }

        const curVl = this.allVisLines[curLine]!;
        const curCol = this.desiredCol ?? this.cursorDispOff - curVl.dispStart;
        this.desiredCol = curCol;

        const nextIdx = curLine + 1;
        const next = this.allVisLines[nextIdx]!;
        let targetDispOff = Math.min(next.dispStart + curCol, next.dispEnd);
        // Avoid boundary: if next is not the last visual line, next.dispEnd ==
        // nextnext.dispStart, which the visual line finder (< dispEnd) assigns to
        // the line after next. On the last line, dispEnd is a valid end-of-buffer
        // position (finder uses fallback) — don't step back.
        if (
            nextIdx < this.allVisLines.length - 1 &&
            targetDispOff === next.dispEnd &&
            next.dispEnd > next.dispStart
        ) {
            targetDispOff--;
        }
        this.cursorPos = this.dispToContent[targetDispOff] ?? this.getContentLength();
    }

    // ── Word navigation ─────────────────────────────────────────────
    //
    // Mirrors pi-tui's editor word movement so the inline edit field
    // behaves like the main editor: Intl.Segmenter "word" granularity
    // refined with ASCII punctuation boundaries. Paste segments are atomic —
    // movement and deletion jump over a whole paste marker rather than
    // stopping inside one.

    private findWordBoundaryBackward(text: string, cursor: number): number {
        if (cursor <= 0) return 0;
        const segments = [...wordSegmenter.segment(text.slice(0, cursor))];
        let newCursor = cursor;

        // Skip trailing whitespace.
        while (segments.length > 0 && isWhitespaceSegment(segments[segments.length - 1]!.segment)) {
            newCursor -= segments.pop()!.segment.length;
        }
        if (segments.length === 0) return newCursor;

        const last = segments[segments.length - 1]!;
        if (last.isWordLike) {
            // Skip one word, stopping just after its trailing punctuation.
            const segment = last.segment;
            const matches = [...segment.matchAll(new RegExp(PUNCTUATION_REGEX.source, "g"))];
            if (matches.length === 0) {
                newCursor -= segment.length;
            } else {
                const lastMatch = matches[matches.length - 1]!;
                newCursor -= segment.length - (lastMatch.index + lastMatch[0].length);
            }
        } else {
            // Skip a run of punctuation (non-word, non-whitespace).
            while (segments.length > 0) {
                const s = segments[segments.length - 1]!;
                if (s.isWordLike || isWhitespaceSegment(s.segment)) break;
                newCursor -= segments.pop()!.segment.length;
            }
        }
        return newCursor;
    }

    private findWordBoundaryForward(text: string, cursor: number): number {
        if (cursor >= text.length) return text.length;
        const iterator = wordSegmenter.segment(text.slice(cursor))[Symbol.iterator]();
        let next = iterator.next();
        let newCursor = cursor;

        // Skip leading whitespace.
        while (!next.done && isWhitespaceSegment(next.value.segment)) {
            newCursor += next.value.segment.length;
            next = iterator.next();
        }
        if (next.done) return newCursor;

        if (next.value.isWordLike) {
            // Skip up to the first punctuation inside the word.
            const segment = next.value.segment;
            const match = PUNCTUATION_REGEX.exec(segment);
            newCursor += match ? match.index : segment.length;
        } else {
            // Skip a run of punctuation (non-word, non-whitespace).
            while (!next.done) {
                const v = next.value;
                if (v.isWordLike || isWhitespaceSegment(v.segment)) break;
                newCursor += v.segment.length;
                next = iterator.next();
            }
        }
        return newCursor;
    }

    private getSegmentFlatBounds(): { start: number; end: number; type: "text" | "paste" }[] {
        const bounds: { start: number; end: number; type: "text" | "paste" }[] = [];
        let pos = 0;
        for (const seg of this.segments) {
            const end = pos + seg.content.length;
            bounds.push({ start: pos, end, type: seg.type });
            pos = end;
        }
        return bounds;
    }

    /**
     * Snap a flat position to the edge of any paste segment it lands inside.
     * Paste markers are atomic, so word movement never stops within one.
     */
    private clampPosToPasteBoundary(pos: number, direction: "backward" | "forward"): number {
        for (const b of this.getSegmentFlatBounds()) {
            if (b.type === "paste" && pos > b.start && pos < b.end) {
                return direction === "backward" ? b.start : b.end;
            }
        }
        return pos;
    }

    private moveCursorWordLeft(): void {
        const target = this.findWordBoundaryBackward(this.text, this.cursorPos);
        this.cursorPos = this.clampPosToPasteBoundary(target, "backward");
        this.desiredCol = null;
    }

    private moveCursorWordRight(): void {
        const target = this.findWordBoundaryForward(this.text, this.cursorPos);
        this.cursorPos = this.clampPosToPasteBoundary(target, "forward");
        this.desiredCol = null;
    }

    /** Delete the flat content range [start, end), merging adjacent text segments. */
    private deleteRange(start: number, end: number): void {
        if (start >= end) return;
        const newSegments: EditSegment[] = [];
        let flatPos = 0;
        for (const seg of this.segments) {
            const segStart = flatPos;
            const segEnd = flatPos + seg.content.length;
            flatPos = segEnd;

            // No overlap with the deletion range — keep as-is.
            if (segEnd <= start || segStart >= end) {
                newSegments.push(seg);
                continue;
            }

            if (seg.type === "paste") {
                // Paste segments are atomic: any overlap drops the whole marker.
                continue;
            }

            const keepBefore = Math.max(0, start - segStart);
            const keepAfter = Math.max(0, segEnd - end);
            if (keepBefore > 0) {
                newSegments.push({ type: "text", content: seg.content.slice(0, keepBefore) });
            }
            if (keepAfter > 0) {
                newSegments.push({
                    type: "text",
                    content: seg.content.slice(seg.content.length - keepAfter),
                });
            }
        }
        this.segments = newSegments;
        this.mergeAdjacentTextSegments();
        this.cursorPos = start;
        this.desiredCol = null;
    }

    private mergeAdjacentTextSegments(): void {
        for (let i = 0; i < this.segments.length - 1; i++) {
            const cur = this.segments[i];
            const next = this.segments[i + 1];
            if (cur?.type === "text" && next?.type === "text") {
                cur.content += next.content;
                this.segments.splice(i + 1, 1);
                i--;
            }
        }
    }

    private deleteWordBeforeCursor(): void {
        if (this.cursorPos <= 0) return;
        const target = this.findWordBoundaryBackward(this.text, this.cursorPos);
        const from = this.clampPosToPasteBoundary(target, "backward");
        this.deleteRange(from, this.cursorPos);
    }

    private deleteWordAfterCursor(): void {
        if (this.cursorPos >= this.getContentLength()) return;
        const target = this.findWordBoundaryForward(this.text, this.cursorPos);
        const to = this.clampPosToPasteBoundary(target, "forward");
        this.deleteRange(this.cursorPos, to);
    }

    // ── Editing ─────────────────────────────────────────────────────

    /** Insert a segment (text or paste) at the cursor position. */
    private insertSegmentAtCursor(segment: EditSegment): void {
        if (this.segments.length === 0) {
            this.segments.push(segment);
            this.cursorPos = segment.content.length;
            return;
        }

        const { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.segments[segIdx];

        if (seg && seg.type === "text") {
            // Split the text segment at the cursor and insert between the halves
            const before = seg.content.slice(0, offset);
            const after = seg.content.slice(offset);
            const spliceArgs: EditSegment[] = [];
            if (before.length > 0) spliceArgs.push({ type: "text", content: before });
            spliceArgs.push(segment);
            if (after.length > 0) spliceArgs.push({ type: "text", content: after });
            this.segments.splice(segIdx, 1, ...spliceArgs);
        } else {
            // At a paste boundary — insert adjacent to it
            const insertIdx =
                seg?.type === "paste" && offset === seg.content.length ? segIdx + 1 : segIdx;
            this.segments.splice(insertIdx, 0, segment);
        }

        this.cursorPos += segment.content.length;
    }

    /** Insert plain text at cursor position, merging into adjacent text segments. */
    private insertAtCursor(text: string): void {
        if (this.segments.length === 0) {
            this.segments.push({ type: "text", content: text });
            this.cursorPos = text.length;
            return;
        }

        const { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.segments[segIdx];

        if (seg && seg.type === "text") {
            // Insert directly into the existing text segment
            seg.content = seg.content.slice(0, offset) + text + seg.content.slice(offset);
        } else {
            // At a paste boundary — create new text segment
            const insertIdx =
                seg?.type === "paste" && offset === seg.content.length ? segIdx + 1 : segIdx;
            // Try to merge with adjacent text segment
            const prev = insertIdx > 0 ? this.segments[insertIdx - 1] : undefined;
            if (prev && prev.type === "text" && offset === 0) {
                prev.content += text;
            } else {
                this.segments.splice(insertIdx, 0, { type: "text", content: text });
            }
        }
        this.cursorPos += text.length;
    }

    /** Remove a paste segment and merge adjacent text segments if both are text. */
    private removeSegmentAndMerge(segIdx: number): void {
        const before = segIdx > 0 ? this.segments[segIdx - 1] : undefined;
        const after = this.segments[segIdx + 1];
        if (before?.type === "text" && after?.type === "text") {
            before.content += after.content;
            this.segments.splice(segIdx, 2);
        } else {
            this.segments.splice(segIdx, 1);
        }
    }

    /** Delete character/segment before cursor (backspace). */
    private deleteBeforeCursor(): void {
        if (this.cursorPos <= 0) return;

        let { segIdx, offset } = this.getSegmentAtPos(this.cursorPos - 1);
        let seg = this.segments[segIdx];
        if (!seg) return;

        // At start of a text segment — backspace should target the previous segment
        if (seg.type === "text" && offset === 0 && segIdx > 0) {
            segIdx--;
            seg = this.segments[segIdx]!;
            offset = seg.type === "paste" ? seg.content.length : seg.content.length - 1;
        }

        if (seg.type === "paste") {
            this.cursorPos -= seg.content.length;
            this.removeSegmentAndMerge(segIdx);
        } else {
            seg.content = seg.content.slice(0, offset) + seg.content.slice(offset + 1);
            this.cursorPos--;
            if (seg.content.length === 0) {
                this.segments.splice(segIdx, 1);
            }
        }
    }

    /** Delete character/segment at cursor (forward delete). */
    private deleteAfterCursor(): void {
        if (this.cursorPos >= this.getContentLength()) return;

        let { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        let seg = this.segments[segIdx];
        if (!seg) return;

        // At end of a text segment — forward delete should target the next segment
        if (seg.type === "text" && offset === seg.content.length) {
            const next = this.segments[segIdx + 1];
            if (next) {
                segIdx++;
                seg = next;
                offset = 0;
            }
        }

        if (seg.type === "paste") {
            this.removeSegmentAndMerge(segIdx);
        } else {
            seg.content = seg.content.slice(0, offset) + seg.content.slice(offset + 1);
            if (seg.content.length === 0) {
                this.segments.splice(segIdx, 1);
            }
        }
    }

    // ── Display mapping & visual lines ──────────────────────────────

    /**
     * Build the display buffer from segments (replacing paste content with
     * placeholders) and the content↔display position mapping.
     */
    private buildDisplayMapping(): {
        display: string;
        contentToDisp: number[];
        dispToContent: number[];
    } {
        let display = "";
        const contentToDisp: number[] = [];
        const dispToContent: number[] = [];
        let cPos = 0;

        for (const seg of this.segments) {
            if (seg.type === "paste") {
                const dStart = display.length;
                // Content start maps to display start
                contentToDisp[cPos] = dStart;
                // All placeholder chars map to paste start content position
                for (let di = 0; di < seg.display.length; di++) {
                    dispToContent[dStart + di] = cPos;
                }
                display += seg.display;
                // Content end maps to display end
                const dEnd = display.length;
                cPos += seg.content.length;
                contentToDisp[cPos] = dEnd;
                dispToContent[dEnd] = cPos;
            } else {
                for (let i = 0; i < seg.content.length; i++) {
                    contentToDisp[cPos + i] = display.length + i;
                    dispToContent[display.length + i] = cPos + i;
                }
                display += seg.content;
                // End-boundary: map the position just past the text
                const dEnd = display.length;
                cPos += seg.content.length;
                contentToDisp[cPos] = dEnd;
                dispToContent[dEnd] = cPos;
            }
        }

        return { display, contentToDisp, dispToContent };
    }

    /**
     * Wrap the display buffer into visual lines and locate the cursor's line.
     * Handles line splits from `\n` and word-wrapping within each split.
     */
    private buildEditVisualLines(
        display: string,
        cursorDispOff: number,
        lineWidth: number,
    ): { allVisLines: EditVisLine[]; cursorVisLineIdx: number } {
        const displayLines = display.split("\n");
        const allVisLines: EditVisLine[] = [];
        let dOff = 0;

        for (let li = 0; li < displayLines.length; li++) {
            const dLine = displayLines[li]!;
            const parts = dLine.length === 0 ? [""] : wrapPreservingSpaces(dLine, lineWidth);

            let lineDOff = dOff;
            for (const part of parts) {
                allVisLines.push({
                    dispStart: lineDOff,
                    dispEnd: lineDOff + part.length,
                    text: part,
                });
                lineDOff += part.length;
            }
            // Account for the \n character in display offsets
            dOff += dLine.length + (li < displayLines.length - 1 ? 1 : 0);
        }

        // Find cursor's visual line (use < for exclusive dispEnd)
        let cursorVisLineIdx = allVisLines.findIndex(
            (vl) => cursorDispOff >= vl.dispStart && cursorDispOff < vl.dispEnd,
        );
        if (cursorVisLineIdx === -1) {
            // Cursor at end of buffer (past all dispEnds) — use last line
            cursorVisLineIdx = allVisLines.length - 1;
        }

        return { allVisLines, cursorVisLineIdx };
    }
}
