import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
    BUILTIN_ADVISOR,
    BUILTIN_REVIEWER,
    BUILTIN_SCOUT,
    BUILTIN_WORKER,
} from "../../src/tools/agent/definitions/discovery";
import { availableAgentsPrompt } from "../../src/tools/agent/definitions/prompt";
import { getUserMemoryDirectory } from "../../src/common/constants";
import { childProtocolPrompt } from "../../src/tools/agent/child/prompt";
import { resolveChildGrant } from "../../src/tools/agent/child/grant";
import type { ChildAgentFactoryContext } from "../../src/tools/agent/contracts/runs";
import type { AgentCapability, AgentDefinition } from "../../src/tools/agent/definitions/types";
import { renderAgentSystemPrompt, renderAgentTask } from "../../src/tools/agent/prompts/renderer";

describe("delegated-agent prompt rendering", () => {
    /**
     * Renders the complete child system prompt the way production does: a definition plus a run mode
     * go through `resolveChildGrant`, and the prompt reads the resolved grant.
     *
     * These cases used to hand-write the prompt option bag, which let them drift from reality: the
     * scout case passed no additional paths at all, while a real scout is granted the memory directory
     * and therefore tells the child about configured additional paths.
     */
    function resolveGrant(
        definition: AgentDefinition,
        {
            isolated = false,
            workspaceId = isolated ? "workspace-1" : undefined,
            parent,
        }: {
            isolated?: boolean;
            workspaceId?: string;
            parent?: { hasUI?: boolean; mode?: "tui" | "print" };
        } = {},
    ) {
        const parentContext = {
            cwd: "/repo",
            hasUI: true,
            mode: "tui",
            ...parent,
        } as unknown as ExtensionContext;
        const context = {
            cwd: "/repo",
            definition,
            parentContext,
            background: false,
            isolated,
            workspaceId,
            runId: `${definition.name}-1`,
            runTitle: `${definition.name} title`,
            onProgress: () => {},
        } as unknown as ChildAgentFactoryContext;
        return resolveChildGrant(context, parentContext);
    }

    function renderPrompt(
        definition: AgentDefinition,
        options: { isolated?: boolean; parent?: { hasUI?: boolean; mode?: "tui" | "print" } } = {},
    ): string {
        const grant = resolveGrant(definition, options);
        return renderAgentSystemPrompt(definition, childProtocolPrompt(grant));
    }

    function customDefinition(
        name: string,
        capabilities: AgentCapability[],
        extra: Partial<AgentDefinition> = {},
    ): AgentDefinition {
        return {
            name,
            description: `${name} description`,
            capabilities,
            systemPrompt: `You are ${name}.`,
            source: "user",
            ...extra,
        };
    }

    const builtins = [
        { name: "scout", definition: BUILTIN_SCOUT },
        { name: "reviewer", definition: BUILTIN_REVIEWER },
        { name: "advisor", definition: BUILTIN_ADVISOR },
        { name: "worker", definition: BUILTIN_WORKER },
    ];

    it.each(builtins)("renders the $name child system prompt", async ({ name, definition }) => {
        await expect(renderPrompt(definition)).toMatchFileSnapshot(
            `__snapshots__/agent-prompt.${name}.system.txt`,
        );
    });

    it("tells a background child nothing different about interaction", async () => {
        // Whether the parent launched the run in the background never reaches the child's prose: a
        // background parent has no UI, so the grant already resolves `canAskUser` to false and the
        // prompt is the one for a parent-only child. Pinned here so the equivalence stays honest if
        // either side changes, instead of duplicating the scout snapshot under a new name.
        const unanswerableParent = renderPrompt(BUILTIN_SCOUT, {
            parent: { hasUI: false, mode: "print" },
        });
        const declinedInteraction = renderPrompt({
            ...BUILTIN_SCOUT,
            allowUserInteraction: false,
        });

        expect(unanswerableParent).toBe(declinedInteraction);
        expect(unanswerableParent).toContain("use `ask_parent` with the evidence");
        expect(unanswerableParent).not.toContain("Use `ask_user`");
    });

    it("renders the scout system prompt with custom safe-Bash patterns", async () => {
        const rendered = renderPrompt({
            ...BUILTIN_SCOUT,
            safeBashCommands: ["ast-outline digest *"],
        });

        await expect(rendered).toMatchFileSnapshot(
            "__snapshots__/agent-prompt.scout.custom-safe-bash.system.txt",
        );
    });

    it("renders the isolated worker child system prompt", async () => {
        await expect(renderPrompt(BUILTIN_WORKER, { isolated: true })).toMatchFileSnapshot(
            "__snapshots__/agent-prompt.worker-isolated.system.txt",
        );
    });

    /**
     * Read roots as labels rather than literal paths: the memory root is an absolute path under the
     * user's home directory, which must not be baked into a committed snapshot.
     */
    function describeRoots(readRoots: readonly string[]): string {
        const memoryRoot = getUserMemoryDirectory();
        return readRoots.map((root) => (root === memoryRoot ? "memory" : "configured")).join(",");
    }

    it("resolves one grant per reachable run profile", async () => {
        // The facts a profile is built from. The prompt text for these same shapes is pinned by the
        // snapshots above, so this records the resolution itself: which rung, which tools, which
        // extension label, and whether calls must serialize.
        const cases: Array<[string, AgentDefinition, object]> = [
            ["scout in a tui parent", BUILTIN_SCOUT, {}],
            [
                "scout under a print parent that reports a UI",
                BUILTIN_SCOUT,
                { parent: { mode: "print" } },
            ],
            [
                "scout under a parent with no UI",
                BUILTIN_SCOUT,
                { parent: { hasUI: false, mode: "print" } },
            ],
            ["advisor declines interaction", BUILTIN_ADVISOR, {}],
            ["reviewer shares the parent checkout", BUILTIN_REVIEWER, {}],
            ["worker in the parent checkout", BUILTIN_WORKER, {}],
            ["worker in an isolated worktree", BUILTIN_WORKER, { isolated: true }],
            [
                "restored worker keeps isolation from its workspace id",
                BUILTIN_WORKER,
                { workspaceId: "workspace-1" },
            ],
            ["custom definition with no bash capability", customDefinition("reader", []), {}],
            [
                "custom scratchpad, todolist and roots",
                customDefinition("organizer", ["scratchpad", "todolist", "safe-bash"], {
                    additionalPaths: ["/opt/read-only"],
                    safeBashCommands: ["ast-outline digest *"],
                }),
                {},
            ],
        ];

        const rows = cases.map(([label, definition, options]) => {
            const grant = resolveGrant(definition, options as never);
            return [
                `### ${label}`,
                `authority=${grant.authority}`,
                `kind=${grant.extensionKind}`,
                `sequential=${grant.requiresSequentialToolExecution}`,
                `tools=${grant.sessionTools.join(",")}`,
                `readRoots=${describeRoots(grant.readRoots)}`,
            ].join(" ");
        });

        await expect(rows.join("\n")).toMatchFileSnapshot(
            "__snapshots__/agent-prompt.grant-profiles.txt",
        );
    });

    it("describes the scratchpad as an additional path root", () => {
        const readOnly = childProtocolPrompt(
            resolveGrant(customDefinition("organizer", ["scratchpad", "safe-bash"])),
        );
        expect(readOnly).toContain(
            "the current working directory, the temporary scratchpad, or an exact full-output file reported by Bash",
        );
        expect(readOnly).toContain(
            "Sensitive-path restrictions apply outside the temporary scratchpad",
        );

        // A same-checkout worker folds the scratchpad into its write scope, because the checkout is
        // already the root; only an isolated worker calls it an *additional* root on top of a worktree.
        const scope = customDefinition("builder", ["scratchpad", "edit"]);
        const worker = childProtocolPrompt(resolveGrant(scope));
        expect(worker).toContain(
            "directly for paths inside the current working directory or the temporary scratchpad;",
        );
        expect(worker).not.toContain("as an additional root");

        const isolatedWorker = childProtocolPrompt(resolveGrant(scope, { isolated: true }));
        expect(isolatedWorker).toContain(
            "This run also has a private temporary scratchpad as an additional root.",
        );
    });

    it("renders only policy-selected context in the task message", async () => {
        const rendered = renderAgentTask("Review the proposed approach.", {
            context: {
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
            policy: BUILTIN_ADVISOR.contextPolicy,
        });

        await expect(rendered).toMatchFileSnapshot(
            "__snapshots__/agent-prompt.advisor-context.txt",
        );
    });

    it("advertises a narrowing context policy in the parent agent catalog", async () => {
        const prompt = availableAgentsPrompt([BUILTIN_ADVISOR]);

        await expect(prompt).toMatchFileSnapshot("__snapshots__/agent-prompt.advisor-catalog.txt");
    });

    it("deduplicates sections and bounds the complete rendered context block", async () => {
        const rendered = renderAgentTask("Review the approach.", {
            context: {
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
            policy: { sectionIds: ["parent_summary"], maxChars: 300 },
        });
        const contextStart = rendered.indexOf("## Additional delegated context");
        const renderedContext = rendered.slice(contextStart);

        expect(renderedContext.length).toBeLessThanOrEqual(300);
        await expect(rendered).toMatchFileSnapshot(
            "__snapshots__/agent-prompt.bounded-context.txt",
        );
    });

    it("renders every supplied section for an agent without a context policy", async () => {
        const rendered = renderAgentTask("Inspect the code.", {
            context: {
                sections: [
                    {
                        id: "parent_summary",
                        title: "Summary",
                        content: "Additional context",
                        source: "parent",
                    },
                    {
                        // An id no built-in policy lists, which a policy-less agent still accepts.
                        id: "goal",
                        title: "Goal",
                        content: "Whatever the parent chose to name it.",
                        source: "repository",
                    },
                ],
            },
        });

        await expect(rendered).toMatchFileSnapshot(
            "__snapshots__/agent-prompt.default-context.txt",
        );
    });

    it("bounds a policy-less context block with the default budget", () => {
        const rendered = renderAgentTask("Inspect the code.", {
            context: {
                sections: Array.from({ length: 12 }, (_, index) => ({
                    id: `section_${index}`,
                    title: `Section ${index}`,
                    content: "x".repeat(12_000),
                    source: "parent" as const,
                })),
            },
        });
        const contextStart = rendered.indexOf("## Additional delegated context");
        const blockLength = rendered.length - contextStart;

        expect(contextStart).toBeGreaterThan(-1);
        expect(blockLength).toBeGreaterThan(0);
        expect(blockLength).toBeLessThanOrEqual(24_000);
        expect(rendered).toContain("[context truncated]");
    });
});
