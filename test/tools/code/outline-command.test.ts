import { describe, expect, it } from "vitest";

import { completeOutlineArguments } from "../../../src/tools/code/index";

function values(prefix: string): string[] {
    return completeOutlineArguments(prefix).map((item) => item.value);
}

describe("/outline argument completions", () => {
    it("lists every subcommand for an empty prefix, and continues past build", () => {
        expect(values("")).toEqual(["status", "on", "off", "build ", "purge"]);
    });

    it("filters by the typed prefix", () => {
        expect(values("b")).toEqual(["build "]);
        expect(values("pu")).toEqual(["purge"]);
    });

    it("completes a path for build only", () => {
        expect(values("build ")).toEqual(["build ."]);
        expect(values("status ")).toEqual([]);
    });

    it("keeps a leading semantic word the user typed", () => {
        expect(values("semantic b")).toEqual(["semantic build "]);
    });
});
