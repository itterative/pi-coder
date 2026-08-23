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
 *
 * The inline editing engine (segment buffer, paste handling, cursor/word
 * movement, windowed rendering) lives in the composable InlineEditor —
 * this component only owns the dialog layout and selection flow.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
    Box,
    Container,
    matchesKey,
    Spacer,
    Text,
    visibleWidth,
} from "@earendil-works/pi-tui";
import { InlineEditor } from "./inline-editor";

// ─── Layout constants ───────────────────────────────────────────────

// Container → Box(padX=1) → Text(padX=1) = 4 chars total horizontal padding
const HORIZONTAL_PADDING = 4;

const CONTENT_BOX_PAD_X = 1;
const CONTENT_BOX_PAD_Y = 0;

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

// ─── AskUserComponent ───────────────────────────────────────────────

export class AskUserComponent implements Component, Focusable {
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

    // Inline editing engine
    private readonly editor = new InlineEditor();

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
    set focused(value: boolean) {
        this._focused = value;
        this.editor.focused = value;
    }

    render(width: number): string[] {
        if (!this.theme) throw new Error("Not initialized");
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
                // Back to selection mode with a cleared buffer
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

    // ── Completion ───────────────────────────────────────────────────

    private confirmSelection(): void {
        const isCustomChoice = this.cursor === this.options.options.length;

        if (isCustomChoice && !this.editing) {
            // Enter on "custom" item without editing — enter edit mode
            this.editing = true;
            this.editor.clear();
            this.invalidate();
            return;
        }

        if (isCustomChoice) {
            // Confirming custom message
            const message = this.editor.text.trim();
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

        const message = this.editor.text.trim() || undefined;
        const answer = message
            ? `${option.label}: ${message}`
            : option.label;

        this.done({ answer, isCustom: false, optionIndex: this.cursor });
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

    private renderEditArea(label: string, prefix: string, width: number): void {
        const styledLabel = this.theme!.fg("accent", label);
        const separator = ": ";
        const labelWithSep = `${styledLabel}${separator}`;

        const contentWidth = Math.max(1, width - HORIZONTAL_PADDING);
        const prefixVisWidth = visibleWidth(prefix);
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

        // In the stacked layout the label lives on its own line above the
        // edit text and is never truncated.
        if (isStacked) {
            this.contentBox.addChild(new Text(`${prefix}${labelWithSep}`, 1, 0));
        }

        const lines = this.editor.renderLines({
            width: editLineWidth,
            placeholder: this.theme!.fg("dim", this.messagePlaceholder),
            firstLinePrefix: isStacked ? "" : labelWithSep,
            linePrefixFor: isStacked
                ? () => " ".repeat(contIndent)
                : (vi) => (vi === 0 ? prefix : " ".repeat(contIndent)),
        });

        for (const line of lines) {
            this.contentBox.addChild(new Text(line, 1, 0));
        }
    }

    // ── Input handlers ───────────────────────────────────────────────

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
    signal?: AbortSignal,
): Promise<AskUserResult | undefined> {
    if (!ctx.hasUI || signal?.aborted) return undefined;
    if (options.options.length === 0) return undefined;

    // Enqueue: wait for any in-flight askUser to finish before showing ours.
    let release!: () => void;
    const waitForTurn = new Promise<void>((resolve) => { release = resolve; });
    const previousQueue = askUserQueue;
    askUserQueue = waitForTurn;
    await previousQueue;
    if (signal?.aborted) {
        release();
        return undefined;
    }

    // Hide the working indicator spinner to prevent flickering while the
    // custom component is displayed (the spinner's animation frames cause
    // constant re-renders that fight with the component on short terminals).
    ctx.ui.setWorkingVisible(false);

    let finish: ((result: AskUserResult | undefined) => void) | undefined;
    const abort = () => finish?.(undefined);
    signal?.addEventListener("abort", abort, { once: true });
    try {
        return await ctx.ui.custom<AskUserResult | undefined>((_tui, theme, _kb, done) => {
            let settled = false;
            finish = (result) => {
                if (settled) return;
                settled = true;
                done(result);
            };
            const component = new AskUserComponent(options);
            component.setDoneCallback(finish);
            component.initialize(theme);
            if (signal?.aborted) queueMicrotask(abort);
            return component;
        });
    } finally {
        signal?.removeEventListener("abort", abort);
        finish = undefined;
        ctx.ui.setWorkingVisible(true);
        release();
    }
}
