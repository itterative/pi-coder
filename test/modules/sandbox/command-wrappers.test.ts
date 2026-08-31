import { describe, expect, it } from "vitest";

import {
    recognizeWrapperPrefix,
    unwrapWrapperCommand,
    unwrapWrapperTokens,
} from "../../../src/modules/sandbox/command-wrappers";
import { parseBashAst } from "../../../src/modules/sandbox/bash";
import { BashCommand } from "../../../src/modules/sandbox/bash";
import resolvePermission, { resolvePermissionDetails } from "../../../src/modules/sandbox/resolve";
import { suggestRule } from "../../../src/modules/sandbox/suggestions";
import type { Permission } from "../../../src/modules/sandbox/permissions";

const CWD = "/project";
const CONFINEMENT = { enabled: true } as const;

function singleCommand(command: string): BashCommand {
    const parsed = parseBashAst(command);
    return new BashCommand(parsed.statements[0].commands[0]);
}

function permission(command: string, permissions: Record<string, Permission> = {}): Permission {
    return resolvePermission(command, CWD, {
        permissions,
        cwdConfinement: CONFINEMENT,
    });
}

function suggestion(command: string): string | null {
    const { unresolved } = resolvePermissionDetails(command, CWD, {
        permissions: {},
        cwdConfinement: CONFINEMENT,
    });
    return unresolved.length === 1 ? suggestRule(unresolved[0]) : null;
}

describe("recognizeWrapperPrefix", () => {
    it.each([
        ["timeout 900 npm run test:run", 2],
        ["timeout 4.5s npm test", 2],
        ["timeout --preserve-status 2m npm test", 3],
        ["timeout -k 5 900 npm test", 4],
        ["timeout --kill-after=5s --signal=TERM 900 npm test", 4],
        ["timeout -v -s KILL 10 npm test", 5],
    ])("unwraps %s", (command, start) => {
        expect(recognizeWrapperPrefix(command.split(" "))).toEqual({ start });
    });

    it.each([
        "timeout 900",
        "timeout abc npm test",
        "timeout $((60*5)) npm test",
        "timeout ${T} npm test",
        "timeout -c /tmp 900 npm test",
        "timeout --chdir=/tmp 900 npm test",
        "timeout --profile=prof.out 900 npm test",
        "timeout --foreground=1 900 npm test",
        "timeout -vk 900 npm test",
        "timeout -k 900 npm test",
        "timeout -- 900 npm test",
        "timeout 5 cd /tmp",
        "timeout 5 pushd /tmp",
        "nice 5 npm test",
        "nohup npm test",
        "env FOO=1 npm test",
    ])("refuses to unwrap %s", (command) => {
        expect(recognizeWrapperPrefix(command.split(" "))).toBeUndefined();
    });
});

describe("unwrapWrapperTokens", () => {
    it("refuses to unwrap a segment with leading environment assignments", () => {
        expect(unwrapWrapperTokens(["CI=true", "timeout", "900", "npm", "test"])).toBeUndefined();
    });

    it("returns undefined for an unwrapped segment", () => {
        expect(unwrapWrapperTokens(["npm", "run", "test:run"])).toBeUndefined();
    });

    it("keeps an assignment-prefixed wrapper prompting as it did before", () => {
        // The wrapper stays opaque behind an assignment, so the unknown `timeout` token decides. Only
        // the convenience of unwrapping is unavailable here, never a safety guarantee.
        expect(permission("CI=true timeout 900 ls -1 src")).toBe("ask");
        expect(permission("timeout 900 ls -1 src")).toBe("allow:sandbox");
    });
});

describe("unwrapWrapperCommand", () => {
    it("preserves word order and redirections", () => {
        const unwrapped = unwrapWrapperCommand(
            singleCommand("timeout 900 npm run test:run > build/out.log"),
        );

        expect(unwrapped?.toTokens()).toEqual(["npm", "run", "test:run", ">", "build/out.log"]);
        expect(unwrapped?.redirections).toHaveLength(1);
        expect(unwrapped?.command).toBe("npm");
    });

    it("refuses to unwrap a command with environment assignments", () => {
        expect(unwrapWrapperCommand(singleCommand("CI=true timeout 900 npm test"))).toBeUndefined();
    });

    it("keeps a wrapper redirection attached to the wrapped command", () => {
        const unwrapped = unwrapWrapperCommand(singleCommand("timeout 5 ls 2> errors.log"));

        expect(unwrapped?.redirections.map((node) => node.target?.value)).toEqual(["errors.log"]);
    });
});

