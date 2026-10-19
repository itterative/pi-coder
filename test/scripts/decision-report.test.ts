import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PI_CODER_EXTENSION_DIR } from "../../src/common/constants";
import { createJsonlRecordLog } from "../../src/common/record-log";
import {
    logBashDecision,
    logFileAccessDecision,
    type BashClassifierRecord,
    type BashDecisionInput,
    type BashDecisionRecord,
    type FileAccessDecisionInput,
} from "../../src/modules/sandbox/decision-log";
import { UnsafeReason } from "../../src/modules/sandbox/heuristics";
import { unresolvedPermissionDetails } from "../../src/modules/sandbox/resolve";
import {
    bundleScript,
    type BundledScript,
    type BundledScriptResult,
} from "../helpers/script-bundle";

const SCRIPT = path.join(PI_CODER_EXTENSION_DIR, "scripts", "decision-report.ts");

/** The flattened per-row shape the script emits under `rows`. */
interface ReportRow {
    ts: string;
    /** which gate wrote the record: a file access carries no command at all */
    gate: "bash" | "file";
    surface: string;
    /** absent on a file-access row, whose target is `path` with `operation` */
    command?: string;
    operation?: "read" | "write";
    path?: string;
    /** the folder a human's "always allow" would have covered */
    folder?: string;
    strategy: string;
    provider?: string;
    model?: string;
    criterion?: string;
    action?: string;
    confidence?: number;
    outcome: string;
    status: string;
    reason: string;
    latencyMs: number;
    applied: boolean;
    tokens?: BashClassifierRecord["tokens"];
    /** `record.prompt?.outcome`, absent when no human was asked. */
    human?: string;
    decision: string;
    /** a Bash-only mode: a file access is neither sandboxed nor run direct */
    sandboxed?: boolean;
}

interface ReportJson {
    files: string[];
    total: number;
    malformed: number;
    consulted: number;
    applied: number;
    abstained: number;
    failed: number;
    bySubject: Record<string, number>;
    /** the file gates on their own, kept apart because they are judged on different criteria */
    file: { consulted: number; resolved: number; meanConfidence: number };
    byAction: Record<string, number>;
    byCriterion: Record<string, number>;
    byOutcome: Record<string, number>;
    humanDecision: Record<string, number>;
    humanSandboxed: number;
    meanLatencyMs: number;
    maxLatencyMs: number;
    inputTokens: number;
    outputTokens: number;
    scriptFiles: ScriptFileJson[];
    rows: ReportRow[];
}

interface ScriptFileJson {
    source: string;
    consults: number;
    confidences: number[];
    newestTs: string;
    newestCommand: string;
}

let script: BundledScript;
let workspace: string;
let logPath: string;
const temporaryDirectories: string[] = [];

type RecordOverrides = Partial<Omit<BashDecisionInput, "command" | "cwd" | "details">>;

type AccessOverrides = Partial<Omit<FileAccessDecisionInput, "cwd">>;

/** Write through the production writer, so a fixture cannot drift from the record schema. */
function record(command: string, overrides: RecordOverrides = {}): void {
    logBashDecision({
        surface: "parent",
        cwd: workspace,
        command,
        details: unresolvedPermissionDetails(),
        decision: "allow",
        sandboxed: false,
        blocked: false,
        ...overrides,
    });
}

/** A complete model verdict, so each case only states the fields it is actually about. */
function verdict(overrides: Partial<BashClassifierRecord> = {}): BashClassifierRecord {
    return {
        strategy: "veto",
        provider: "llama-local",
        model: "test-model",
        criterion: "none",
        action: "host",
        confidence: 0.9,
        outcome: "host",
        status: "applied",
        reason: "criterion resolved the prompt",
        latencyMs: 120,
        applied: true,
        tokens: { input: 100, output: 10, total: 110 },
        ...overrides,
    };
}

