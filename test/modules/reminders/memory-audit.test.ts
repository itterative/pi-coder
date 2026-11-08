import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    createMemoryAuditTrigger,
    formatMemoryAuditFindings,
    MAX_REMINDER_FINDINGS,
    type LabeledFinding,
} from "../../../src/modules/reminders/memory-audit";

/**
 * The automatic memory audit: keyed on a stat fingerprint of both trees, parsed only when that fingerprint
 * moved, and silent unless the finding set is news. Every case drives the real audit against a throwaway
 * project tree and a throwaway user tree, because the fingerprint and the parser are the two halves this
 * module exists to keep in step.
 */

const roots: string[] = [];
let projectRoot: string;
let agentDir: string;

async function makeRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

async function writeMemory(abs: string, text: string): Promise<void> {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, "utf8");
}

/** A memory whose frontmatter parses: indexed, short description, name matching the file. */
function validMemory(name: string, description = "A memory that parses."): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
}

/** A memory whose unquoted `: ` breaks the frontmatter: the audit's `frontmatter` error. */
function brokenMemory(name: string): string {
    return `---\nname: ${name}\ndescription: Contains a colon: which breaks YAML\n---\n\n# ${name}\n\nBody.\n`;
}

beforeEach(async () => {
    projectRoot = await makeRoot("pi-memory-audit-project-");
    agentDir = await makeRoot("pi-memory-audit-agent-");
    // The user tree resolves through pi's agent dir, so this keeps the real one out of the test.
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const projectMemory = (rel: string): string => join(projectRoot, ".pi", "agent", "memory", rel);
const userMemory = (rel: string): string => join(agentDir, "memory", rel);

function finding(overrides: Partial<LabeledFinding> = {}): LabeledFinding {
    return {
        severity: "warning",
        tree: "project",
        path: "a.md",
        rule: "reachability",
        message: "nested doc no index names",
        ...overrides,
    };
}

describe("automatic memory audit", () => {
    it("stays silent about what was already on disk when the session started", async () => {
        await writeMemory(projectMemory("a.md"), brokenMemory("a"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        // The broken memory predates the run: reporting it would open every session with the same finding.
        expect(await audit.check(projectRoot)).toBeUndefined();
    });

    it("skips the parse entirely while the trees are unchanged", async () => {
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        let parses = 0;
        const audit = createMemoryAuditTrigger({
            audit: async () => {
                parses += 1;
                return [];
            },
        });

        await audit.reseed(projectRoot);
        expect(await audit.check(projectRoot)).toBeUndefined();
        expect(await audit.check(projectRoot)).toBeUndefined();

        expect(parses).toBe(0);
    });

    it("reports a memory the edit left unparseable", async () => {
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        await writeMemory(projectMemory("a.md"), brokenMemory("a"));
        const text = await audit.check(projectRoot);

        expect(text).toBeDefined();
        expect(text).toContain("1 new error");
        expect(text).toContain("ERROR project/a.md [frontmatter]");
    });

    it("reports the user tree as well, labelled apart from the project tree", async () => {
        await writeMemory(userMemory("u.md"), validMemory("u"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        await writeMemory(userMemory("u.md"), brokenMemory("u"));
        const text = await audit.check(projectRoot);

        expect(text).toContain("ERROR user/u.md [frontmatter]");
    });

    it("sees a nested-only edit, which is what breaks an index link", async () => {
        await writeMemory(projectMemory("index.md"), validMemory("index"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        // The edit adds a nested doc and touches no top-level file. Because no index names it, the audit's
        // reachability warning is the finding a top-level-only fingerprint would have missed.
        await writeMemory(projectMemory("nested/doc.md"), validMemory("doc"));
        const text = await audit.check(projectRoot);

        expect(text).toContain("[reachability]");
        expect(text).toContain("project/nested/doc.md");
    });

    it("does not repeat a finding set the agent has already been told", async () => {
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        await writeMemory(projectMemory("a.md"), brokenMemory("a"));
        expect(await audit.check(projectRoot)).toContain("[frontmatter]");

        // Another memory edit that adds no finding: the trees moved, the news did not.
        await writeMemory(projectMemory("b.md"), validMemory("b"));
        expect(await audit.check(projectRoot)).toBeUndefined();
    });

    it("stays quiet while a failed repair only changes the parser's message", async () => {
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        await writeMemory(projectMemory("a.md"), brokenMemory("a"));
        expect(await audit.check(projectRoot)).toContain("[frontmatter]");

        // The file is still broken, and still broken the same way: file + rule is the identity, so a differently
        // worded YAML error is not a second thing to report.
        await writeMemory(
            projectMemory("a.md"),
            "---\nname: a\ndescription: Another unquoted colon: here\n---\n\n# a\n",
        );
        expect(await audit.check(projectRoot)).toBeUndefined();
    });

    it("reports only a newly broken memory, counting the earlier one as outstanding", async () => {
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        await writeMemory(projectMemory("b.md"), validMemory("b"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        await writeMemory(projectMemory("a.md"), brokenMemory("a"));
        expect(await audit.check(projectRoot)).toContain("project/a.md");

        await writeMemory(projectMemory("b.md"), brokenMemory("b"));
        const text = await audit.check(projectRoot);

        expect(text).toContain("project/b.md");
        expect(text).not.toContain("project/a.md");
        expect(text).toContain("1 previously reported finding is still present");
    });

    it("prunes a fixed finding, so breaking that memory again is news again", async () => {
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        await writeMemory(projectMemory("b.md"), validMemory("b"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        await writeMemory(projectMemory("a.md"), brokenMemory("a"));
        await writeMemory(projectMemory("b.md"), brokenMemory("b"));
        expect(await audit.check(projectRoot)).toContain("project/a.md");
        expect(await audit.check(projectRoot)).toBeUndefined();

        // Fixing one of two broken memories is an audit with no news, but it prunes that finding.
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        expect(await audit.check(projectRoot)).toBeUndefined();

        await writeMemory(projectMemory("a.md"), brokenMemory("a"));
        expect(await audit.check(projectRoot)).toContain("project/a.md");
    });

    it("reports the same finding again after a clean audit cleared it", async () => {
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        await writeMemory(projectMemory("a.md"), brokenMemory("a"));
        expect(await audit.check(projectRoot)).toContain("[frontmatter]");

        await writeMemory(projectMemory("a.md"), validMemory("a"));
        expect(await audit.check(projectRoot)).toBeUndefined();

        await writeMemory(projectMemory("a.md"), brokenMemory("a"));
        expect(await audit.check(projectRoot)).toContain("[frontmatter]");
    });

    it("does not report a warning the other tree has carried since before the run", async () => {
        // A pre-existing user-tree error is the trap: auditing both trees is right, but a project edit is not
        // evidence about it, so it must not ride along as this run's news.
        await writeMemory(userMemory("u.md"), brokenMemory("u"));
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        await writeMemory(projectMemory("b.md"), validMemory("b"));

        expect(await audit.check(projectRoot)).toBeUndefined();
    });

    it("drops the queue entry a restart invalidates", async () => {
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        const audit = createMemoryAuditTrigger();
        await audit.reseed(projectRoot);

        await writeMemory(projectMemory("a.md"), brokenMemory("a"));
        // A second reseed is the session the run now belongs to: its baseline is the broken tree, so the
        // finding is not this session's news.
        await audit.reseed(projectRoot);

        expect(await audit.check(projectRoot)).toBeUndefined();
    });

    it("never fails a step over a tree it cannot read", async () => {
        const audit = createMemoryAuditTrigger({
            fingerprint: async () => {
                throw new Error("permission denied");
            },
        });

        await expect(audit.reseed(projectRoot)).rejects.toThrow("permission denied");
        await expect(audit.check(projectRoot)).resolves.toBeUndefined();
    });

    it("is off when the setting says so", async () => {
        await writeMemory(projectMemory("a.md"), validMemory("a"));
        let parses = 0;
        const audit = createMemoryAuditTrigger({
            enabled: false,
            audit: async () => {
                parses += 1;
                return [];
            },
        });

        await audit.reseed(projectRoot);
        await writeMemory(projectMemory("a.md"), brokenMemory("a"));

        expect(await audit.check(projectRoot)).toBeUndefined();
        expect(parses).toBe(0);
    });
});

describe("memory audit reminder text", () => {
    it("leads with errors and names the tree each finding came from", () => {
        const text = formatMemoryAuditFindings([
            finding({ severity: "error", path: "z.md", rule: "frontmatter" }),
            finding({ tree: "user", path: "a.md" }),
        ]);

        expect(text).toContain("1 new error, 1 new warning");
        expect(text.indexOf("ERROR project/z.md")).toBeLessThan(text.indexOf("warn  user/a.md"));
    });

    it("caps the list and points at the tool for the rest", () => {
        const findings = Array.from({ length: MAX_REMINDER_FINDINGS + 2 }, (_unused, index) =>
            finding({ path: `m${index}.md` }),
        );

        const text = formatMemoryAuditFindings(findings);
        const listed = text.split("\n").filter((line) => line.startsWith("warn "));

        expect(listed).toHaveLength(MAX_REMINDER_FINDINGS);
        expect(text).toContain("…and 2 more findings; call the memory_audit tool");
    });

    it("says one error rather than 1 errors, and drops a zero count", () => {
        const text = formatMemoryAuditFindings([finding({ severity: "error" })]);

        expect(text).toContain("1 new error after the memory edits");
        expect(text).not.toContain("warning");
    });

    it("keeps the outstanding count separate from the lines it prints", () => {
        const text = formatMemoryAuditFindings([finding({ path: "new.md" })], 2);

        expect(text).toContain("warn  project/new.md");
        expect(text).toContain("…and 2 previously reported findings are still present");
    });
});
