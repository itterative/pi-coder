import { describe, expect, it } from "vitest";

import {
    discoverFiles,
    parsePathTarget,
    patternWithinTarget,
} from "../../../src/tools/code/discovery";
import { MAX_FILES } from "../../../src/tools/code/languages";
import { MemoryCodeSource } from "../../helpers/code-source";

describe("path targets", () => {
    it.each([
        ["src/tools/**", "src/tools", "**"],
        ["src/**/*.ts", "src", "**/*.ts"],
        ["*.ts", ".", "*.ts"],
        ["**/src/**", ".", "**/src/**"],
        ["/project/src/*.ts", "/project/src", "*.ts"],
        // One-level under a prefix is over-collected as a basename pattern in rg; the post-filter trims it.
        ["src/*", "src", "*"],
    ])("expresses %s relative to %s as %s", (input, base, expected) => {
        const target = parsePathTarget(input);

        expect(target.base).toBe(base);
        expect(patternWithinTarget(target)).toBe(expected);
    });

    it("leaves an exclusion-looking pattern to the post-filter", () => {
        expect(patternWithinTarget(parsePathTarget("!src/**/*.ts"))).toBeUndefined();
    });

    it("leaves a literal path without a pattern", () => {
        const target = parsePathTarget("src/tools");

        expect(target.pattern).toBeUndefined();
        expect(patternWithinTarget(target)).toBeUndefined();
    });
});

describe("pattern-aware discovery", () => {
    it("counts matches, not every discovered file, against the cap", async () => {
        const files: Record<string, string> = {};

        for (let index = 0; index < MAX_FILES + 5; index += 1) {
            files[`src/unit${index}.ts`] = "";
        }

        for (let index = 0; index < 50; index += 1) {
            files[`src/notes${index}.md`] = "Plain notes.\n";
        }

        const source = new MemoryCodeSource("/project", files);
        const target = parsePathTarget("src/*.ts");
        const discovery = await discoverFiles(
            source,
            source.resolvePath(target.base),
            undefined,
            patternWithinTarget(target),
        );

        expect(discovery.files).toHaveLength(MAX_FILES);
        expect(discovery.truncated).toBe(true);
        expect(discovery.files.every((file) => file.endsWith(".ts"))).toBe(true);
    });
});
