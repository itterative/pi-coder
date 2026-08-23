import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
    PI_CODER_AGENT_SESSIONS_DIR,
    PI_CODER_EXTENSION_DIR,
    PI_CODER_STATE_DIR,
} from "../../src/common/constants";

describe("pi-coder installation constants", () => {
    it("resolves runtime data relative to the installed extension root", () => {
        expect(fs.existsSync(path.join(PI_CODER_EXTENSION_DIR, "package.json"))).toBe(true);
        expect(PI_CODER_STATE_DIR).toBe(path.join(PI_CODER_EXTENSION_DIR, ".state"));
        expect(PI_CODER_AGENT_SESSIONS_DIR).toBe(path.join(PI_CODER_STATE_DIR, "agent-sessions"));
    });
});
