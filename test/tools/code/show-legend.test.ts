import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runShow } from "../../../src/tools/code/show";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

/** A 60-line body: long enough that one page cannot hold it at a small limit. */
const LONG_BODY = Array.from(
    { length: 60 },
    (_, index) => `    const int value${index} = ${index};`,
).join("\n");

/** `attention_block` sorts before `zzz_helper`, so the long body is the first block on the page. */
const FILES: Record<string, string> = {
    "src/model.cpp": `namespace engine {

void attention_block() {
${LONG_BODY}
}

void zzz_helper(int value) {
    return value + 1;
}

}  // namespace engine
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

describe("outline show pagination", () => {
    it("names every resolved symbol before any body, so a cut page cannot hide one", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src",
            query: ["engine::attention_block", "engine::zzz_helper"].join(", "),
            limit: 400,
        });
        const [header = ""] = result.text.split("\n\n");

        expect(header).toContain("src/model.cpp:3-64");
        expect(header).toContain("src/model.cpp:66-68");
        expect(header).toContain("engine::attention_block");
        expect(header).toContain("engine::zzz_helper");
        expect(result.truncated).toBe(true);
    });

    it("says how many blocks the cut page never reached", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src",
            query: ["engine::attention_block", "engine::zzz_helper"].join(", "),
            limit: 400,
        });

        expect(result.text).toContain("# omitted 1 more block(s) after this body");
    });

    it("reports the remaining line count on a continuation", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src",
            query: "engine::attention_block",
            limit: 400,
        });

        // Both the continuation and what is left, because the page step is set by the character budget.
        expect(result.text).toMatch(
            /# next: offset=\d+ \(source line\) · \d+ of \d+ body line\(s\) left/,
        );
        expect(result.text).toContain("# … truncated 51 line(s)");
        expect(result.text).toContain("raise limit to fit more per call");
    });

    it("keeps the header single-line when only one symbol was asked for", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src",
            query: "engine::zzz_helper",
            limit: 400,
        });
        const [header = ""] = result.text.split("\n");

        expect(header.startsWith("# show src engine::zzz_helper")).toBe(true);
    });
});
