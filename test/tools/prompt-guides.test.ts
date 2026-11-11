import { describe, expect, it } from "vitest";
import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

import {
    contributeToolGuide,
    isToolDeclared,
    setPromptSection,
} from "../../src/common/prompt-section";
import registerAskUserTool from "../../src/tools/ask_user";
import registerCodeTool from "../../src/tools/code";
import registerMemoryAudit from "../../src/modules/memory/audit-ui";
import { beforeAgentStartEvent, createPiStub, handlerView, stubContext } from "../helpers/pi-stub";

function options(
    overrides: Partial<NormalizedBuildSystemPromptOptions> = {},
): NormalizedBuildSystemPromptOptions {
    return {
        selectedTools: ["outline", "ask_user"],
        hiddenTools: [],
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        appendSystemPrompt: "",
        sections: {},
        cwd: "/tmp",
        contextFiles: [],
        skills: [],
        ...overrides,
    };
}

describe("named prompt sections", () => {
    it("sets a trimmed body and skips an empty one", () => {
        const target = options();

        setPromptSection(target, "memory_system", "  index\n");
        setPromptSection(target, "scratchpad_system", "   ");

        expect(target.sections).toEqual({ memory_system: "index" });
    });

    it("treats a hidden tool as undeclared", () => {
        expect(isToolDeclared(options(), "outline")).toBe(true);
        expect(isToolDeclared(options({ hiddenTools: ["outline"] }), "outline")).toBe(false);
        expect(isToolDeclared(options({ selectedTools: [] }), "outline")).toBe(false);
    });

    it("contributes a guide only while the tool is declared", () => {
        const declared = options();
        const hidden = options({ hiddenTools: ["outline"] });

        contributeToolGuide(declared, "outline", "guide");
        contributeToolGuide(hidden, "outline", "guide");

        expect(declared.sections).toEqual({ outline_tool_guide: "guide" });
        expect(hidden.sections).toEqual({});
    });
});

describe("tool guides contributed by the tools themselves", () => {
    it("contributes each declared tool's guide, and omits a hidden one", async () => {
        const stub = createPiStub();
        registerCodeTool(stub.pi);
        registerAskUserTool(stub.pi);
        registerMemoryAudit(stub.pi);

        const handlers = handlerView(stub, "before_agent_start").before_agent_start;
        const ctx = stubContext({ cwd: process.cwd() });
        const event = beforeAgentStartEvent();
        for (const handler of handlers) {
            await handler(event, ctx);
        }

        const sections = event.systemPromptOptions.sections;
        expect(sections.outline_tool_guide).toContain("## Outline");
        // The index boundary has to be stated: prose comments inside a body are not in it, and a caller who has
        // just read that search does semantic retrieval will otherwise expect them to be.
        expect(sections.outline_tool_guide).toContain("comment *inside* a function body");
        expect(sections.outline_tool_guide).toContain("path=<file>");
        expect(sections.ask_user_tool_guide).toContain("You decide");
        expect(sections.memory_audit_tool_guide).toContain("Weigh warnings");

        const hiddenEvent = beforeAgentStartEvent({ hiddenTools: ["outline"] });
        for (const handler of handlers) {
            await handler(hiddenEvent, ctx);
        }

        expect(hiddenEvent.systemPromptOptions.sections.outline_tool_guide).toBeUndefined();
        expect(hiddenEvent.systemPromptOptions.sections.ask_user_tool_guide).toContain(
            "You decide",
        );
    });
});
