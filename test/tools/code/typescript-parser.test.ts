import { describe, expect, it } from "vitest";

import { parseTypeScriptFile } from "../../../src/tools/code/typescript";

const TYPESCRIPT = `import type { External } from "./external";

export interface Options {
    readonly value: string;
    method(x: number): boolean;
}

export type Handler = (event: string) => void;

export enum Mode {
    A,
    B = 2,
}

export abstract class Base implements Options {
    private field: string;
    protected static count = 0;

    constructor(value: string) {
        this.field = value;
    }

    get value(): string {
        return this.field;
    }

    method(x: number): boolean {
        return x > 0;
    }

    abstract run(): void;
}

export function helper(a: number, b: number = 2): string {
    return String(a + b);
}

export const arrow = (value: string): number => value.length;
const plain = 42;

export namespace Outer {
    export function inner(): void {}
}
`;

describe("TypeScript adapter", () => {
    it("extracts interfaces, types, enums, classes, functions, and variables", async () => {
        const parsed = await parseTypeScriptFile(TYPESCRIPT, "/project/sample.ts", "typescript");

        expect(parsed.language).toBe("typescript");
        expect(parsed.parseErrors).toBe(0);
        expect(parsed.all.map((declaration) => declaration.qualifiedName)).toEqual(
            expect.arrayContaining([
                "Options",
                "Options::value",
                "Options::method",
                "Handler",
                "Mode",
                "Mode::A",
                "Mode::B",
                "Base",
                "Base::field",
                "Base::count",
                "Base::constructor",
                "Base::value",
                "Base::method",
                "Base::run",
                "helper",
                "arrow",
                "plain",
                "Outer",
                "Outer::inner",
            ]),
        );

        expect(parsed.all.find((item) => item.qualifiedName === "Options")?.kind).toBe("interface");
        expect(parsed.all.find((item) => item.qualifiedName === "Handler")?.kind).toBe("typeAlias");
        expect(parsed.all.find((item) => item.qualifiedName === "Mode::A")?.kind).toBe(
            "enumMember",
        );
        expect(parsed.all.find((item) => item.qualifiedName === "Base::field")?.access).toBe(
            "private",
        );
        expect(parsed.all.find((item) => item.qualifiedName === "Base::count")?.access).toBe(
            "protected",
        );
        expect(parsed.all.find((item) => item.qualifiedName === "Base::constructor")?.kind).toBe(
            "constructor",
        );
        expect(parsed.all.find((item) => item.qualifiedName === "Base::value")?.access).toBe(
            "public",
        );
        expect(parsed.all.find((item) => item.qualifiedName === "Base::run")?.isDefinition).toBe(
            false,
        );
        expect(parsed.all.find((item) => item.qualifiedName === "arrow")?.kind).toBe("function");
        expect(parsed.all.find((item) => item.qualifiedName === "plain")?.kind).toBe("variable");
        expect(parsed.all.find((item) => item.qualifiedName === "helper")?.paramTypes).toEqual([
            "number",
            "number",
        ]);
        expect(parsed.all.find((item) => item.qualifiedName === "helper")?.signature).toContain(
            "export function helper",
        );
        expect(parsed.all.find((item) => item.qualifiedName === "helper")?.bodyRange).toBeDefined();
    });

    it("parses TSX and keeps a component function as a declaration", async () => {
        const parsed = await parseTypeScriptFile(
            `export function Button(props: { label: string }) {
    return <button>{props.label}</button>;
}
`,
            "/project/button.tsx",
            "tsx",
        );

        expect(parsed.language).toBe("tsx");
        expect(parsed.parseErrors).toBe(0);
        expect(parsed.all.find((item) => item.qualifiedName === "Button")?.kind).toBe("function");
        expect(parsed.all.find((item) => item.qualifiedName === "Button")?.paramTypes).toEqual([
            "{label:string}",
        ]);
    });
});

const NESTED = `export function outer(): number {
    const local = 1;

    function inner(value: number): number {
        const arrow = (x: number) => x + value;
        return arrow(value);
    }

    const helper = () => inner(local);
    if (local > 0) {
        function conditional(): void {}
    }
    return helper();
}

export class Worker {
    run(): void {
        function step(): void {}
        const closure = () => step();
        closure();
    }
}
`;

describe("TypeScript nested closures", () => {
    it("extracts named inner functions and arrow constants but not plain locals", async () => {
        const parsed = await parseTypeScriptFile(NESTED, "/project/nested.ts", "typescript");

        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(names).toEqual(
            expect.arrayContaining([
                "outer",
                "outer::inner",
                "outer::inner::arrow",
                "outer::helper",
                "outer::conditional",
                "Worker",
                "Worker::run",
                "Worker::run::step",
                "Worker::run::closure",
            ]),
        );
        expect(names).not.toContain("outer::local");
        expect(
            parsed.all.find((declaration) => declaration.qualifiedName === "outer::inner")?.kind,
        ).toBe("function");
        expect(
            parsed.all.find((declaration) => declaration.qualifiedName === "outer::helper")?.kind,
        ).toBe("function");
        expect(
            parsed.all.find((declaration) => declaration.qualifiedName === "Worker::run::step")
                ?.kind,
        ).toBe("function");
    });
});
