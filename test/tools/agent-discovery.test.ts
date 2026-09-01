import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
    agentCapabilities,
    BUILTIN_ADVISOR,
    BUILTIN_SCOUT,
    discoverAgentsInDirectories,
} from "../../src/tools/agent/definitions/discovery";
import { capabilityReadRoots, capabilityTools } from "../../src/tools/agent/child/capabilities";
import {
    parseAgentDefinitionSnapshot,
    snapshotAgentDefinition,
} from "../../src/tools/agent/definitions/types";

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function tempScope(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-agents-"));
    tempDirs.push(dir);
    return dir;
}

/**
 * Definition files are authored as fixtures under `fixtures/agent-definitions/` and copied into a
 * temp scope under their own names, because the loader's contract is about the files it reads:
 * sort order decides which duplicate wins, and each diagnostic reports the offending path.
 */
function copyFixtures(dir: string, names: string[]): void {
    for (const name of names) {
        const fixture = fileURLToPath(
            new URL(`./fixtures/agent-definitions/${name}.md`, import.meta.url),
        );
        fs.copyFileSync(fixture, path.join(dir, `${name}.md`));
    }
}

describe("agent discovery", () => {
    it("selects the first sorted same-scope definition and warns", () => {
        const userDir = tempScope();
        copyFixtures(userDir, ["analyst-a", "analyst-b"]);

        const result = discoverAgentsInDirectories(userDir);
        const analyst = result.agents.find((agent) => agent.name === "analyst");

        expect(analyst?.systemPrompt).toBe("Definition A");
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                level: "warning",
                message: expect.stringContaining("first sorted definition wins"),
                paths: [path.join(userDir, "analyst-a.md"), path.join(userDir, "analyst-b.md")],
            }),
        );
    });

    it("lets a project definition override a user definition with an informational diagnostic", () => {
        const userDir = tempScope();
        const projectDir = tempScope();
        copyFixtures(userDir, ["analyst-user"]);
        copyFixtures(projectDir, ["analyst-project"]);

        const result = discoverAgentsInDirectories(userDir, projectDir);
        const analyst = result.agents.find((agent) => agent.name === "analyst");

        expect(analyst?.source).toBe("project");
        expect(analyst?.systemPrompt).toBe("Project definition");
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                level: "info",
                message: expect.stringContaining("overrides the user agent"),
            }),
        );
    });

    it("does not load project definitions when no trusted project directory is supplied", () => {
        const userDir = tempScope();
        const projectDir = tempScope();
        copyFixtures(projectDir, ["project-only"]);

        const untrusted = discoverAgentsInDirectories(userDir);
        const trusted = discoverAgentsInDirectories(userDir, projectDir);

        expect(untrusted.agents.map((agent) => agent.name)).toEqual([
            "scout",
            "reviewer",
            "advisor",
            "worker",
        ]);
        expect(trusted.agents.map((agent) => agent.name)).toEqual([
            "scout",
            "reviewer",
            "advisor",
            "worker",
            "project-only",
        ]);
    });

    it("keeps built-in capabilities while applying scout overlays", () => {
        const userDir = tempScope();
        copyFixtures(userDir, ["scout-safe-bash"]);

        const result = discoverAgentsInDirectories(userDir);
        const scout = result.agents.find((agent) => agent.name === "scout");

        expect(scout).toMatchObject({
            source: "builtin",
            description: BUILTIN_SCOUT.description,
            capabilities: BUILTIN_SCOUT.capabilities,
            systemPrompt: BUILTIN_SCOUT.systemPrompt,
            safeBashCommands: ["ast-outline digest *"],
        });
    });

    /**
     * An overlay must not gain a field it never asked for: the merge copies the built-in and then
     * applies only requested keys, so `additionalPaths: []` or a blank `model` would have to be
     * written as an absent key rather than an empty one.
     */
    it("omits optional fields the overlay did not request", () => {
        const userDir = tempScope();
        copyFixtures(userDir, ["scout-blank-model", "reviewer-metadata-only"]);

        const result = discoverAgentsInDirectories(userDir);
        const scout = result.agents.find((agent) => agent.name === "scout");
        const reviewer = result.agents.find((agent) => agent.name === "reviewer");

        expect(scout).toMatchObject({
            source: "builtin",
            capabilities: BUILTIN_SCOUT.capabilities,
            systemPrompt: BUILTIN_SCOUT.systemPrompt,
        });
        expect(scout?.model).toBeUndefined();
        expect(scout?.safeBashCommands).toBeUndefined();
        expect(scout?.additionalPaths).toEqual([]);
        // A field the overlay never mentions stays absent, not empty.
        expect(reviewer?.additionalPaths).toBeUndefined();
        expect(reviewer?.safeBashCommands).toBeUndefined();
        expect(reviewer?.model).toBeUndefined();
        expect(reviewer?.description).toBe("Overlaid reviewer");
    });

    /**
     * `mergeScopeDefinition` uses `body || base.systemPrompt`, which distinguishes an empty custom
     * body from a metadata-only overlay only because the custom skeleton starts with an empty prompt.
     * Pin both sides of that fallback.
     */
    it("gives a body-less custom definition no prompt and a body-less overlay the built-in prompt", () => {
        const userDir = tempScope();
        copyFixtures(userDir, ["custom-no-body", "scout-safe-bash"]);

        const result = discoverAgentsInDirectories(userDir);
        const terse = result.agents.find((agent) => agent.name === "terse");
        const scout = result.agents.find((agent) => agent.name === "scout");

        expect(terse).toMatchObject({ source: "user", description: "terse description" });
        expect(terse?.systemPrompt).toBe("");
        expect(scout?.systemPrompt).toBe(BUILTIN_SCOUT.systemPrompt);
    });

    it("overrides scout metadata but ignores capability changes", () => {
        const userDir = tempScope();
        copyFixtures(userDir, ["scout-full-overlay"]);

        const result = discoverAgentsInDirectories(userDir);
        const scout = result.agents.find((agent) => agent.name === "scout");

        expect(scout).toMatchObject({
            source: "builtin",
            description: "Custom scout",
            capabilities: BUILTIN_SCOUT.capabilities,
            additionalPaths: ["/tmp/notes"],
            safeBashCommands: ["ast-outline digest *"],
            model: "provider/model",
            systemPrompt: "Custom scout role",
        });
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    message: expect.stringContaining("capabilities cannot be overridden"),
                }),
            ]),
        );
    });

    it("grants only declared capabilities", () => {
        const userDir = tempScope();
        copyFixtures(userDir, ["custom-capabilities", "todo-capabilities", "stale-tools"]);

        const result = discoverAgentsInDirectories(userDir);
        const scout = result.agents.find((agent) => agent.name === "scout");
        const reviewer = result.agents.find((agent) => agent.name === "reviewer");
        const advisor = result.agents.find((agent) => agent.name === "advisor");
        const worker = result.agents.find((agent) => agent.name === "worker");
        const custom = result.agents.find((agent) => agent.name === "custom");
        const todo = result.agents.find((agent) => agent.name === "todo");
        const stale = result.agents.find((agent) => agent.name === "stale");

        expect(scout).toMatchObject({
            source: "builtin",
            capabilities: ["read", "search", "memories", "safe-bash"],
        });
        expect(reviewer).toMatchObject({
            source: "builtin",
            capabilities: [
                "read",
                "search",
                "memories",
                "scratchpad",
                "safe-bash",
                "command-runner",
            ],
        });
        expect(advisor).toBe(BUILTIN_ADVISOR);
        expect(advisor).toMatchObject({
            source: "builtin",
            capabilities: ["read", "search", "memories", "safe-bash"],
        });
        expect(capabilityTools(advisor!)).toEqual(["read", "grep", "find", "ls", "bash"]);
        expect(capabilityTools(scout!)).toEqual(["read", "grep", "find", "ls", "bash"]);
        expect(worker).toMatchObject({
            source: "builtin",
            capabilities: [
                "read",
                "search",
                "memories",
                "scratchpad",
                "todolist",
                "safe-bash",
                "command-runner",
                "edit",
            ],
        });
        expect(capabilityTools(worker!)).toEqual([
            "read",
            "grep",
            "find",
            "ls",
            "edit",
            "write",
            "bash",
        ]);
        expect(custom).toMatchObject({
            source: "user",
            capabilities: ["command-runner", "memories"],
            additionalPaths: ["/tmp/shared-notes"],
            safeBashCommands: ["ast-outline digest *"],
        });
        expect(capabilityReadRoots(custom!)).toEqual([
            "/tmp/shared-notes",
            path.join(os.homedir(), ".pi", "agent", "memory"),
        ]);
        expect(agentCapabilities(custom!)).toEqual([
            "read",
            "search",
            "memories",
            "safe-bash",
            "command-runner",
        ]);
        expect(capabilityTools(custom!)).toEqual(["read", "grep", "find", "ls", "bash"]);
        expect(todo).toMatchObject({ source: "user", capabilities: ["todolist"] });
        expect(agentCapabilities(todo!)).toEqual(["read", "search", "scratchpad", "todolist"]);
        expect(capabilityTools(todo!)).toEqual(["read", "grep", "find", "ls"]);
        expect(stale?.capabilities).toEqual([]);
        expect(result.diagnostics.filter((diagnostic) => diagnostic.level === "warning")).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    message: expect.stringContaining('field "tools" is unsupported'),
                }),
            ]),
        );
    });

    it("preserves additional paths in durable definition snapshots", () => {
        const definition = {
            name: "snapshot-agent",
            description: "Snapshot agent",
            capabilities: [],
            additionalPaths: ["/tmp/notes"],
            safeBashCommands: ["ast-outline digest *"],
            systemPrompt: "Inspect notes",
            source: "user" as const,
        };

        expect(parseAgentDefinitionSnapshot(snapshotAgentDefinition(definition))).toMatchObject({
            additionalPaths: ["/tmp/notes"],
            safeBashCommands: ["ast-outline digest *"],
        });
    });

    /**
     * Every guard in `loadScope` exists so a broken file says _which_ field is wrong. Pin one
     * message per guard, including the paths it reports, so reordering or rewording a guard is a
     * deliberate change rather than a side effect of restructuring the loader.
     */
    it("diagnoses each malformed field with its own message", () => {
        const cases = [
            { fixture: "bad-name", name: "Bad Name", message: "Agent name must match" },
            {
                fixture: "missing-description",
                name: "missing-description",
                message: "Agent description must be a non-empty string.",
            },
            {
                fixture: "blank-description",
                name: "blank-description",
                message: "Agent description must be a non-empty string when provided.",
            },
            {
                fixture: "list-model",
                name: "list-model",
                message: "Agent model must be a provider/model string.",
            },
            {
                fixture: "not-a-list",
                name: "not-a-list",
                message: "Agent capabilities must be an array",
            },
            {
                fixture: "empty-path",
                name: "bad-paths",
                message: "additionalPaths must be an array",
            },
            {
                fixture: "bad-commands",
                name: "bad-commands",
                message: "safeBashCommands must be an array",
            },
            {
                fixture: "custom-edit",
                name: "edit-agent",
                message: "The edit capability is reserved for the built-in worker.",
            },
        ];
        const userDir = tempScope();
        copyFixtures(
            userDir,
            cases.map((testCase) => testCase.fixture),
        );

        const result = discoverAgentsInDirectories(userDir);

        for (const testCase of cases) {
            expect(result.agents.map((agent) => agent.name)).not.toContain(testCase.name);
            expect(result.diagnostics).toContainEqual(
                expect.objectContaining({
                    level: "warning",
                    message: expect.stringContaining(testCase.message),
                    paths: [path.join(userDir, `${testCase.fixture}.md`)],
                }),
            );
        }
    });

    it("rejects malformed or unknown capability lists", () => {
        const userDir = tempScope();
        copyFixtures(userDir, ["not-a-list", "unknown-capability", "custom-edit", "empty-path"]);

        const result = discoverAgentsInDirectories(userDir);

        expect(result.agents.map((agent) => agent.name)).not.toContain("not-a-list");
        expect(result.agents.map((agent) => agent.name)).not.toContain("unknown");
        expect(result.agents.map((agent) => agent.name)).not.toContain("edit-agent");
        expect(result.agents.map((agent) => agent.name)).not.toContain("bad-paths");
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    message: expect.stringContaining("capabilities must be an array"),
                }),
            ]),
        );
    });

    /**
     * Guard order is user-visible. Two of the three advisories are raised after the model guard, so a
     * file with both problems reports only the model rejection, while a file whose rejection comes
     * later reports the advisory _and_ the rejection. Assert the whole ordered list: `toContainEqual`
     * tolerates extra entries and would let a refactor silently reordering the guards pass.
     */
    it("reports diagnostics in guard order for multi-problem definitions", () => {
        const userDir = tempScope();
        copyFixtures(userDir, [
            "scout-overlay-bad-model",
            "scout-overlay-bad-paths",
            "tools-bad-capabilities",
            "tools-bad-model",
            "tools-reserved-edit",
        ]);

        const result = discoverAgentsInDirectories(userDir);
        const at = (fixture: string) => [path.join(userDir, `${fixture}.md`)];

        expect(result.diagnostics).toEqual([
            {
                level: "warning",
                message: expect.stringContaining("provider/model string"),
                paths: at("scout-overlay-bad-model"),
            },
            {
                level: "warning",
                message: expect.stringContaining("capabilities cannot be overridden"),
                paths: at("scout-overlay-bad-paths"),
            },
            {
                level: "warning",
                message: expect.stringContaining("additionalPaths must be an array"),
                paths: at("scout-overlay-bad-paths"),
            },
            {
                level: "warning",
                message: expect.stringContaining('field "tools" is unsupported'),
                paths: at("tools-bad-capabilities"),
            },
            {
                level: "warning",
                message: expect.stringContaining("capabilities must be an array"),
                paths: at("tools-bad-capabilities"),
            },
            {
                level: "warning",
                message: expect.stringContaining("provider/model string"),
                paths: at("tools-bad-model"),
            },
            {
                level: "warning",
                message: expect.stringContaining('field "tools" is unsupported'),
                paths: at("tools-reserved-edit"),
            },
            {
                level: "warning",
                message: expect.stringContaining("edit capability is reserved"),
                paths: at("tools-reserved-edit"),
            },
        ]);
        // None of these files loaded, so only the built-ins remain.
        expect(result.agents.map((agent) => agent.name)).toEqual([
            "scout",
            "reviewer",
            "advisor",
            "worker",
        ]);
    });

    it("reports malformed definitions without hiding valid agents", () => {
        const userDir = tempScope();
        copyFixtures(userDir, ["not-frontmatter", "valid-definition"]);

        const result = discoverAgentsInDirectories(userDir);

        expect(result.agents.map((agent) => agent.name)).toEqual([
            "scout",
            "reviewer",
            "advisor",
            "worker",
            "valid",
        ]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                level: "warning",
                paths: [path.join(userDir, "not-frontmatter.md")],
            }),
        );
    });
});
