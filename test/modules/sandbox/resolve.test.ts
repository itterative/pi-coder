import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import resolvePermission, { resolvePermissionDetails } from "../../../src/modules/sandbox/resolve";
import type { SandboxConfigCwdConfinement } from "../../../src/common/config";
import type { Permission } from "../../../src/modules/sandbox/permissions";

const CWD = "/project";
const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

interface ResolveTest {
    desc: string;
    command: string;
    permissions: Record<string, Permission>;
    cwdConfinement?: SandboxConfigCwdConfinement;
    expected: Permission;
}

const runTests = (tests: ResolveTest[]) => {
    it.each(tests)("$desc", (test) => {
        expect(
            resolvePermission(test.command, CWD, {
                permissions: test.permissions,
                cwdConfinement: test.cwdConfinement ?? {},
            }),
        ).toBe(test.expected);
    });
};

describe("resolvePermissionDetails: unresolved segments", () => {
    it("passes additional roots to cwd confinement", () => {
        const scratchpad = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-resolve-root-"));
        temporaryDirectories.push(scratchpad);

        expect(resolvePermission(
            `cat ${path.join(scratchpad, "notes.txt")}`,
            CWD,
            {
                permissions: {},
                cwdConfinement: {},
                additionalRoots: [scratchpad],
            },
        )).toBe("allow:sandbox");
        expect(resolvePermission(
            `rm -rf ${path.join(scratchpad, "notes.txt")}`,
            CWD,
            {
                permissions: {},
                cwdConfinement: {},
                additionalRoots: [scratchpad],
            },
        )).toBe("allow:sandbox");
        expect(resolvePermission("rm -rf file.txt", CWD, {
            permissions: {},
            cwdConfinement: {},
        })).toBe("ask");
    });

    const check = (
        command: string,
        permissions: Record<string, Permission> = {},
        cwdConfinement?: SandboxConfigCwdConfinement,
    ) =>
        resolvePermissionDetails(command, CWD, {
            permissions,
            cwdConfinement: cwdConfinement ?? {},
        });

    it("single unknown segment in a heuristic chain", () => {
        const d = check("cd /project && npx vitest run | tail -5");
        expect(d.permission).toBe("ask");
        expect(d.unresolved).toEqual([[
            "npx", "vitest", "run",
        ]]);
    });

    it("two unknown segments", () => {
        const d = check("foo a && bar b");
        expect(d.permission).toBe("ask");
        expect(d.unresolved).toEqual([
            ["foo", "a"],
            ["bar", "b"],
        ]);
    });

    it("heuristic-covered chain: none unresolved", () => {
        const d = check("cat file.txt && ls src");
        expect(d.permission).toBe("allow:sandbox");
        expect(d.unresolved).toEqual([]);
    });

    it("explicit ask rule: ask, but none unresolved", () => {
        const d = check("npx vitest", { "npx *": "ask" });
        expect(d.permission).toBe("ask");
        expect(d.unresolved).toEqual([]);
    });

    it("uncovered sensitive segment is reported", () => {
        const d = check("cat .env");
        expect(d.permission).toBe("ask");
        expect(d.unresolved).toEqual([["cat", ".env"]]);
    });

    it("allow rule on one segment does not hide the other", () => {
        const d = check("npx vitest && nc host 80", { "npx *": "allow" });
        expect(d.permission).toBe("ask");
        expect(d.unresolved).toEqual([[
            "nc", "host", "80",
        ]]);
    });

    it("deny: permission deny (unresolved list not used for the dialog)", () => {
        const d = check("npx vitest && rm -rf x", { "rm *": "deny" });
        expect(d.permission).toBe("deny");
    });

    it("empty command", () => {
        const d = check("");
        expect(d.permission).toBe("ask");
        expect(d.unresolved).toEqual([]);
    });
});

