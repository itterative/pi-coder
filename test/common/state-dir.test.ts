import path from "node:path";

import { describe, expect, it } from "vitest";

import { PI_CODER_EXTENSION_DIR } from "../../src/common/extension-dir";
import { agentDirFromEnvironment, resolveStateDirectory } from "../../src/common/state-dir";

/**
 * The state root is resolved twice: by the extension through pi's `getAgentDir()`, and by the report scripts
 * through this env-only mirror (they are bundled into one ESM file by their CLI tests, so they cannot import
 * the CommonJS pi package). These cases pin the mirror to pi's rule for the two inputs that move the agent
 * directory — `PI_CODING_AGENT_DIR` and `$HOME` — plus the override and its checkout-relative base.
 */
describe("resolveStateDirectory", () => {
    it("puts the state root under pi's default agent directory", () => {
        const env = { HOME: "/home/dev" };

        expect(agentDirFromEnvironment(env)).toBe("/home/dev/.pi/agent");
        expect(resolveStateDirectory(env)).toBe("/home/dev/.pi/agent/pi-coder");
    });

    it("follows PI_CODING_AGENT_DIR and expands a leading tilde the way pi's resolver does", () => {
        expect(
            resolveStateDirectory({ HOME: "/home/dev", PI_CODING_AGENT_DIR: "~/dot-pi/agent" }),
        ).toBe("/home/dev/dot-pi/agent/pi-coder");
        expect(
            resolveStateDirectory({ HOME: "/home/dev", PI_CODING_AGENT_DIR: "/srv/pi/agent" }),
        ).toBe("/srv/pi/agent/pi-coder");
    });

    it("prefers an injected agent dir over the environment", () => {
        // The extension passes pi's own `getAgentDir()` so the two cannot disagree; an injected value is
        // authoritative even when the environment names a different agent dir.
        expect(
            resolveStateDirectory(
                { HOME: "/home/dev", PI_CODING_AGENT_DIR: "/srv/pi/agent" },
                "/injected/agent",
            ),
        ).toBe("/injected/agent/pi-coder");
    });

    it("lets PI_CODER_STATE_DIR relocate the whole tree", () => {
        expect(
            resolveStateDirectory({
                HOME: "/home/dev",
                PI_CODER_STATE_DIR: "/mnt/fast/pi-coder-state",
            }),
        ).toBe("/mnt/fast/pi-coder-state");
    });

    it("resolves a relative PI_CODER_STATE_DIR against the extension checkout, not the cwd", () => {
        // So `<checkout>/.env` can say `.state`: pi may be started from any project directory, and the state
        // root still belongs to the copy of pi-coder that reads the file.
        expect(resolveStateDirectory({ HOME: "/home/dev", PI_CODER_STATE_DIR: "state" })).toBe(
            path.join(PI_CODER_EXTENSION_DIR, "state"),
        );
    });

    it("treats a blank relocation as unset", () => {
        expect(resolveStateDirectory({ HOME: "/home/dev", PI_CODER_STATE_DIR: "   " })).toBe(
            "/home/dev/.pi/agent/pi-coder",
        );
    });
});
