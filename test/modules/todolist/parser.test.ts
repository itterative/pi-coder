import { describe, expect, it } from "vitest";

import { parseTodoList } from "../../../src/modules/todolist/parser";
import { dedent } from "../memory/utils";

const validDocument = dedent`
    ---
    version: 1
    todos:
      - id: inspect
        title: Inspect the existing implementation
        status: pending
      - id: implement
        title: Implement the feature
        status: in_progress
      - id: verify
        title: Run the validation suite
        status: completed
      - id: blocked-task
        title: Resolve the unavailable dependency
        status: blocked
    ---

    # Notes

    The body is freeform Markdown.
`;

describe("parseTodoList", () => {
    it("parses structured entries and preserves the freeform body", () => {
        expect(parseTodoList(validDocument, "TODO.md")).toEqual({
            path: "TODO.md",
            version: 1,
            items: [
                { id: "inspect", title: "Inspect the existing implementation", status: "pending" },
                { id: "implement", title: "Implement the feature", status: "in_progress" },
                { id: "verify", title: "Run the validation suite", status: "completed" },
                { id: "blocked-task", title: "Resolve the unavailable dependency", status: "blocked" },
            ],
            body: "\n# Notes\n\nThe body is freeform Markdown.",
        });
    });

    it("accepts an empty TODO list", () => {
        const document = "---\nversion: 1\ntodos: []\n---\n\n# Notes\n";

        expect(parseTodoList(document, "empty.md").items).toEqual([]);
    });

    it("allows arbitrary Markdown after the frontmatter", () => {
        const document = "---\nversion: 1\ntodos: []\n---\n\n```yaml\n---\nnot: frontmatter\n---\n```\n";

        expect(parseTodoList(document, "notes.md").body).toContain("not: frontmatter");
    });

    it("normalizes CRLF input", () => {
        const document = [
            "---",
            "version: 1",
            "todos:",
            "  - id: inspect",
            "    title: Inspect the code",
            "    status: pending",
            "---",
            "",
            "# Notes",
        ].join("\r\n");

        expect(parseTodoList(document, "TODO.md")).toMatchObject({
            body: "\n# Notes",
            items: [{ id: "inspect", status: "pending" }],
        });
    });

    it.each([
        ["missing frontmatter", "# Notes\n", "`version` must be the integer 1"],
        ["missing version", "---\ntodos: []\n---\n", "`version` must be the integer 1"],
        ["wrong version", "---\nversion: 2\ntodos: []\n---\n", "`version` must be the integer 1"],
        ["missing todos", "---\nversion: 1\n---\n", "`todos` must be a YAML sequence"],
        ["unknown top-level field", "---\nversion: 1\ntodos: []\nowner: parent\n---\n", "unknown field(s): owner"],
        ["malformed YAML", "---\nversion: [\n---\n", "invalid YAML frontmatter"],
    ])("rejects %s", (_name, document, reason) => {
        expect(() => parseTodoList(document, "invalid.md")).toThrow(reason);
    });

    it.each([
        ["an invalid ID", "bad id", "invalid"],
        ["a duplicate ID", "inspect", "duplicated"],
    ])("rejects %s", (_name, id, reason) => {
        const document = `---\nversion: 1\ntodos:\n  - id: inspect\n    title: First\n    status: pending\n  - id: ${id}\n    title: Second\n    status: pending\n---\n`;

        expect(() => parseTodoList(document, "invalid.md")).toThrow(reason);
    });

    it.each([
        ["unknown item fields", "  - id: inspect\n    title: Inspect\n    status: pending\n    owner: parent", "unknown field(s): owner"],
        ["empty titles", "  - id: inspect\n    title: \"\"\n    status: pending", "non-empty string `title`"],
        ["invalid statuses", "  - id: inspect\n    title: Inspect\n    status: waiting", "invalid status"],
        ["non-mapping entries", "  - inspect", "must be a mapping"],
    ])("rejects %s", (_name, item, reason) => {
        const document = `---\nversion: 1\ntodos:\n${item}\n---\n`;

        expect(() => parseTodoList(document, "invalid.md")).toThrow(reason);
    });

    it("rejects more than the bounded number of entries", () => {
        const todos = Array.from(
            { length: 51 },
            (_value, index) => `{id: task-${index}, title: Task ${index}, status: pending}`,
        ).join(", ");
        const document = `---\nversion: 1\ntodos: [${todos}]\n---\n`;

        expect(() => parseTodoList(document, "large.md")).toThrow("maximum of 50");
    });
});
