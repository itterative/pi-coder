/**
 * Ask User Component
 *
 * A UI component that presents a question to the user with selectable options
 * and an optional inline custom message (press Tab to type one).
 *
 * Layout:
 *   ┌─── DynamicBorder ────────────────────────┐
 *   │  Title (fixed, always visible)           │
 *   │                                          │
 *   │  Description line 1                      │
 *   │  Description line 2                      │
 *   │                                          │
 *   │  → Option A                              │
 *   │    Option B                              │
 *   │    Type custom message...                │
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
} from "@earendil-works/pi-tui";

// ─── Layout constants ───────────────────────────────────────────────

// Container → Box(padX=1) → Text(padX=1) = 4 chars total horizontal padding
const HORIZONTAL_PADDING = 4;

const CONTENT_BOX_PAD_X = 1;
const CONTENT_BOX_PAD_Y = 0;

// Max visual lines in the inline edit area before truncating
const MAX_EDIT_LINES = 3;

// Minimum width (in cells) we guarantee for the custom-message edit area.
// When the inline layout (label beside the text) would leave less than this,
// we instead stack the label on its own line so the edit text has room
// instead of collapsing to one character per line.
const MIN_EDIT_WIDTH = 20;

// Extra indentation applied to the edit text in the stacked layout. Without
// it, the typed text would sit at the same column as the next option below,
// making it look like a sibling option rather than the message belonging to
// the label above.
const STACKED_INDENT = 2;

// Character count above which an inline paste becomes a placeholder segment
const LARGE_PASTE_THRESHOLD = 150;

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

export interface AskUserOption {
    label: string;
    description?: string;
}

export interface AskUserOptions {
    /** Title shown at the top */
    title: string;
    /** Description lines displayed below the title */
    description?: string;
    /** Options to select from (always visible) */
    options: AskUserOption[];
    /** Label for the "custom message" option (default: "Type a custom reply") */
    customOptionLabel?: string;
    /** Placeholder for inline message editing */
    messagePlaceholder?: string;
}

export interface AskUserResult {
    /** The selected option label, or the custom message */
    answer: string;
    /** True if the user typed a custom reply */
    isCustom: boolean;
    /** The selected option index, or -1 for custom */
    optionIndex: number;
}

// ─── Internal types ──────────────────────────────────────────────────

type EditSegment =
    | { type: "text"; content: string }
    | { type: "paste"; content: string; display: string };

interface EditVisLine {
    dispStart: number;
    dispEnd: number;
    text: string;
}

// ─── AskUserComponent ───────────────────────────────────────────────

class AskUserComponent implements Component, Focusable {
    // Theme & layout
    private theme: Theme | null = null;
    private readonly container: Container;
    private readonly contentBox: Box;

    // Configuration
    private readonly customOptionLabel: string;
    private readonly messagePlaceholder: string;

    // Selection state
    private cursor = 0;
    private editing = false;
    private _focused = false;

    // Edit buffer (segment-based)
    private editSegments: EditSegment[] = [];
    private cursorPos = 0;
    private desiredCol: number | null = null;

    // Paste input state
    private pasteBuffer = "";
    private isInPaste = false;

    // Edit navigation state (computed during render)
    private editAllVisLines: EditVisLine[] = [];
    private editDispToContent: number[] = [];
    private editCursorDispOff = 0;
    private editCursorVisLineIdx = 0;

    // Completion callback
    private done!: (result: AskUserResult | undefined) => void;

    constructor(
        private readonly options: AskUserOptions,
    ) {
        this.customOptionLabel = options.customOptionLabel ?? "Type a custom reply";
        this.messagePlaceholder = options.messagePlaceholder ?? "type your reply...";
        this.container = new Container();
        this.contentBox = new Box(CONTENT_BOX_PAD_X, CONTENT_BOX_PAD_Y);
    }

    setDoneCallback(done: (result: AskUserResult | undefined) => void): void {
        this.done = done;
    }

