import fs from "node:fs";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

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
    it("resolves runtime data relative to the installed extension root", () => {
        expect(fs.existsSync(path.join(PI_CODER_EXTENSION_DIR, "package.json"))).toBe(true);
        expect(PI_CODER_STATE_DIR).toBe(path.join(PI_CODER_EXTENSION_DIR, ".state"));
        expect(PI_CODER_AGENT_SESSIONS_DIR).toBe(path.join(PI_CODER_STATE_DIR, "agent-sessions"));
    });
});
