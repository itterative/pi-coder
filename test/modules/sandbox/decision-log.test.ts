import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import sandboxConfig from "../../../src/common/config";
import { BASH_DECISION_LOG_PATH, PI_CODER_STATE_DIR } from "../../../src/common/constants";
import {
    getDecisionLogConfig,
    logBashDecision,
    type BashDecisionRecord,
} from "../../../src/modules/sandbox/decision-log";
import {
    resolvePermissionDetails,
    unresolvedPermissionDetails,
} from "../../../src/modules/sandbox/resolve";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

let cwd: string;
let logPath: string;

/** Write a project-local sandbox config and make it the loaded configuration. */
function useConfig(decisionLog: Record<string, unknown> | undefined): void {
    const configDirectory = path.join(cwd, ".pi");
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(configDirectory, "bash-sandbox-config.json"),
        JSON.stringify({
            sandbox: { enabled: true },
            permissions: {},
            ...(decisionLog ? { decisionLog } : {}),
        }),
    );
    sandboxConfig.load(cwd);
}

function readRecords(): BashDecisionRecord[] {
    if (!fs.existsSync(logPath)) {
        return [];
    }

    return fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as BashDecisionRecord);
}

beforeEach(() => {
    cwd = makeTemporaryDirectory("pi-decision-log-");
    logPath = path.join(makeTemporaryDirectory("pi-decision-log-home-"), "decisions.jsonl");
    vi.stubEnv("SANDBOX_DECISION_LOG_PATH", logPath);
    vi.stubEnv("SANDBOX_DECISION_LOG", "1");
    useConfig(undefined);
});

afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("getDecisionLogConfig", () => {
    it("defaults to enabled at the environment or config path", () => {
        const config = getDecisionLogConfig();
        expect(config.enabled).toBe(true);
        expect(config.filePath).toBe(logPath);
        expect(config.maxBytes).toBeGreaterThan(0);
    });

    it("falls back to gitignored extension state when nothing chooses a path", () => {
        vi.stubEnv("SANDBOX_DECISION_LOG_PATH", "");
        useConfig(undefined);

        // The default must stay inside `.state/`, never the repository tree or the
        // user's pi config directory.
        expect(getDecisionLogConfig().filePath).toBe(BASH_DECISION_LOG_PATH);
        expect(path.dirname(BASH_DECISION_LOG_PATH)).toBe(PI_CODER_STATE_DIR);
    });

    it("lets the environment switch override an enabled config", () => {
        useConfig({ enabled: true });
        vi.stubEnv("SANDBOX_DECISION_LOG", "off");
        expect(getDecisionLogConfig().enabled).toBe(false);
    });

    it("falls back to config when the environment does not choose", () => {
        vi.stubEnv("SANDBOX_DECISION_LOG", "");
        vi.stubEnv("SANDBOX_DECISION_LOG_PATH", "");
        const configured = path.join(cwd, "configured.jsonl");
        useConfig({ enabled: false, path: configured });

        const config = getDecisionLogConfig();
        expect(config.enabled).toBe(false);
        expect(config.filePath).toBe(configured);
    });
});