    initialize(theme: Theme): void {
        this.theme = theme;
        const borderColor = (s: string) => theme.fg("border", s);

        this.container.addChild(new DynamicBorder(borderColor));

        // Title
        this.container.addChild(
            new Text(theme.fg("accent", theme.bold(`  ${this.options.title}`)), 1, 0),
        );
        this.container.addChild(new Spacer(1));

        // Description + options + help
        this.container.addChild(this.contentBox);

        this.container.addChild(new Spacer(1));
        this.container.addChild(new DynamicBorder(borderColor));
    }

    // ── Component & Focusable ────────────────────────────────────────

    get focused(): boolean { return this._focused; }
    set focused(value: boolean) { this._focused = value; }

    render(width: number): string[] {
        if (!this.theme) throw new Error("Not initialized");
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

    // ── Completion ───────────────────────────────────────────────────

    private confirmSelection(): void {
        const totalItems = this.options.options.length + 1; // +1 for custom
        const isCustomChoice = this.cursor === this.options.options.length;

        if (isCustomChoice && !this.editing) {
            // Enter on "custom" item without editing — enter edit mode
            this.editing = true;
            this.editSegments = [];
            this.cursorPos = 0;
            this.invalidate();
            return;
        }

        if (isCustomChoice) {
            // Confirming custom message
            const message = this.editBuffer.trim();
            if (!message) {
                // Empty custom message — just go back
                this.editing = false;
                this.invalidate();
                return;
            }
            this.done({ answer: message, isCustom: true, optionIndex: -1 });
            return;
        }

        // Selected a predefined option, possibly with an attached message
        const option = this.options.options[this.cursor];
        if (!option) {
            this.done(undefined);
            return;
        }

        const message = this.editBuffer.trim() || undefined;
        const answer = message
            ? `${option.label}: ${message}`
            : option.label;

        this.done({ answer, isCustom: false, optionIndex: this.cursor });
    }

    // ── Segment / cursor helpers ─────────────────────────────────────

    private get editBuffer(): string {
        return this.editSegments.map(s => s.content).join("");
    }

    private getContentLength(): number {
        return this.editSegments.reduce((sum, s) => sum + s.content.length, 0);
    }

    private getSegmentAtPos(pos: number): { segIdx: number; offset: number } {
        let accumulated = 0;
        for (let i = 0; i < this.editSegments.length; i++) {
            const segLen = this.editSegments[i]!.content.length;
            if (pos <= accumulated + segLen) {
                return { segIdx: i, offset: pos - accumulated };
            }
            accumulated += segLen;
        }
        const lastIdx = Math.max(0, this.editSegments.length - 1);
        return { segIdx: lastIdx, offset: this.editSegments[lastIdx]?.content.length ?? 0 };
    }

    private getFlatPos(segIdx: number, offset: number): number {
        let pos = 0;
        for (let i = 0; i < segIdx; i++) {
            pos += this.editSegments[i]!.content.length;
        }
        return pos + offset;
    }

    // ── Cursor movement ──────────────────────────────────────────────

    private moveCursorLeft(): void {
        if (this.cursorPos <= 0) return;
        this.cursorPos--;
        this.desiredCol = null;
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
            this.cursorPos = 0;
            this.desiredCol = null;
            return;
        }
        const curVl = this.editAllVisLines[curLine]!;
        const curCol = this.desiredCol ?? (this.editCursorDispOff - curVl.dispStart);
        this.desiredCol = curCol;
        const prev = this.editAllVisLines[curLine - 1]!;
        let targetDispOff = Math.min(prev.dispStart + curCol, prev.dispEnd);
        if (targetDispOff === prev.dispEnd && prev.dispEnd > prev.dispStart) {
            targetDispOff--;
        }
        this.cursorPos = this.editDispToContent[targetDispOff] ?? 0;
    }

