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
            symbols: ["buildReminderSignals"],
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
            symbols: ["ReminderSignals"],
        });

        expect(result.text).toContain("interface ReminderSignals");
        expect(result.text).toContain("currentTurn: number");
    });

    it("finds TypeScript definitions and call sites", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src/reminders",
            symbols: ["buildReminderSignals"],
        });

        expect(result.text).toContain("src/reminders/signals.ts");
        expect(result.text).toContain("[def]");
        expect(result.text).toContain("src/reminders/index.ts");
        expect(result.text).toContain("[call]");
        expect(result.matches).toBeGreaterThanOrEqual(2);
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
            symbols: ["outer::inner"],
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
            symbols: ["inner"],
        });

        expect(result.text).toContain("outer");
        expect(result.text).toContain("[def]");
        expect(result.text).toContain("[call]");
        expect(result.matches).toBeGreaterThanOrEqual(2);
    });
});
