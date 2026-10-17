import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProbeCommand } from "../../../src/modules/sandbox/bubblewrap";
import { probeCommand, scanOverlay } from "../../../src/modules/sandbox/probe";
import type { SandboxConfig } from "../../../src/common/config";

/**
 * The resolved shape with no configured mounts and no permission rules. Passing it explicitly keeps a test
 * from picking up the developer's own sandbox config.
 */
const NO_USER_CONFIG: SandboxConfig = { sandbox: { mounts: {} }, permissions: {} };

function hasBwrap(): boolean {
    try {
        execFileSync("bwrap", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/** Probing spawns bwrap and mounts an overlay, so it is only meaningful on a real Linux host. */
const canProbe = process.platform === "linux" && hasBwrap();

function write(root: string, relative: string, content: string): void {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

describe("probe command line", () => {
    const line = buildProbeCommand("rm -rf build", {
        cwd: "/repo",
        upper: "/scratch/upper",
        work: "/scratch/work",
        statusFd: 3,
        config: NO_USER_CONFIG,
        env: { SHELL: "/bin/bash", HOME: "/home/user", PATH: "/usr/bin" },
    });

    it("observes the workspace through an overlay instead of binding it writable", () => {
        expect(line).toContain("--overlay-src '/repo'");
        expect(line).toContain("--overlay '/scratch/upper' '/scratch/work' '/repo'");
        expect(line).not.toContain("--bind '/repo' '/repo'");
    });

    it("gives the sandbox its own /tmp and mounts nothing else writable", () => {
        expect(line).toContain("--tmpfs /tmp");
        expect(line).not.toMatch(/(^|\s)--bind /);
        expect(line).not.toContain("--dev-bind");
    });

    it("unshares the network and reports status on the descriptor the caller reads", () => {
        expect(line).toContain("--unshare-all");
        expect(line).toContain("--die-with-parent");
        expect(line).toContain("--json-status-fd 3");
    });
});

describe("probe overlay scanning", () => {
    let root: string;
    let upper: string;
    let lower: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-scan-"));
        upper = path.join(root, "upper");
        lower = path.join(root, "lower");
        fs.mkdirSync(upper);
        fs.mkdirSync(lower);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("reports an untouched overlay as empty", () => {
        expect(scanOverlay(upper, lower)).toEqual({ changes: [], truncated: false });
    });

    it("reports a file that only the overlay has as created", () => {
        write(upper, "added.txt", "12345");

        expect(scanOverlay(upper, lower).changes).toEqual([
            { path: "added.txt", kind: "created", beforeBytes: null, afterBytes: 5 },
        ]);
    });

    it("reports a rewritten file with both byte counts", () => {
        write(lower, "doc.md", "0123456789");
        write(upper, "doc.md", "0123");

        expect(scanOverlay(upper, lower).changes).toEqual([
            { path: "doc.md", kind: "modified", beforeBytes: 10, afterBytes: 4 },
        ]);
    });

    it("orders rewrites by how much they lost", () => {
        write(lower, "small.md", "0123456789");
        write(upper, "small.md", "012345678");
        write(lower, "big.md", "0123456789");
        write(upper, "big.md", "01");

        expect(scanOverlay(upper, lower).changes.map((change) => change.path)).toEqual([
            "big.md",
            "small.md",
        ]);
    });

    it("walks nested directories", () => {
        write(upper, "a/b/deep.txt", "x");

        expect(scanOverlay(upper, lower).changes.map((change) => change.path)).toEqual([
            "a/b/deep.txt",
        ]);
    });

    it("stops at the configured maximum and reports the truncation", () => {
        for (let index = 0; index < 5; index += 1) {
            write(upper, `file-${index}.txt`, "x");
        }

        const scanned = scanOverlay(upper, lower, 2);

        expect(scanned.changes).toHaveLength(2);
        expect(scanned.truncated).toBe(true);
    });

    it("reports an unavailable probe when the workspace is not a directory", async () => {
        const result = await probeCommand({
            command: "ls",
            cwd: path.join(root, "missing"),
            config: NO_USER_CONFIG,
        });

        expect(result.status).toBe("unavailable");
        expect(result.reason).toContain("not a directory");
        expect(result.changes).toEqual([]);
    });
});

describe.skipIf(!canProbe)("probing a command", () => {
    let workspace: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-workspace-"));
        write(workspace, "keep.txt", "hello\n");
        write(workspace, "long.md", "content line\n".repeat(100));
        write(workspace, "doomed.txt", "delete me\n");
        write(workspace, "sub/nested.txt", "nested\n");
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    function probe(command: string, timeoutMs?: number) {
        return probeCommand({
            command,
            cwd: workspace,
            config: NO_USER_CONFIG,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
    }

    it("reports no changes for a command that only reads", async () => {
        const result = await probe("ls -la && cat keep.txt > /dev/null");

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.changes).toEqual([]);
    });

    it("reports modifications, deletions, and creations, and leaves the real tree alone", async () => {
        const result = await probe(
            "echo replaced > keep.txt && rm doomed.txt && echo fresh > sub/new.txt",
        );

        expect(result.status).toBe("completed");
        expect(result.changes).toEqual([
            { path: "doomed.txt", kind: "deleted", beforeBytes: 10, afterBytes: null },
            { path: "keep.txt", kind: "modified", beforeBytes: 6, afterBytes: 9 },
            { path: "sub/new.txt", kind: "created", beforeBytes: null, afterBytes: 6 },
        ]);

        expect(fs.readFileSync(path.join(workspace, "keep.txt"), "utf8")).toBe("hello\n");
        expect(fs.existsSync(path.join(workspace, "doomed.txt"))).toBe(true);
        expect(fs.existsSync(path.join(workspace, "sub", "new.txt"))).toBe(false);
    });

    it("reports how much an in-place rewrite threw away", async () => {
        const result = await probe("truncate -s 100 long.md");

        expect(result.status).toBe("completed");
        expect(result.changes).toEqual([
            { path: "long.md", kind: "modified", beforeBytes: 1300, afterBytes: 100 },
        ]);
        expect(fs.statSync(path.join(workspace, "long.md")).size).toBe(1300);
    });

    it("keeps the reading of a command that failed partway", async () => {
        const result = await probe("echo partial > keep.txt; exit 3");

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(3);
        expect(result.changes).toEqual([
            { path: "keep.txt", kind: "modified", beforeBytes: 6, afterBytes: 8 },
        ]);
    });

    it("reports a timeout instead of an empty reading", async () => {
        const result = await probe("sleep 30", 300);

        expect(result.status).toBe("timeout");
        expect(result.reason).toContain("300ms");
        expect(result.changes).toEqual([]);
    });

    it("cannot change anything outside the workspace", async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-outside-"));
        const target = path.join(outside, "escaped.txt");

        try {
            const result = await probe(`echo escaped > ${target}`);

            expect(result.status).toBe("completed");
            expect(fs.existsSync(target)).toBe(false);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it("removes everything it wrote to its scratch root", async () => {
        const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-scratch-"));

        try {
            const result = await probeCommand({
                command: "echo written > keep.txt",
                cwd: workspace,
                config: NO_USER_CONFIG,
                scratchRoot,
            });

            expect(result.status).toBe("completed");
            expect(fs.readdirSync(scratchRoot)).toEqual([]);
        } finally {
            fs.rmSync(scratchRoot, { recursive: true, force: true });
        }
    });
});