/**
 * One applied verdict, one abstained verdict the human approved into the sandbox, one timeout, and one record
 * with no classifier at all, so `consulted` and `total` cannot agree by accident.
 */
function writeCanonicalFixture(): void {
    record("git status", { classifier: verdict() });

    record("rm -rf build", {
        prompt: { outcome: "yes" },
        decision: "allow:sandbox",
        sandboxed: true,
        classifier: verdict({
            criterion: "destructive",
            action: "refuse",
            confidence: 0.42,
            outcome: "abstain",
            status: "abstained",
            reason: "policy withheld the verdict",
            latencyMs: 200,
            applied: false,
            tokens: { input: 50, output: 5, total: 55 },
        }),
    });

    // The request failed before the model answered, so it names neither criterion nor action.
    record("curl https://example.test/data", {
        classifier: {
            strategy: "classify",
            provider: "remote",
            model: "small-model",
            outcome: "abstain",
            status: "timeout",
            reason: "request timed out",
            latencyMs: 300,
            applied: false,
        },
    });

    record("cat README.md");
}

/**
 * Move the newest record's clock back. The production writer always stamps "now", so this record still comes
 * from the writer; only its `ts` is moved, which is exactly the drift `--since` has to survive.
 */
function ageLastRecord(ageMs: number): void {
    const log = createJsonlRecordLog<BashDecisionRecord>({
        filePath: logPath,
        maxBytes: 0,
        generations: 0,
    });
    const records = log.read();
    const last = records.at(-1);
    if (last === undefined) {
        throw new Error("cannot age an empty decision log");
    }

    last.ts = new Date(Date.now() - ageMs).toISOString();
    writeFileSync(logPath, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function runScript(args: string[], file: string = logPath): BundledScriptResult {
    return script.run(["--path", file, ...args]);
}

/** Text mode must succeed silently, so any stderr here is a real bug rather than a skip note. */
function runText(args: string[] = []): BundledScriptResult {
    const result = runScript(args);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");

    return result;
}

function runJson(args: string[] = []): ReportJson {
    const result = runText([...args, "--json"]);

    return JSON.parse(result.stdout) as ReportJson;
}

function requireRow(report: ReportJson, command: string): ReportRow {
    const row = report.rows.find((candidate) => candidate.command === command);
    if (row === undefined) {
        throw new Error(`no report row for command: ${command}`);
    }

    return row;
}

/**
 * One direct file access outside every trusted root, through the production writer.
 *
 * Both gates append to the same file, so the mixed log is the real input shape and not a hypothetical.
 */
function access(overrides: AccessOverrides = {}): void {
    logFileAccessDecision({
        surface: "parent",
        cwd: workspace,
        operation: "read",
        path: "/home/user/.pi/agent/settings.json",
        folder: "/home/user/.pi/agent",
        reasons: [UnsafeReason.OUTSIDE_CWD],
        resolvedBy: "classifier",
        decision: "allow",
        blocked: false,
        classifier: verdict({ strategy: "file-access", criterion: "asked_for", confidence: 0.72 }),
        ...overrides,
    });
}

function requireFileRow(report: ReportJson, filePath: string): ReportRow {
    const row = report.rows.find((candidate) => candidate.path === filePath);
    if (row === undefined) {
        throw new Error(`no report row for path: ${filePath}`);
    }

    return row;
}

beforeAll(() => {
    // The shared helper bundles the script once so each case pays a plain node start rather than the tsx loader.
    script = bundleScript(SCRIPT, "pi-decision-report-");
});

afterAll(() => {
    script.dispose();
});

beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "pi-decision-report-"));
    temporaryDirectories.push(workspace);
    logPath = path.join(workspace, "bash-log.jsonl");
    // The suite default disables the writer; this file points it at its own temporary log.
    vi.stubEnv("SANDBOX_DECISION_LOG", "1");
    vi.stubEnv("SANDBOX_DECISION_LOG_PATH", logPath);
});

afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("decision-report script", () => {
    it("fails naming the missing log", () => {
        const result = runScript(["--json"], path.join(workspace, "absent.jsonl"));
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("no decision log found");
    });

    it("prints usage on --help without reading a log", () => {
        const result = script.run(["--help"]);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        for (const flag of [
            "--path",
            "--since",
            "--criterion",
            "--applied",
            "--prompted",
            "--limit",
            "--json",
            "--help",
        ]) {
            expect(result.stdout).toContain(flag);
        }
    });

    it("rejects an unknown flag through the top-level error handler", () => {
        const result = runScript(["--nonsense"]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("unknown option: --nonsense");
    });

    it("aggregates the consulted verdicts and leaves unconsulted records out of them", () => {
        writeCanonicalFixture();

        const report = runJson();
        expect(report.files).toEqual([logPath]);
        expect(report.total).toBe(4);
        expect(report.consulted).toBe(3);
        expect(report.applied).toBe(1);
        expect(report.abstained).toBe(1);
        expect(report.failed).toBe(1);
        expect(report.byAction).toEqual({ host: 1, refuse: 1, "(no answer)": 1 });
        expect(report.byCriterion).toEqual({ none: 1, destructive: 1, "(no answer)": 1 });
        expect(report.byOutcome).toEqual({ abstain: 2, host: 1 });
        expect(report.humanDecision).toEqual({ "allow:sandbox": 1 });
        expect(report.humanSandboxed).toBe(1);
        expect(report.meanLatencyMs).toBe(207);
        expect(report.maxLatencyMs).toBe(300);
        expect(report.inputTokens).toBe(150);
        expect(report.outputTokens).toBe(15);

        // JSON rows stay in log order, oldest first.
        expect(report.rows.map((row) => row.command)).toEqual([
            "git status",
            "rm -rf build",
            "curl https://example.test/data",
        ]);

        const abstained = requireRow(report, "rm -rf build");
        expect(abstained.human).toBe("yes");
        expect(abstained.decision).toBe("allow:sandbox");
        expect(abstained.sandboxed).toBe(true);
        expect(abstained.applied).toBe(false);
        expect(abstained.criterion).toBe("destructive");
        expect(abstained.action).toBe("refuse");
        expect(abstained.confidence).toBe(0.42);
        expect(abstained.provider).toBe("llama-local");
        expect(abstained.model).toBe("test-model");
        expect(abstained.status).toBe("abstained");
        expect(abstained.reason).toBe("policy withheld the verdict");
        expect(abstained.latencyMs).toBe(200);
        expect(abstained.tokens).toEqual({ input: 50, output: 5, total: 55 });

        const applied = requireRow(report, "git status");
        expect(applied.human).toBeUndefined();
        expect(applied.applied).toBe(true);
        expect(applied.outcome).toBe("host");
    });

    it("renders sections newest-first, honours --limit, and omits empty sections", () => {
        record("alpha task", { classifier: verdict({ latencyMs: 10 }) });
        record("bravo task", { classifier: verdict({ latencyMs: 20 }) });
        record("charlie task", {
            prompt: { outcome: "no" },
            decision: "deny",
            sandboxed: false,
            blocked: true,
            classifier: verdict({
                criterion: "destructive",
                action: "refuse",
                outcome: "abstain",
                status: "abstained",
                applied: false,
                latencyMs: 30,
            }),
        });

        const text = runText();
        expect(text.stdout).toMatch(
            /decision model: 3 consulted of 3 records in 1 file — \d{2}:\d{2}:\d{2} to \d{2}:\d{2}:\d{2}/,
        );
        expect(text.stdout).toMatch(/resolved by the model\s+2/);
        expect(text.stdout).toMatch(/abstained\s+1/);
        expect(text.stdout).toMatch(/failed\s+0/);
        expect(text.stdout).toMatch(/criteria named\s+/);
        expect(text.stdout).toMatch(/action\s+/);
        expect(text.stdout).toMatch(/outcome\s+/);
        expect(text.stdout).toMatch(/latency\s+mean \d+ms, max \d+ms/);
        expect(text.stdout).toMatch(/tokens\s+\d+ in, \d+ out/);
        expect(text.stdout).toMatch(/human on those rows\s+deny 1 \(sandboxed 0\)/);
        expect(text.stdout).toContain("RESOLVED BY THE MODEL (2)");
        expect(text.stdout).toContain("ABSTAINED — THE HUMAN DECIDED (1)");
        expect(text.stdout).not.toContain("FAILED — NO VERDICT");
        expect(text.stdout.indexOf("bravo task")).toBeLessThan(text.stdout.indexOf("alpha task"));
        expect(text.stdout).toContain("2 of 3 consulted accesses were resolved without a prompt.");

        const limited = runText(["--limit", "1"]);
        expect(limited.stdout).toContain("RESOLVED BY THE MODEL (2, newest 1)");
        expect(limited.stdout).toContain("bravo task");
        expect(limited.stdout).not.toContain("alpha task");
        expect(limited.stdout).toContain("ABSTAINED — THE HUMAN DECIDED (1)");
        expect(limited.stdout).not.toContain("ABSTAINED — THE HUMAN DECIDED (1, newest");
    });

    it("prints the failed section with the status, latency, and reason", () => {
        record("curl https://example.test/data", {
            classifier: {
                strategy: "classify",
                outcome: "abstain",
                status: "timeout",
                reason: "request timed out",
                latencyMs: 300,
                applied: false,
            },
        });

        const text = runText();
        expect(text.stdout).toContain("FAILED — NO VERDICT (1)");
        expect(text.stdout).toMatch(/timeout\s+300ms request timed out/);
        expect(text.stdout).toContain("0 of 1 consulted accesses were resolved without a prompt.");
    });

    it("filters by --applied, --prompted, and --criterion", () => {
        writeCanonicalFixture();

        const applied = runJson(["--applied"]);
        expect(applied.consulted).toBe(1);
        expect(applied.rows.map((row) => row.command)).toEqual(["git status"]);

        const prompted = runJson(["--prompted"]);
        expect(prompted.consulted).toBe(1);
        expect(prompted.rows.map((row) => row.command)).toEqual(["rm -rf build"]);

        const destructive = runJson(["--criterion", "destructive"]);
        expect(destructive.consulted).toBe(1);
        expect(destructive.rows.map((row) => row.command)).toEqual(["rm -rf build"]);

        // `--limit` narrows text sections only; the machine output still carries every consulted row.
        const limitedJson = runJson(["--limit", "1"]);
        expect(limitedJson.consulted).toBe(3);
        expect(limitedJson.rows).toHaveLength(3);

        // A filter that matches nothing is still a successful report with `-` for the empty histograms.
        const none = runText(["--criterion", "privileged"]);
        expect(none.stdout).toMatch(/decision model: 0 consulted of 4 records in 1 file/);
        expect(none.stdout).toMatch(/criteria named\s+-/);
        expect(none.stdout).not.toContain("human on those rows");
        expect(none.stdout).toContain("0 of 0 consulted accesses were resolved without a prompt.");
    });

    it("drops records older than --since and rejects an unreadable window", () => {
        record("recent task", { classifier: verdict() });
        record("stale task", { classifier: verdict({ latencyMs: 200 }) });
        ageLastRecord(30 * 24 * 3600 * 1000);

        const all = runJson();
        expect(all.total).toBe(2);
        expect(all.consulted).toBe(2);

        // The stale record is 30 days old, so a 60-day window keeps both while 7d keeps only the recent one.
        const wide = runJson(["--since", "60d"]);
        expect(wide.total).toBe(2);

        const week = runJson(["--since", "7d"]);
        expect(week.total).toBe(1);
        expect(week.consulted).toBe(1);
        expect(week.rows.map((row) => row.command)).toEqual(["recent task"]);

        const invalid = runScript(["--since", "nonsense"]);
        expect(invalid.status).toBe(1);
        expect(invalid.stderr).toContain("could not read duration: nonsense");
    });

    it("reads rotated generations oldest-first and lists every file it read", () => {
        // The older record goes into the rotated sibling the writer would leave behind; the newer one into the
        // live file, so `discoverGenerations` has to find and order both.
        vi.stubEnv("SANDBOX_DECISION_LOG_PATH", `${logPath}.1`);
        record("rotated older", { classifier: verdict({ latencyMs: 100 }) });
        vi.stubEnv("SANDBOX_DECISION_LOG_PATH", logPath);
        record("rotated newer", { classifier: verdict({ latencyMs: 200 }) });

        const report = runJson();
        expect(report.files).toEqual([`${logPath}.1`, logPath]);
        expect(report.total).toBe(2);
        expect(report.consulted).toBe(2);
        expect(report.rows.map((row) => row.command)).toEqual(["rotated older", "rotated newer"]);
        expect(runText().stdout).toContain("in 2 files");
    });

    it("groups the consults by the script files they sent", () => {
        const sources = ["package.json#deploy", "scripts/deploy.js"];
        record("npm run deploy", {
            classifier: verdict({ script: { kind: "package", sources, chars: 40 } }),
        });
        record("npm run deploy --prod", {
            classifier: verdict({
                confidence: 0.5,
                script: { kind: "package", sources, chars: 40 },
            }),
        });

        const report = runJson();
        // The script entry is not a file, and both consults carried the same path: one row, two scores.
        expect(
            report.scriptFiles.map(({ source, consults, confidences }) => ({
                source,
                consults,
                confidences,
            })),
        ).toEqual([{ source: "scripts/deploy.js", consults: 2, confidences: [0.5, 0.9] }]);
        expect(report.scriptFiles[0]?.newestCommand).toBe("npm run deploy --prod");

        const text = runText().stdout;
        expect(text).toContain("FILES SENT TO THE MODEL (1)");
        expect(text).toContain("scripts/deploy.js  2×  50%, 90%");
    });

    it("attributes each body's own answer to its file when the log carries one", () => {
        const script: BashClassifierRecord["script"] = {
            kind: "package",
            sources: ["package.json#deploy", "scripts/deploy.js"],
            chars: 40,
            answers: [
                {
                    source: "package.json#deploy",
                    criterion: "privileged",
                    action: "sandbox",
                    confidence: 0.4,
                    status: "answered",
                },
                {
                    source: "scripts/deploy.js",
                    criterion: "none",
                    action: "host",
                    confidence: 0.9,
                    status: "answered",
                },
            ],
        };
        record("npm run deploy", {
            classifier: verdict({
                criterion: "privileged",
                action: "sandbox",
                confidence: 0.4,
                outcome: "sandbox",
                script,
            }),
        });

        const report = runJson();
        // The folded confidence belongs to the invoked line, not the file: the file shows its own 90%.
        expect(
            report.scriptFiles.map(({ source, consults, confidences }) => ({
                source,
                consults,
                confidences,
            })),
        ).toEqual([{ source: "scripts/deploy.js", consults: 1, confidences: [0.9] }]);
    });

    it("counts a torn line as malformed without dropping the readable records", () => {
        record("readable task", { classifier: verdict() });
        appendFileSync(logPath, "{ not json\n");

        const report = runJson();
        expect(report.malformed).toBe(1);
        expect(report.total).toBe(1);
        expect(report.consulted).toBe(1);
    });
});

describe("decision-report script with both gates in one log", () => {
    it("reports a file-access row as an access instead of a missing command", () => {
        // The regression this whole block exists for: the reader took `record.command` from every row, so the
        // first `gate: "file"` line the production writer ever emitted killed the report with
        // `Cannot read properties of undefined (reading 'replace')`.
        record("git status", { classifier: verdict() });
        access();

        const text = runText().stdout;
        expect(text).toContain("subjects                bash 1, file 1");
        expect(text).toContain("read /home/user/.pi/agent/settings.json");
        expect(text).toContain("file accesses           1 consults, mean 72%, resolved 1");
        expect(text).not.toContain("undefined");

        const report = runJson();
        const row = requireFileRow(report, "/home/user/.pi/agent/settings.json");
        expect(row).toMatchObject({
            gate: "file",
            operation: "read",
            folder: "/home/user/.pi/agent",
            strategy: "file-access",
            criterion: "asked_for",
        });
        // Each gate's rows carry only their own fields, so a consumer never has to guess what a blank means.
        expect(row).not.toHaveProperty("command");
        expect(row).not.toHaveProperty("sandboxed");
        expect(requireRow(report, "git status").gate).toBe("bash");
    });

    it("slices one gate with --subject and rejects any other name", () => {
        record("git status", { classifier: verdict() });
        access();
        access({
            path: "/home/user/.ssh/config",
            folder: "/home/user/.ssh",
            operation: "write",
        });

        expect(runJson(["--subject", "file"]).consulted).toBe(2);
        expect(runJson(["--subject", "bash"]).consulted).toBe(1);
        expect(runText(["--subject", "file"]).stdout).toContain("subject filter: file");

        const rejected = runScript(["--subject", "commands"]);
        expect(rejected.status).toBe(1);
        expect(rejected.stderr).toContain("--subject wants `bash` or `file`");
    });

    it("keeps the command-shaped aggregates on the command rows", () => {
        // A file access has no script body. Counting it in the with/without-body pair would read as a collapse
        // in the body population every time someone opened a file outside the repo.
        record("npm run deploy", {
            classifier: verdict({
                script: {
                    kind: "package",
                    sources: ["package.json#deploy", "scripts/deploy.js"],
                    chars: 140,
                },
            }),
        });
        access();
        access({ path: "/home/user/docs/tui.md", folder: "/home/user/docs" });
        access({ path: "/home/user/notes.md", folder: "/home/user" });

        const report = runJson();
        expect(report.bySubject).toEqual({ bash: 1, file: 3 });
        expect(report.file).toMatchObject({ consulted: 3, resolved: 3 });
        // One consult carried the body, and three file rows did not: the per-file count staying at 1 is the
        // assertion, not the source name.
        expect(report.scriptFiles).toEqual([
            expect.objectContaining({ source: "scripts/deploy.js", consults: 1 }),
        ]);

        const text = runText().stdout;
        expect(text).toContain("with a script body      1 consults");
        expect(text).toContain("without a body          0 consults");
    });

    it("counts a sandbox decision only where sandboxing exists", () => {
        // The abstained section prints `sandbox` or `direct` from a Bash-only field. Reading `undefined` as
        // `direct` would make every still-asked read look like a command run outside the bubble.
        record("rm -rf build", {
            prompt: { outcome: "yes" },
            decision: "allow:sandbox",
            sandboxed: true,
            classifier: verdict({ applied: false, outcome: "abstain", status: "abstained" }),
        });
        access({
            prompt: { outcome: "yes" },
            resolvedBy: "prompt",
            classifier: verdict({
                strategy: "file-access",
                criterion: "unrelated",
                applied: false,
                outcome: "abstain",
                status: "abstained",
            }),
        });

        const report = runJson();
        expect(report.abstained).toBe(2);
        expect(report.humanSandboxed).toBe(1);
        expect(report.humanDecision).toEqual({ "allow:sandbox": 1, allow: 1 });

        const lines = runText().stdout.split("\n");
        const sectionStart = lines.findIndex((line) => line.startsWith("ABSTAINED"));
        const section = lines.slice(sectionStart).filter((line) => line.includes(" model "));

        expect(section).toHaveLength(2);
        expect(section.filter((line) => line.includes("sandbox"))).toHaveLength(1);
    });
});
