import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { runDeps } from "../../../src/tools/code/deps";
import { importsOf } from "../../../src/tools/code/imports";
import { clearCodeCache, loadParsedFile } from "../../../src/tools/code/load";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

const TYPESCRIPT = {
    "src/core/util.ts": "export function helper(): number {\n    return 1;\n}\n",
    "src/core/user.ts": [
        'import path from "node:path";',
        'import { helper } from "./util";',
        'import { gone } from "./missing";',
        'const fs = require("node:fs");',
        "",
        "export function use(): number {",
        "    return helper() + (path.sep.length > 0 ? 1 : 0) + (fs === null ? 1 : 0);",
        "}",
        "",
    ].join("\n"),
    "src/app.ts": [
        'import { helper } from "./core/util";',
        "",
        "export const value = helper();",
        "",
    ].join("\n"),
    "test/user.test.ts": 'import { use } from "../src/core/user";\n',
};

/** One import row, tolerant of the state column's padding but strict about its fields. */
function importRow(state: string, specifier: string, line: number, target?: string): RegExp {
    const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const suffix = target === undefined ? "" : `\\s+→\\s+${escaped(target)}`;

    return new RegExp(`^\\s+${state}\\s+${escaped(specifier)}\\s+:${line}${suffix}`, "m");
}

function source(files: Record<string, string> = TYPESCRIPT): MemoryCodeSource {
    return new MemoryCodeSource("/project", files);
}

describe("outline deps", () => {
    it("separates local, external, and unresolved imports", async () => {
        const result = await runDeps(source(), {
            action: "deps",
            path: "src/core/user.ts",
        });

        expect(result.text).toContain("# deps src/core/user.ts");
        expect(result.text).toContain("4 imports");
        expect(result.text).toContain("1 local");
        expect(result.text).toContain("2 external");
        expect(result.text).toContain("1 unresolved");
        expect(result.text).toMatch(importRow("local", "./util", 2, "src/core/util.ts"));
        expect(result.text).toMatch(importRow("external", "node:path", 1));
        expect(result.text).toMatch(importRow("unresolved", "./missing", 3));
    });

    it("lists the files that import the subject, with their line", async () => {
        const result = await runDeps(source(), {
            action: "deps",
            path: "src/core/util.ts",
        });

        expect(result.text).toContain("0 imports");
        expect(result.text).toContain("2 dependents");
        expect(result.text).toContain("src/app.ts  :1");
        expect(result.text).toContain("src/core/user.ts  :2");
    });

    it("does not turn a commented-out import into an edge", async () => {
        const files = {
            "src/util.ts": "export const value = 1;\n",
            "src/comment.ts": [
                '// import { value } from "./util";',
                'import { value } from "./util";',
                "",
            ].join("\n"),
        };
        const result = await runDeps(source(files), { action: "deps", path: "src/comment.ts" });

        expect(result.text).toContain("1 import");
        expect(result.text).toContain("local");
    });

    it("reports dependents from the whole tree, with no filter to hide them", async () => {
        const result = await runDeps(source(), {
            action: "deps",
            path: "src/core/user.ts",
        });

        expect(result.text).toContain("test/user.test.ts");
        expect(result.text).not.toContain("# filter:");
    });

    it("takes a file, not a pattern", async () => {
        const result = await runDeps(source(), { action: "deps", path: "src/**" });

        expect(result.text).toBe("# deps takes a file, not a pattern: src/**");
    });

    it("keeps an include target outside the subject's directory resolvable", async () => {
        const result = await runDeps(
            source({
                "proj/CMakeLists.txt": "",
                "proj/include/app/util.hpp": "#pragma once\n",
                "proj/src/main.cpp": "#include <app/util.hpp>\n",
                "proj/src/other.cpp": "#include <app/util.hpp>\n",
            }),
            { action: "deps", path: "proj/src/main.cpp" },
        );

        expect(result.text).toMatch(
            importRow("local", "app/util.hpp", 1, "proj/include/app/util.hpp"),
        );
    });

    it("needs a file, not a directory", async () => {
        const result = await runDeps(source(), { action: "deps", path: "src" });

        expect(result.text).toContain("needs a file, not a directory");
    });
});

