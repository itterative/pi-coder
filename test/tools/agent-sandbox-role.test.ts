import { describe, expect, it } from "vitest";

import { sandboxRoleFor } from "../../src/tools/agent/child/sandbox-role";

/**
 * The role decides a mount mode, so getting it wrong in either direction is visible: a scout that may write
 * defeats the point of the read-only mount, and a reviewer that may not write cannot run the test suite it
 * was delegated to run.
 */
describe("sandboxRoleFor", () => {
    it("makes the rungs that can only read read-only", () => {
        expect(sandboxRoleFor("read")).toBe("readonly");
        expect(sandboxRoleFor("inspect")).toBe("readonly");
    });

    it("keeps the workspace writable from the command rung up", () => {
        expect(sandboxRoleFor("command")).toBe("write");
        expect(sandboxRoleFor("mutate")).toBe("write");
    });
});
