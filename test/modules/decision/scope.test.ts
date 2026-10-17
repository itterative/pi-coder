import { describe, expect, it } from "vitest";

import {
    scopeAnswer,
    type ScriptCapability,
    type ScriptCapabilitySummary,
} from "../../../src/modules/decision";

function profiles(...capabilities: ScriptCapability[]): ScriptCapabilitySummary[] {
    return capabilities.map((capability) => ({ source: "run.py", capability }));
}

describe("decision scope gate", () => {
    it("asks the inspect rung for nothing but read-only code", () => {
        expect(scopeAnswer(profiles("read_only"), "scout")).toBeUndefined();

        expect(scopeAnswer(profiles("writes_files"), "scout")).toMatchObject({
            action: "refuse",
            reason: "out_of_scope",
            confidence: 0,
        });
        expect(scopeAnswer(profiles("read_only", "network"), "advisor")?.reason).toBe(
            "out_of_scope",
        );
    });

    it("lets the command rung run builds that write, but not code that leaves the copy", () => {
        expect(scopeAnswer(profiles("read_only", "writes_files"), "reviewer")).toBeUndefined();

        for (const capability of [
            "writes_outside",
            "network",
            "privileged",
            "remote_code",
            "destructive",
            "process_control",
        ] as const) {
            expect(scopeAnswer(profiles(capability), "reviewer")?.reason).toBe("out_of_scope");
        }
    });

    it("covers every capability for a mutating runner", () => {
        for (const capability of [
            "read_only",
            "writes_files",
            "writes_outside",
            "network",
            "privileged",
            "remote_code",
            "destructive",
            "process_control",
        ] as const) {
            expect(scopeAnswer(profiles(capability), "parent")).toBeUndefined();
            expect(scopeAnswer(profiles(capability), "worker")).toBeUndefined();
        }
    });

    it("treats a custom agent at the command rung", () => {
        expect(scopeAnswer(profiles("writes_files"), "agent")).toBeUndefined();
        expect(scopeAnswer(profiles("network"), "agent")?.reason).toBe("out_of_scope");
    });

    it("has no answer when there are no bodies", () => {
        expect(scopeAnswer([], "scout")).toBeUndefined();
    });
});