    private moveCursorDown(): void {
        if (this.editAllVisLines.length === 0) return;
        const curLine = this.editCursorVisLineIdx;
        if (curLine === -1 || curLine >= this.editAllVisLines.length - 1) {
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

    // ── Editing ──────────────────────────────────────────────────────

    private insertSegmentAtCursor(segment: EditSegment): void {
        if (this.editSegments.length === 0) {
            this.editSegments.push(segment);
            this.cursorPos = segment.content.length;
            return;
        }
        const { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.editSegments[segIdx];
        if (seg && seg.type === "text") {
            const before = seg.content.slice(0, offset);
            const after = seg.content.slice(offset);
            const spliceArgs: EditSegment[] = [];
            if (before.length > 0) spliceArgs.push({ type: "text", content: before });
            spliceArgs.push(segment);
            if (after.length > 0) spliceArgs.push({ type: "text", content: after });
            this.editSegments.splice(segIdx, 1, ...spliceArgs);
        } else {
            const insertIdx = (seg?.type === "paste" && offset === seg.content.length)
                ? segIdx + 1
                : segIdx;
            this.editSegments.splice(insertIdx, 0, segment);
        }
        this.cursorPos += segment.content.length;
    }

    private insertAtCursor(text: string): void {
        if (this.editSegments.length === 0) {
            this.editSegments.push({ type: "text", content: text });
            this.cursorPos = text.length;
            return;
        }
        const { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.editSegments[segIdx];
        if (seg && seg.type === "text") {
            seg.content = seg.content.slice(0, offset) + text + seg.content.slice(offset);
        } else {
            const insertIdx = (seg?.type === "paste" && offset === seg.content.length)
                ? segIdx + 1
                : segIdx;
            const prev = insertIdx > 0 ? this.editSegments[insertIdx - 1] : undefined;
            if (prev && prev.type === "text" && offset === 0) {
                prev.content += text;
            } else {
                this.editSegments.splice(insertIdx, 0, { type: "text", content: text });
            }
        }
        this.cursorPos += text.length;
    }

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

    private deleteBeforeCursor(): void {
        if (this.cursorPos <= 0) return;
        let { segIdx, offset } = this.getSegmentAtPos(this.cursorPos - 1);
        let seg = this.editSegments[segIdx];
        if (!seg) return;
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

    private deleteAfterCursor(): void {
        if (this.cursorPos >= this.getContentLength()) return;
        let { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        let seg = this.editSegments[segIdx];
        if (!seg) return;
        if (seg.type === "text" && offset === seg.content.length) {
            const next = this.editSegments[segIdx + 1];
            if (next) { segIdx++; seg = next; offset = 0; }
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

    // ── Content rendering ────────────────────────────────────────────

    private rebuildContent(width: number): void {
        this.contentBox.clear();

        // Description lines
        if (this.options.description) {
            const descLines = this.options.description.split("\n");
            for (const line of descLines) {
                this.contentBox.addChild(new Text(`  ${line}`, 1, 0));
            }
            this.contentBox.addChild(new Spacer(1));
        }

        // Options
        const totalItems = this.options.options.length + 1; // +1 for custom
        for (let i = 0; i < totalItems; i++) {
            const isCustom = i === this.options.options.length;
            const isCursor = i === this.cursor;
            const isEditing = isCursor && this.editing;

            const prefix = isCursor
                ? this.theme!.fg("accent", "→ ")
                : "  ";

            if (isCustom) {
                // "Type custom reply" option
                if (isEditing) {
                    this.renderEditArea(this.customOptionLabel, prefix, width);
                } else {
                    const label = isCursor
                        ? this.theme!.fg("accent", this.customOptionLabel)
                        : this.theme!.fg("dim", this.customOptionLabel);
                    this.contentBox.addChild(new Text(`${prefix}${label}`, 1, 0));
                }
            } else {
                const option = this.options.options[i]!;
                if (isEditing) {
                    this.renderEditArea(option.label, prefix, width);
                } else {
                    const label = isCursor
                        ? this.theme!.fg("accent", option.label)
                        : option.label;
                    const content = option.description
                        ? `${label}${this.theme!.fg("muted", ` - ${option.description}`)}`
                        : label;
                    this.contentBox.addChild(new Text(`${prefix}${content}`, 1, 0));
                }
            }
        }

        this.contentBox.addChild(new Spacer(1));

        // Help text
        const helpText = this.editing
            ? "Enter confirm | Esc back"
            : "↑/↓ navigate | Enter select | Tab add message | Esc cancel";
        this.contentBox.addChild(
            new Text(this.theme!.fg("muted", `  ${helpText}`), 1, 0),
        );
    }

    // ── Edit area rendering ──────────────────────────────────────────

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
                contentToDisp[cPos] = dStart;
                for (let di = 0; di < seg.display.length; di++) {
                    dispToContent[dStart + di] = cPos;
                }
                display += seg.display;
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
                const dEnd = display.length;
                cPos += seg.content.length;
                contentToDisp[cPos] = dEnd;
                dispToContent[dEnd] = cPos;
            }
        }

        return { display, contentToDisp, dispToContent };
    }

    private wrapLine(text: string, width: number): string[] {
        if (width <= 0) return [text || ""];
        if (visibleWidth(text) <= width) return [text];

        const lines: string[] = [];
        let remaining = text;

        while (visibleWidth(remaining) > width) {
            let lastSpaceStrIdx = -1;
            let visPos = 0;

            for (let si = 0; si < remaining.length; si++) {
                const ch = remaining.codePointAt(si)!;
                if (ch === 0x1b && remaining[si + 1] === "[") {
                    const endSeq = remaining.indexOf("m", si + 2);
                    if (endSeq !== -1) { si = endSeq; continue; }
                }
                const charWidth = ch > 0xffff ? 2 : 1;
                visPos += charWidth;
                if (ch > 0xffff) si++;
                if (visPos > width) break;
                if (ch === 32) lastSpaceStrIdx = si + 1;
            }

            if (lastSpaceStrIdx > 0) {
                lines.push(remaining.substring(0, lastSpaceStrIdx));
                remaining = remaining.substring(lastSpaceStrIdx);
            } else {
                // Hard break
                let hv = 0;
                let breakIdx = remaining.length;
                for (let si = 0; si < remaining.length; si++) {
                    const ch = remaining.codePointAt(si)!;
                    if (ch === 0x1b && remaining[si + 1] === "[") {
                        const endSeq = remaining.indexOf("m", si + 2);
                        if (endSeq !== -1) { si = endSeq; continue; }
                    }
                    const cw = ch > 0xffff ? 2 : 1;
                    if (hv + cw > width) { breakIdx = si; break; }
                    hv += cw;
                    if (ch > 0xffff) si++;
                }
                lines.push(remaining.substring(0, breakIdx));
                remaining = remaining.substring(breakIdx);
            }
        }
        if (remaining.length > 0) lines.push(remaining);
        return lines.length > 0 ? lines : [""];
    }

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
            const parts = dLine.length === 0 ? [""] : this.wrapLine(dLine, lineWidth);
            let lineDOff = dOff;
            for (const part of parts) {
                allVisLines.push({
                    dispStart: lineDOff,
                    dispEnd: lineDOff + part.length,
                    text: part,
                });
                lineDOff += part.length;
            }
            dOff += dLine.length + (li < displayLines.length - 1 ? 1 : 0);
        }

        let cursorVisLineIdx = allVisLines.findIndex(vl =>
            cursorDispOff >= vl.dispStart && cursorDispOff < vl.dispEnd,
        );
        if (cursorVisLineIdx === -1) cursorVisLineIdx = allVisLines.length - 1;

        return { allVisLines, cursorVisLineIdx };
    }

    private renderEditArea(label: string, prefix: string, width: number): void {
        const styledLabel = this.theme!.fg("accent", label);
        const buffer = this.editBuffer;
        const hasContent = buffer.length > 0;
        const marker = this._focused ? CURSOR_MARKER : "";
        const visualCursor = "\x1b[7m \x1b[27m";
        const isAtEnd = this.cursorPos >= buffer.length;

        const contentWidth = Math.max(1, width - HORIZONTAL_PADDING);
        const prefixVisWidth = visibleWidth(prefix);
        const separator = ": ";
        const labelWithSep = `${styledLabel}${separator}`;
        const totalPrefixVisWidth = prefixVisWidth + visibleWidth(labelWithSep);

        // Decide between an inline layout (label beside the edit text) and a
        // stacked layout (label on its own line, edit text below). We stack
        // whenever the inline edit area would be narrower than a comfortable
        // minimum — this happens with long labels and/or narrow terminals and
        // would otherwise drive the edit text down to one character per line.
        // Stacking always yields at least as much edit width as the inline
        // layout, so it is strictly better when space is tight.
        const inlineEditLineWidth = contentWidth - totalPrefixVisWidth - 1;
        const isStacked = inlineEditLineWidth < MIN_EDIT_WIDTH;

        // Indent used by the edit text lines.
        //   Inline layout: continuation lines align under the edit text,
        //                  i.e. just past the "label: " prefix.
        //   Stacked layout: every edit line nests a little deeper than the
        //                   arrow column so it reads as the message for the
        //                   label above, not as the next option.
        const contIndent = isStacked
            ? prefixVisWidth + STACKED_INDENT
            : totalPrefixVisWidth;
        const editLineWidth = isStacked
            ? Math.max(1, contentWidth - contIndent - 1)
            : Math.max(1, inlineEditLineWidth);

        if (!hasContent) {
            const placeholder = this.theme!.fg("dim", this.messagePlaceholder);
            if (isStacked) {
                this.contentBox.addChild(new Text(`${prefix}${labelWithSep}`, 1, 0));
                this.contentBox.addChild(new Text(
                    `${" ".repeat(contIndent)}${marker}${visualCursor}${placeholder}`,
                    1, 0,
                ));
            } else {
                this.contentBox.addChild(new Text(
                    `${prefix}${labelWithSep}${marker}${visualCursor}${placeholder}`,
                    1, 0,
                ));
            }
            this.editAllVisLines = [];
            this.editDispToContent = [];
            this.editCursorDispOff = 0;
            this.editCursorVisLineIdx = 0;
            return;
        }

        const { display, contentToDisp, dispToContent } = this.buildDisplayMapping();
        this.editDispToContent = dispToContent;
        this.editCursorDispOff = contentToDisp[this.cursorPos] ?? display.length;

        const { allVisLines, cursorVisLineIdx } = this.buildEditVisualLines(
            display, this.editCursorDispOff, editLineWidth,
        );

        // The edit window is fixed at MAX_EDIT_LINES (3) regardless of layout.
        // The reason it must be 3 — not fewer — is cursor navigation: the scroll
        // logic pins the cursor to the MIDDLE visible line, which is then never
        // ellipsed (a top “…” lives on line 0, a bottom “…” on line 2). With
        // only 2 lines the cursor would land on an ellipsed line; with 1 it
        // can be ellipsed on both sides and invisible. So even in the stacked
        // layout, where the label adds its own line(s) above, we keep 3 edit
        // lines — the taller block is the price of clean cursor movement.
        const maxEditLines = MAX_EDIT_LINES;

        let startLine: number;
        if (allVisLines.length <= maxEditLines) {
            startLine = 0;
        } else {
            startLine = Math.max(0, Math.min(
                cursorVisLineIdx - 1,
                allVisLines.length - maxEditLines,
            ));
        }
        const endLine = Math.min(allVisLines.length, startLine + maxEditLines);
        const visibleVisLines = allVisLines.slice(startLine, endLine);

        this.editAllVisLines = allVisLines;
        this.editCursorVisLineIdx = cursorVisLineIdx;

        const isTruncatedTop = startLine > 0;
        const isTruncatedBottom = endLine < allVisLines.length;

        // In the stacked layout the label lives on its own line above the edit
        // text and is never truncated. Scroll indicators (…) stay on the edit
        // visual lines themselves — prepended to the first visible line when
        // content is hidden above, appended to the last when hidden below —
        // exactly as in the inline layout, so they never add extra lines and
        // the block stays within budget.
        if (isStacked) {
            this.contentBox.addChild(new Text(`${prefix}${labelWithSep}`, 1, 0));
        }

        for (let vi = 0; vi < visibleVisLines.length; vi++) {
            const vl = visibleVisLines[vi]!;
            const isCursorLine = (startLine + vi) === cursorVisLineIdx;

            let linePrefix: string;
            let prefixText: string;

            if (isStacked) {
                linePrefix = " ".repeat(contIndent);
                prefixText = "";
            } else if (vi === 0) {
                linePrefix = prefix;
                prefixText = labelWithSep;
            } else {
                linePrefix = " ".repeat(contIndent);
                prefixText = "";
            }

            // Top truncation indicator (content hidden above this window) sits
            // on the first visible line, right before its text — the same spot
            // in both layouts, so it never costs an extra line.
            const topEllipsis = vi === 0 && isTruncatedTop ? "…" : "";
            // Bottom truncation indicator (content hidden below) sits on the
            // last visible line, right after its text.
            let suffixText = "";
            if (vi === visibleVisLines.length - 1 && isTruncatedBottom) {
                suffixText = "…";
            }

            if (isCursorLine) {
                const displayText = vl.text;
                const beforeCursor = prefixText + topEllipsis;
                const cursorColInText = this.editCursorDispOff - vl.dispStart;
                const insertAt = beforeCursor.length + Math.min(cursorColInText, displayText.length);

                if (isAtEnd) {
                    this.contentBox.addChild(new Text(
                        `${linePrefix}${beforeCursor}${displayText}${suffixText}${marker}${visualCursor}`,
                        1, 0,
                    ));
                } else {
                    const full = beforeCursor + displayText + suffixText;
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
                let displayText = vl.text;
                // Trim one char at each end that an ellipsis occupies so the
                // line keeps its width (matches the original inline behavior).
                if (topEllipsis) {
                    displayText = displayText.slice(1);
                }
                if (suffixText) {
                    displayText = displayText.slice(0, displayText.length - 1);
                }
                this.contentBox.addChild(new Text(
                    `${linePrefix}${prefixText}${topEllipsis}${displayText}${suffixText}`,
                    1, 0,
                ));
            }
        }
    }

    // ── Input handlers ───────────────────────────────────────────────

    private handlePasteInput(key: string): boolean {
        const hasPasteStart = key.includes("\x1b[200~");
        if (!this.isInPaste && !hasPasteStart) return false;

        if (hasPasteStart && !this.editing) {
            const stripped = key.replace("\x1b[200~", "");
            if (stripped.includes("\x1b[201~")) return true;
            this.isInPaste = true;
            this.pasteBuffer = "";
            return true;
        }

        if (hasPasteStart) {
            this.isInPaste = true;
            this.pasteBuffer = "";
            key = key.replace("\x1b[200~", "");
        }

        this.pasteBuffer += key;
        const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
        if (endIndex === -1) return true;

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

    private handleEditInput(key: string): boolean {
        if (matchesKey(key, "escape")) {
            // If on the custom option with empty buffer, go back to selection
            // If on a predefined option, cancel edit
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

    private handleSelectInput(key: string): void {
        const totalItems = this.options.options.length + 1;

        if (matchesKey(key, "up") || key === "k") {
            if (this.cursor > 0) {
                this.cursor--;
                this.invalidate();
            }
            return;
        }

        if (matchesKey(key, "down") || key === "j") {
            if (this.cursor < totalItems - 1) {
                this.cursor++;
                this.invalidate();
            }
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

// ─── Queue for concurrent askUser calls ────────────────────────────
//
// When pi executes multiple tool calls in parallel, several ask_user calls
// may arrive at the same time. ctx.ui.custom() can only display one custom
// component at a time — a second concurrent call would never resolve because
// its done callback is never wired up. We solve this by serialising all
// askUser calls through a simple promise-chain queue so that each one waits
// for the previous to finish before showing its component.

let askUserQueue: Promise<void> = Promise.resolve();

// ─── Public API ──────────────────────────────────────────────────────

export async function askUser(
    options: AskUserOptions,
    ctx: { hasUI: boolean; ui: ExtensionContext["ui"] },
): Promise<AskUserResult | undefined> {
    if (!ctx.hasUI) return undefined;
    if (options.options.length === 0) return undefined;

    // Enqueue: wait for any in-flight askUser to finish before showing ours.
    let release!: () => void;
    const waitForTurn = new Promise<void>((resolve) => { release = resolve; });
    const previousQueue = askUserQueue;
    askUserQueue = waitForTurn;
    await previousQueue;

    // Hide the working indicator spinner to prevent flickering while the
    // custom component is displayed (the spinner's animation frames cause
    // constant re-renders that fight with the component on short terminals).
    ctx.ui.setWorkingVisible(false);

    try {
        return await ctx.ui.custom<AskUserResult | undefined>((_tui, theme, _kb, done) => {
            const component = new AskUserComponent(options);
            component.setDoneCallback(done);
            component.initialize(theme);
            return component;
        });
    } finally {
        ctx.ui.setWorkingVisible(true);
        release();
    }
}
