import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

export interface BorderCharacters {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
    bottomHorizontal?: string;
    rightVertical?: string;
}

export const ROUNDED_BORDER: BorderCharacters = {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
};

export const LIGHT_BORDER: BorderCharacters = {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
};

export const HEAVY_BORDER: BorderCharacters = {
    topLeft: "┏",
    topRight: "┓",
    bottomLeft: "┗",
    bottomRight: "┛",
    horizontal: "━",
    vertical: "┃",
};

export const DOUBLE_BORDER: BorderCharacters = {
    topLeft: "╔",
    topRight: "╗",
    bottomLeft: "╚",
    bottomRight: "╝",
    horizontal: "═",
    vertical: "║",
};

/** Heavy horizontal strokes with light vertical strokes. */
export const MIXED_BORDER: BorderCharacters = {
    topLeft: "┍",
    topRight: "┑",
    bottomLeft: "┕",
    bottomRight: "┙",
    horizontal: "━",
    vertical: "│",
};

export const BLOCK_BORDER: BorderCharacters = {
    topLeft: "▛",
    topRight: "▜",
    bottomLeft: "▙",
    bottomRight: "▟",
    horizontal: "▀",
    bottomHorizontal: "▄",
    vertical: "▌",
    rightVertical: "▐",
};

export const BORDER_STYLES = {
    rounded: ROUNDED_BORDER,
    light: LIGHT_BORDER,
    heavy: HEAVY_BORDER,
    double: DOUBLE_BORDER,
    mixed: MIXED_BORDER,
    block: BLOCK_BORDER,
} as const;

export interface BorderBoxOptions {
    borderColor?: (text: string) => string;
    characters?: BorderCharacters;
    /** Fixed total height, including the top and bottom borders. */
    height?: number;
}

/** Wrap a component in a width-aware Unicode box border. */
export class BorderBox implements Component {
    private readonly borderColor: (text: string) => string;
    private readonly characters: BorderCharacters;
    private height: number | undefined;

    constructor(
        private readonly child: Component,
        options: BorderBoxOptions = {},
    ) {
        this.borderColor = options.borderColor ?? ((text) => text);
        this.characters = options.characters ?? ROUNDED_BORDER;
        this.height = options.height;
    }

    setHeight(height: number | undefined): void {
        this.height = height;
    }

    render(width: number): string[] {
        if (width <= 1) return [this.borderColor(this.characters.vertical)];

        const innerWidth = width - 2;
        const topHorizontal = this.characters.horizontal.repeat(innerWidth);
        const bottomHorizontal = (
            this.characters.bottomHorizontal ?? this.characters.horizontal
        ).repeat(innerWidth);
        const leftVertical = this.characters.vertical;
        const rightVertical = this.characters.rightVertical ?? this.characters.vertical;
        const childLines = this.child.render(innerWidth);
        const innerHeight =
            this.height === undefined ? childLines.length : Math.max(0, this.height - 2);
        const contentLines = childLines.slice(0, innerHeight);
        while (contentLines.length < innerHeight) contentLines.push("");
        const lines = contentLines.map(
            (line) =>
                this.borderColor(leftVertical) +
                truncateToWidth(line, innerWidth, "", true) +
                this.borderColor(rightVertical),
        );

        return [
            this.borderColor(this.characters.topLeft + topHorizontal + this.characters.topRight),
            ...lines,
            this.borderColor(
                this.characters.bottomLeft + bottomHorizontal + this.characters.bottomRight,
            ),
        ];
    }

    handleInput(data: string): void {
        this.child.handleInput?.(data);
    }

    invalidate(): void {
        this.child.invalidate();
    }
}
