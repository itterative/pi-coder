import { describe, expect, it } from "vitest";

import {
    adapterForLanguage,
    grammarForAdapter,
    preprocessWithAdapter,
} from "../../../src/tools/code/adapters";

describe("language adapters", () => {
    it("maps each supported language to its grammar", () => {
        expect(grammarForAdapter("cpp")).toBe("cpp");
        expect(grammarForAdapter("hip")).toBe("cpp");
        expect(grammarForAdapter("typescript")).toBe("typescript");
        expect(grammarForAdapter("tsx")).toBe("tsx");
        expect(grammarForAdapter("javascript")).toBe("javascript");
        expect(grammarForAdapter("java")).toBe("java");
        expect(grammarForAdapter("csharp")).toBe("c-sharp");
        expect(grammarForAdapter("go")).toBe("go");
        expect(grammarForAdapter("rust")).toBe("rust");
        expect(grammarForAdapter("python")).toBe("python");
        expect(grammarForAdapter("php")).toBe("php");
        expect(grammarForAdapter("ruby")).toBe("ruby");
        expect(grammarForAdapter("markdown")).toBeUndefined();
    });

    it("scopes preprocessing to the adapter", () => {
        const cpp = "__global__ void kernel() {}\n";
        const prepared = preprocessWithAdapter("cpp", cpp);

        expect(prepared).not.toContain("__global__");
        expect(prepared).toHaveLength(cpp.length);
        expect(preprocessWithAdapter("javascript", cpp)).toBe(cpp);
        expect(preprocessWithAdapter("typescript", cpp)).toBe(cpp);
        expect(preprocessWithAdapter("markdown", cpp)).toBe(cpp);
    });

    it("rejects an unknown language instead of guessing C++", () => {
        expect(() => adapterForLanguage("cobol")).toThrow("no parser adapter");
    });
});
