import { describe, expect, it } from "vitest";

import {
    decideSessionImage,
    type ImagePlan,
} from "../../../../src/modules/sandbox/container/image-plan";

const RECIPE_PLAN: ImagePlan = {
    kind: "recipe",
    recipe: {
        path: "/project/.pi/Containerfile",
        contextDir: "/project/.pi",
        text: "FROM debian:bookworm-slim\n",
        source: "project",
    },
    image: "localhost/pi-coder-sandbox:abc123",
    nodePath: "/opt/pi/node",
    effectiveText: "FROM node:24-trixie-slim AS pi-dispatcher-node\n",
    containerfilePath: "/state/container/Containerfile",
    contextDir: "/project/.pi",
    hash: "abc123",
};

describe("decideSessionImage", () => {
    it("uses an explicit image as-is, with node from PATH", () => {
        const plan: ImagePlan = { kind: "explicit", image: "custom:1", nodePath: "node" };

        expect(decideSessionImage(plan, true)).toEqual({
            ok: true,
            image: "custom:1",
            nodePath: "node",
        });
    });

    it("uses the default image when no recipe exists, so an existing checkout is untouched", () => {
        const plan: ImagePlan = { kind: "default", image: "node:24-trixie-slim", nodePath: "node" };

        expect(decideSessionImage(plan, true)).toMatchObject({
            ok: true,
            image: "node:24-trixie-slim",
        });
    });

    it("runs a built recipe image with the runtime its prologue installed", () => {
        expect(decideSessionImage(RECIPE_PLAN, true)).toEqual({
            ok: true,
            image: "localhost/pi-coder-sandbox:abc123",
            nodePath: "/opt/pi/node",
        });
    });

    it("refuses an unbuilt recipe image instead of falling back to a bare default", () => {
        const decision = decideSessionImage(RECIPE_PLAN, false);

        expect(decision.ok).toBe(false);

        if (decision.ok) {
            return;
        }

        expect(decision.reason).toContain("localhost/pi-coder-sandbox:abc123");
        expect(decision.reason).toContain("/project/.pi/Containerfile");
        expect(decision.reason).toContain("/sandbox build");
        expect(decision.reason).toContain("PI_SANDBOX_IMAGE");
    });

    it("refuses an unsupported recipe before podman is involved", () => {
        const decision = decideSessionImage({ kind: "unsupported", reason: "musl base" }, false);

        expect(decision).toEqual({ ok: false, reason: "musl base" });
    });
});
