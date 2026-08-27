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
        { name: "scout", definition: BUILTIN_SCOUT, mutating: false, safeBash: true, allowUserInteraction: true, hasScratchpad: false },
        { name: "reviewer", definition: BUILTIN_REVIEWER, mutating: false, safeBash: true, commandRunner: true, allowUserInteraction: true, hasScratchpad: true },
        { name: "advisor", definition: BUILTIN_ADVISOR, mutating: false, safeBash: true, allowUserInteraction: false, hasScratchpad: false },
        { name: "worker", definition: BUILTIN_WORKER, mutating: true, safeBash: true, commandRunner: true, allowUserInteraction: true, hasScratchpad: true },
    ] as const;

    it.each(builtins)("renders the $name child system prompt", async ({ name, definition, mutating, safeBash, commandRunner = false, allowUserInteraction, hasScratchpad }) => {
        const rendered = renderAgentSystemPrompt(
            definition,
            childProtocolPrompt(false, mutating, safeBash, allowUserInteraction, false, commandRunner, hasScratchpad),
        );

        await expect(rendered).toMatchFileSnapshot(`__snapshots__/agent-prompt.${name}.system.txt`);
    });

    it("renders the isolated worker child system prompt", async () => {
        const rendered = renderAgentSystemPrompt(
            BUILTIN_WORKER,
            childProtocolPrompt(false, true, true, true, true, true, true),
        );

        await expect(rendered).toMatchFileSnapshot("__snapshots__/agent-prompt.worker-isolated.system.txt");
    });

    it("describes the scratchpad as an additional path root", () => {
        const prompt = childProtocolPrompt(false, false, true, true, false, false, true);

        expect(prompt).toContain("current working directory or the temporary scratchpad");
        expect(prompt).toContain("Sensitive-path restrictions apply outside the temporary scratchpad");
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
    });

    it("advertises context sections in the parent agent catalog", async () => {
        const prompt = availableAgentsPrompt([BUILTIN_ADVISOR]);

        await expect(prompt).toMatchFileSnapshot("__snapshots__/agent-prompt.advisor-catalog.txt");
    });

    it("deduplicates sections and bounds the complete rendered context block", async () => {
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
        await expect(rendered).toMatchFileSnapshot("__snapshots__/agent-prompt.bounded-context.txt");
    });

    it("preserves task-only behavior without a context policy", async () => {
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

        await expect(rendered).toMatchFileSnapshot("__snapshots__/agent-prompt.task-only.txt");
    });
});
