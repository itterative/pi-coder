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
 *   │  │  Content lines (j/k to scroll)      │ │
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
 * - j/k scrolls the content area by one page
 *
 * The inline editing engine (segment buffer, paste handling, cursor/word
 * movement, windowed rendering) lives in the composable InlineEditor —
 * this component only owns the dialog layout, scrollable content area,
 * and selection flow.
 *
 * Scrolling:
 * - scrollOffset is a visual-row index (accounts for wrapped lines)
 * - When a wrapped line is split by scrolling, the continuation gets an
 *   ellipsis prefix ("… │ ") to indicate it belongs to the line above
 */

import type { EventBus, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
    Box,
    Container,
    matchesKey,
    Spacer,
    Text,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { hasQueuedDialog, withDialogQueue } from "./dialog-queue";
import { InlineEditor } from "./inline-editor";

// ─── Layout & behavior constants ─────────────────────────────────────

// Total horizontal padding: Container → Box(padX=CONTENT_BOX_PAD_X) → Text(padX=1)
// = 2*CONTENT_BOX_PAD_X + 2*1
const HORIZONTAL_PADDING = 4;

const CONTENT_BOX_PAD_X = 1;
const CONTENT_BOX_PAD_Y = 0;

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
    // Ignore confirmation until this many milliseconds after the dialog opens
    confirmationDelayMs?: number;
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

// Maps a visual row to its logical line and part
interface FlatEntry {
    logicalIdx: number;
    partIdx: number;
}

// ─── SelectWithMessageComponent ──────────────────────────────────────

export class SelectWithMessageComponent<T> implements Component, Focusable {
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
    private readonly confirmationEnabledAt: number;
    private readonly borderTone?: "border" | "borderAccent" | (() => "border" | "borderAccent");

    // ── Selection state ──
    private cursor: number;
    private editing = false;
    private _focused = false;

    // ── Inline editing engine ──
    private readonly editor = new InlineEditor();

    // ── Content area scroll ──
    private scrollOffset = 0;
    private lineInfos: LogicalLineInfo[] = [];
    private flatIndex: FlatEntry[] = [];

    // ── Completion callback ──
    private done!: (result: SelectWithMessageResult<T> | undefined) => void;

    constructor(
        private readonly options: SelectWithMessageOptions<T>,
    ) {
        this.selectHelpText = options.selectHelpText
            ?? "↑/↓ navigate | Enter select | Tab add message | j/k scroll | Esc cancel";
        this.editHelpText = options.editHelpText ?? "Enter confirm | Esc back";
        this.messageSeparator = options.messageSeparator ?? ", ";
        this.messagePlaceholder = options.messagePlaceholder ?? "type a message...";
        this.maxContentLines = options.maxContentLines ?? 10;
        this.confirmationEnabledAt = Date.now() + Math.max(0, options.confirmationDelayMs ?? 0);
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
        this.editor.focused = value;
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
        const paste = this.editor.handlePasteInput(key, this.editing);
        if (paste.consumed) {
            if (paste.changed) this.invalidate();
            if (paste.remaining) this.handleInput(paste.remaining);
            return;
        }

        if (this.editing) {
            const result = this.editor.handleKey(key);
            if (result === "submit") {
                this.confirmSelection();
                return;
            }
            if (result === "cancel") {
                this.editing = false;
                this.editor.clear();
                this.invalidate();
                return;
            }
            this.invalidate();
            return;
        }

        this.handleSelectInput(key);
    }

    // ── Completion ──────────────────────────────────────────────────

    private confirmSelection(): void {
        if (Date.now() < this.confirmationEnabledAt) {
            return;
        }

        const item = this.options.items[this.cursor];
        if (!item) {
            this.done(undefined);
            return;
        }

        const message = this.editor.text.trim() || undefined;
        const displayText = message
            ? `${item.label}${this.messageSeparator}${message}`
            : item.label;

        this.done({ value: item.value, message, displayText });
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
                        this.theme!.fg("dim", `  Showing lines ${firstLogical}-${lastLogical} of ${totalLogicalLines} (j/k to scroll)`),
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

    /** Render the edit area for the selected item with cursor navigation support. */
    private renderEditArea(item: SelectMessageItem<T>, prefix: string, width: number): void {
        const label = this.theme!.fg("accent", item.label);
        const labelWithSep = `${label}${this.messageSeparator}`;

        // Content width: Container(width) → Box(padX=1) → Text(padX=1) = width - HORIZONTAL_PADDING
        const contentWidth = Math.max(1, width - HORIZONTAL_PADDING);
        const prefixVisWidth = visibleWidth(prefix);
        const totalPrefixVisWidth = prefixVisWidth + visibleWidth(labelWithSep);

        // -1 to leave room for the cursor character on every visual line
        const editLineWidth = Math.max(1, contentWidth - totalPrefixVisWidth - 1);

        const lines = this.editor.renderLines({
            width: editLineWidth,
            placeholder: this.theme!.fg("dim", item.placeholder ?? this.messagePlaceholder),
            firstLinePrefix: labelWithSep,
            linePrefixFor: (vi) => (vi === 0 ? prefix : " ".repeat(totalPrefixVisWidth)),
        });

        for (const line of lines) {
            this.contentBox.addChild(new Text(line, 1, 0));
        }
    }

    // ── Input handlers ──────────────────────────────────────────────

    /** Handle selection mode input. */
    private handleSelectInput(key: string): void {
        // Custom key handler (selection mode only; in edit mode keys go
        // to the editor). Runs before the built-in handling.
        if (this.options.handleSelectInput?.(key)) {
            this.invalidate();
            return;
        }

        if (matchesKey(key, "up")) {
            if (this.cursor > 0) {
                this.cursor--;
                this.invalidate();
            }
            return;
        }

        if (matchesKey(key, "down")) {
            if (this.cursor < this.options.items.length - 1) {
                this.cursor++;
                this.invalidate();
            }
            return;
        }

        if (key === "k") {
            this.scrollOffset = Math.max(0, this.scrollOffset - this.maxContentLines);
            this.invalidate();
            return;
        }

        if (key === "j") {
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
            this.editor.clear();
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
    ctx: { hasUI: boolean; ui: ExtensionContext["ui"]; events?: EventBus },
    signal?: AbortSignal,
): Promise<SelectWithMessageResult<T> | undefined> {
    if (!ctx.hasUI || signal?.aborted) return undefined;
    if (options.items.length === 0) return undefined;

    return withDialogQueue(signal, async () => {
        // Hide the working indicator spinner to prevent flickering while the
        // custom component is displayed (the spinner's animation frames cause
        // constant re-renders that fight with the component on short terminals).
        ctx.ui.setWorkingVisible(false);

        let finish: ((result: SelectWithMessageResult<T> | undefined) => void) | undefined;
        const abort = () => finish?.(undefined);
        signal?.addEventListener("abort", abort, { once: true });
        try {
            return await ctx.ui.custom<SelectWithMessageResult<T> | undefined>((_tui, theme, _kb, done) => {
                let settled = false;
                finish = (result) => {
                    if (settled) return;
                    settled = true;
                    done(result);
                };
                const component = new SelectWithMessageComponent(options);
                component.setDoneCallback(finish);
                component.initialize(theme);
                if (signal?.aborted) queueMicrotask(abort);
                return component;
            });
        } finally {
            signal?.removeEventListener("abort", abort);
            finish = undefined;
            if (!hasQueuedDialog(ctx.events)) {
                ctx.ui.setWorkingVisible(true);
            }
        }
    }, ctx.events);
}
