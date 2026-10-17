/**
 * Numeric Input Component
 *
 * A named facade over the generic text input: the numeric variant is the same editor with a number-shaped
 * parse, so both share one implementation and one overlay helper.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
    TextInputComponent,
    textInput,
    type TextInputOptions,
    type TextInputParseResult,
} from "./text-input";

export type NumericInputParseResult<T extends number> = TextInputParseResult<T>;
export type NumericInputOptions<T extends number> = TextInputOptions<T>;
export { TextInputComponent as NumericInputComponent };

export function parsePositiveInteger(text: string): NumericInputParseResult<number> {
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1) {
        return { error: "Enter a positive whole number." };
    }
    return { value };
}

/** Reusable inline numeric editor; the numeric default placeholder is the only difference. */
export function numericInput<T extends number>(
    options: NumericInputOptions<T>,
    ctx: ExtensionCommandContext,
): Promise<T | undefined> {
    return textInput({ placeholder: "enter a number...", ...options }, ctx);
}
