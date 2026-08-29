import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => {
    const fsModule = process.getBuiltinModule("node:fs") as typeof import("node:fs");
    const osModule = process.getBuiltinModule("node:os") as typeof import("node:os");
    const pathModule = process.getBuiltinModule("node:path") as typeof import("node:path");
    const root = fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), "pi-coder-agent-setup-e2e-"));
    return {
        root,
        repository: pathModule.join(root, "repo"),
        state: pathModule.join(root, "workspaces"),
        sessions: pathModule.join(root, "agent-sessions"),
    };
});

vi.mock("../../../src/common/constants", async () => {
    const actual = await vi.importActual<typeof import("../../../src/common/constants")>("../../../src/common/constants");
    return {
        ...actual,
        PI_CODER_STATE_DIR: testPaths.root,
        PI_CODER_AGENT_SESSIONS_DIR: testPaths.sessions,
        PI_CODER_WORKSPACES_DIR: testPaths.state,
    };
});

import { BUILTIN_WORKER } from "../../../src/tools/agent/definitions/discovery";
import { runWorkspaceSetup } from "../../../src/tools/agent/workspaces/setup";
import { createAgentWorkspace } from "../../../src/tools/agent/workspaces/lifecycle";
import { getAgentWorkspace } from "../../../src/tools/agent/workspaces/store";
import { createE2EContext, createE2EPathsAtRoot, createScriptedChild, initializeRepository, removeE2EPaths } from "./helpers";

let paths = createE2EPathsAtRoot(testPaths.root);

beforeEach(() => {
    fs.rmSync(testPaths.root, { recursive: true, force: true });
    paths = createE2EPathsAtRoot(testPaths.root);
    initializeRepository(paths.repository);
});

afterAll(() => {
    removeE2EPaths(paths);
});

describe("isolated workspace setup e2e", () => {
    it("runs setup in the worktree and persists the ready state", async () => {
        const workspace = await createAgentWorkspace(paths.repository, { workspacesDir: paths.state });
        const factory = vi.fn(async (context: any) => {
            fs.writeFileSync(path.join(context.cwd, "setup-artifact.txt"), "prepared\n");
            return createScriptedChild({ output: "Installed project dependencies" });
        });

        const ready = await runWorkspaceSetup(workspace, {
            definition: BUILTIN_WORKER,
            factory,
            ctx: createE2EContext(paths, { ui: { notify: vi.fn() } }),
            setupRunId: "setup-run-1",
        });

        expect(factory).toHaveBeenCalledWith(expect.objectContaining({
            cwd: workspace.worktreePath,
            isolated: true,
            runId: `workspace-setup-${workspace.slug}`,
        }));
        expect(fs.readFileSync(path.join(workspace.worktreePath, "setup-artifact.txt"), "utf8")).toBe("prepared\n");
        expect(ready).toMatchObject({ setupState: "ready", setupSummary: "Installed project dependencies" });
        expect((await getAgentWorkspace(ready.id, { workspacesDir: paths.state }))?.setupState).toBe("ready");
    });

    it("persists failed setup without leaving a live setup child", async () => {
        const workspace = await createAgentWorkspace(paths.repository, { workspacesDir: paths.state });
        const child = createScriptedChild({ error: "dependency unavailable" });
        const factory = vi.fn(async () => child);

        await expect(runWorkspaceSetup(workspace, {
            definition: BUILTIN_WORKER,
            factory,
            ctx: createE2EContext(paths, { ui: { notify: vi.fn() } }),
            setupRunId: "setup-run-2",
        })).rejects.toThrow("dependency unavailable");

        const failed = await getAgentWorkspace(workspace.id, { workspacesDir: paths.state });
        expect(failed).toMatchObject({ setupState: "failed", setupSummary: "Workspace setup failed: dependency unavailable" });
        expect(child.isDisposed).toBe(true);
    });
});
