import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
    agentAdditionalPaths,
    agentCapabilities,
    agentTools,
    BUILTIN_ADVISOR,
    BUILTIN_REVIEWER,
    discoverAgentsInDirectories,
} from "../../src/tools/agent/definitions/discovery";
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

function writeAgent(
    dir: string,
    file: string,
    name: string,
    body: string,
    extra = "",
): void {
    fs.writeFileSync(
        path.join(dir, file),
        `---\nname: ${name}\ndescription: ${name} description\n${extra}---\n\n${body}\n`,
    );
}

describe("agent discovery", () => {
    it("selects the first sorted same-scope definition and warns", () => {
        const userDir = tempScope();
        writeAgent(userDir, "b.md", "analyst", "Definition B");
        writeAgent(userDir, "a.md", "analyst", "Definition A");

        const result = discoverAgentsInDirectories(userDir);
        const analyst = result.agents.find((agent) => agent.name === "analyst");

        expect(analyst?.systemPrompt).toBe("Definition A");
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
            level: "warning",
            message: expect.stringContaining("first sorted definition wins"),
            paths: [path.join(userDir, "a.md"), path.join(userDir, "b.md")],
        }));
    });

    it("lets a project definition override a user definition with an informational diagnostic", () => {
        const userDir = tempScope();
        const projectDir = tempScope();
        writeAgent(userDir, "analyst.md", "analyst", "User definition");
        writeAgent(projectDir, "analyst.md", "analyst", "Project definition");

        const result = discoverAgentsInDirectories(userDir, projectDir);
        const analyst = result.agents.find((agent) => agent.name === "analyst");

        expect(analyst?.source).toBe("project");
        expect(analyst?.systemPrompt).toBe("Project definition");
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
            level: "info",
            message: expect.stringContaining("overrides the user agent"),
        }));
    });

    it("does not load project definitions when no trusted project directory is supplied", () => {
        const userDir = tempScope();
        const projectDir = tempScope();
        writeAgent(projectDir, "project-only.md", "project-only", "Project definition");

        const untrusted = discoverAgentsInDirectories(userDir);
        const trusted = discoverAgentsInDirectories(userDir, projectDir);

        expect(untrusted.agents.map((agent) => agent.name)).toEqual(["scout", "reviewer", "advisor", "worker"]);
        expect(trusted.agents.map((agent) => agent.name)).toEqual(["scout", "reviewer", "advisor", "worker", "project-only"]);
    });

    it("protects reserved names and grants only declared capabilities", () => {
        const userDir = tempScope();
        writeAgent(userDir, "scout.md", "scout", "Override built-in");
        writeAgent(userDir, "reviewer.md", "reviewer", "Override reviewer");
        writeAgent(userDir, "advisor.md", "advisor", "Override advisor");
        writeAgent(userDir, "worker.md", "worker", "Override worker");
        writeAgent(
            userDir,
            "custom.md",
            "custom",
            "Custom",
            "capabilities: [command-runner, memories]\nadditionalPaths: [\"/tmp/shared-notes\"]\n",
        );
        writeAgent(userDir, "todo.md", "todo", "TODO", "capabilities: [todolist]\n");
        writeAgent(userDir, "stale.md", "stale", "Stale", "tools: [read, bash]\n");

        const result = discoverAgentsInDirectories(userDir);
        const scout = result.agents.find((agent) => agent.name === "scout");
        const reviewer = result.agents.find((agent) => agent.name === "reviewer");
        const advisor = result.agents.find((agent) => agent.name === "advisor");
        const worker = result.agents.find((agent) => agent.name === "worker");
        const custom = result.agents.find((agent) => agent.name === "custom");
        const todo = result.agents.find((agent) => agent.name === "todo");
        const stale = result.agents.find((agent) => agent.name === "stale");

        expect(scout).toMatchObject({ source: "builtin", capabilities: ["read", "search", "memories", "safe-bash"] });
        expect(reviewer).toMatchObject({
            source: "builtin",
            capabilities: ["read", "search", "memories", "scratchpad", "safe-bash", "command-runner"],
        });
        expect(advisor).toBe(BUILTIN_ADVISOR);
        expect(advisor).toMatchObject({
            source: "builtin",
            capabilities: ["read", "search", "memories", "safe-bash"],
        });
        expect(agentTools(advisor!)).toEqual(["read", "grep", "find", "ls", "bash"]);
        expect(agentTools(scout!)).toEqual(["read", "grep", "find", "ls", "bash"]);
        expect(worker).toMatchObject({
            source: "builtin",
            capabilities: ["read", "search", "memories", "scratchpad", "todolist", "safe-bash", "command-runner", "edit"],
        });
        expect(agentTools(worker!)).toEqual(["read", "grep", "find", "ls", "edit", "write", "bash"]);
        expect(custom).toMatchObject({
            source: "user",
            capabilities: ["command-runner", "memories"],
            additionalPaths: ["/tmp/shared-notes"],
        });
        expect(agentAdditionalPaths(custom!)).toEqual([
            "/tmp/shared-notes",
            path.join(os.homedir(), ".pi", "agent", "memory"),
        ]);
        expect(agentCapabilities(custom!)).toEqual(["read", "search", "memories", "safe-bash", "command-runner"]);
        expect(agentTools(custom!)).toEqual(["read", "grep", "find", "ls", "bash"]);
        expect(todo).toMatchObject({ source: "user", capabilities: ["todolist"] });
        expect(agentCapabilities(todo!)).toEqual(["read", "search", "scratchpad", "todolist"]);
        expect(agentTools(todo!)).toEqual(["read", "grep", "find", "ls"]);
        expect(stale?.capabilities).toEqual([]);
        expect(result.diagnostics.filter((diagnostic) => diagnostic.level === "warning"))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining("reserved") }),
                expect.objectContaining({ message: expect.stringContaining("field \"tools\" is unsupported") }),
            ]));
    });

    it("preserves additional paths in durable definition snapshots", () => {
        const definition = {
            name: "snapshot-agent",
            description: "Snapshot agent",
            capabilities: [],
            additionalPaths: ["/tmp/notes"],
            systemPrompt: "Inspect notes",
            source: "user" as const,
        };

        expect(parseAgentDefinitionSnapshot(snapshotAgentDefinition(definition)))
            .toMatchObject({ additionalPaths: ["/tmp/notes"] });
    });

    it("rejects malformed or unknown capability lists", () => {
        const userDir = tempScope();
        writeAgent(userDir, "not-a-list.md", "not-a-list", "Bad", "capabilities: safe-bash\n");
        writeAgent(userDir, "unknown.md", "unknown", "Bad", "capabilities: [unsafe-bash]\n");
        writeAgent(userDir, "edit.md", "edit-agent", "Bad", "capabilities: [edit]\n");
        writeAgent(userDir, "paths.md", "bad-paths", "Bad", "additionalPaths: [\"\"]\n");

        const result = discoverAgentsInDirectories(userDir);

        expect(result.agents.map((agent) => agent.name)).not.toContain("not-a-list");
        expect(result.agents.map((agent) => agent.name)).not.toContain("unknown");
        expect(result.agents.map((agent) => agent.name)).not.toContain("edit-agent");
        expect(result.agents.map((agent) => agent.name)).not.toContain("bad-paths");
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ message: expect.stringContaining("capabilities must be an array") }),
        ]));
    });

    it("reports malformed definitions without hiding valid agents", () => {
        const userDir = tempScope();
        fs.writeFileSync(path.join(userDir, "bad.md"), "not frontmatter");
        writeAgent(userDir, "valid.md", "valid", "Valid definition");

        const result = discoverAgentsInDirectories(userDir);

        expect(result.agents.map((agent) => agent.name)).toEqual(["scout", "reviewer", "advisor", "worker", "valid"]);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
            level: "warning",
            paths: [path.join(userDir, "bad.md")],
        }));
    });
});
