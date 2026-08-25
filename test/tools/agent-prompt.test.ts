import { describe, expect, it } from "vitest";

import {
    BUILTIN_ADVISOR,
    BUILTIN_REVIEWER,
    BUILTIN_SCOUT,
    BUILTIN_WORKER,
} from "../../src/tools/agent/definitions/discovery";
import { availableAgentsPrompt } from "../../src/tools/agent/definitions/prompt";
import { childProtocolPrompt } from "../../src/tools/agent/child/extension";
import {
    renderAgentSystemPrompt,
    renderAgentTask,
} from "../../src/tools/agent/prompts/renderer";

describe("delegated-agent prompt rendering", () => {
    const builtins = [
        { name: "scout", definition: BUILTIN_SCOUT, mutating: false, safeBash: true, allowUserInteraction: true },
        { name: "reviewer", definition: BUILTIN_REVIEWER, mutating: false, safeBash: true, allowUserInteraction: true },
        { name: "advisor", definition: BUILTIN_ADVISOR, mutating: false, safeBash: true, allowUserInteraction: false },
        { name: "worker", definition: BUILTIN_WORKER, mutating: true, safeBash: false, allowUserInteraction: true },
    ] as const;

    it.each(builtins)("renders the $name child system prompt", async ({ name, definition, mutating, safeBash, allowUserInteraction }) => {
        const rendered = renderAgentSystemPrompt(
            definition,
            childProtocolPrompt(false, mutating, safeBash, allowUserInteraction),
        );

        expect(rendered).toContain("<delegated_agent_instructions>");
        expect(rendered).toContain("<delegated_agent_role>");
        expect(rendered).toContain("<delegated_agent_protocol>");
        expect(rendered).toContain("follow them throughout this task");
        expect(rendered).toContain("return a self-contained report to the parent");
        await expect(rendered).toMatchFileSnapshot(`__snapshots__/agent-prompt.${name}.system.txt`);
    });

    it("renders only policy-selected context in the task message", async () => {
        const rendered = renderAgentTask(
            "Review the proposed approach.",
            {
                sections: [
                    {
                        id: "parent_summary",
                        title: "Parent implementation summary",
                        content: "The parent added the run manager integration.",
                        source: "parent",
                    },
                    {
                        id: "recent_context",
                        title: "Recent context",
                        content: "The parent is weighing a prompt renderer.",
                        source: "parent",
                    },
                    {
                        id: "not_requested",
                        title: "Not requested",
                        content: "This section should not be included.",
                        source: "repository",
                    },
                ],
            },
            BUILTIN_ADVISOR.contextPolicy,
        );

        await expect(rendered).toMatchFileSnapshot("__snapshots__/agent-prompt.advisor-context.txt");
        expect(rendered).not.toContain("Not requested");
    });

    it("advertises context sections in the parent agent catalog", () => {
        const prompt = availableAgentsPrompt([BUILTIN_ADVISOR]);

        expect(prompt).toContain("context sections: parent_summary, recent_context, implementation_state");
    });

    it("deduplicates sections and bounds the complete rendered context block", () => {
        const rendered = renderAgentTask(
            "Review the approach.",
            {
                sections: [
                    {
                        id: "parent_summary",
                        title: "Summary",
                        content: "First section. " + "x".repeat(1_000),
                        source: "parent",
                    },
                    {
                        id: "parent_summary",
                        title: "Duplicate summary",
                        content: "This duplicate must not be rendered.",
                        source: "parent",
                    },
                ],
            },
            { sectionIds: ["parent_summary"], maxChars: 300 },
        );
        const contextStart = rendered.indexOf("## Additional delegated context");
        const renderedContext = rendered.slice(contextStart);

        expect(renderedContext.length).toBeLessThanOrEqual(300);
        expect(renderedContext).toContain("First section.");
        expect(renderedContext).not.toContain("Duplicate summary");
    });

    it("preserves task-only behavior without a context policy", () => {
        const rendered = renderAgentTask(
            "Inspect the code.",
            {
                sections: [{
                    id: "parent_summary",
                    title: "Summary",
                    content: "Additional context",
                    source: "parent",
                }],
            },
            undefined,
        );

        expect(rendered).toBe("Inspect the code.");
    });
});
