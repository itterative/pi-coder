import fs from "node:fs";
import os from "node:os";
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

    it("lets a checkout .env pin the state root, relative to that checkout", async () => {
        // The development split: `<checkout>/.env` says `.state`, so this copy keeps its state in the checkout
        // while an installed copy (which has no `.env`) uses the agent dir.
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-env-"));
        const file = path.join(directory, ".env");
        fs.writeFileSync(file, "PI_CODER_STATE_DIR=.state\n", "utf-8");

        try {
            vi.resetModules();
            // Stub blank rather than relying on deletion: the loader writes into process.env, and unstubbing
            // restores a stubbed key to "unset" while a plain mutation would survive into later tests.
            vi.stubEnv("PI_CODER_STATE_DIR", "");
            vi.stubEnv("PI_CODER_ENV_FILE", file);

            const local = await import("../../src/common/constants");

            expect(local.PI_CODER_STATE_DIR).toBe(
                path.join(local.PI_CODER_EXTENSION_DIR, ".state"),
            );
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
