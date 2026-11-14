import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { runShow } from "../../../src/tools/code/show";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

const FILES: Record<string, string> = {
    "src/reminders/signals.ts": `export interface ReminderSignals {
    currentTurn: number;
}

export function buildReminderSignals(input: ReminderSignals): ReminderSignals {
    return { ...input, currentTurn: input.currentTurn + 1 };
}
`,
    "src/reminders/index.ts": `import { buildReminderSignals } from "./signals";

export function registerReminders(): void {
    const signals = buildReminderSignals({ currentTurn: 1 });

    console.log(signals);
}
`,
    "src/reminders/component.tsx": `export function Badge(props: { label: string }) {
    return <span>{props.label}</span>;
}
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline on TypeScript", () => {
    it("digests a TypeScript directory", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/reminders",
        });

        expect(result.text).toContain("# digest src/reminders · 3 files · tsx,typescript ·");
        expect(result.text).toContain("export function buildReminderSignals");
        expect(result.text).toContain("export interface ReminderSignals");
        expect(result.text).toContain("export function Badge");
        expect(result.parseErrors).toBe(0);
    });

    it("shows a TypeScript function and searches its declaration", async () => {
        const shown = await runShow(source(), {
            action: "show",
            path: "src/reminders",
            query: "buildReminderSignals",
        });
        const searched = await runSearch(source(), {
            action: "search",
            path: "src/reminders",
            query: "buildReminder",
        });

        expect(shown.text).toContain("function buildReminderSignals · definition");
        expect(shown.text).toContain("return { ...input");
        expect(searched.text).toContain("function  buildReminderSignals");
        expect(searched.matches).toBe(1);
    });

    it("shows an interface with its members", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/reminders",
            query: "ReminderSignals",
        });

        expect(result.text).toContain("interface ReminderSignals");
        expect(result.text).toContain("currentTurn: number");
    });

    it("finds TypeScript definitions and call sites", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src/reminders",
            query: "buildReminderSignals",
        });

        expect(result.text).toContain("src/reminders/signals.ts");
        expect(result.text).toContain("[def]");
        expect(result.text).toContain("src/reminders/index.ts");
        expect(result.text).toContain("[call]");
        expect(result.matches).toBeGreaterThanOrEqual(2);
    });
});

describe("outline signature-hide notes", () => {
    it("names the kinds a single-file digest hid, and only for a file target", async () => {
        const shape = new MemoryCodeSource("/project", {
            "src/shape.ts": `export class Box {
    private value = 1;
    method(): void {}
}

export enum Mode {
    A,
    B,
}
`,
        });
        const file = await runDigest(shape, { action: "digest", path: "src/shape.ts" });

        expect(file.text).toContain("class Box");
        expect(file.text).toContain("enum Mode");
        expect(file.text).toContain(
            "# kinds: 2 enum members, 1 field hidden in signatures detail; detail=full lists all",
        );

        // A directory digest would repeat the line per file; the general rule stays in the docs.
        const directory = await runDigest(shape, { action: "digest", path: "src" });
        expect(directory.text).not.toContain("# kinds:");

        // Nothing is hidden in full detail, so there is nothing to announce.
        const full = await runDigest(shape, {
            action: "digest",
            path: "src/shape.ts",
            detail: "full",
        });
        expect(full.text).not.toContain("# kinds:");
    });
});

describe("outline show dedent note", () => {
    const nested = new MemoryCodeSource("/project", {
        "src/nested.ts": `export class Box {
    method(): void {
        return;
    }
}

export namespace Outer {
    export class Inner {
        method(): void {}
    }
}
`,
    });

    it("points at the file range when a body was dedented", async () => {
        const method = await runShow(nested, {
            action: "show",
            path: "src/nested.ts",
            query: "Box::method",
        });
        const container = await runShow(nested, {
            action: "show",
            path: "src/nested.ts",
            query: "Outer::Inner",
            detail: "full",
        });

        expect(method.text).toContain(
            "# dedented: read src/nested.ts:2-4 for the exact indentation before editing",
        );
        expect(container.text).toContain(
            "# dedented: read src/nested.ts:8-10 for the exact indentation before editing",
        );
    });

    it("stays quiet for a top-level declaration", async () => {
        const box = await runShow(nested, {
            action: "show",
            path: "src/nested.ts",
            query: "Box",
            detail: "full",
        });

        expect(box.text).not.toContain("# dedented:");
    });
});

describe("outline on TypeScript root constants", () => {
    it("lists module-level constants but not block locals", async () => {
        const constants = new MemoryCodeSource("/project", {
            "src/constants.ts": `export const LIMIT = 10;
const TABLE = { a: 1, b: 2 };

export function read(): number {
    const local = 1;
    return LIMIT + local;
}
`,
        });
        const digest = await runDigest(constants, {
            action: "digest",
            path: "src/constants.ts",
        });

        expect(digest.text).toContain("const LIMIT = 10");
        expect(digest.text).toContain("const TABLE");
        expect(digest.text).not.toContain("const local");
    });
});

const NESTED_FILES: Record<string, string> = {
    "src/closures.ts": `export function outer(): number {
    const local = 1;

    function inner(value: number): number {
        return value + local;
    }

    const helper = () => inner(local);
    return helper();
}
`,
};

describe("outline on nested TypeScript closures", () => {
    it("lists and shows inner closures", async () => {
        const nested = new MemoryCodeSource("/project", NESTED_FILES);
        const digest = await runDigest(nested, {
            action: "digest",
            path: "src/closures.ts",
        });
        const shown = await runShow(nested, {
            action: "show",
            path: "src/closures.ts",
            query: "outer::inner",
        });
        const searched = await runSearch(nested, {
            action: "search",
            path: "src/closures.ts",
            query: "inner",
        });

        expect(digest.text).toContain("function inner");
        expect(digest.text).toContain("const helper = () => inner(local)");
        expect(shown.text).toContain("function outer::inner · definition");
        expect(shown.text).toContain("return value + local");
        expect(searched.text).toContain("function  outer::inner");
    });

    it("groups nested usages under their closure scope", async () => {
        const nested = new MemoryCodeSource("/project", NESTED_FILES);
        const result = await runUsages(nested, {
            action: "usages",
            path: "src/closures.ts",
            query: "inner",
        });

        expect(result.text).toContain("outer");
        expect(result.text).toContain("[def]");
        expect(result.text).toContain("[call]");
        expect(result.matches).toBeGreaterThanOrEqual(2);
    });
});