describe("logBashDecision", () => {
    it("records a heuristic grant with its per-segment source", () => {
        const command = "cat notes.txt";
        const details = resolvePermissionDetails(command, cwd, {
            permissions: {},
            cwdConfinement: {},
        });
        expect(details.source).toBe("heuristic");

        logBashDecision({
            surface: "parent",
            cwd,
            command,
            details,
            decision: "allow:sandbox",
            sandboxed: true,
            blocked: false,
        });

        const [record] = readRecords();
        expect(record).toBeDefined();
        expect(record.v).toBe(1);
        expect(Number.isNaN(Date.parse(record.ts))).toBe(false);
        expect(record.surface).toBe("parent");
        expect(record.agent).toBeUndefined();
        expect(record.command).toBe(command);
        expect(record.decision).toBe("allow:sandbox");
        expect(record.blocked).toBe(false);
        expect(record.prompt).toBeUndefined();
        expect(record.resolution.permission).toBe("allow:sandbox");
        expect(record.resolution.source).toBe("heuristic");
        expect(record.resolution.pattern).toBeNull();
        expect(record.resolution.segments).toEqual([
            {
                tokens: ["cat", "notes.txt"],
                source: "heuristic",
                permission: "allow:sandbox",
                pattern: null,
                coveredBy: null,
            },
        ]);
    });

    it("records the prompt outcome, suggestion, remembered rule, and note", () => {
        const command = "npx vitest run";
        const details = resolvePermissionDetails(command, cwd, {
            permissions: {},
            cwdConfinement: {},
        });

        logBashDecision({
            surface: "child",
            agentName: "worker",
            cwd,
            command,
            details,
            prompt: { outcome: "remember", suggestion: "npx vitest run", rule: "npx vitest run" },
            decision: "allow:sandbox",
            sandboxed: true,
            blocked: false,
            note: "focused run is fine",
        });

        const [record] = readRecords();
        expect(record.surface).toBe("child");
        expect(record.agent).toBe("worker");
        expect(record.prompt).toEqual({
            outcome: "remember",
            suggestion: "npx vitest run",
            rule: "npx vitest run",
        });
        expect(record.note).toBe("focused run is fine");
        expect(record.resolution.segments[0]?.source).toBe("unresolved");
        expect(record.resolution.segments[0]?.permission).toBeUndefined();
    });

    it("records an explicit denial from a configured rule", () => {
        const details = resolvePermissionDetails("rm -rf /", cwd, {
            permissions: { "rm *": "deny" },
            cwdConfinement: {},
        });

        logBashDecision({
            surface: "parent",
            cwd,
            command: "rm -rf /",
            details,
            decision: "deny",
            sandboxed: false,
            blocked: true,
        });

        const [record] = readRecords();
        expect(record.resolution.permission).toBe("deny");
        expect(record.resolution.pattern).toBe("rm *");
        expect(record.decision).toBe("deny");
        expect(record.blocked).toBe(true);
    });

    it("records the unresolved details of an unparsable command", () => {
        const details = unresolvedPermissionDetails();

        logBashDecision({
            surface: "parent",
            cwd,
            command: "echo $(unterminated",
            details,
            prompt: { outcome: "dismissed" },
            decision: "deny",
            sandboxed: false,
            blocked: true,
        });

        const [record] = readRecords();
        expect(record.resolution.source).toBe("unresolved");
        expect(record.resolution.segments).toEqual([]);
        expect(record.prompt).toEqual({ outcome: "dismissed" });
    });

    it("appends one line per decision", () => {
        const details = resolvePermissionDetails("ls", cwd, {
            permissions: {},
            cwdConfinement: {},
        });
        for (const command of ["ls", "ls -la"]) {
            logBashDecision({
                surface: "parent",
                cwd,
                command,
                details,
                decision: "allow:sandbox",
                sandboxed: true,
                blocked: false,
            });
        }

        expect(fs.readFileSync(logPath, "utf8").trimEnd().split("\n")).toHaveLength(2);
    });

    it("does not write when disabled by the environment switch", () => {
        vi.stubEnv("SANDBOX_DECISION_LOG", "0");
        logBashDecision({
            surface: "parent",
            cwd,
            command: "ls",
            details: unresolvedPermissionDetails(),
            decision: "allow",
            sandboxed: false,
            blocked: false,
        });

        expect(readRecords()).toEqual([]);
    });

    it("honours config enablement when the environment stays silent", () => {
        vi.stubEnv("SANDBOX_DECISION_LOG", "");
        useConfig({ enabled: false });

        logBashDecision({
            surface: "parent",
            cwd,
            command: "ls",
            details: unresolvedPermissionDetails(),
            decision: "allow",
            sandboxed: false,
            blocked: false,
        });
        expect(readRecords()).toEqual([]);

        useConfig({ enabled: true });
        logBashDecision({
            surface: "parent",
            cwd,
            command: "ls",
            details: unresolvedPermissionDetails(),
            decision: "allow",
            sandboxed: false,
            blocked: false,
        });
        expect(readRecords()).toHaveLength(1);
    });

    it("rotates the log to a single previous generation past the cap", () => {
        useConfig({ enabled: true, maxBytes: 200 });
        fs.writeFileSync(logPath, `${"x".repeat(400)}\n`);

        logBashDecision({
            surface: "parent",
            cwd,
            command: "ls",
            details: unresolvedPermissionDetails(),
            decision: "allow",
            sandboxed: false,
            blocked: false,
        });

        expect(fs.readFileSync(`${logPath}.1`, "utf8")).toContain("xxxx");
        expect(readRecords()).toHaveLength(1);
    });

    it("swallows writer failures", () => {
        // A regular file where a parent directory is required fails mkdir fast
        // (ENOTDIR) without touching anything outside the temporary directory.
        const blocker = path.join(cwd, "blocker");
        fs.writeFileSync(blocker, "not a directory\n");
        vi.stubEnv("SANDBOX_DECISION_LOG_PATH", path.join(blocker, "decisions.jsonl"));

        expect(() =>
            logBashDecision({
                surface: "parent",
                cwd,
                command: "ls",
                details: unresolvedPermissionDetails(),
                decision: "allow",
                sandboxed: false,
                blocked: false,
            }),
        ).not.toThrow();
    });
});