describe("timeout resolution through the sandbox", () => {
    it("treats a wrapped read-only command as confined", () => {
        expect(permission("timeout 900 ls -1 src")).toBe("allow:sandbox");
        expect(permission("timeout 900 git status --short")).toBe("allow:sandbox");
    });

    it("keeps a wrapped outside path uncovered", () => {
        expect(permission("timeout 900 cat /etc/passwd")).toBe("ask");
    });

    it("does not let a wrapper hide an unsafe inner command", () => {
        expect(permission("timeout 900 npm run test:run")).toBe("ask");
        expect(permission("timeout --chdir=/tmp 900 ls -1 src")).toBe("ask");
    });

    it("matches an explicit rule written for the wrapped command", () => {
        expect(permission("timeout 900 npm run test:run", { "npm run test:run": "allow" })).toBe(
            "allow",
        );
        expect(
            permission("timeout 900 npx vitest run test/a.test.ts", { "npx vitest *": "allow" }),
        ).toBe("allow");
    });

    it("grants the wrapped form after its own suggestion is remembered", () => {
        // The loop the parent actually uses: the prompt offers a rule for the wrapped command,
        // remembering it must stop the next wrapped invocation from prompting.
        const command = "timeout 900 npx vitest run test/a.test.ts";
        const rule = suggestion(command);
        if (rule === null) {
            throw new Error("expected a suggestion for the wrapped command");
        }

        expect(permission(command, { [rule]: "allow:sandbox" })).toBe("allow:sandbox");
    });

    it("lets an explicit rule for the wrapper itself deny the line", () => {
        expect(
            permission("timeout 900 npm run test:run", {
                "npm run test:run": "allow",
                "timeout *": "deny",
            }),
        ).toBe("deny");
    });

    it("unwraps nested wrappers the same way in all three paths", () => {
        const command = "timeout 5 timeout 3 npm run test:run";

        expect(permission(command, { "npm run test:run": "allow:sandbox" })).toBe("allow:sandbox");
        expect(suggestion(command)).toBe("npm run test:run");
    });

    it("confines a redirection written inside the wrapper prefix", () => {
        // The redirection belongs to the wrapper's process, so it stays checked as a write even
        // though it sits among the wrapper's own arguments.
        expect(permission("timeout > out 900 ls -1 src")).toBe("allow:sandbox");
        expect(permission("timeout > /etc/out 900 ls -1 src")).toBe("ask");
    });

    it("gates the curated command allowlist on the wrapped command", () => {
        // An allowlist restricts which commands the heuristic may vouch for. The wrapped command is
        // the one doing the work, so `timeout` itself needs no entry, and an allowlist entry naming
        // the wrapper would be inert.
        expect(
            resolvePermission("timeout 900 ls -1 src", CWD, {
                permissions: {},
                cwdConfinement: { enabled: true, commands: ["ls"] },
            }),
        ).toBe("allow:sandbox");
        expect(
            resolvePermission("timeout 900 ls -1 src", CWD, {
                permissions: {},
                cwdConfinement: { enabled: true, commands: ["cat"] },
            }),
        ).toBe("ask");
    });

    it("applies custom safe-bash patterns to the wrapped command", () => {
        const options = {
            permissions: {},
            cwdConfinement: { enabled: true },
            safeBashCommands: ["mytool *"],
        };

        expect(resolvePermission("timeout 5 mytool foo", CWD, options)).toBe("allow:sandbox");
        // A custom pattern naming the wrapper stops matching, because the wrapper is no longer the
        // command being classified.
        expect(
            resolvePermission("timeout 5 mytool foo", CWD, {
                ...options,
                safeBashCommands: ["timeout 5 mytool"],
            }),
        ).toBe("ask");
    });

    it("keeps a rule naming the wrapper effective for a chained segment", () => {
        // A whole-line pattern cannot cover a single segment of a chain, so this exercises the
        // literal segment view alongside the wrapped one. Matching only the wrapped command would
        // let `&&` bypass a rule that names the wrapper.
        const permissions = {
            "npm run test:run": "allow:sandbox",
            "timeout *": "deny",
        };

        expect(permission("ls -1 src && timeout 900 npm run test:run", permissions)).toBe("deny");
        expect(permission("timeout 900 npm run test:run && ls -1 src", permissions)).toBe("deny");
    });

    it("keeps deny on the inner command authoritative", () => {
        expect(
            permission("timeout 900 rm -rf src", {
                "rm *": "deny",
            }),
        ).toBe("deny");
    });

    it("suggests the wrapped command rather than the wrapper", () => {
        expect(suggestion("timeout 900 npm run test:run")).toBe("npm run test:run");
        expect(suggestion("timeout 900 npx vitest run test/a.test.ts")).toBe("npx vitest *");
        expect(suggestion("timeout 900 npm run test:run")).toBe(suggestion("npm run test:run"));
    });

    it("reports the wrapped segment as the unresolved one", () => {
        const details = resolvePermissionDetails("timeout 900 npm run test:run", CWD, {
            permissions: {},
            cwdConfinement: CONFINEMENT,
        });

        expect(details.unresolved).toEqual([["npm", "run", "test:run"]]);
    });

    it("resolves a wrapped command in a chain against a session-style rule", () => {
        expect(
            permission("cd src && timeout 900 npm run test:run && git status --short", {
                "npm run test:run": "allow:sandbox",
            }),
        ).toBe("allow:sandbox");
    });
});
