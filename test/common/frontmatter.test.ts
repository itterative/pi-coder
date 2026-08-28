import { describe, expect, it } from "vitest";

import {
    FrontmatterParseError,
    parseFrontmatter,
} from "../../src/common/frontmatter";
import { dedent } from "../modules/memory/utils";

describe("parseFrontmatter", () => {
    it("returns an empty mapping and preserves ordinary Markdown", () => {
        const content = "# Notes\r\n\r\n---\r\n\r\nFreeform\r\n";

        expect(parseFrontmatter(content, "notes.md")).toEqual({
            frontmatter: {},
            body: "# Notes\n\n---\n\nFreeform\n",
        });
    });

    it("parses nested YAML and preserves the Markdown body", () => {
        const content = dedent`
            ---
            version: 1
            todos:
              - id: inspect
                title: Inspect the code
                status: pending
            ---

            # Notes

            Freeform content.
        `;

        expect(parseFrontmatter(content, "TODO.md")).toEqual({
            frontmatter: {
                version: 1,
                todos: [{ id: "inspect", title: "Inspect the code", status: "pending" }],
            },
            body: "\n# Notes\n\nFreeform content.",
        });
    });

    it("normalizes CRLF line endings", () => {
        const content = ["---", "name: test", "---", "", "# Body"].join("\r\n");

        expect(parseFrontmatter(content, "test.md")).toEqual({
            frontmatter: { name: "test" },
            body: "\n# Body",
        });
    });

    it("requires a closing delimiter after an opening delimiter", () => {
        expect(() => parseFrontmatter("---\nname: test\n", "broken.md"))
            .toThrowError(new FrontmatterParseError("broken.md", "missing closing YAML frontmatter delimiter (---)"));
    });

    it("requires delimiter lines to contain only the delimiter", () => {
        expect(() => parseFrontmatter("---\nname: test\n---not-a-delimiter\n", "broken.md"))
            .toThrow(FrontmatterParseError);
    });

    it("wraps YAML parser errors with the source path", () => {
        expect(() => parseFrontmatter("---\nversion: [\n---\n", "broken.md"))
            .toThrow(/broken\.md: invalid YAML frontmatter:/);
    });

    it("requires the YAML value to be a mapping", () => {
        expect(() => parseFrontmatter("---\n- one\n- two\n---\n", "broken.md"))
            .toThrow(new FrontmatterParseError("broken.md", "frontmatter must contain a YAML mapping"));
    });
});
