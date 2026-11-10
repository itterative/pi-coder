import { describe, expect, it } from "vitest";

import { parseCodeFile } from "../../../src/tools/code/parse";

const JAVASCRIPT = `// A small module.
export class Runner {
    #secret = 1;

    constructor(value) {
        this.value = value;
    }

    run(input) {
        const helper = (x) => x + this.value;
        return helper(input);
    }

    make = (z) => z + 1;
}

export function makeRunner(value) {
    return new Runner(value);
}

export const arrow = (x) => x * 2;

function outer() {
    const local = 1;
    const inner = () => local;
    return inner();
}
`;

describe("JavaScript adapter", () => {
    it("extracts classes, members, functions, variables, and nested closures", async () => {
        const parsed = await parseCodeFile(JAVASCRIPT, "/project/sample.js", "javascript");
        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(parsed.language).toBe("javascript");
        expect(parsed.parseErrors).toBe(0);
        expect(names).toEqual(
            expect.arrayContaining([
                "Runner",
                "Runner::#secret",
                "Runner::constructor",
                "Runner::run",
                "Runner::run::helper",
                "Runner::make",
                "makeRunner",
                "arrow",
                "outer",
                "outer::inner",
            ]),
        );
        expect(names).not.toContain("outer::local");
        expect(parsed.all.find((item) => item.qualifiedName === "Runner")?.kind).toBe("class");
        expect(parsed.all.find((item) => item.qualifiedName === "Runner::constructor")?.kind).toBe(
            "constructor",
        );
        expect(parsed.all.find((item) => item.qualifiedName === "Runner::run")?.kind).toBe(
            "method",
        );
        expect(parsed.all.find((item) => item.qualifiedName === "arrow")?.kind).toBe("function");
        expect(parsed.all.find((item) => item.qualifiedName === "outer::inner")?.kind).toBe(
            "function",
        );
    });

    it("parses JSX with the javascript grammar and keeps the component declaration", async () => {
        const parsed = await parseCodeFile(
            `export default function App({ label }) {
    return <section className="app">{label}</section>;
}
`,
            "/project/component.jsx",
            "javascript",
        );

        expect(parsed.language).toBe("javascript");
        expect(parsed.parseErrors).toBe(0);
        expect(parsed.all.find((item) => item.qualifiedName === "App")?.kind).toBe("function");
    });
});
