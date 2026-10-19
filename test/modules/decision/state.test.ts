import { describe, expect, it } from "vitest";

import { buildState, hasRequestContext } from "../../../src/modules/decision";
import type { DecisionContext } from "../../../src/modules/decision";
import { runnerRulesFor } from "../../../src/modules/decision/runner-rules";

describe("decision state", () => {
    it("carries the command, cwd, and the parent's rules in every shape", () => {
        expect(buildState({ command: "ls", cwd: "/repo" }, "command_cwd")).toEqual({
            command: "ls",
            cwd: "/repo",
            runner_rules: [...runnerRulesFor("parent")],
        });
        expect(buildState({ command: "ls", cwd: "/repo" }, "request_context")).toMatchObject({
            command: "ls",
            cwd: "/repo",
            runner_rules: [...runnerRulesFor("parent")],
        });
    });

    it("states the runner's authority, including what it must not do", () => {
        const worker = buildState({ command: "ls", cwd: "/repo", runner: "worker" }, "command_cwd");
        const reviewer = buildState(
            { command: "ls", cwd: "/repo", runner: "reviewer" },
            "command_cwd",
        );

        expect(worker.runner_rules).toEqual([...runnerRulesFor("worker")]);
        expect(reviewer.runner_rules).toEqual([...runnerRulesFor("reviewer")]);
        // A mutating runner has no prohibition *inside* its copy, only beyond it; a command-rung runner
        // has the file prohibition, and that line is what makes it refuse edits (19/25 -> 24/25 measured).
        const parent = buildState({ command: "ls", cwd: "/repo", runner: "parent" }, "command_cwd");
        expect(String(parent.runner_rules)).not.toContain("DON'T");
        expect(String(worker.runner_rules)).toContain(
            "DON'T: change files outside its own working copy",
        );
        expect(String(reviewer.runner_rules)).toContain("DON'T: create, change, or delete files");
    });

    it("says where a worker's working copy is", () => {
        const worktree = buildState(
            { command: "ls", cwd: "/repo", runner: "worker", isolation: "worktree" },
            "command_cwd",
        );
        const checkout = buildState(
            { command: "ls", cwd: "/repo", runner: "worker", isolation: "checkout" },
            "command_cwd",
        );

        expect(String(worktree.runner_rules)).toContain("isolated disposable git worktree");
        expect(String(checkout.runner_rules)).toContain("the user's working tree");
    });

    it("adds the request and the recent turns only in the request_context shape", () => {
        const context = {
            command: "rm -rf ./build",
            cwd: "/repo",
            request: "clean out the build directory so we can rebuild",
            recent: [{ role: "assistant", text: "Let me look at the tree first." }],
        };

        expect(buildState(context, "request_context")).toMatchObject({
            request: "clean out the build directory so we can rebuild",
            recent_messages: [{ role: "assistant", text: "Let me look at the tree first." }],
        });

        const bare = buildState(context, "command_cwd");
        expect(bare).not.toHaveProperty("request");
        expect(bare).not.toHaveProperty("recent_messages");
    });

    it("omits empty optional fields", () => {
        const state = buildState(
            {
                command: "ls",
                cwd: "/repo",
                request: "   ",
                recent: [{ role: "user", text: " " }],
            },
            "request_context",
        );

        expect(state).not.toHaveProperty("request");
        expect(state).not.toHaveProperty("recent_messages");
    });

    it("carries uncommitted workspace changes only when there are any", () => {
        const dirty = buildState(
            {
                command: "git checkout -- src/a.ts",
                cwd: "/repo",
                workspace: {
                    changes: [
                        { status: "modified", path: "src/a.ts" },
                        { status: "untracked", path: "tmp/b.txt" },
                    ],
                    truncated: true,
                },
            },
            "command_cwd",
        );

        expect(dirty.workspace_status).toEqual({
            changes: ["modified: src/a.ts", "untracked: tmp/b.txt"],
            note: "more changed files are not listed",
        });

        const clean = buildState(
            { command: "ls", cwd: "/repo", workspace: { changes: [], truncated: false } },
            "command_cwd",
        );
        expect(clean).not.toHaveProperty("workspace_status");
    });

    it("leaves the history to the strategy that asks for it", () => {
        const state = buildState(
            { command: "ls", cwd: "/repo", history: ["cd /repo && git status"] },
            "request_context",
        );

        expect(state).not.toHaveProperty("command_history");
    });

    it("carries resolved script bodies in every shape, in artifact order", () => {
        const context: DecisionContext = {
            command: "npm run deploy",
            cwd: "/repo",
            script: {
                kind: "package",
                artifacts: [
                    {
                        source: "package.json#deploy",
                        path: "/repo/package.json",
                        text: "node deploy.js",
                    },
                    { source: "deploy.js", path: "/repo/deploy.js", text: "deploy()" },
                ],
            },
        };

        expect(buildState(context, "request_context")).toMatchObject({
            scripts: ["node deploy.js", "deploy()"],
        });
        expect(buildState(context, "command_cwd")).toMatchObject({
            scripts: ["node deploy.js", "deploy()"],
        });
    });

    it("carries capability summaries instead of bodies on a command request", () => {
        const state = buildState(
            {
                command: "npm run deploy",
                cwd: "/repo",
                scriptProfiles: [
                    { source: "package.json#deploy", capability: "writes_files" },
                    { source: "scripts/deploy.js", capability: "network" },
                ],
            },
            "request_context",
        );

        expect(state.script_capabilities).toEqual([
            { source: "package.json#deploy", capability: "writes_files" },
            { source: "scripts/deploy.js", capability: "network" },
        ]);
        expect(state).not.toHaveProperty("scripts");
    });

    it("adds a bracketed marker for an omission, after the bodies", () => {
        const state = buildState(
            {
                command: "npm run a",
                cwd: "/repo",
                script: {
                    kind: "package",
                    artifacts: [
                        { source: "package.json#a", path: "/repo/package.json", text: "npm run a" },
                    ],
                    omissions: [{ reason: "cycle", source: "package.json#a" }],
                },
            },
            "request_context",
        );

        expect(state.scripts).toEqual([
            "npm run a",
            "[script not resolved: cycle at package.json#a]",
        ]);
    });

    it("describes a depth stop in the marker too", () => {
        const state = buildState(
            {
                command: "npm run a",
                cwd: "/repo",
                script: {
                    kind: "package",
                    artifacts: [
                        { source: "package.json#a", path: "/repo/package.json", text: "npm run b" },
                    ],
                    omissions: [{ reason: "depth", source: "package.json#b" }],
                },
            },
            "request_context",
        );

        expect(state.scripts).toEqual([
            "npm run b",
            "[script not resolved: depth limit at package.json#b]",
        ]);
    });

    it("adds no script fields for a body-less inline or binary form", () => {
        for (const script of [
            { kind: "inline", artifacts: [] },
            { kind: "binary", artifacts: [] },
        ] as const) {
            const state = buildState(
                { command: "npx tsc --noEmit", cwd: "/repo", script },
                "request_context",
            );
            expect(state).not.toHaveProperty("scripts");
        }
    });

    it("sends an inline body like any other script text", () => {
        const state = buildState(
            {
                command: "python3 -c 'print(1)'",
                cwd: "/repo",
                script: {
                    kind: "inline",
                    artifacts: [{ source: "inline:python3 -c", text: "print(1)" }],
                },
            },
            "request_context",
        );

        expect(state.scripts).toEqual(["print(1)"]);
    });

    it("adds no script field when a recognized form resolved no body", () => {
        const state = buildState(
            {
                command: "npm run missing",
                cwd: "/repo",
                script: { kind: "package", artifacts: [] },
            },
            "request_context",
        );

        expect(state).not.toHaveProperty("scripts");
    });
});

describe("hasRequestContext", () => {
    it("reports which shapes carry the request", () => {
        expect(hasRequestContext("request_context")).toBe(true);
        expect(hasRequestContext("command_cwd")).toBe(false);
    });
});
