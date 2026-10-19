import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    Heuristic,
    UnsafeReason,
    type HeuristicAssessment,
} from "../../src/modules/sandbox/heuristics";
import {
    isModelConsultableAssessment,
    isRelaxedConfinementSafe,
} from "../../src/tools/agent/child/safe-bash";

const temporaryDirectories: string[] = [];

/** An assessment with the given reasons; the helper reads only classification and reasons. */
function unsafe(...reasons: UnsafeReason[]): HeuristicAssessment {
    return { classification: Heuristic.UNSAFE, reasons, tags: [] };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function makeWorkspace(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-safe-bash-relaxed-"));
    temporaryDirectories.push(directory);
    return directory;
}

describe("safe-bash decision consult boundary", () => {
    it("consults only on the allowlist axis", () => {
        expect(isModelConsultableAssessment(unsafe(UnsafeReason.UNKNOWN_COMMAND))).toBe(true);
        expect(isModelConsultableAssessment(unsafe(UnsafeReason.COMMAND_NOT_ALLOWED))).toBe(true);

        expect(isModelConsultableAssessment(unsafe(UnsafeReason.OUTSIDE_CWD))).toBe(false);
        expect(
            isModelConsultableAssessment(
                unsafe(UnsafeReason.UNKNOWN_COMMAND, UnsafeReason.UNSAFE_FLAG),
            ),
        ).toBe(false);
        expect(
            isModelConsultableAssessment({
                classification: Heuristic.SAFE_READONLY,
                reasons: [],
                tags: [],
            }),
        ).toBe(false);
    });

    it("re-checks unknown commands with every literal path confined", () => {
        const cwd = makeWorkspace();
        fs.writeFileSync(path.join(cwd, "run.py"), "print(1)\n");

        expect(isRelaxedConfinementSafe("python3 -c 'print(1)'", cwd)).toBe(true);
        expect(isRelaxedConfinementSafe("python3 run.py", cwd)).toBe(true);
        expect(isRelaxedConfinementSafe("awk 'NR==1' run.py", cwd)).toBe(true);

        expect(isRelaxedConfinementSafe("python3 /etc/hostname", cwd)).toBe(false);
        expect(isRelaxedConfinementSafe("awk 'NR==1' /etc/hostname", cwd)).toBe(false);
        expect(isRelaxedConfinementSafe(`python3 -c "$(cat run.py)"`, cwd)).toBe(false);
    });

    it("treats quoted inline code as code, not as a dynamic path", () => {
        const cwd = makeWorkspace();
        fs.writeFileSync(path.join(cwd, "run.py"), "print(1)\n");

        expect(isRelaxedConfinementSafe(`python3 -c 'print({"a": 1})'`, cwd)).toBe(true);
        expect(isRelaxedConfinementSafe(`python3 -c 'print("a" * 3)'`, cwd)).toBe(true);
        expect(isRelaxedConfinementSafe(`python3 -c 'print(f"{1+1}")'`, cwd)).toBe(true);
        expect(isRelaxedConfinementSafe(`node -e 'console.log({a: 1})'`, cwd)).toBe(true);

        // The rest of the command is still checked: a real outside path stays blocked.
        expect(isRelaxedConfinementSafe(`python3 -c 'print({"a": 1})' /etc/hostname`, cwd)).toBe(
            false,
        );
        // Only the literal operand is exempted; a dynamic operand has no code to vouch for.
        expect(isRelaxedConfinementSafe(`python3 -c "$(cat run.py)"`, cwd)).toBe(false);
        // A chain keeps the full-line answer, because no directory state is guessed across commands.
        expect(
            isRelaxedConfinementSafe(`python3 -c 'print({"a": 1})' && cat run.py`, cwd),
        ).toBe(false);
    });
});
