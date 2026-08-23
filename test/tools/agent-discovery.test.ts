import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverAgentsInDirectories } from "../../src/tools/agent/discovery";

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
        writeAgent(userDir, "b.md", "reviewer", "Definition B");
        writeAgent(userDir, "a.md", "reviewer", "Definition A");

        const result = discoverAgentsInDirectories(userDir);
        const reviewer = result.agents.find((agent) => agent.name === "reviewer");

        expect(reviewer?.systemPrompt).toBe("Definition A");
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
            level: "warning",
            message: expect.stringContaining("first sorted definition wins"),
            paths: [path.join(userDir, "a.md"), path.join(userDir, "b.md")],
        }));
    });

    it("lets a project definition override a user definition with an informational diagnostic", () => {
        const userDir = tempScope();
        const projectDir = tempScope();
        writeAgent(userDir, "reviewer.md", "reviewer", "User definition");
        writeAgent(projectDir, "reviewer.md", "reviewer", "Project definition");

        const result = discoverAgentsInDirectories(userDir, projectDir);
        const reviewer = result.agents.find((agent) => agent.name === "reviewer");

        expect(reviewer?.source).toBe("project");
        expect(reviewer?.systemPrompt).toBe("Project definition");
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

        expect(untrusted.agents.map((agent) => agent.name)).toEqual(["scout", "worker"]);
        expect(trusted.agents.map((agent) => agent.name)).toEqual(["scout", "worker", "project-only"]);
    });

    it("protects reserved names and enforces the read-only tool ceiling", () => {
        const userDir = tempScope();
        writeAgent(userDir, "scout.md", "scout", "Override built-in");
        writeAgent(userDir, "worker.md", "worker", "Override worker");
        writeAgent(userDir, "custom.md", "custom", "Custom", "tools: [read, bash, write, grep]\n");

        const result = discoverAgentsInDirectories(userDir);
        const scout = result.agents.find((agent) => agent.name === "scout");
        const worker = result.agents.find((agent) => agent.name === "worker");
        const custom = result.agents.find((agent) => agent.name === "custom");

        expect(scout?.source).toBe("builtin");
        expect(worker).toMatchObject({ source: "builtin", mutating: true });
        expect(worker?.tools).toEqual(["read", "grep", "find", "ls", "edit", "write", "bash"]);
        expect(custom?.tools).toEqual(["read", "grep"]);
        expect(result.diagnostics.filter((diagnostic) => diagnostic.level === "warning"))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining("reserved") }),
                expect.objectContaining({ message: expect.stringContaining("Unsupported tools") }),
            ]));
    });

    it("reports malformed definitions without hiding valid agents", () => {
        const userDir = tempScope();
        fs.writeFileSync(path.join(userDir, "bad.md"), "not frontmatter");
        writeAgent(userDir, "valid.md", "valid", "Valid definition");

        const result = discoverAgentsInDirectories(userDir);

        expect(result.agents.map((agent) => agent.name)).toEqual(["scout", "worker", "valid"]);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
            level: "warning",
            paths: [path.join(userDir, "bad.md")],
        }));
    });
});
