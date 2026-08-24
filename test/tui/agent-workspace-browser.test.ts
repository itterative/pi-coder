import { describe, expect, it } from "vitest";

import {
    AgentWorkspaceBrowserComponent,
} from "../../src/tui/agent-workspace-browser";
import type { AgentWorkspace } from "../../src/tools/agent/contracts/workspaces";
import { KEY, interact, mockTheme, renderText } from "../helpers";

const available: AgentWorkspace = {
    version: 1,
    id: "quiet-lantern-7k3",
    cwd: "/repo/project",
    repositoryRoot: "/repo/project",
    worktreePath: "/state/workspaces/quiet-lantern-7k3",
    slug: "quiet-lantern-7k3",
    baseRevision: "abc123def456",
    setupState: "ready",
    status: "available",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
};

const reviewRequired: AgentWorkspace = {
    ...available,
    id: "silver-meadow-2p4",
    slug: "silver-meadow-2p4",
    worktreePath: "/state/workspaces/silver-meadow-2p4",
    setupState: "skipped",
    status: "review_required",
    setupSummary: "Setup was skipped by the user.",
};

describe("AgentWorkspaceBrowserComponent", () => {
    it("renders workspace status and summary counts", () => {
        const component = new AgentWorkspaceBrowserComponent({
            cwd: "/repo/project",
            workspaces: [available, reviewRequired],
        });
        component.initialize(mockTheme);

        expect(renderText(component, 100)).toContain("1 available · 1 review required · 0 leased");
        expect(renderText(component, 100)).toContain("quiet-lantern-7k3 · available");
        expect(renderText(component, 100)).toContain("silver-meadow-2p4 · review required");
        expect(renderText(component, 100)).toContain("Review-required workspaces are not selected automatically.");
    });

    it("opens workspace details and returns to the list", () => {
        const component = new AgentWorkspaceBrowserComponent({
            cwd: "/repo/project",
            workspaces: [available],
        });
        component.initialize(mockTheme);
        const ui = interact(component, 100);

        ui.press(KEY.enter);
        expect(ui.render()).toContain("Workspace: quiet-lantern-7k3");
        expect(ui.render()).toContain("Worktree: /state/workspaces/quiet-lantern-7k3");

        ui.press(KEY.escape);
        expect(ui.render()).toContain("Agent workspaces");
        expect(ui.render()).not.toContain("Workspace: quiet-lantern-7k3");
    });

    it("renders an empty state", () => {
        const component = new AgentWorkspaceBrowserComponent({ cwd: "/repo/project", workspaces: [] });
        component.initialize(mockTheme);

        expect(renderText(component, 100)).toContain("No isolated workspaces have been created for this cwd.");
    });
});
