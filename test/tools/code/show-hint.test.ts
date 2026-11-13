import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runShow } from "../../../src/tools/code/show";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

const FILES: Record<string, string> = {
    "src/ops/decode.hip": `namespace vibes::hip {

[[nodiscard]] std::int64_t choose_splits(std::int64_t kv_heads, int pool_rows) noexcept {
    return kv_heads;
}

[[nodiscard]] std::int64_t split_ceiling(const Plan& plan) noexcept {
    return plan.rows;
}

}  // namespace vibes::hip
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

describe("outline show parameter hints", () => {
    it("matches a type however its qualifiers are spelled", async () => {
        for (const hint of [
            "vibes::hip::choose_splits(std::int64_t, int)",
            "vibes::hip::choose_splits(int64_t, int)",
            "choose_splits(int64_t, int)",
        ]) {
            const result = await runShow(source(), {
                action: "show",
                path: "src",
                query: hint,
            });

            expect(result.matches, hint).toBeGreaterThan(0);
            expect(result.text, hint).toContain("choose_splits");
        }
    });

    it("ignores cv-qualifiers and reference decoration on both sides", async () => {
        const source = new MemoryCodeSource("/project", {
            "src/holder.cpp": `struct Address {};

bool connect(const Address& target, int port);

bool connect(const Address& target, int port) {
    return true;
}
`,
        });
        const result = await runShow(source, {
            action: "show",
            path: "src",
            query: "connect(Address, int)",
        });

        expect(result.matches).toBeGreaterThan(0);
        expect(result.text).toContain("bool connect");
    });

    it("does not pick an overload for a hint that matches no signature, and names the real ones", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src",
            query: "vibes::hip::choose_splits(const Plan&)",
        });

        expect(result.matches).toBe(0);
        expect(result.text).toContain("# not found");
        expect(result.text).toContain("# hint: no signature matched");
        // The signatures a caller can copy, in selector form.
        expect(result.text).toContain("vibes::hip::choose_splits(std::int64_t, int)");
    });

    it("does not advise narrowing when the caller asked for two different symbols", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src",
            query: ["vibes::hip::choose_splits(int64_t, int)", "vibes::hip::split_ceiling"].join(
                ", ",
            ),
        });

        expect(result.matches).toBeGreaterThan(1);
        expect(result.text).not.toContain("# note:");
    });

    it("still reports ambiguity when one selector reaches two groups", async () => {
        const source = new MemoryCodeSource("/project", {
            "src/holder.cpp": `struct Holder {
    void run(int value);
    void run(const Plan& plan);
};

void Holder::run(int value) {}

void Holder::run(const Plan& plan) {}
`,
        });
        const result = await runShow(source, {
            action: "show",
            path: "src",
            query: "Holder::run",
        });

        expect(result.text).toContain("# note: 2 overloads match");
    });

    it("reports a symbol that did not resolve while another one did", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src",
            query: ["split_ceiling", "does_not_exist"].join(", "),
        });

        expect(result.matches).toBeGreaterThan(0);
        expect(result.text).toContain("split_ceiling");
        expect(result.text).toContain("# not found: does_not_exist in src");
    });
});