describe("resolvePermission: patterns vs heuristics", () => {
    describe("explicit patterns always win over heuristics", () => {
        runTests([
            {
                desc: "explicit allow is not downgraded to allow:sandbox",
                command: "cat file.txt",
                permissions: { "cat *": "allow" },
                expected: "allow",
            },
            {
                desc: "explicit deny is not relaxed by heuristic",
                command: "cat file.txt",
                permissions: { "cat *": "deny" },
                expected: "deny",
            },
            {
                desc: "explicit ask is not relaxed by heuristic",
                command: "cat file.txt",
                permissions: { "cat *": "ask" },
                expected: "ask",
            },
            {
                desc: "heuristic applies when pattern does not match",
                command: "cat file.txt",
                permissions: { "npm *": "allow" },
                expected: "allow:sandbox",
            },
            {
                desc: "heuristic classification maps to configured permission",
                command: "cat file.txt",
                permissions: {},
                cwdConfinement: { permission: "allow" },
                expected: "allow",
            },
        ]);
    });

    describe('"**" default is not overridden by heuristics', () => {
        runTests([
            {
                desc: "deny default stands for heuristic-eligible command",
                command: "cat file.txt",
                permissions: { "**": "deny" },
                expected: "deny",
            },
            {
                desc: "allow default is not downgraded to allow:sandbox",
                command: "cat file.txt",
                permissions: { "**": "allow" },
                expected: "allow",
            },
            {
                desc: "allow:sandbox default stands",
                command: "cat file.txt",
                permissions: { "**": "allow:sandbox" },
                expected: "allow:sandbox",
            },
            {
                desc: "explicit ask default lets heuristic apply",
                command: "cat file.txt",
                permissions: { "**": "ask" },
                expected: "allow:sandbox",
            },
        ]);
    });

    describe("chained commands (cd ... && npx vitest | tail ...)", () => {
        const chained = "cd /project && npx vitest | tail -5";

        runTests([
            {
                desc: "bare rule matches its segment within a chain and dominates",
                command: chained,
                permissions: { "npx vitest": "allow" },
                expected: "allow",
            },
            {
                desc: "wildcard rule matches its segment within a chain and dominates",
                command: chained,
                permissions: { "npx *": "allow" },
                expected: "allow",
            },
            {
                desc: "whole-command chain pattern takes precedence over per-segment",
                command: chained,
                permissions: { "cd * && npx vitest | tail *": "allow", "npx *": "deny" },
                expected: "allow",
            },
            {
                desc: "bare npx vitest matches its own rule (not downgraded)",
                command: "npx vitest",
                permissions: { "npx vitest": "allow" },
                expected: "allow",
            },
            {
                desc: "chain with only known confined commands gets heuristic permission",
                command: "cd /project && cat output.txt | tail -5",
                permissions: { "npx vitest": "allow" },
                expected: "allow:sandbox",
            },
            {
                desc: "heuristic segments use cwd after cd",
                command: "cd src && cat ../README.md",
                permissions: { "cd *": "allow" },
                expected: "allow",
            },
            {
                desc: "pipeline directory changes do not leak to heuristics",
                command: "cd src | cat ../README.md",
                permissions: { "cd *": "allow" },
                expected: "ask",
            },
            {
                desc: "unknown segment without a rule keeps the chain at ask",
                command: "cat file.txt && nc host 80",
                permissions: { "npx *": "allow" },
                expected: "ask",
            },
        ]);
    });

    describe("per-segment combination", () => {
        runTests([
            {
                desc: "deny in any segment dominates the chain",
                command: "cat ok.txt && rm -rf build",
                permissions: { "rm *": "deny" },
                expected: "deny",
            },
            {
                desc: "deny dominates even with allow and heuristic segments",
                command: "npx vitest && cat ok.txt && rm -rf build",
                permissions: { "npx *": "allow", "rm *": "deny" },
                expected: "deny",
            },
            {
                desc: "ask in any segment prompts for the chain",
                command: "cat file.txt | tail -5",
                permissions: { "tail *": "ask" },
                expected: "ask",
            },
            {
                desc: "explicit allow dominates heuristic segments (runs unsandboxed)",
                command: "cat file.txt | tail -5",
                permissions: { "cat *": "allow" },
                expected: "allow",
            },
            {
                desc: "explicit allow:sandbox dominates heuristic segments (runs sandboxed)",
                command: "cat file.txt | tail -5",
                permissions: { "cat *": "allow:sandbox" },
                expected: "allow:sandbox",
            },
            {
                desc: "unresolved segment forces ask despite allow rule on another segment",
                command: "npx vitest && nc host 80",
                permissions: { "npx *": "allow" },
                expected: "ask",
            },
            {
                desc: "sensitive path in a segment prompts for the chain",
                command: "cat .env | tail -5",
                permissions: {},
                expected: "ask",
            },
            {
                desc: "multi-line: policy line dominates heuristic line",
                command: "cat file.txt\nnpx vitest",
                permissions: { "npx *": "allow" },
                expected: "allow",
            },
            {
                desc: "multi-line: deny line dominates allow line",
                command: "npx vitest\nrm -rf build",
                permissions: { "npx *": "allow", "rm *": "deny" },
                expected: "deny",
            },
            {
                desc: "heuristic-only chain resolves to heuristic permission",
                command: "cat file.txt && ls src",
                permissions: {},
                expected: "allow:sandbox",
            },
            {
                desc: "heuristic disabled: unmatched segments prompt",
                command: "cat a.txt && ls src",
                permissions: {},
                cwdConfinement: { enabled: false },
                expected: "ask",
            },
            {
                desc: "whole-command match skips per-segment logic entirely",
                command: "cat file.txt | tail -5",
                permissions: { "cat * | tail *": "allow" },
                expected: "allow",
            },
        ]);
    });

    describe("risky combination cases", () => {
        runTests([
            {
                desc: "quotes do not dodge a deny rule",
                command: 'cat file.txt && "rm" -rf build',
                permissions: { "rm *": "deny" },
                expected: "deny",
            },
            {
                desc: "dangerous env assignment defeats heuristic rescue",
                command: "LD_PRELOAD=/tmp/evil.so cat file.txt | tail -5",
                permissions: { "tail *": "allow" },
                expected: "ask",
            },
            {
                desc: "env assignment with secret path defeats heuristic rescue",
                command: "FOO=.env cat file.txt | tail -5",
                permissions: { "tail *": "allow" },
                expected: "ask",
            },
            {
                desc: "shell wrapper cannot launder an allowed rule",
                command: "cat file.txt && bash -c 'rm -rf /'",
                permissions: { "cat *": "allow" },
                expected: "ask",
            },
            {
                desc: "only chain operators prompts",
                command: "; ; ;",
                permissions: {},
                expected: "ask",
            },
            {
                desc: "trailing chain operator still resolves",
                command: "cat file.txt &&",
                permissions: {},
                expected: "allow:sandbox",
            },
            {
                desc: "explicit allow-all default bypasses heuristic-sensitive checks",
                command: "cat .env",
                permissions: { "**": "allow" },
                expected: "allow",
            },
            {
                desc: "deny default is not rescued by heuristics in chains",
                command: "cat file.txt | tail -5",
                permissions: { "**": "deny" },
                expected: "deny",
            },
        ]);
    });
});