describe("outline deps across languages", () => {
    it("resolves C and C++ quoted includes but not system headers", async () => {
        const result = await runDeps(
            source({
                "native/a.h": "#pragma once\nint a();\n",
                "native/b.cpp": '#include "a.h"\n#include <vector>\nint b() { return a(); }\n',
            }),
            { action: "deps", path: "native/b.cpp" },
        );

        expect(result.text).toContain("2 imports");
        expect(result.text).toMatch(importRow("local", "a.h", 1, "native/a.h"));
        expect(result.text).toMatch(importRow("external", "vector", 2));
    });

    it("resolves Python absolute and relative modules", async () => {
        const files = {
            "py/pkg/__init__.py": "",
            "py/pkg/mod.py": "def f():\n    return 1\n",
            "py/app.py": "from pkg.mod import f\n",
            "py/pkg/other.py": "from .mod import f\n",
        };
        const absolute = await runDeps(source(files), { action: "deps", path: "py/app.py" });
        const relative = await runDeps(source(files), { action: "deps", path: "py/pkg/other.py" });

        expect(absolute.text).toMatch(importRow("local", "pkg.mod", 1, "py/pkg/mod.py"));
        expect(relative.text).toMatch(importRow("local", ".mod", 1, "py/pkg/mod.py"));
    });

    it("resolves Rust crate paths", async () => {
        const result = await runDeps(
            source({
                "rust/src/lib.rs": "pub mod a;\npub mod b;\n",
                "rust/src/a.rs": "use crate::b::thing;\n",
                "rust/src/b.rs": "pub fn thing() {}\n",
            }),
            { action: "deps", path: "rust/src/a.rs" },
        );

        expect(result.text).toMatch(importRow("local", "crate::b::thing", 1, "rust/src/b.rs"));
    });

    it("resolves Java and C# names to the file that declares them", async () => {
        const java = await runDeps(
            source({
                "java/com/acme/Util.java": "package com.acme;\npublic class Util {}\n",
                "java/com/acme/App.java":
                    "package com.acme;\nimport com.acme.Util;\nimport java.util.List;\npublic class App {}\n",
            }),
            { action: "deps", path: "java/com/acme/App.java" },
        );
        const csharp = await runDeps(
            source({
                "cs/Util.cs": "namespace Acme.Util { public class Helper {} }\n",
                "cs/App.cs": "using Acme.Util;\nusing System.Text;\npublic class App {}\n",
            }),
            { action: "deps", path: "cs/App.cs" },
        );

        expect(java.text).toMatch(
            importRow("local", "com.acme.Util", 2, "java/com/acme/Util.java"),
        );
        expect(java.text).toMatch(importRow("external", "java.util.List", 3));
        expect(csharp.text).toMatch(importRow("local", "Acme.Util", 1, "cs/Util.cs"));
        expect(csharp.text).toMatch(importRow("external", "System.Text", 2));
    });

    it("resolves a Go package path to its directory and a PHP namespace to its file", async () => {
        const go = await runDeps(
            source({
                "pkg/x/x.go": "package x\nfunc X() {}\n",
                "cmd/app/main.go":
                    'package main\n\nimport "github.com/acme/repo/pkg/x"\n\nfunc main() { x.X() }\n',
            }),
            { action: "deps", path: "cmd/app/main.go" },
        );
        const php = await runDeps(
            source({
                "php/Util.php": "<?php\nnamespace Acme;\nclass Util {}\n",
                "php/App.php": "<?php\nuse Acme\\Util;\nclass App {}\n",
            }),
            { action: "deps", path: "php/App.php" },
        );

        expect(go.text).toMatch(importRow("local", "github.com/acme/repo/pkg/x", 3, "pkg/x/"));
        expect(php.text).toMatch(importRow("local", "Acme\\Util", 2, "php/Util.php"));
    });

    it("resolves Ruby require_relative and leaves require external", async () => {
        const result = await runDeps(
            source({
                "rb/lib.rb": "def helper; end\n",
                "rb/app.rb": 'require_relative "lib"\nrequire "json"\n',
            }),
            { action: "deps", path: "rb/app.rb" },
        );

        expect(result.text).toMatch(importRow("local", "lib", 1, "rb/lib.rb"));
        expect(result.text).toMatch(importRow("external", "json", 2));
    });
});

describe("outline deps discovery", () => {
    /** A source whose cwd walk hides a tree, the way ripgrep honours a gitignore. */
    class HiddenSource extends MemoryCodeSource {
        constructor(
            cwd: string,
            files: Record<string, string>,
            private readonly hidden: string,
        ) {
            super(cwd, files);
        }

        override async glob(root: string, options: { limit: number; signal?: AbortSignal }) {
            const files = await super.glob(root, options);

            return root === this.cwd
                ? files.filter((file) => !path.relative(this.cwd, file).startsWith(this.hidden))
                : files;
        }
    }

    it("resolves CMake-style angle includes through include/ roots", async () => {
        const result = await runDeps(
            source({
                "proj/CMakeLists.txt": "",
                "proj/include/app/util.hpp": "#pragma once\n",
                "proj/src/main.cpp": "#include <app/util.hpp>\n#include <vector>\n",
            }),
            { action: "deps", path: "proj/src/main.cpp" },
        );

        expect(result.text).toMatch(
            importRow("local", "app/util.hpp", 1, "proj/include/app/util.hpp"),
        );
        expect(result.text).toMatch(importRow("external", "vector", 2));
    });

    it("scans the nearest project root when the cwd walk skips the subject", async () => {
        const files = {
            ".hidden/proj/CMakeLists.txt": "",
            ".hidden/proj/include/app/util.hpp": "#pragma once\n",
            ".hidden/proj/src/main.cpp": "#include <app/util.hpp>\n",
            ".hidden/proj/src/other.cpp": "#include <app/util.hpp>\n",
        };
        const result = await runDeps(new HiddenSource("/project", files, ".hidden"), {
            action: "deps",
            path: ".hidden/proj/include/app/util.hpp",
        });

        expect(result.text).toContain("2 dependents");
        expect(result.text).toContain(".hidden/proj/src/main.cpp  :1");
        expect(result.text).toContain(".hidden/proj/src/other.cpp  :1");
    });
});

describe("outline import extraction", () => {
    async function parse(relative: string, content: string) {
        const memory = source({ [relative]: content });
        const loaded = await loadParsedFile(memory, `/project/${relative}`);

        if (loaded.kind !== "parsed") {
            throw new Error("expected a parsed file");
        }

        return loaded.parsed;
    }

    it("ignores an import inside a string literal", async () => {
        const file = await parse(
            "src/s.ts",
            'const text = `\nimport x from "./fake";\n`;\nimport { real } from "./real";\n',
        );
        const imports = importsOf(file);

        expect(imports.map((entry) => entry.specifier)).toEqual(["./real"]);
    });

    it("dedupes repeated specifiers and keeps the first line", async () => {
        const file = await parse(
            "src/s.ts",
            'import { a } from "./x";\nimport { b } from "./x";\n',
        );

        expect(importsOf(file)).toEqual([
            { specifier: "./x", line: 1, style: "path", relative: true },
        ]);
    });
});
