import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { renderOutlineCall, renderOutlineResult } from "../../../src/tools/code/render";
import type { CodeActionResult } from "../../../src/tools/code/types";
import { mockTheme, renderText, snapshotText } from "../../helpers";

const TIMING: NonNullable<CodeActionResult["details"]["timing"]> = {
    totalMs: 14.2,
    sourceMs: 0.3,
    semanticMs: 0,
    discoverMs: 1.4,
    parseMs: 9.1,
    searchMs: 1.2,
    tailMs: 0,
    workMs: 2.2,
    files: 3,
    cached: 0,
    parsed: 3,
    tooLarge: 0,
    parseErrors: 0,
};

function result(
    text: string,
    timing?: typeof TIMING,
): AgentToolResult<CodeActionResult["details"]> {
    return {
        content: [{ type: "text", text }],
        details: {
            action: "search",
            path: "src",
            source: "local",
            files: 3,
            matches: 1,
            timing,
        },
    };
}

describe("outline TUI rendering", () => {
    it("shows within in the call line", () => {
        const text = renderText(
            renderOutlineCall(
                {
                    action: "search",
                    path: "src",
                    query: "connect",
                    within: "dependents:src/core/socket.ts",
                },
                mockTheme,
            ),
            120,
        );

        expect(text).toContain("within=dependents:src/core/socket.ts");
        expect(snapshotText(text)).toMatchFileSnapshot("__snapshots__/outline-render.call.txt");
    });

    it("sets the timing caption apart with a blank line", () => {
        const text = renderText(
            renderOutlineResult(
                result("# search connect\nsrc/a.ts:1  function  connect", TIMING),
                { expanded: true, isPartial: false },
                mockTheme,
            ),
            120,
        );

        const rendered = snapshotText(text);

        expect(rendered).toContain("\n\n");
        expect(
            rendered.endsWith(
                "timing: 14 ms · parse 9 · work 2 · discover 1 · search 1 · files 3 · parsed 3",
            ),
        ).toBe(true);
        expect(rendered).toMatchFileSnapshot("__snapshots__/outline-render.result.txt");
    });

    it("adds no caption when the call has no timing", () => {
        const text = renderText(
            renderOutlineResult(
                result("# search connect\nsrc/a.ts:1  function  connect"),
                { expanded: true, isPartial: false },
                mockTheme,
            ),
            120,
        );

        const rendered = snapshotText(text);

        expect(rendered).not.toContain("timing:");
        expect(rendered.endsWith("connect")).toBe(true);
    });
});
