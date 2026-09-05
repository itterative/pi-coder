import { describe, expect, it } from "vitest";

import {
    MIN_CHECKPOINT_SECTIONS,
    SERIALIZATION_SYSTEM_PROMPT,
    checkpointSectionCount,
    segmentSummaryInstruction,
} from "../../../src/modules/compaction/prompt";
import { compactionPreparation } from "../../helpers/compaction-doubles";

describe("checkpoint section counting", () => {
    it("needs more than one section, so a heading over an apology cannot pass", () => {
        expect(MIN_CHECKPOINT_SECTIONS).toBe(2);
        expect(checkpointSectionCount("## Goal\n\nI have no prior thinking to reproduce.")).toBe(1);
        expect(
            checkpointSectionCount(
                "I don't have any prior thinking to reproduce — this is the first turn.",
            ),
        ).toBe(0);
    });

    it("matches on words rather than exact titles", () => {
        expect(checkpointSectionCount("## Goal\n## Key Decisions\n")).toBe(2);
        expect(checkpointSectionCount("## goal\n## KEY DECISIONS:\n")).toBe(2);
        expect(checkpointSectionCount("## Decisions\n")).toBe(1);
    });

    it("counts one section per heading, however many known words it names", () => {
        // Both words are known, but it is one section; counting them as two would let a single heading
        // satisfy the guard.
        expect(checkpointSectionCount("## Constraints & Preferences\n")).toBe(1);
        expect(checkpointSectionCount("## Goal\n## Goal\n")).toBe(1);
        expect(checkpointSectionCount("## Goal\n## Constraints & Preferences\n")).toBe(2);
    });

    it("ignores level-3 headings and prose that merely mentions a section word", () => {
        expect(checkpointSectionCount("### Done\n- [x] ship it\n")).toBe(0);
        expect(checkpointSectionCount("The goal was stated in the next context window.\n")).toBe(0);
    });

    it("tells the model not to answer about its own reasoning", () => {
        // The 2026-09-05 refusal read the old `retained verbatim` clause as a request to dump a chain of
        // thought, so the instruction now closes that off and avoids the baiting phrase.
        const text = segmentSummaryInstruction({
            preparation: compactionPreparation({ isSplitTurn: true }),
        });

        expect(text).toContain("do not describe, reproduce, or audit any");
        expect(text).toContain("kept as-is below");
        expect(text).not.toContain("retained verbatim");
        expect(SERIALIZATION_SYSTEM_PROMPT).toContain("transcript");
    });
});
