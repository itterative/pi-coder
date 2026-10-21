import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import registerMemoryExtension from "../../../src/modules/memory";
import { compactionMarker, customEntry } from "../../helpers/compaction-doubles";
import { createPiStub, stubContext, stubSessionManager, type PiStub } from "../../helpers/pi-stub";

const MEMORY_INDEX_TYPE = "pi-memory:memory-index";

let root: string;
let projectCwd: string;
let projectDir: string;
let userDir: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-memory-index-"));
    // getUserMemoryDirectory reads os.homedir() at call time, so the temp home is what a test session sees.
    vi.stubEnv("HOME", root);
    projectCwd = join(root, "project");
    projectDir = join(projectCwd, ".pi", "agent", "memory");
    userDir = join(root, ".pi", "agent", "memory");
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
});

function harness(): PiStub {
    const stub = createPiStub();
    registerMemoryExtension(stub.pi);
    return stub;
}

/**
 * `getEntries` deliberately answers with every entry in the file while `getBranch` answers with the active
 * path, so a suite where the two disagree fails if the lookup drifts back to the file-wide scan.
 */
function context(branch: SessionEntry[], fileEntries: SessionEntry[] = branch): ExtensionContext {
    return stubContext({
        cwd: projectCwd,
        sessionManager: stubSessionManager({
            getBranch: () => branch,
            getEntries: () => fileEntries,
        }),
    });
}

async function writeMemory(name: string, description: string): Promise<void> {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
        join(projectDir, `${name}.md`),
        `---\nname: ${name}\ndescription: ${description}\ncategory: workflow\n---\n\n# ${name}\n`,
    );
}

function indexEntry(id: string, name: string, description: string): SessionEntry {
    return customEntry(id, MEMORY_INDEX_TYPE, {
        projectDir,
        userDir,
        projectMemories: [{ name, description, category: "workflow" }],
        userMemories: [],
    });
}

function appendedData(stub: PiStub, index: number): unknown {
    const entry = stub.entries[index];
    if (!entry) {
        throw new Error(`pi stub: no appended entry at index ${index}`);
    }

    return entry.data;
}

async function startSession(stub: PiStub, ctx: ExtensionContext): Promise<void> {
    await stub.requireHandler("session_start")({ reason: "startup" }, ctx);
}

async function promptAfterRun(stub: PiStub, ctx: ExtensionContext): Promise<string> {
    const result = (await stub.requireHandler("before_agent_start")(
        { systemPrompt: "<project_context>\nProject\n</project_context>" },
        ctx,
    )) as { systemPrompt: string };

    return result.systemPrompt;
}

describe("memory index snapshot lifecycle", () => {
    it("reads both trees at session start and records the snapshot", async () => {
        await writeMemory("first", "first memory");
        const stub = harness();
        const ctx = context([]);

        await startSession(stub, ctx);

        expect(await promptAfterRun(stub, ctx)).toContain("first memory");
        expect(stub.entries).toHaveLength(1);
        expect(stub.entries[0]?.customType).toBe(MEMORY_INDEX_TYPE);
        expect((stub.entries[0]?.data as { projectDir: string }).projectDir).toBe(projectDir);
    });

    it("rebuilds the index after a compaction and records a new snapshot", async () => {
        await writeMemory("first", "first memory");
        const stub = harness();
        const ctx = context([]);
        await startSession(stub, ctx);

        await writeMemory("second", "second memory");
        await stub.requireHandler("session_compact")({ reason: "manual" }, ctx);

        expect(await promptAfterRun(stub, ctx)).toContain("second memory");
        expect(stub.entries).toHaveLength(2);
    });

    it("restores the branch snapshot, not the last entry in the session file", async () => {
        const branch = [indexEntry("a1", "branch-memory", "from the branch")];
        const fileEntries = [
            ...branch,
            compactionMarker("f1", { at: "2026-01-01T00:00:01.000Z", firstKeptEntryId: "a1" }),
            indexEntry("b1", "post-fold", "after the fold"),
        ];
        const stub = harness();
        const ctx = context(branch, fileEntries);

        await startSession(stub, ctx);

        const prompt = await promptAfterRun(stub, ctx);
        expect(prompt).toContain("from the branch");
        expect(prompt).not.toContain("after the fold");
        expect(stub.entries).toHaveLength(0);
    });

    it("rescans when the branch's only snapshot predates a compaction", async () => {
        await writeMemory("fresh", "from disk");
        const branch = [
            indexEntry("a1", "stale-memory", "from before the fold"),
            compactionMarker("f1", { at: "2026-01-01T00:00:01.000Z", firstKeptEntryId: "a1" }),
        ];
        const stub = harness();
        const ctx = context(branch);

        await startSession(stub, ctx);

        const prompt = await promptAfterRun(stub, ctx);
        expect(prompt).toContain("from disk");
        expect(prompt).not.toContain("from before the fold");
        expect(stub.entries).toHaveLength(1);
    });

    it("restores the pre-compaction snapshot when navigating back before the fold", async () => {
        await writeMemory("first", "first memory");
        const stub = harness();
        const branch: SessionEntry[] = [];
        const ctx = context(branch);
        await startSession(stub, ctx);
        branch.push(customEntry("a1", MEMORY_INDEX_TYPE, appendedData(stub, 0)));

        await writeMemory("second", "second memory");
        await stub.requireHandler("session_compact")({ reason: "manual" }, ctx);
        branch.push(customEntry("b1", MEMORY_INDEX_TYPE, appendedData(stub, 1)));
        expect(await promptAfterRun(stub, ctx)).toContain("second memory");

        // Navigate to a point before the fold: the post-compaction snapshot is not an ancestor.
        branch.length = 1;
        await stub.requireHandler("session_tree")({ newLeafId: "a1", oldLeafId: "b1" }, ctx);

        const prompt = await promptAfterRun(stub, ctx);
        expect(prompt).toContain("first memory");
        expect(prompt).not.toContain("second memory");
        expect(stub.entries).toHaveLength(2);
    });

    it("rescans without recording snapshots when the session cache is disabled", async () => {
        vi.stubEnv("PI_MEMORY_SESSION_CACHE", "false");
        await writeMemory("first", "first memory");
        const stub = harness();
        const ctx = context([]);
        await startSession(stub, ctx);

        await writeMemory("second", "second memory");
        await stub.requireHandler("session_compact")({ reason: "manual" }, ctx);

        expect(await promptAfterRun(stub, ctx)).toContain("second memory");
        expect(stub.entries).toHaveLength(0);
    });
});
