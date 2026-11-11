import {
    keyHint,
    type AgentToolResult,
    type Theme,
    type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { describeTiming } from "./timing";
import type { CodeActionResult } from "./types";

/** The collapsible preview pi uses for tools without a result renderer; matching it keeps the TUI uniform. */
const PREVIEW_LINES = 10;

/** The call arguments this renderer reads; the schema's static type is assignable to it. */
interface OutlineCallArgs {
    action?: string;
    path?: string;
    query?: string;
    symbols?: readonly string[];
    offset?: number;
}

export function renderOutlineCall(args: OutlineCallArgs, theme: Theme): Text {
    const action = args.action ?? "digest";
    const target = args.path ?? ".";
    let text = theme.fg("toolTitle", theme.bold(`outline ${action} `));
    text += theme.fg("accent", target);

    if (args.query !== undefined && args.query.length > 0) {
        text += theme.fg("accent", ` "${args.query}"`);
    }

    if (args.symbols !== undefined && args.symbols.length > 0) {
        text += theme.fg("muted", ` ${args.symbols.join(", ")}`);
    }

    if ((args.offset ?? 0) > 0) {
        text += theme.fg("muted", ` offset=${args.offset}`);
    }

    return new Text(text, 0, 0);
}

/**
 * The result, collapsed exactly like pi's fallback, with the timing line underneath.
 *
 * The timings ride in `details` rather than the text: the agent pays tokens for the text, and where the call
 * spent its time is a question the human reading the session asks.
 */
export function renderOutlineResult(
    result: AgentToolResult<CodeActionResult["details"]>,
    options: ToolRenderResultOptions,
    theme: Theme,
): Text {
    const text = result.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    const lines = text.split("\n");
    const shown = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
    const remaining = lines.length - shown.length;
    let out = shown.map((line) => theme.fg("toolOutput", line)).join("\n");

    if (remaining > 0) {
        out += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
    }

    const timing = result.details?.timing;

    if (timing !== undefined) {
        out += `\n${theme.fg("muted", describeTiming(timing))}`;
    }

    return new Text(out, 0, 0);
}
