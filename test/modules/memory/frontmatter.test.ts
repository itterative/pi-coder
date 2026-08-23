import { describe, it, expect } from "vitest";

import { parseFrontmatter, FrontmatterParseError } from "../../../src/modules/memory/frontmatter";
import { dedent } from "./utils";

describe("parseFrontmatter", () => {
    it("parses valid frontmatter", () => {
        const result = parseFrontmatter(
            dedent`
                ---
                name: architecture
                description: Key architectural decisions and patterns
                ---

                # Architecture
            `,
            "architecture.md",
        );

        expect(result).toEqual({
            name: "architecture",
            description: "Key architectural decisions and patterns",
        });
    });

    it("throws when frontmatter is missing", () => {
        expect(() => parseFrontmatter("# Just a regular markdown file", "notes.md")).toThrow(FrontmatterParseError);
    });

    it("throws when name is missing", () => {
        expect(() =>
            parseFrontmatter(
                dedent`
                    ---
                    description: Some description
                    ---
                `,
                "bad.md",
            ),
        ).toThrow(FrontmatterParseError);
    });

    it("throws when description is missing", () => {
        expect(() =>
            parseFrontmatter(
                dedent`
                    ---
                    name: test
                    ---
                `,
                "bad.md",
            ),
        ).toThrow(FrontmatterParseError);
    });

    it("throws when delimiters are not at the start", () => {
        expect(() =>
            parseFrontmatter(
                dedent`
                    Some text before
                    ---
                    name: test
                    description: desc
                    ---
                `,
                "bad.md",
            ),
        ).toThrow(FrontmatterParseError);
    });

    it("handles CRLF line endings", () => {
        const result = parseFrontmatter(
            ["---", "name: test", "description: A test memory", "---"].join("\r\n"),
            "test.md",
        );

        expect(result).toEqual({ name: "test", description: "A test memory" });
    });

    it("handles extra whitespace in field values", () => {
        const result = parseFrontmatter(
            dedent`
                ---
                name:   my-memory
                description:   Some desc
                ---
            `,
            "ws.md",
        );

        expect(result).toEqual({ name: "my-memory", description: "Some desc" });
    });

    it("handles hyphenated names", () => {
        const result = parseFrontmatter(
            dedent`
                ---
                name: my-cool-memory
                description: A hyphenated name
                ---
            `,
            "my-cool-memory.md",
        );

        expect(result.name).toBe("my-cool-memory");
    });

    describe("multi-line strings", () => {
        it("parses double-quoted multi-line value", () => {
            const result = parseFrontmatter(
                dedent`
                    ---
                    name: architecture
                    description: "Key architectural decisions

                    and patterns used in the project"
                    ---
                `,
                "architecture.md",
            );

            expect(result).toEqual({
                name: "architecture",
                description: "Key architectural decisions\n\nand patterns used in the project",
            });
        });

        it("parses single-quoted multi-line value", () => {
            const result = parseFrontmatter(
                dedent`
                    ---
                    name: 'project
                    config'
                    description: Project configuration
                    ---
                `,
                "config.md",
            );

            expect(result).toEqual({
                name: "project\nconfig",
                description: "Project configuration",
            });
        });

        it("parses both fields as multi-line quoted strings", () => {
            const result = parseFrontmatter(
                dedent`
                    ---
                    name: "my
                    memory"
                    description: "A longer description that
                    spans multiple lines"
                    ---
                `,
                "multi.md",
            );

            expect(result).toEqual({
                name: "my\nmemory",
                description: "A longer description that\nspans multiple lines",
            });
        });
    });

    describe("block scalars (|)", () => {
        it("parses literal block scalar", () => {
            const result = parseFrontmatter(
                dedent`
                    ---
                    name: my-memory
                    description: |
                      Line one of the description.
                      Line two of the description.
                    ---
                `,
                "block.md",
            );

            expect(result).toEqual({
                name: "my-memory",
                description: "Line one of the description.\nLine two of the description.\n",
            });
        });

        it("parses literal block scalar with explicit strip (|-)", () => {
            const result = parseFrontmatter(
                dedent`
                    ---
                    name: my-memory
                    description: |-
                      Line one.
                      Line two.
                    ---
                `,
                "block-strip.md",
            );

            expect(result).toEqual({ name: "my-memory", description: "Line one.\nLine two." });
        });

        it("preserves empty lines within block scalar", () => {
            const result = parseFrontmatter(
                dedent`
                    ---
                    name: my-memory
                    description: |
                      First paragraph.

                      Second paragraph.
                    ---
                `,
                "block-para.md",
            );

            expect(result).toEqual({
                name: "my-memory",
                description: "First paragraph.\n\nSecond paragraph.\n",
            });
        });

        it("strips trailing empty lines with |-", () => {
            const result = parseFrontmatter(
                dedent`
                    ---
                    name: my-memory
                    description: |-
                      Content here.


                    ---
                `,
                "block-trailing.md",
            );

            expect(result).toEqual({ name: "my-memory", description: "Content here." });
        });

        it("handles block scalar followed by another field", () => {
            const result = parseFrontmatter(
                dedent`
                    ---
                    description: |
                      Multi-line description.
                      Second line.
                    name: my-memory
                    ---
                `,
                "block-order.md",
            );

            expect(result).toEqual({
                name: "my-memory",
                description: "Multi-line description.\nSecond line.\n",
            });
        });

        it("handles empty block scalar", () => {
            const result = parseFrontmatter(
                dedent`
                    ---
                    name: empty-block
                    description: |-
                    ---
                `,
                "empty-block.md",
            );

            expect(result).toEqual({ name: "empty-block", description: "" });
        });

        it("keeps all trailing newlines with |+", () => {
            const result = parseFrontmatter(
                dedent`
                    ---
                    name: keep-newlines
                    description: |+
                      Content here.


                    ---
                `,
                "keep.md",
            );

            expect(result).toEqual({ name: "keep-newlines", description: "Content here.\n\n\n" });
        });
    });
});
