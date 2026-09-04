import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import sandboxConfig from "../../src/common/config";
import { PI_CODER_EXTENSION_DIR } from "../../src/common/constants";
import { logBashDecision, type BashDecisionInput } from "../../src/modules/sandbox/decision-log";
import {
    resolvePermissionDetails,
    unresolvedPermissionDetails,
    type ResolvePermissionDetails,
} from "../../src/modules/sandbox/resolve";

const SCRIPT = path.join(PI_CODER_EXTENSION_DIR, "scripts", "permission-report.mjs");

interface ReportJson {
    total: number;
    gapView: "records" | "segments";
    prompted: number;
    blocked: number;
    promptedApproved: Record<
        string,
        { count: number; examples: string[]; rules: Record<string, number> }
    >;
    promptedDenied: Record<string, { count: number; notes: string[] }>;
    heuristicGrants: Record<string, { count: number }>;
    unasked: Record<string, { count: number; agents: string[] }>;
    ruleHits: Record<string, number>;
}

interface ScriptResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

const temporaryDirectories: string[] = [];
let workspace: string;
let logPath: string;

type RecordOverrides = Partial<Omit<BashDecisionInput, "command">>;

/** Write a real record through the production writer, so the fixture cannot drift. */
function record(command: string, overrides: RecordOverrides = {}): void {
    // `workspace` is a real directory, so the cwd-confinement heuristic can grant.
    const details: ResolvePermissionDetails =
        overrides.details ??
        resolvePermissionDetails(command, workspace, { permissions: {}, cwdConfinement: {} });

    logBashDecision({
        surface: "parent",
        cwd: workspace,
        command,
        details,
        decision: "allow:sandbox",
        sandboxed: true,
        blocked: false,
        ...overrides,
    });
}

function runScript(args: string[], file: string = logPath): ScriptResult {
    const result = spawnSync(process.execPath, [SCRIPT, "--path", file, ...args], {
        encoding: "utf8",
    });

    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

function runReport(args: string[] = []): ReportJson {
    const result = runScript([...args, "--json"]);
    expect(result.status, result.stderr).toBe(0);

    return JSON.parse(result.stdout) as ReportJson;
}

beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-report-"));
    temporaryDirectories.push(workspace);
    logPath = path.join(workspace, "decisions.jsonl");
    fs.writeFileSync(path.join(workspace, "README.md"), "# fixture\n");

    // A project-local config keeps the suite independent of the developer's own
    // global sandbox configuration.
    fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    fs.writeFileSync(
        path.join(workspace, ".pi", "bash-sandbox-config.json"),
        JSON.stringify({
            sandbox: { enabled: true },
            permissions: {},
            decisionLog: { enabled: true },
        }),
    );
    sandboxConfig.load(workspace);

    vi.stubEnv("SANDBOX_DECISION_LOG", "1");
    vi.stubEnv("SANDBOX_DECISION_LOG_PATH", logPath);
});

afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("permission-report script", () => {
    it("groups decisions by how they were resolved", () => {
        // Repeated approvals of the same shape must collapse into one candidate.
        record("npx vitest run", { prompt: { outcome: "yes", suggestion: "npx vitest run" } });
        record("npx vitest run src/index.ts", {
            prompt: { outcome: "remember", suggestion: "npx vitest run", rule: "npx vitest run" },
        });
        record("kubectl delete pod nginx", {
            prompt: { outcome: "no" },
            decision: "deny",
            sandboxed: false,
            blocked: true,
            note: "never mutate the cluster from an agent",
        });
        record("cat README.md");
        record("terraform plan", {
            surface: "child",
            agentName: "scout",
            decision: "deny",
            sandboxed: false,
            blocked: true,
        });

        const report = runReport();
        expect(report.total).toBe(5);
        expect(report.prompted).toBe(3);
        expect(report.blocked).toBe(2);

        expect(Object.keys(report.promptedApproved)).toEqual(["npx vitest run"]);
        expect(report.promptedApproved["npx vitest run"].count).toBe(2);
        expect(report.promptedApproved["npx vitest run"].examples).toHaveLength(2);
        expect(report.promptedApproved["npx vitest run"].rules).toEqual({ "npx vitest run": 1 });

        expect(Object.keys(report.promptedDenied)).toEqual(["kubectl delete pod"]);
        expect(report.promptedDenied["kubectl delete pod"].notes).toEqual([
            "never mutate the cluster from an agent",
        ]);

        // File arguments collapse into the shape key, so every confined `cat` groups together.
        expect(report.heuristicGrants["cat <file>"].count).toBe(1);
        expect(report.unasked["terraform plan"].count).toBe(1);
        expect(report.unasked["terraform plan"].agents).toEqual(["scout"]);
    });

    it("keeps every uncovered segment visible in one candidate row", () => {
        // A formatter behind a heredoc used to disappear into the first gap's group.
        record("npx vitest run && npx prettier --check README.md", {
            prompt: { outcome: "yes", suggestion: "npx vitest run" },
        });
        record("npx vitest run", { prompt: { outcome: "yes" } });

        const report = runReport();
        expect(report.gapView).toBe("records");
        expect(Object.keys(report.promptedApproved)).toEqual([
            "npx vitest run + npx prettier --check",
            "npx vitest run",
        ]);

        // --all-gaps counts each uncovered segment on its own row, so the second
        // segment of the chained line is comparable with the bare one.
        const exploded = runReport(["--all-gaps"]);
        expect(exploded.gapView).toBe("segments");
        expect(exploded.promptedApproved["npx vitest run"].count).toBe(2);
        expect(exploded.promptedApproved["npx prettier --check"].count).toBe(1);
    });

    it("removes shell control-flow words from candidate keys", () => {
        record("for n in 1 2; do echo $n; done", { prompt: { outcome: "yes" } });
        record("if [ -f README.md ]; then echo yes; fi", { prompt: { outcome: "yes" } });

        // `do`/`then` name the body command, and a bare `done`/`fi` carries nothing,
        // so neither may stand in for the command a human actually approved.
        const report = runReport();
        expect(Object.keys(report.promptedApproved)).toEqual([
            "for n in + echo $n",
            "if [ -f + echo yes",
        ]);
    });

    it("counts configured rule hits with the permission they granted", () => {
        const details = resolvePermissionDetails("make build", workspace, {
            permissions: { "make *": "allow" },
            cwdConfinement: {},
        });
        expect(details.pattern).toBe("make *");

        record("make build", { details, decision: "allow", sandboxed: false });

        expect(runReport().ruleHits).toEqual({ "make *\tallow": 1 });
    });

    it("honours --since by dropping older records", () => {
        record("npx vitest run", { prompt: { outcome: "yes" } });
        const stale = {
            v: 1,
            ts: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
            surface: "parent",
            cwd: workspace,
            command: "old-tool run",
            resolution: { permission: "ask", source: "unresolved", pattern: null, segments: [] },
            prompt: { outcome: "yes" },
            decision: "allow",
            sandboxed: false,
            blocked: false,
        };
        fs.appendFileSync(logPath, `${JSON.stringify(stale)}\n`);

        expect(runReport().total).toBe(2);
        expect(runReport(["--since", "7d"]).total).toBe(1);
    });

    it("filters by surface and reports unparsable lines on stderr", () => {
        record("aws s3 ls", {
            surface: "child",
            agentName: "worker",
            details: unresolvedPermissionDetails(),
            prompt: { outcome: "no" },
            decision: "deny",
            sandboxed: false,
            blocked: true,
        });
        record("cat README.md");
        fs.appendFileSync(logPath, "{ not json\n");

        const result = runScript(["--surface", "child", "--json"]);
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("skipping unparsable line");

        const report = JSON.parse(result.stdout) as ReportJson;
        expect(report.total).toBe(1);
        expect(Object.keys(report.promptedDenied)).toEqual(["aws s3 ls"]);
    });

    it("fails naming the missing log", () => {
        const result = runScript(["--json"], path.join(workspace, "absent.jsonl"));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("no decision log found");
    });

    it("rejects an unknown argument", () => {
        const result = spawnSync(process.execPath, [SCRIPT, "--nonsense"], { encoding: "utf8" });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("unknown argument");
    });
});
