import { describe, expect, it } from "vitest";

import { splitSymbolList } from "../../../src/tools/code/format";

describe("splitSymbolList", () => {
    it("splits a comma-joined entry an agent sent as one string", () => {
        expect(splitSymbolList(["Qwen35Model::attention_block, Qwen35Model::mlp_block"])).toEqual([
            "Qwen35Model::attention_block",
            "Qwen35Model::mlp_block",
        ]);
    });

    it("keeps commas inside an overload's parameter list", () => {
        expect(splitSymbolList(["Socket::connect(const Address&, int), Socket::fd"])).toEqual([
            "Socket::connect(const Address&, int)",
            "Socket::fd",
        ]);
    });

    it("trims entries, drops empties, and keeps repeats in order", () => {
        expect(splitSymbolList([" a::b , , c::d,", "a::b"])).toEqual(["a::b", "c::d", "a::b"]);
    });
});
