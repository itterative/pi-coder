import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runShow } from "../../../src/tools/code/show";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

const FILES: Record<string, string> = {
    "src/models/blocks.cpp": `namespace qwen35 {

struct Model {
    void attention_block(CallList& calls, const LayerPlan& layer, std::int32_t n, bool accumulate);
};

void Model::attention_block(CallList& calls, const LayerPlan& layer, std::int32_t n,
                            bool accumulate) {
    (void)calls;
}

}  // namespace qwen35
`,
    "src/models/step.cpp": `namespace qwen35 {

void step() {
    Model::attention_block();
}

}  // namespace qwen35
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

describe("outline show targeting", () => {
    it("names the file a symbol actually lives in when the target file lacks it", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/models/step.cpp",
            symbols: ["qwen35::Model::attention_block"],
        });

        expect(result.matches).toBe(0);
        expect(result.text).toContain("# not found");
        expect(result.text).toContain("# elsewhere");
        expect(result.text).toContain("src/models/blocks.cpp:");
    });

    it("names where a missing symbol lives when another symbol matched", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/models/step.cpp",
            symbols: ["qwen35::step, qwen35::Model::attention_block"],
        });

        expect(result.matches).toBeGreaterThan(0);
        expect(result.text).toContain("void step()");
        expect(result.text).toContain("# elsewhere");
        expect(result.text).toContain("src/models/blocks.cpp:");
    });

    it("matches a leading parameter list and says the hint was partial", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/models",
            symbols: ["qwen35::Model::attention_block(CallList&, const LayerPlan&)"],
        });

        expect(result.matches).toBeGreaterThan(0);
        expect(result.text).toContain("bool accumulate");
        expect(result.text).toContain("matched the first 2 of 4 parameters");
    });

    it("does not match when the leading parameters differ", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/models",
            symbols: ["qwen35::Model::attention_block(const LayerPlan&)"],
        });

        expect(result.matches).toBe(0);
    });
});
