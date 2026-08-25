import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { agentTools, discoverAgentsInDirectories } from "../../src/tools/agent/definitions/discovery";

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

        expect(untrusted.agents.map((agent) => agent.name)).toEqual(["scout", "reviewer", "worker"]);
        expect(trusted.agents.map((agent) => agent.name)).toEqual(["scout", "reviewer", "worker", "project-only"]);
    });

    it("protects reserved names and grants only declared capabilities", () => {
        const userDir = tempScope();
        writeAgent(userDir, "scout.md", "scout", "Override built-in");
        writeAgent(userDir, "reviewer.md", "reviewer", "Override reviewer");
        writeAgent(userDir, "worker.md", "worker", "Override worker");
        writeAgent(userDir, "custom.md", "custom", "Custom", "capabilities: [safe-bash, safe-git-history]\n");
        writeAgent(userDir, "stale.md", "stale", "Stale", "tools: [read, bash]\n");

        const result = discoverAgentsInDirectories(userDir);
        const scout = result.agents.find((agent) => agent.name === "scout");
        const reviewer = result.agents.find((agent) => agent.name === "reviewer");
        const worker = result.agents.find((agent) => agent.name === "worker");
        const custom = result.agents.find((agent) => agent.name === "custom");
        const stale = result.agents.find((agent) => agent.name === "stale");

        expect(scout).toMatchObject({ source: "builtin", capabilities: ["safe-bash"] });
        expect(reviewer).toMatchObject({ source: "builtin", capabilities: ["safe-bash", "safe-git-history"] });
        expect(agentTools(scout!)).toEqual(["read", "grep", "find", "ls", "bash"]);
        expect(worker).toMatchObject({ source: "builtin", mutating: true });
        expect(agentTools(worker!)).toEqual(["read", "grep", "find", "ls", "edit", "write", "bash"]);
        expect(agentTools(custom!)).toEqual(["read", "grep", "find", "ls", "bash", "review_history"]);
        expect(stale?.capabilities).toEqual([]);
        expect(result.diagnostics.filter((diagnostic) => diagnostic.level === "warning"))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining("reserved") }),
                expect.objectContaining({ message: expect.stringContaining("field \"tools\" is unsupported") }),
            ]));
    });

    it("keeps safe-git-history independent from safe-bash", () => {
        const userDir = tempScope();
        writeAgent(userDir, "history.md", "history", "History", "capabilities: [safe-git-history]\n");

        const result = discoverAgentsInDirectories(userDir);
        const history = result.agents.find((agent) => agent.name === "history");

        expect(history?.capabilities).toEqual(["safe-git-history"]);
        expect(agentTools(history!)).toEqual(["read", "grep", "find", "ls", "review_history"]);
    });

    it("rejects malformed or unknown capability lists", () => {
        const userDir = tempScope();
        writeAgent(userDir, "not-a-list.md", "not-a-list", "Bad", "capabilities: safe-bash\n");
        writeAgent(userDir, "unknown.md", "unknown", "Bad", "capabilities: [unsafe-bash]\n");

        const result = discoverAgentsInDirectories(userDir);

        expect(result.agents.map((agent) => agent.name)).not.toContain("not-a-list");
        expect(result.agents.map((agent) => agent.name)).not.toContain("unknown");
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ message: expect.stringContaining("capabilities must be an array") }),
        ]));
    });

    it("reports malformed definitions without hiding valid agents", () => {
        const userDir = tempScope();
        fs.writeFileSync(path.join(userDir, "bad.md"), "not frontmatter");
        writeAgent(userDir, "valid.md", "valid", "Valid definition");

        const result = discoverAgentsInDirectories(userDir);

        expect(result.agents.map((agent) => agent.name)).toEqual(["scout", "reviewer", "worker", "valid"]);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
            level: "warning",
            paths: [path.join(userDir, "bad.md")],
        }));
    });
});
