import path from "node:path";

import { describe, expect, it } from "vitest";

import { containerStatePaths } from "../../../../src/modules/sandbox/container/state";

describe("containerStatePaths", () => {
    it("keeps one home and one Containerfile for every session", () => {
        const paths = containerStatePaths("/state");

        expect(paths).toEqual({
            root: path.join("/state", "container"),
            home: path.join("/state", "container", "home"),
            containerfile: path.join("/state", "container", "Containerfile"),
        });
    });
});
