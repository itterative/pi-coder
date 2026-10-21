import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Strip the common indentation of a template block; the shared util takes a template literal instead. */
function trimBlock(text: string): string {
    const lines = text.split("\n");

    while (lines.length > 0 && lines[0].trim() === "") {
        lines.shift();
    }

    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop();
    }

    const indents = lines
        .filter((line) => line.trim() !== "")
        .map((line) => line.match(/^\s*/)![0].length);
    const indent = Math.min(...indents);

    return lines.map((line) => line.slice(indent)).join("\n") + "\n";
}

import {
    auditMemoryTrees,
    formatAuditReport,
    INDEX_BUDGET_BYTES,
    summarizeAudit,
    type AuditFinding,
} from "../../../src/modules/memory/audit";

const roots: string[] = [];

interface TreeOptions {
    project?: Record<string, string>;
    user?: Record<string, string>;
    repoDocs?: Record<string, string>;
}

/** Build a throwaway repo whose memory trees mirror the real `.pi/agent/memory` layout. */
async function makeTree(options: TreeOptions): Promise<{
    projectRoot: string;
    projectDir: string;
    userDir: string;
}> {
    const projectRoot = await mkdtemp(join(tmpdir(), "pi-memory-audit-"));
    roots.push(projectRoot);

    const projectDir = join(projectRoot, ".pi", "agent", "memory");
    const userDir = join(projectRoot, "user-memory");

    async function writeAll(
        base: string,
        files: Record<string, string> | undefined,
    ): Promise<void> {
        for (const [rel, text] of Object.entries(files ?? {})) {
            const abs = join(base, rel);
            await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
            await writeFile(abs, trimBlock(text), "utf8");
        }
    }

    await writeAll(projectDir, options.project);
    await writeAll(userDir, options.user);
    await writeAll(projectRoot, options.repoDocs);

    return { projectRoot, projectDir, userDir };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function audit(options: TreeOptions): Promise<AuditFinding[]> {
    const { projectRoot, projectDir, userDir } = await makeTree(options);
    const results = await auditMemoryTrees({ projectDir, userDir, projectRoot });

    return results.flatMap((result) => result.findings);
}

const cleanIndex = `
    ---
    name: sandbox
    description: Cwd-confinement permission model.
    category: architecture
    ---

    # Sandbox

    See \`sandbox/path-safety.md\` for the path rules.
    `;

const cleanDetail = `
    ---
    name: path-safety
    description: Path and environment safety rules.
    category: architecture
    ---

    # Path safety

    Back in the index: [../sandbox.md](../sandbox.md).
    `;

describe("auditMemoryTrees", () => {
    it("reports nothing for a well-formed two-tier tree", async () => {
        const findings = await audit({
            project: { "sandbox.md": cleanIndex, "sandbox/path-safety.md": cleanDetail },
        });

        expect(findings).toEqual([]);
    });

    it("flags frontmatter that silently drops an indexed memory", async () => {
        const findings = await audit({
            project: {
                "agents.md": `
                    ---
                    name: agents
                    description: Cluster index for delegated agents: what the feature is.
                    category: architecture
                    ---

                    # Agents
                    `,
            },
        });

        const frontmatter = findings.filter((finding) => finding.rule === "frontmatter");
        expect(frontmatter).toHaveLength(1);
        expect(frontmatter[0]?.severity).toBe("error");
        expect(frontmatter[0]?.path).toBe("agents.md");
        expect(frontmatter[0]?.message).toContain("this memory is not indexed");
    });

    it("requires the name field to match the filename stem", async () => {
        const findings = await audit({
            project: {
                "sandbox.md": `
                    ---
                    name: sandboxing
                    description: Wrong name.
                    category: architecture
                    ---

                    # Sandbox
                    `,
            },
        });

        expect(findings.map((finding) => finding.rule)).toContain("name");
    });

    it("budgets indexed descriptions and index bodies", async () => {
        const findings = await audit({
            project: {
                "sandbox.md": `
                    ---
                    name: sandbox
                    description: ${"a".repeat(160)}
                    category: architecture
                    ---

                    # Sandbox

                    ${"body ".repeat(INDEX_BUDGET_BYTES)}
                    `,
            },
        });

        const rules = findings.map((finding) => finding.rule);
        expect(rules).toContain("description");
        expect(rules).toContain("index-budget");
    });

    it("treats a nested doc no index names as unreachable, but not one the index links", async () => {
        const unreachable = await audit({
            project: {
                "sandbox.md": `
                    ---
                    name: sandbox
                    description: Index that lists nothing.
                    category: architecture
                    ---

                    # Sandbox
                    `,
                "sandbox/path-safety.md": cleanDetail,
            },
        });

        expect(unreachable.find((finding) => finding.rule === "reachability")?.path).toBe(
            "sandbox/path-safety.md",
        );

        const linked = await audit({
            project: { "sandbox.md": cleanIndex, "sandbox/path-safety.md": cleanDetail },
        });
        expect(linked.find((finding) => finding.rule === "reachability")).toBeUndefined();
    });

    it("catches an index that names a nested path that does not exist", async () => {
        const findings = await audit({
            project: {
                "sandbox.md": cleanIndex,
                "sandbox/other.md": `
                    ---
                    name: other
                    description: Something else.
                    category: architecture
                    ---

                    # Other

                    Lists \`sandbox/path-safety.md\` which was never written.
                    `,
            },
        });

        const dangling = findings.filter((finding) => finding.rule === "dangling-reference");
        expect(dangling).toHaveLength(1);
        expect(dangling[0]?.severity).toBe("error");
        expect(dangling[0]?.path).toBe("sandbox.md");
    });

    it("catches a relative link that lost a level when a doc moved deeper", async () => {
        const findings = await audit({
            repoDocs: { "docs/gates.md": "# Gates\n" },
            project: {
                "sandbox.md": cleanIndex,
                "sandbox/path-safety.md": `
                    ---
                    name: path-safety
                    description: Path rules with a short link.
                    category: architecture
                    ---

                    See [gates](../../../docs/gates.md).
                    `,
            },
        });

        const broken = findings.filter((finding) => finding.rule === "broken-link");
        expect(broken).toHaveLength(1);
        expect(broken[0]?.path).toBe("sandbox/path-safety.md");
        expect(broken[0]?.message).toContain("one more");
    });

    it("resolves links from the documenting file, its memory dir, and the project root", async () => {
        const findings = await audit({
            repoDocs: { "docs/gates.md": "# Gates\n" },
            project: {
                "sandbox.md": cleanIndex,
                "sandbox/path-safety.md": `
                    ---
                    name: path-safety
                    description: Path rules with a correct link.
                    category: architecture
                    ---

                    See [gates](../../../../docs/gates.md).
                    `,
            },
        });

        expect(findings.filter((finding) => finding.rule === "broken-link")).toEqual([]);
    });

    it("flags pointers to memory names that are not indexed, and spares historical framing", async () => {
        const stale = await audit({
            project: {
                "sandbox.md": `
                    ---
                    name: sandbox
                    description: Index with a stale pointer.
                    category: architecture
                    ---

                    # Sandbox

                    See the \`heuristics\` memory for the rules.
                    `,
            },
        });

        expect(stale.find((finding) => finding.rule === "stale-memory-reference")?.severity).toBe(
            "warning",
        );

        const historical = await audit({
            project: {
                "sandbox.md": `
                    ---
                    name: sandbox
                    description: Index with an archive mention.
                    category: architecture
                    ---

                    # Sandbox

                    This replaces the former \`heuristics\` memory.
                    `,
            },
        });
        expect(
            historical.find((finding) => finding.rule === "stale-memory-reference"),
        ).toBeUndefined();
    });

    it("accepts a reference to a memory indexed only in the user tree", async () => {
        const findings = await audit({
            project: {
                "sandbox.md": `
                    ---
                    name: sandbox
                    description: Index pointing at a user memory.
                    category: architecture
                    ---

                    # Sandbox

                    See the \`conventions\` memory.
                    `,
            },
            user: {
                "conventions.md": `
                    ---
                    name: conventions
                    description: User-level conventions.
                    ---

                    # Conventions
                    `,
            },
        });

        expect(findings.filter((finding) => finding.rule === "stale-memory-reference")).toEqual([]);
    });

    it("reports non-lowercase categories and nested frontmatter that fails to parse", async () => {
        const findings = await audit({
            project: {
                "sandbox.md": `
                    ---
                    name: sandbox
                    description: Index with a capitalized category.
                    category: Architecture
                    ---

                    # Sandbox

                    See \`sandbox/path-safety.md\`.
                    `,
                "sandbox/path-safety.md": `
                    ---
                    name: other
                    description: Nested doc whose name disagrees and is not parsed.
                    category: architecture
                    ---

                    # Path safety
                    `,
            },
        });

        const rules = findings.map((finding) => finding.rule);
        expect(rules).toContain("category");
        expect(rules).toContain("name");
        expect(
            findings.find((finding) => finding.path === "sandbox/path-safety.md")?.severity,
        ).toBe("warning");
    });

    it("warns about a nested doc with no frontmatter at all", async () => {
        const findings = await audit({
            project: {
                "sandbox.md": `
                    ---
                    name: sandbox
                    description: Index.
                    category: architecture
                    ---

                    # Sandbox

                    See \`sandbox/notes.md\`.
                    `,
                "sandbox/notes.md": "# Notes\n\nNo frontmatter here.\n",
            },
        });

        expect(findings.find((finding) => finding.rule === "frontmatter")?.message).toContain(
            "no frontmatter",
        );
    });

    it("summarizes and formats for both surfaces", async () => {
        const { projectRoot, projectDir, userDir } = await makeTree({
            project: { "sandbox.md": cleanIndex, "sandbox/path-safety.md": cleanDetail },
        });
        const results = await auditMemoryTrees({ projectDir, userDir, projectRoot });

        expect(summarizeAudit(results)).toMatch(
            /project: 1 indexed, 1 nested, 0 errors, 0 warnings/,
        );
        expect(formatAuditReport(results)).toContain("no findings");
    });
});
