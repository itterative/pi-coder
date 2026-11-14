import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { runShow } from "../../../src/tools/code/show";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

/**
 * Macros are declarations.
 *
 * `kind=macro` existed while nothing produced one, so a `#define` a caller had seen in the file was invisible to
 * `search`, `digest`, and `show`, and searching its name returned only the functions whose signatures mention it.
 * C/C++ preprocessor defines and Rust `macro_rules!` are indexed now; the value is the body, which is what makes
 * a log or error string inside a macro reachable by literal text search.
 */
const FILES: Record<string, string> = {
    "src/x.hpp": [
        "#define MAX 10",
        "#define SQUARE(x) ((x) * (x))",
        "#define MULTI(a, b) \\",
        "    ((a) + (b))",
        "/// Logs and throws.",
        "#define LOG(message) throw std::runtime_error(message)",
        "#ifdef HIP",
        "#define DEVICE __device__",
        "#else",
        "#define DEVICE",
        "#endif",
        'void use() { int x = SQUARE(MAX); LOG("boom"); }',
        "",
    ].join("\n"),
    "src/lib.rs": [
        "macro_rules! must_use {",
        "    ($value:expr) => {",
        "        $value",
        "    };",
        "}",
        "",
    ].join("\n"),
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline macros in digest", () => {
    it("lists a C++ #define with its signature and range", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/x.hpp",
            detail: "signatures",
        });

        expect(result.text).toContain("#define MAX 10  :1 [def]");
        expect(result.text).toContain("#define SQUARE(x) ((x) * (x))  :2 [def]");
        // A continuation is one declaration spanning two lines, and the signature stops before the backslash.
        expect(result.text).toContain("#define MULTI(a, b)  :3-4 [def]");
    });

    it("lists a Rust macro_rules! as a macro", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/lib.rs",
            detail: "signatures",
        });

        expect(result.text).toContain("macro_rules! must_use  :1-5 [def]");
    });

    it("keeps the macros from every preprocessor branch", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/x.hpp",
            kind: "macro",
        });

        // Both branches are parsed; the tool is not a preprocessor and must not pretend one was evaluated.
        expect(result.text).toContain("#define DEVICE __device__");
        expect(result.text).toContain("#define DEVICE");
        expect(result.text).not.toContain("void use()");
    });
});

describe("outline macros in search, show, and usages", () => {
    it("finds a macro by name under kind=macro", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "MAX",
            kind: "macro",
        });

        expect(result.text).toContain("macro  MAX  #define MAX 10 [def]");
        expect(result.text).toContain("# filter: kind=macro");
    });

    it("shows the macro with the doc comment above it", async () => {
        const result = await runShow(source(), { action: "show", path: "src", query: "LOG" });

        expect(result.text).toContain("macro LOG");
        expect(result.text).toContain("#define LOG(message) throw std::runtime_error(message)");
        expect(result.text).toContain("Logs and throws.");
    });

    it("counts the definition and its call sites in usages", async () => {
        const result = await runUsages(source(), { action: "usages", path: "src", query: "MAX" });

        expect(result.text).toContain("#define MAX 10  [def]");
        expect(result.text).toContain("SQUARE(MAX)");
        expect(result.text).toContain("[ref]");
    });

    it("reaches text inside a macro value with a literal body search", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "runtime error",
        });

        expect(result.text).toContain("macro  LOG");
        expect(result.text).toContain("[body]");
        expect(result.text).toContain("throw std::runtime_error(message)");
    });
});
