import fs from "node:fs";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    PI_CODER_AGENT_SESSIONS_DIR,
    PI_CODER_EXTENSION_DIR,
    PI_CODER_STATE_DIR,
    getScratchpadDirectory,
    getUserMemoryDirectory,
    getUserSessionsDirectory,
} from "../../src/common/constants";

describe("pi agent directories", () => {
    it("resolves the sessions directory next to the agent dir pi itself uses", () => {
        // pi writes every transcript under `<agent dir>/sessions`, and its own resolver follows
        // `PI_CODING_AGENT_DIR`; the container mount has to name the same directory, not a hardcoded `~/.pi`.
        expect(getUserSessionsDirectory()).toBe(path.join(getAgentDir(), "sessions"));
    });

    it("resolves the user memory directory the same way, so both move with the agent dir", () => {
        expect(getUserMemoryDirectory()).toBe(path.join(getAgentDir(), "memory"));
    });

    it("puts the durable scratchpad store under the agent dir, not in the OS temp dir", () => {
        // Scratchpads used to live in `os.tmpdir()`, which a tmpfs-backed `/tmp` wipes on every host or
        // dev-environment restart. They must follow `PI_CODING_AGENT_DIR` and stay out of the checkout.
        expect(getScratchpadDirectory()).toBe(path.join(getAgentDir(), "scratchpad"));
    });
});

describe("pi-coder installation constants", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it("keeps runtime state outside the installed extension root", () => {
        // pi updates a git-installed package with `git reset --hard` + `git clean -fdx`, and `-x` removes
        // ignored files too: anything inside the checkout is destroyed by the next update. The agent dir is
        // pi's own durable location, and it follows `PI_CODING_AGENT_DIR`.
        expect(fs.existsSync(path.join(PI_CODER_EXTENSION_DIR, "package.json"))).toBe(true);
        expect(PI_CODER_STATE_DIR).toBe(path.resolve(getAgentDir(), "pi-coder"));
        expect(PI_CODER_STATE_DIR.startsWith(`${PI_CODER_EXTENSION_DIR}${path.sep}`)).toBe(false);
        expect(PI_CODER_AGENT_SESSIONS_DIR).toBe(path.join(PI_CODER_STATE_DIR, "agent-sessions"));
    });

    it("lets PI_CODER_STATE_DIR relocate the whole state tree", async () => {
        vi.resetModules();
        vi.stubEnv("PI_CODER_STATE_DIR", "/tmp/pi-coder-test-state");

        const relocated = await import("../../src/common/constants");

        expect(relocated.PI_CODER_STATE_DIR).toBe("/tmp/pi-coder-test-state");
        expect(relocated.PI_CODER_WORKSPACES_DIR).toBe("/tmp/pi-coder-test-state/workspaces");
        expect(relocated.BASH_DECISION_LOG_PATH).toBe("/tmp/pi-coder-test-state/bash-log.jsonl");
    });

    it("treats a blank PI_CODER_STATE_DIR as unset", async () => {
        vi.resetModules();
        vi.stubEnv("PI_CODER_STATE_DIR", "   ");

        const resolved = await import("../../src/common/constants");

        expect(resolved.PI_CODER_STATE_DIR).toBe(path.resolve(getAgentDir(), "pi-coder"));
    });
});
