import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runShow } from "../../../src/tools/code/show";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

const FILE = `void dequant() {
  const auto decode = [=](int first, int last) {
    const auto decode_row = [&](float* target) { target[0] = 1.0f; };
    decode_row(nullptr);
  };
  decode(0, 1);
}
`;

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", {
        "src/dequant.cpp": FILE,
    });
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline on C++ closures", () => {
    it("maps named lambdas nested in function bodies", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/dequant.cpp",
        });

        expect(result.text).toContain("const auto decode = [=]");
        expect(result.text).toContain("const auto decode_row = [&]");
        expect(result.parseErrors).toBe(0);
    });

    it("shows a nested lambda and finds its uses", async () => {
        const shown = await runShow(source(), {
            action: "show",
            path: "src/dequant.cpp",
            symbols: ["dequant::decode::decode_row"],
        });
        const used = await runUsages(source(), {
            action: "usages",
            path: "src/dequant.cpp",
            symbols: ["dequant::decode"],
        });

        expect(shown.text).toContain("function dequant::decode::decode_row · definition");
        expect(shown.text).toContain("target[0] = 1.0f");
        expect(used.text).toContain("[def]");
        expect(used.text).toContain("[call]");
        expect(used.matches).toBeGreaterThanOrEqual(2);
    });
});
