/**
 * Select with Inline Message Component
 *
 * A single-select UI component with a scrollable content area (like a pager)
 * and an optional inline message edited by pressing Tab.
 *
 * Layout:
 *   ┌─── DynamicBorder ────────────────────────┐
 *   │  Title (fixed, always visible)           │
 *   │                                          │
 *   │  ┌─ contentBox (scrollable) ───────────┐ │
 *   │  │  Content lines (PgUp/PgDn to scroll)│ │
 *   │  │  ...                                │ │
 *   │  │  Showing lines X-Y of Z             │ │
 *   │  └─────────────────────────────────────┘ │
 *   │                                          │
 *   │  → Item 1                                │
 *   │    Item 2                                │
 *   │    Item 3                                │
 *   │                                          │
 *   │  Help text                               │
 *   └─── DynamicBorder ────────────────────────┘
 *
 * Flow:
 * - ↑/↓ navigate options
 * - Enter selects option immediately (no message)
 * - Tab switches to inline edit mode: "Option, |" where cursor types
 * - In edit mode: Enter confirms with message, Escape returns to selection
 * - In edit mode: ←/→ move cursor, ↑/↓ navigate visual lines
 * - PageUp/PageDown scrolls the content area
 *
 * Edit buffer model:
 * - Segments: typed text or large pastes (shown as placeholder)
 * - cursorPos: flat offset into concatenated content
 * - Paste segments are atomic for cursor navigation (left/right skip them)
 * - Display buffer replaces paste content with placeholders; cursor mapping
 *   translates between content and display positions
 *
 * Scrolling:
 * - scrollOffset is a visual-row index (accounts for wrapped lines)
 * - When a wrapped line is split by scrolling, the continuation gets an
 *   ellipsis prefix ("… │ ") to indicate it belongs to the line above
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
    CURSOR_MARKER,
    Box,
    Container,
    matchesKey,
    Spacer,
    Text,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { wrapPreservingSpaces } from "../common/text";

// ─── Layout & behavior constants ─────────────────────────────────────

// Total horizontal padding: Container → Box(padX=CONTENT_BOX_PAD_X) → Text(padX=1)
// = 2*CONTENT_BOX_PAD_X + 2*1
const HORIZONTAL_PADDING = 4;

const CONTENT_BOX_PAD_X = 1;
const CONTENT_BOX_PAD_Y = 0;

// Max visual lines in the inline edit area before truncating.
// MUST be >= 3 so the cursor always has a safe middle line between
// the truncated first/last lines (cursor is never placed on those).
const MAX_EDIT_LINES = 3;

// Character count above which an inline paste becomes a placeholder segment
const LARGE_PASTE_THRESHOLD = 150;

// Visible width of the "…" truncation indicator
const ELLIPSIS_VISUAL_WIDTH = 1;

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

// ─── Public types ────────────────────────────────────────────────────

// An item in the select list
export interface SelectMessageItem<T> {
    value: T;
    label: string;
    description?: string;
    // Optional placeholder for message input (overrides default)
    placeholder?: string;
}

// Options for the select-with-message component
export interface SelectWithMessageOptions<T> {
    // Title shown at the top (always visible). May be a function so it
    // can change while the dialog is open (re-evaluated on every render,
    // e.g. to show a live mode indicator).
    title: string | (() => string);
    // Content lines displayed in the scrollable area (e.g. command text)
    contentLines: string[];
    // Items to select from (always visible below content area)
    items: SelectMessageItem<T>[];
    // Initial cursor position
    initialCursor?: number;
    // Maximum visible lines in the scrollable content area (default: 10)
    maxContentLines?: number;
    // Optional border tone (default "border"). May be a function so it
    // can change while the dialog is open — DynamicBorder re-evaluates
    // the color function on every render.
    borderTone?: "border" | "borderAccent" | (() => "border" | "borderAccent");
    // Optional custom key handler for selection mode, called before
    // the built-in handling (in edit mode keys go to the editor and
    // this is not called). Return true if the key was handled.
    handleSelectInput?: (key: string) => boolean;
    // Custom help text for selection mode
    selectHelpText?: string;
    // Custom help text for edit mode
    editHelpText?: string;
    // Separator between label and user message (default: ", ")
    messageSeparator?: string;
    // Placeholder shown when editing and no message typed yet
    messagePlaceholder?: string;
}

// Result of the selection
export interface SelectWithMessageResult<T> {
    value: T;
    // The custom message appended by the user (if any)
    message?: string;
    // The full display text (label + message)
    displayText: string;
}

// ─── Internal types ──────────────────────────────────────────────────

// Per-logical-line info after wrapping (content only, no prefixes)
interface LogicalLineInfo {
    // Wrapped text parts (raw content, no prefix)
    parts: string[];
    // Number of visual rows this logical line occupies
    visualCount: number;
}

// Edit buffer segment: typed text or a large paste shown as placeholder
type EditSegment =
    | { type: "text"; content: string }
    | { type: "paste"; content: string; display: string };

// Maps a visual row to its logical line and part
interface FlatEntry {
    logicalIdx: number;
    partIdx: number;
}

// Visual line info for cursor navigation
interface EditVisLine {
    dispStart: number;  // start offset in display string
    dispEnd: number;    // end offset (exclusive) in display string
    text: string;       // visible text (plain, no prefix)
}

// ─── SelectWithMessageComponent ──────────────────────────────────────

class SelectWithMessageComponent<T> implements Component, Focusable {
    // ── Theme & layout ──
    private theme: Theme | null = null;
    private readonly container: Container;
    private readonly contentBox: Box;
    private titleText!: Text;

    // ── Configuration ──
    private readonly selectHelpText: string;
    private readonly editHelpText: string;
    private readonly messageSeparator: string;
    private readonly messagePlaceholder: string;
    private readonly maxContentLines: number;
    private readonly borderTone?: "border" | "borderAccent" | (() => "border" | "borderAccent");

    // ── Selection state ──
    private cursor: number;
    private editing = false;
    private _focused = false;

    // ── Edit buffer (segment-based) ──
    private editSegments: EditSegment[] = [];
    private cursorPos = 0;
    private desiredCol: number | null = null;

    // ── Paste input state ──
    private pasteBuffer = "";
    private isInPaste = false;

    // ── Content area scroll ──
    private scrollOffset = 0;
    private lineInfos: LogicalLineInfo[] = [];
    private flatIndex: FlatEntry[] = [];

    // ── Edit navigation state (computed during render) ──
    private editAllVisLines: EditVisLine[] = [];
    private editDispToContent: number[] = [];
    private editCursorDispOff = 0;
    private editCursorVisLineIdx = 0;

    // ── Completion callback ──
    private done!: (result: SelectWithMessageResult<T> | undefined) => void;

    constructor(
        private readonly options: SelectWithMessageOptions<T>,
    ) {
        this.selectHelpText = options.selectHelpText
            ?? "↑/↓ navigate | Enter select | Tab add message | PgUp/PgDn scroll | Esc cancel";
        this.editHelpText = options.editHelpText ?? "Enter confirm | Esc back";
        this.messageSeparator = options.messageSeparator ?? ", ";
        this.messagePlaceholder = options.messagePlaceholder ?? "type a message...";
        this.maxContentLines = options.maxContentLines ?? 10;
        this.borderTone = options.borderTone;
        this.cursor = options.initialCursor ?? 0;

        this.container = new Container();
        this.contentBox = new Box(CONTENT_BOX_PAD_X, CONTENT_BOX_PAD_Y);
    }

    setDoneCallback(done: (result: SelectWithMessageResult<T> | undefined) => void): void {
        this.done = done;
    }

    initialize(theme: Theme): void {
        this.theme = theme;
        const borderColor = (s: string) => {
            const tone = typeof this.borderTone === "function"
                ? this.borderTone()
                : (this.borderTone ?? "border");
            return theme.fg(tone, s);
        };

        this.container.addChild(new DynamicBorder(borderColor));

        // Title (fixed position, always visible; the text is updated on
        // every render in rebuildContent so it may reflect live state)
        this.titleText = new Text("", 1, 0);
        this.container.addChild(this.titleText);
        this.container.addChild(new Spacer(1));

        // Scrollable content area + items + help text
        this.container.addChild(this.contentBox);

        this.container.addChild(new Spacer(1));
        this.container.addChild(new DynamicBorder(borderColor));
    }

    // ── Component & Focusable interface ─────────────────────────────

    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
    }

    render(width: number): string[] {
        if (!this.theme) {
            throw new Error("SelectWithMessageComponent must be initialized before rendering");
        }
        this.rebuildContent(width);
        return this.container.render(width);
    }

    invalidate(): void {
        this.container.invalidate();
    }

    handleInput(key: string): void {
        if (this.handlePasteInput(key)) return;
        if (this.editing && this.handleEditInput(key)) return;
        this.handleSelectInput(key);
    }

    // ── Completion ──────────────────────────────────────────────────

    private confirmSelection(): void {
        const item = this.options.items[this.cursor];
        if (!item) {
            this.done(undefined);
            return;
        }

        const message = this.editBuffer.trim() || undefined;
        const displayText = message
            ? `${item.label}${this.messageSeparator}${message}`
            : item.label;

        this.done({ value: item.value, message, displayText });
    }

    // ── Segment / cursor helpers ────────────────────────────────────

    private get editBuffer(): string {
        return this.editSegments.map(s => s.content).join("");
    }

    private getContentLength(): number {
        return this.editSegments.reduce((sum, s) => sum + s.content.length, 0);
    }

    /** Map flat content position to (segmentIndex, offset within segment). */
    private getSegmentAtPos(pos: number): { segIdx: number; offset: number } {
        let accumulated = 0;
        for (let i = 0; i < this.editSegments.length; i++) {
            const segLen = this.editSegments[i]!.content.length;
            if (pos <= accumulated + segLen) {
                return { segIdx: i, offset: pos - accumulated };
            }
            accumulated += segLen;
        }
        // Past the end — clamp to end of last segment
        const lastIdx = Math.max(0, this.editSegments.length - 1);
        return { segIdx: lastIdx, offset: this.editSegments[lastIdx]?.content.length ?? 0 };
    }

    /** Map (segmentIndex, offset) to flat content position. */
    private getFlatPos(segIdx: number, offset: number): number {
        let pos = 0;
        for (let i = 0; i < segIdx; i++) {
            pos += this.editSegments[i]!.content.length;
        }
        return pos + offset;
    }

    // ── Cursor movement ─────────────────────────────────────────────

    private moveCursorLeft(): void {
        if (this.cursorPos <= 0) return;
        this.cursorPos--;
        this.desiredCol = null;
        // If landed inside a paste segment, jump to its start
        const { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.editSegments[segIdx];
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
        const seg = this.editSegments[segIdx];
        if (seg?.type === "paste") {
            this.cursorPos = this.getFlatPos(segIdx, seg.content.length);
        }
    }

    private moveCursorUp(): void {
        if (this.editAllVisLines.length === 0) return;

        const curLine = this.editCursorVisLineIdx;
        if (curLine <= 0) {
            // Already on absolute first line — move to start
            this.cursorPos = 0;
            this.desiredCol = null;
            return;
        }

        const curVl = this.editAllVisLines[curLine]!;
        const curCol = this.desiredCol ?? (this.editCursorDispOff - curVl.dispStart);
        this.desiredCol = curCol;

        const prev = this.editAllVisLines[curLine - 1]!;
        let targetDispOff = Math.min(prev.dispStart + curCol, prev.dispEnd);
        // Avoid boundary: prev.dispEnd == next.dispStart, which the visual line
        // finder (< dispEnd) assigns to the next line. Step inside prev.
        if (targetDispOff === prev.dispEnd && prev.dispEnd > prev.dispStart) {
            targetDispOff--;
        }
        this.cursorPos = this.editDispToContent[targetDispOff] ?? 0;
    }

    private moveCursorDown(): void {
        if (this.editAllVisLines.length === 0) return;

        const curLine = this.editCursorVisLineIdx;
        if (curLine === -1 || curLine >= this.editAllVisLines.length - 1) {
            // Already on absolute last line — move to end
            this.cursorPos = this.getContentLength();
            this.desiredCol = null;
            return;
        }

        const curVl = this.editAllVisLines[curLine]!;
        const curCol = this.desiredCol ?? (this.editCursorDispOff - curVl.dispStart);
        this.desiredCol = curCol;

        const nextIdx = curLine + 1;
        const next = this.editAllVisLines[nextIdx]!;
        let targetDispOff = Math.min(next.dispStart + curCol, next.dispEnd);
        // Avoid boundary: if next is not the last visual line, next.dispEnd ==
        // nextnext.dispStart, which the visual line finder (< dispEnd) assigns to
        // the line after next. Step inside next. On the last line, dispEnd is a
        // valid end-of-buffer position (finder uses fallback) — don't step back.
        if (nextIdx < this.editAllVisLines.length - 1
            && targetDispOff === next.dispEnd && next.dispEnd > next.dispStart) {
            targetDispOff--;
        }
        this.cursorPos = this.editDispToContent[targetDispOff] ?? this.getContentLength();
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
        while (
            segments.length > 0 &&
            isWhitespaceSegment(segments[segments.length - 1]!.segment)
        ) {
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
        for (const seg of this.editSegments) {
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
    private clampPosToPasteBoundary(
        pos: number,
        direction: "backward" | "forward",
    ): number {
        for (const b of this.getSegmentFlatBounds()) {
            if (b.type === "paste" && pos > b.start && pos < b.end) {
                return direction === "backward" ? b.start : b.end;
            }
        }
        return pos;
    }

    private moveCursorWordLeft(): void {
        const target = this.findWordBoundaryBackward(this.editBuffer, this.cursorPos);
        this.cursorPos = this.clampPosToPasteBoundary(target, "backward");
        this.desiredCol = null;
    }

    private moveCursorWordRight(): void {
        const target = this.findWordBoundaryForward(this.editBuffer, this.cursorPos);
        this.cursorPos = this.clampPosToPasteBoundary(target, "forward");
        this.desiredCol = null;
    }

    /** Delete the flat content range [start, end), merging adjacent text segments. */
    private deleteRange(start: number, end: number): void {
        if (start >= end) return;
        const newSegments: EditSegment[] = [];
        let flatPos = 0;
        for (const seg of this.editSegments) {
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
        this.editSegments = newSegments;
        this.mergeAdjacentTextSegments();
        this.cursorPos = start;
        this.desiredCol = null;
    }

    private mergeAdjacentTextSegments(): void {
        for (let i = 0; i < this.editSegments.length - 1; i++) {
            const cur = this.editSegments[i];
            const next = this.editSegments[i + 1];
            if (cur?.type === "text" && next?.type === "text") {
                cur.content += next.content;
                this.editSegments.splice(i + 1, 1);
                i--;
            }
        }
    }

    private deleteWordBeforeCursor(): void {
        if (this.cursorPos <= 0) return;
        const target = this.findWordBoundaryBackward(this.editBuffer, this.cursorPos);
        const from = this.clampPosToPasteBoundary(target, "backward");
        this.deleteRange(from, this.cursorPos);
    }

    private deleteWordAfterCursor(): void {
        if (this.cursorPos >= this.getContentLength()) return;
        const target = this.findWordBoundaryForward(this.editBuffer, this.cursorPos);
        const to = this.clampPosToPasteBoundary(target, "forward");
        this.deleteRange(this.cursorPos, to);
    }

    // ── Editing ─────────────────────────────────────────────────────

    /** Insert a segment (text or paste) at the cursor position. */
    private insertSegmentAtCursor(segment: EditSegment): void {
        if (this.editSegments.length === 0) {
            this.editSegments.push(segment);
            this.cursorPos = segment.content.length;
            return;
        }

        const { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.editSegments[segIdx];

        if (seg && seg.type === "text") {
            // Split the text segment at the cursor and insert between the halves
            const before = seg.content.slice(0, offset);
            const after = seg.content.slice(offset);
            const spliceArgs: EditSegment[] = [];
            if (before.length > 0) spliceArgs.push({ type: "text", content: before });
            spliceArgs.push(segment);
            if (after.length > 0) spliceArgs.push({ type: "text", content: after });
            this.editSegments.splice(segIdx, 1, ...spliceArgs);
        } else {
            // At a paste boundary — insert adjacent to it
            const insertIdx = (seg?.type === "paste" && offset === seg.content.length)
                ? segIdx + 1
                : segIdx;
            this.editSegments.splice(insertIdx, 0, segment);
        }

        this.cursorPos += segment.content.length;
    }

    /** Insert plain text at cursor position, merging into adjacent text segments. */
    private insertAtCursor(text: string): void {
        if (this.editSegments.length === 0) {
            this.editSegments.push({ type: "text", content: text });
            this.cursorPos = text.length;
            return;
        }

        const { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.editSegments[segIdx];

        if (seg && seg.type === "text") {
            // Insert directly into the existing text segment
            seg.content = seg.content.slice(0, offset) + text + seg.content.slice(offset);
        } else {
            // At a paste boundary — create new text segment
            const insertIdx = (seg?.type === "paste" && offset === seg.content.length)
                ? segIdx + 1
                : segIdx;
            // Try to merge with adjacent text segment
            const prev = insertIdx > 0 ? this.editSegments[insertIdx - 1] : undefined;
            if (prev && prev.type === "text" && offset === 0) {
                prev.content += text;
            } else {
                this.editSegments.splice(insertIdx, 0, { type: "text", content: text });
            }
        }
        this.cursorPos += text.length;
    }

    /**
     * Remove a paste segment and merge adjacent text segments if both are text.
     */
    private removeSegmentAndMerge(segIdx: number): void {
        const before = segIdx > 0 ? this.editSegments[segIdx - 1] : undefined;
        const after = this.editSegments[segIdx + 1];
        if (before?.type === "text" && after?.type === "text") {
            before.content += after.content;
            this.editSegments.splice(segIdx, 2);
        } else {
            this.editSegments.splice(segIdx, 1);
        }
    }

    /** Delete character/segment before cursor (backspace). */
    private deleteBeforeCursor(): void {
        if (this.cursorPos <= 0) return;

        let { segIdx, offset } = this.getSegmentAtPos(this.cursorPos - 1);
        let seg = this.editSegments[segIdx];
        if (!seg) return;

        // At start of a text segment — backspace should target the previous segment
        if (seg.type === "text" && offset === 0 && segIdx > 0) {
            segIdx--;
            seg = this.editSegments[segIdx]!;
            offset = seg.type === "paste" ? seg.content.length : seg.content.length - 1;
        }

        if (seg.type === "paste") {
            this.cursorPos -= seg.content.length;
            this.removeSegmentAndMerge(segIdx);
        } else {
            seg.content = seg.content.slice(0, offset) + seg.content.slice(offset + 1);
            this.cursorPos--;
            if (seg.content.length === 0) {
                this.editSegments.splice(segIdx, 1);
            }
        }
    }

    /** Delete character/segment at cursor (forward delete). */
    private deleteAfterCursor(): void {
        if (this.cursorPos >= this.getContentLength()) return;

        let { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        let seg = this.editSegments[segIdx];
        if (!seg) return;

        // At end of a text segment — forward delete should target the next segment
        if (seg.type === "text" && offset === seg.content.length) {
            const next = this.editSegments[segIdx + 1];
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
                this.editSegments.splice(segIdx, 1);
            }
        }
    }

    // ── Content area rendering ──────────────────────────────────────

    private computeLineInfos(
        contentLines: string[],
        width: number,
    ): { infos: LogicalLineInfo[]; flatIndex: FlatEntry[] } {
        const totalLines = contentLines.length;
        if (totalLines === 0) return { infos: [], flatIndex: [] };

        const lineNumWidth = String(totalLines).length;
        const effectiveTextWidth = Math.max(1, width - HORIZONTAL_PADDING);
        const prefixVisWidth = lineNumWidth + 3;
        const textContentWidth = Math.max(1, effectiveTextWidth - prefixVisWidth);

        const infos: LogicalLineInfo[] = [];
        const flatIndex: FlatEntry[] = [];

        for (let i = 0; i < totalLines; i++) {
            const line = contentLines[i]!;

            let parts: string[];
            if (line.trim() === "") {
                parts = [""];
            } else {
                parts = wrapTextWithAnsi(line, textContentWidth);
            }

            infos.push({ parts, visualCount: parts.length });
            for (let pi = 0; pi < parts.length; pi++) {
                flatIndex.push({ logicalIdx: i, partIdx: pi });
            }
        }

        return { infos, flatIndex };
    }

    private rebuildContent(width: number): void {
        // Re-evaluate the title (it may be a function of live dialog
        // state, e.g. the prompt mode)
        const title = typeof this.options.title === "function"
            ? this.options.title()
            : this.options.title;
        this.titleText.setText(
            this.theme!.fg("accent", this.theme!.bold(`  ${title}`)),
        );

        this.contentBox.clear();

        // --- Scrollable content area ---
        const contentLines = this.options.contentLines;
        const totalLogicalLines = contentLines.length;

        if (totalLogicalLines > 0) {
            const { infos, flatIndex } = this.computeLineInfos(contentLines, width);
            this.lineInfos = infos;
            this.flatIndex = flatIndex;

            const totalVisual = flatIndex.length;

            const maxOffset = Math.max(0, totalVisual - this.maxContentLines);
            const start = Math.max(0, Math.min(this.scrollOffset, maxOffset));
            this.scrollOffset = start;
            const end = Math.min(totalVisual, start + this.maxContentLines);

            const lineNumWidth = String(totalLogicalLines).length;
            const numPrefix = (idx: number) =>
                this.theme!.fg("dim", String(idx + 1).padStart(lineNumWidth) + " │ ");
            const contPrefix = this.theme!.fg("dim", " ".repeat(lineNumWidth) + " │ ");
            const ellipsisPrefix = this.theme!.fg("dim", " ".repeat(Math.max(0, lineNumWidth - 1)) + "… │ ");

            for (let vi = start; vi < end; vi++) {
                const entry = flatIndex[vi]!;
                let prefix: string;

                if (entry.partIdx === 0) {
                    prefix = numPrefix(entry.logicalIdx);
                } else if (vi === start) {
                    prefix = ellipsisPrefix;
                } else {
                    prefix = contPrefix;
                }

                const content = infos[entry.logicalIdx]!.parts[entry.partIdx]!;
                this.contentBox.addChild(new Text(prefix + content, 1, 0));
            }

            if (totalVisual > this.maxContentLines) {
                const firstLogical = flatIndex[start]!.logicalIdx + 1;
                const lastLogical = flatIndex[end - 1]!.logicalIdx + 1;
                this.contentBox.addChild(new Spacer(1));
                this.contentBox.addChild(
                    new Text(
                        this.theme!.fg("dim", `  Showing lines ${firstLogical}-${lastLogical} of ${totalLogicalLines} (PgUp/PgDn to scroll)`),
                        1,
                        0,
                    ),
                );
            }
        } else {
            this.lineInfos = [];
            this.flatIndex = [];
        }

        this.contentBox.addChild(new Spacer(1));

        // --- Selection items (always visible) ---
        for (let i = 0; i < this.options.items.length; i++) {
            const item = this.options.items[i];
            if (!item) continue;

            const isCursor = i === this.cursor;
            const isEditing = isCursor && this.editing;

            const prefix = isCursor
                ? this.theme!.fg("accent", "→ ")
                : "  ";

            if (isEditing) {
                this.renderEditArea(item, prefix, width);
            } else {
                const label = isCursor
                    ? this.theme!.fg("accent", item.label)
                    : item.label;
                const content = item.description
                    ? `${label}${this.theme!.fg("muted", ` - ${item.description}`)}`
                    : label;
                this.contentBox.addChild(new Text(`${prefix}${content}`, 1, 0));
            }
        }

        this.contentBox.addChild(new Spacer(1));

        // Help text
        const helpText = this.editing ? this.editHelpText : this.selectHelpText;
        this.contentBox.addChild(
            new Text(this.theme!.fg("muted", `  ${helpText}`), 1, 0),
        );
    }

    // ── Edit area rendering ─────────────────────────────────────────

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

        for (const seg of this.editSegments) {
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
        let cursorVisLineIdx = allVisLines.findIndex(vl =>
            cursorDispOff >= vl.dispStart && cursorDispOff < vl.dispEnd,
        );
        if (cursorVisLineIdx === -1) {
            // Cursor at end of buffer (past all dispEnds) — use last line
            cursorVisLineIdx = allVisLines.length - 1;
        }

        return { allVisLines, cursorVisLineIdx };
    }

    /** Render the edit area for the selected item with cursor navigation support. */
    private renderEditArea(item: SelectMessageItem<T>, prefix: string, width: number): void {
        const label = this.theme!.fg("accent", item.label);
        const buffer = this.editBuffer;
        const hasContent = buffer.length > 0;
        const marker = this._focused ? CURSOR_MARKER : "";
        const visualCursor = "\x1b[7m \x1b[27m";
        const isAtEnd = this.cursorPos >= buffer.length;

        // Content width: Container(width) → Box(padX=1) → Text(padX=1) = width - HORIZONTAL_PADDING
        const contentWidth = Math.max(1, width - HORIZONTAL_PADDING);
        const prefixVisWidth = visibleWidth(prefix);

        if (!hasContent) {
            // Empty buffer — cursor at start
            const placeholder = this.theme!.fg("dim", item.placeholder ?? this.messagePlaceholder);
            this.contentBox.addChild(new Text(
                `${prefix}${label}${this.messageSeparator}${marker}${visualCursor}${placeholder}`,
                1, 0,
            ));
            // Store minimal navigation state
            this.editAllVisLines = [];
            this.editDispToContent = [];
            this.editCursorDispOff = 0;
            this.editCursorVisLineIdx = 0;
            return;
        }

        // Label and width calculations
        const labelWithSep = `${label}${this.messageSeparator}`;
        const totalPrefixVisWidth = prefixVisWidth + visibleWidth(labelWithSep);

        // -1 to leave room for the cursor character on every visual line
        const editLineWidth = Math.max(1, contentWidth - totalPrefixVisWidth - 1);

        // Build display buffer with content↔display mapping
        const { display, contentToDisp, dispToContent } = this.buildDisplayMapping();

        // Store for up/down navigation
        this.editDispToContent = dispToContent;
        this.editCursorDispOff = contentToDisp[this.cursorPos] ?? display.length;

        // Build visual lines
        const { allVisLines, cursorVisLineIdx } = this.buildEditVisualLines(
            display,
            this.editCursorDispOff,
            editLineWidth,
        );

        // Apply line limit: show window that includes cursor's visual line.
        // Offset by 1 so the cursor is never on the first visible line when
        // top-truncated (or the last when bottom-truncated). With MAX_EDIT_LINES
        // >= 3 the cursor is always in the safe middle.
        let startLine: number;
        if (allVisLines.length <= MAX_EDIT_LINES) {
            startLine = 0;
        } else {
            startLine = Math.max(0, Math.min(
                cursorVisLineIdx - 1,
                allVisLines.length - MAX_EDIT_LINES,
            ));
        }
        const endLine = Math.min(allVisLines.length, startLine + MAX_EDIT_LINES);
        const visibleVisLines = allVisLines.slice(startLine, endLine);

        // Store navigation state
        this.editAllVisLines = allVisLines;
        this.editCursorVisLineIdx = cursorVisLineIdx;

        const isTruncatedTop = startLine > 0;
        const isTruncatedBottom = endLine < allVisLines.length;

        // Build Text components with cursor marker
        for (let vi = 0; vi < visibleVisLines.length; vi++) {
            const vl = visibleVisLines[vi]!;
            const isCursorLine = (startLine + vi) === cursorVisLineIdx;

            let linePrefix: string;
            let prefixText: string; // text before the buffer content (label or "…")

            if (vi === 0) {
                // First rendered line always shows label
                linePrefix = prefix;
                if (isTruncatedTop) {
                    prefixText = labelWithSep + "…";
                } else {
                    prefixText = labelWithSep;
                }
            } else {
                linePrefix = " ".repeat(totalPrefixVisWidth);
                prefixText = "";
            }

            // Append "…" suffix if this is the last visible line and there are more below
            let suffixText = "";
            if (vi === visibleVisLines.length - 1 && isTruncatedBottom) {
                suffixText = "…";
            }

            if (isCursorLine) {
                // Cursor is never on a truncated line, so displayText is the full text
                const displayText = vl.text;
                const cursorColInText = this.editCursorDispOff - vl.dispStart;
                const insertAt = prefixText.length + Math.min(cursorColInText, displayText.length);

                if (isAtEnd) {
                    // Cursor at end of buffer — append marker + visual cursor + suffix
                    this.contentBox.addChild(new Text(
                        `${linePrefix}${prefixText}${displayText}${suffixText}${marker}${visualCursor}`,
                        1, 0,
                    ));
                } else {
                    // Cursor mid-line — highlight the character under the cursor
                    const full = prefixText + displayText + suffixText;
                    const charUnderCursor = full[insertAt];
                    if (charUnderCursor) {
                        const highlighted = `\x1b[7m${charUnderCursor}\x1b[27m`;
                        this.contentBox.addChild(new Text(
                            `${linePrefix}${full.slice(0, insertAt)}${marker}${highlighted}${full.slice(insertAt + 1)}`,
                            1, 0,
                        ));
                    } else {
                        this.contentBox.addChild(new Text(
                            `${linePrefix}${full}${marker}${visualCursor}`,
                            1, 0,
                        ));
                    }
                }
            } else {
                // For truncated lines, slice off chars to make room for the
                // "…" prefix/suffix without overflow.
                let displayText = vl.text;
                if (vi === 0 && isTruncatedTop) {
                    // Top truncated: "…" prefix replaces first char
                    displayText = vl.text.slice(ELLIPSIS_VISUAL_WIDTH);
                } else if (vi === visibleVisLines.length - 1 && isTruncatedBottom) {
                    // Bottom truncated: "…" suffix replaces last char
                    displayText = vl.text.slice(0, vl.text.length - ELLIPSIS_VISUAL_WIDTH);
                }
                this.contentBox.addChild(new Text(
                    `${linePrefix}${prefixText}${displayText}${suffixText}`,
                    1, 0,
                ));
            }
        }
    }

    // ── Input handlers ──────────────────────────────────────────────

    /** Handle bracketed paste input. Returns true if the key was consumed. */
    private handlePasteInput(key: string): boolean {
        const hasPasteStart = key.includes("\x1b[200~");

        // Not in paste and no start marker — not paste input
        if (!this.isInPaste && !hasPasteStart) return false;

        // Paste start received outside edit mode — consume and discard
        if (hasPasteStart && !this.editing) {
            const stripped = key.replace("\x1b[200~", "");
            // If the end marker is in the same chunk, consume entirely
            if (stripped.includes("\x1b[201~")) return true;
            // Otherwise enter discard mode to consume the rest
            this.isInPaste = true;
            this.pasteBuffer = "";
            return true;
        }

        // Paste start in edit mode — begin buffering
        if (hasPasteStart) {
            this.isInPaste = true;
            this.pasteBuffer = "";
            key = key.replace("\x1b[200~", "");
        }

        this.pasteBuffer += key;
        const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
        if (endIndex === -1) return true; // still buffering

        // Paste complete
        const pasteContent = this.pasteBuffer.substring(0, endIndex);
        this.isInPaste = false;
        const remaining = this.pasteBuffer.substring(endIndex + 6);
        this.pasteBuffer = "";

        if (this.editing) {
            const cleanText = pasteContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            const isLarge = cleanText.includes("\n") || cleanText.length > LARGE_PASTE_THRESHOLD;
            if (isLarge) {
                const lineCount = cleanText.split("\n").length;
                const display = lineCount > 1
                    ? `[Pasted ${lineCount} lines]`
                    : `[Pasted ${cleanText.length} chars]`;
                this.insertSegmentAtCursor({ type: "paste", content: cleanText, display });
            } else {
                this.insertAtCursor(cleanText);
            }
            this.invalidate();
        }

        if (remaining) this.handleInput(remaining);
        return true;
    }

    /** Handle edit mode input. Returns true if the key was consumed. */
    private handleEditInput(key: string): boolean {
        if (matchesKey(key, "escape")) {
            this.editing = false;
            this.editSegments = [];
            this.cursorPos = 0;
            this.invalidate();
            return true;
        }

        if (matchesKey(key, "enter")) {
            this.confirmSelection();
            return true;
        }

        // Word deletion (matches pi-tui editor: Ctrl+W / Alt+Backspace, Alt+D / Alt+Delete)
        if (matchesKey(key, "ctrl+w") || matchesKey(key, "alt+backspace")) {
            this.deleteWordBeforeCursor();
            this.invalidate();
            return true;
        }

        if (matchesKey(key, "alt+d") || matchesKey(key, "alt+delete")) {
            this.deleteWordAfterCursor();
            this.invalidate();
            return true;
        }

        if (matchesKey(key, "backspace")) {
            this.deleteBeforeCursor();
            this.invalidate();
            return true;
        }

        if (matchesKey(key, "delete")) {
            this.deleteAfterCursor();
            this.invalidate();
            return true;
        }

        // Word movement (matches pi-tui editor: Alt/Ctrl+Left/Right, Alt+B/F)
        if (
            matchesKey(key, "alt+left") ||
            matchesKey(key, "ctrl+left") ||
            matchesKey(key, "alt+b")
        ) {
            this.moveCursorWordLeft();
            this.invalidate();
            return true;
        }

        if (
            matchesKey(key, "alt+right") ||
            matchesKey(key, "ctrl+right") ||
            matchesKey(key, "alt+f")
        ) {
            this.moveCursorWordRight();
            this.invalidate();
            return true;
        }

        if (matchesKey(key, "left")) {
            this.moveCursorLeft();
            this.invalidate();
            return true;
        }

        if (matchesKey(key, "right")) {
            this.moveCursorRight();
            this.invalidate();
            return true;
        }

        if (matchesKey(key, "up")) {
            this.moveCursorUp();
            this.invalidate();
            return true;
        }

        if (matchesKey(key, "down")) {
            this.moveCursorDown();
            this.invalidate();
            return true;
        }

        if (key.length === 1 && key.charCodeAt(0) >= 32) {
            this.insertAtCursor(key);
            this.desiredCol = null;
            this.invalidate();
        }
        return true;
    }

    /** Handle selection mode input. */
    private handleSelectInput(key: string): void {
        // Custom key handler (selection mode only; in edit mode keys go
        // to the editor). Runs before the built-in handling.
        if (this.options.handleSelectInput?.(key)) {
            this.invalidate();
            return;
        }

        if (matchesKey(key, "up") || key === "k") {
            if (this.cursor > 0) {
                this.cursor--;
                this.invalidate();
            }
            return;
        }

        if (matchesKey(key, "down") || key === "j") {
            if (this.cursor < this.options.items.length - 1) {
                this.cursor++;
                this.invalidate();
            }
            return;
        }

        if (matchesKey(key, "pageUp")) {
            this.scrollOffset = Math.max(0, this.scrollOffset - this.maxContentLines);
            this.invalidate();
            return;
        }

        if (matchesKey(key, "pageDown")) {
            const flatIndex = this.flatIndex;
            const currentEnd = Math.min(flatIndex.length, this.scrollOffset + this.maxContentLines);

            if (currentEnd < flatIndex.length) {
                this.scrollOffset = currentEnd;
            }
            this.invalidate();
            return;
        }

        if (matchesKey(key, "enter")) {
            this.confirmSelection();
            return;
        }

        if (matchesKey(key, "tab")) {
            this.editing = true;
            this.editSegments = [];
            this.cursorPos = 0;
            this.invalidate();
            return;
        }

        if (matchesKey(key, "escape") || key === "q") {
            this.done(undefined);
            return;
        }
    }
}

// ─── Public API ──────────────────────────────────────────────────────

// Show select-with-message UI and return result (or undefined if cancelled)
export async function selectWithMessage<T>(
    options: SelectWithMessageOptions<T>,
    ctx: { hasUI: boolean; ui: ExtensionContext["ui"] },
): Promise<SelectWithMessageResult<T> | undefined> {
    if (!ctx.hasUI) {
        return undefined;
    }

    if (options.items.length === 0) {
        return undefined;
    }

    // Hide the working indicator spinner to prevent flickering while the
    // custom component is displayed (the spinner's animation frames cause
    // constant re-renders that fight with the component on short terminals).
    ctx.ui.setWorkingVisible(false);

    try {
        return await ctx.ui.custom<SelectWithMessageResult<T> | undefined>((_tui, theme, _kb, done) => {
            const component = new SelectWithMessageComponent(options);
            component.setDoneCallback(done);
            component.initialize(theme);
            return component;
        });
    } finally {
        ctx.ui.setWorkingVisible(true);
    }
}
