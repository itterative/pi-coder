import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

/**
 * One member name, two types, both called from member functions of their own type.
 *
 * `Ops` is declared first on purpose: a request for `CallList::attention_paged` must surface the call inside
 * `CallList`'s own member function above the one inside `Ops`, even though `Ops` comes first in the file.
 */
const FILES: Record<string, string> = {
    "src/types.hpp": `struct Ops {
    int attention_paged(int page);

    int run() { return attention_paged(2); }
};

struct CallList {
    int attention_paged(int page);

    int run() { return attention_paged(1); }
};
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

describe("outline usages with a qualified symbol", () => {
    it("puts the occurrences inside the named type first, even when the other type comes first in the file", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src",
            query: "CallList::attention_paged",
            kind: "call",
        });
        const rows = result.text.split("\n").filter((line) => line.trimStart().startsWith(":"));

        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain("attention_paged(1)");
        expect(rows[1]).toContain("attention_paged(2)");
    });

    it("marks the row that only shares the name, and only that row", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src",
            query: "CallList::attention_paged",
            kind: "call",
        });
        const groups = result.text.split("\n").filter((line) => /^ {2}\S/.test(line));

        expect(groups).toHaveLength(2);
        expect(groups[0]).toContain("CallList::run");
        expect(groups[0]).not.toContain("[name-only]");
        expect(groups[1]).toContain("Ops::run");
        expect(groups[1]).toContain("[name-only]");
        expect(result.text).toContain("the enclosing type is not the one you qualified");
    });

    it("keeps the type for a member defined out of line in another file", async () => {
        // `CallList::run_one` lives at namespace scope in the .cpp, so no class declaration encloses the call; only
        // the function's own qualified name says which class it belongs to.
        const source = new MemoryCodeSource("/project", {
            "src/call_list.cpp": `struct Ops {
    int attention_paged(int page);
};

struct CallList {
    int attention_paged(int page);
    int run_one(const Ops& ops);
};

int CallList::run_one(const Ops& ops) {
    return attention_paged(1) + ops.attention_paged(2);
}
`,
        });
        const result = await runUsages(source, {
            action: "usages",
            path: "src",
            query: "CallList::attention_paged",
            kind: "call",
        });
        const groups = result.text.split("\n").filter((line) => /^ {2}\S/.test(line));

        expect(groups[0]).toContain("CallList::run_one");
        expect(groups[0]).not.toContain("[name-only]");
        expect(result.text).not.toContain("[name-only]");
    });

    it("adds neither mark nor note for an unqualified symbol", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src",
            query: "attention_paged",
            kind: "call",
        });

        expect(result.text).not.toContain("[name-only]");
        expect(result.text).not.toContain("enclosing type");
    });

    it("does not mark a reference that spells the qualified type itself", async () => {
        // `OpId::gemm` inside a free function is exactly what was asked for; only the enclosing declaration is not
        // `OpId`. Tagging these `[name-only]` said the qualifier had been ignored when every row contained it.
        const source = new MemoryCodeSource("/project", {
            "src/registry.cpp": [
                "enum class OpId { gemm, other };",
                "",
                "void register_ops() {",
                "    add(OpId::gemm);",
                "}",
                "",
            ].join("\n"),
        });
        const result = await runUsages(source, {
            action: "usages",
            path: "src",
            query: "OpId::gemm",
            kind: "ref",
        });

        expect(result.text).toContain("OpId::gemm");
        expect(result.text).not.toContain("[name-only]");
    });
});
