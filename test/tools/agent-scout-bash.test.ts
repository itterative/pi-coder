import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { ClassifierAnswer, ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerChildExtension } from "../../src/tools/agent/child/extension";
import { resolveChildGrant } from "../../src/tools/agent/child/grant";
import decisionConfig from "../../src/modules/decision/config";
import { SCRIPT_QUESTION, VETO_QUESTION } from "../../src/modules/decision";
import { resetDecisionEvaluator } from "../../src/modules/decision/gate";
import { DECISION_PROVIDER_ID } from "../../src/modules/decision/provider";
import type { BashDecisionRecord } from "../../src/modules/sandbox/decision-log";
import type { ChildAgentFactoryContext } from "../../src/tools/agent/contracts/runs";
import type { AgentDefinition } from "../../src/tools/agent/definitions/types";
import { getPermissionState } from "../../src/modules/sandbox/permission-state";
import { partialTracker } from "../helpers/agent-doubles";
import { KEY, mockTheme } from "../helpers";
import {
    createPiStub,
    stubContext,
    stubSessionManager,
    stubUiWithDialogs,
    type SessionManagerLike,
    type StubHandler,
} from "../helpers/pi-stub";
import {
    answeringRegistry,
    choiceAnswer,
    classifier,
    classifierModelRegistry,
    criterionResult,
    type Classifier,
} from "../modules/decision/classifier";

const tempDirs: string[] = [];

afterEach(() => {
    decisionConfig.reset();
    resetDecisionEvaluator();
    vi.unstubAllEnvs();
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

beforeEach(() => {
    decisionConfig.reset();
    resetDecisionEvaluator();
});

/**
 * A record the resolver wrote: every Bash row this helper reads in the command-gate tests goes through the
 * resolver, so `resolution` is present even though the schema allows a resolver-less read-only-gate row.
 */
type ResolvedDecisionRecord = BashDecisionRecord & {
    resolution: NonNullable<BashDecisionRecord["resolution"]>;
};

/** Records appended by the development decision log. */
function readDecisionLog(filePath: string): ResolvedDecisionRecord[] {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    return fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as ResolvedDecisionRecord);
}

function setup(
    cwd: string,
    {
        safeBash = true,
        commandRunner = false,
        background = true,
        allowUserInteraction = true,
        isolated = false,
        sessionManager = stubSessionManager(),
        additionalPaths = [],
        safeBashCommands = [],
        modelRegistry,
        agentName = "scout",
    }: {
        safeBash?: boolean;
        commandRunner?: boolean;
        background?: boolean;
        allowUserInteraction?: boolean;
        isolated?: boolean;
        sessionManager?: SessionManagerLike;
        additionalPaths?: string[];
        safeBashCommands?: string[];
        modelRegistry?: ExtensionContext["modelRegistry"];
        agentName?: string;
    } = {},
) {
    const stub = createPiStub();
    // The parent's dialog surface, kept in one place: only an interactive parent can answer, so `ui` is
    // handed over together with `hasUI`/`mode` below and the dialogs it opens are collected here.
    const { ui, dialogs } = stubUiWithDialogs(mockTheme);
    const tracker = partialTracker();

    const parentContext = stubContext({
        cwd,
        sessionManager,
        hasUI: commandRunner,
        mode: commandRunner ? "tui" : "print",
        ...(commandRunner ? { ui } : {}),
        ...(modelRegistry === undefined ? {} : { modelRegistry }),
    });

    // Grant resolution is the production path, so the knobs above become a definition plus a run
    // mode rather than a hand-assembled option bag. That keeps the assertions about what a given
    // capability set may do honest: they now exercise the resolution itself.
    const definition: AgentDefinition = {
        name: agentName,
        description: "Read-only reconnaissance",
        capabilities: commandRunner ? ["command-runner"] : safeBash ? ["safe-bash"] : [],
        systemPrompt: "",
        source: "builtin",
        allowUserInteraction,
        ...(additionalPaths.length > 0 ? { additionalPaths } : {}),
        ...(safeBashCommands.length > 0 ? { safeBashCommands } : {}),
    };
    const context: ChildAgentFactoryContext = {
        cwd,
        definition,
        parentContext,
        background,
        isolated,
        runId: "scout-1",
        runTitle: "Bash safety",
        onProgress: () => {},
    };
    const grant = resolveChildGrant(context, parentContext);
    registerChildExtension(tracker, parentContext, cwd, grant.extensionOptions)(stub.pi);

    // Read off the stub after every gate has registered, so each list stays in registration order. These
    // are the recorded handlers themselves rather than a `handlerView`: several assertions below call a
    // gate synchronously and expect its plain return value.
    const handlers: Record<"tool_call" | "tool_result" | "session_start", StubHandler[]> = {
        tool_call: stub.handlersFor("tool_call"),
        tool_result: stub.handlersFor("tool_result"),
        session_start: stub.handlersFor("session_start"),
    };

    return { handlers, ctx: { cwd, sessionManager }, tools: stub.tools, dialogs, sessionManager };
}

const DECISION_MODEL_ID = "test-classifier";
const DECISION_MODEL = classifier(DECISION_PROVIDER_ID, DECISION_MODEL_ID);

function decisionSection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        enabled: true,
        provider: DECISION_PROVIDER_ID,
        model: DECISION_MODEL_ID,
        ...overrides,
    };
}

/**
 * Put a decision config in the child's working directory and enable the decision log at a temporary path.
 *
 * The project walk-up must be stubbed non-blank: `test/setup.ts` pins `DECISION_MODEL_CONFIG_PATH` to `""`,
 * which means "no project file at all", so the temp workspace's file would never be found otherwise.
 */
function writeDecisionConfig(cwd: string, section: Record<string, unknown>): string {
    const configDirectory = path.join(cwd, ".pi");
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(configDirectory, "decision-model-config.json"),
        JSON.stringify({ decisionModel: section }),
    );

    const logPath = path.join(cwd, "decisions.jsonl");
    vi.stubEnv("DECISION_MODEL_CONFIG_PATH", path.join(cwd, "unused-fallback.json"));
    vi.stubEnv("SANDBOX_DECISION_LOG", "1");
    vi.stubEnv("SANDBOX_DECISION_LOG_PATH", logPath);
    return logPath;
}

/** The child's own session: one user turn, so the classifier state carries it as the delegated task. */
function sessionWithTask(cwd: string, task: string): SessionManager {
    const sessions = path.join(cwd, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const session = SessionManager.create(cwd, sessions);
    session.appendMessage({ role: "user", content: task, timestamp: 1 });
    return session;
}

interface ChildDecisionRun {
    result: unknown;
    classify: Mock<(model: Classifier, context: ClassifierContext) => Promise<ClassifierResult>>;
    state: ClassifierContext["state"] | undefined;
    records: BashDecisionRecord[];
    dialogs: ReturnType<typeof stubUiWithDialogs>["dialogs"];
}

/**
 * Drive one unresolved child command through the command gate with the model configured in the temp workspace.
 *
 * `answerPrompt` answers the dialog a prompt path opens; a case that expects no prompt leaves it false, so an
 * unexpected dialog leaves `pending` unsettled and fails the test rather than passing silently.
 */
async function runChildDecision(options: {
    section: Record<string, unknown>;
    criterion?: string;
    confidence?: number;
    answerPrompt?: boolean;
    agentName?: string;
    isolated?: boolean;
}): Promise<ChildDecisionRun> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-decision-"));
    tempDirs.push(cwd);
    const logPath = writeDecisionConfig(cwd, options.section);
    const sessionManager = sessionWithTask(cwd, "run the delegated tests");

    const classify = vi.fn(async (model: Classifier, _context: ClassifierContext) =>
        criterionResult(model, options.criterion ?? "none", options.confidence ?? 1),
    );
    const runtime = setup(cwd, {
        commandRunner: true,
        background: false,
        sessionManager,
        modelRegistry: classifierModelRegistry(answeringRegistry([DECISION_MODEL], classify)),
        ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
        ...(options.isolated === undefined ? {} : { isolated: options.isolated }),
    });

    const pending = runtime.handlers.tool_call[0]!(
        {
            toolName: "bash",
            toolCallId: "bash-decision-1",
            input: { command: "npm run test:run" },
        },
        runtime.ctx,
    );

    if (options.answerPrompt === true) {
        await vi.waitFor(() => expect(runtime.dialogs).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 260));
        runtime.dialogs[0].handleInput(KEY.enter);
    }

    const result = await pending;

    return {
        result,
        classify,
        state: classify.mock.calls[0]?.[1]?.state,
        records: readDecisionLog(logPath),
        dialogs: runtime.dialogs,
    };
}

describe("child decision-model wiring", () => {
    it("does not consult when only the parent surface is enabled", async () => {
        const run = await runChildDecision({
            section: decisionSection({ surfaces: ["parent"] }),
            criterion: "privileged",
            answerPrompt: true,
        });

        expect(run.classify).not.toHaveBeenCalled();
        expect(run.dialogs).toHaveLength(1);
        expect(run.result).toEqual({ block: false });

        const [record] = run.records;
        expect(record?.classifier).toBeUndefined();
        expect(record?.prompt).toBeDefined();
    });

    it("records a dry-run verdict but still prompts when apply is off", async () => {
        const run = await runChildDecision({
            section: decisionSection({ apply: false, surfaces: ["parent", "child"] }),
            criterion: "privileged",
            confidence: 0.9,
            answerPrompt: true,
        });

        expect(run.classify).toHaveBeenCalledTimes(1);
        expect(run.dialogs).toHaveLength(1);

        const [record] = run.records;
        expect(record?.classifier).toMatchObject({
            criterion: "privileged",
            action: "sandbox",
            outcome: "sandbox",
            status: "applied",
            applied: false,
        });
        expect(record?.prompt).toBeDefined();
    });

    it("applies a sandbox verdict without a prompt when apply is on", async () => {
        const run = await runChildDecision({
            section: decisionSection({ apply: true, surfaces: ["parent", "child"] }),
            criterion: "privileged",
            confidence: 0.9,
        });

        expect(run.classify).toHaveBeenCalledTimes(1);
        expect(run.dialogs).toHaveLength(0);
        expect(run.result).toEqual({ block: false });

        const [record] = run.records;
        expect(record?.classifier).toMatchObject({ applied: true, outcome: "sandbox" });
        expect(record?.decision).toBe("allow:sandbox");
        expect(record?.sandboxed).toBe(true);
        expect(record?.prompt).toBeUndefined();
    });

    it("keeps a destructive verdict behind the prompt when apply is on", async () => {
        const run = await runChildDecision({
            section: decisionSection({ apply: true, surfaces: ["parent", "child"] }),
            criterion: "destructive",
            confidence: 0.9,
            answerPrompt: true,
        });

        expect(run.classify).toHaveBeenCalledTimes(1);
        expect(run.dialogs).toHaveLength(1);
        expect(run.result).toEqual({ block: false });

        const [record] = run.records;
        expect(record?.classifier).toMatchObject({
            criterion: "destructive",
            action: "refuse",
            outcome: "abstain",
            applied: false,
            reason: "refuse requires confirmation",
        });
        expect(record?.prompt).toBeDefined();
    });

    it("runs a confident none unsandboxed with no prompt", async () => {
        const run = await runChildDecision({
            section: decisionSection({ apply: true, surfaces: ["parent", "child"] }),
            criterion: "none",
            confidence: 0.9,
        });

        expect(run.classify).toHaveBeenCalledTimes(1);
        expect(run.dialogs).toHaveLength(0);
        expect(run.result).toEqual({ block: false });

        const [record] = run.records;
        expect(record?.classifier).toMatchObject({ applied: true, outcome: "host" });
        expect(record?.decision).toBe("allow");
        expect(record?.sandboxed).toBe(false);
    });

    it("sends the scout's read-only runner rules in the classifier state", async () => {
        const run = await runChildDecision({
            section: decisionSection({ apply: true, surfaces: ["parent", "child"] }),
            criterion: "none",
            confidence: 0.9,
        });

        expect(run.state).toMatchObject({
            runner_rules: expect.arrayContaining([
                "Runs as a delegated read-only child.",
                "DON'T: create, change, or delete files.",
            ]),
        });
    });

    it("sends an isolated worker's mutate-in-worktree rules in the classifier state", async () => {
        const run = await runChildDecision({
            section: decisionSection({ apply: true, surfaces: ["parent", "child"] }),
            criterion: "none",
            confidence: 0.9,
            agentName: "worker",
            isolated: true,
        });

        expect(run.state).toMatchObject({
            runner_rules: expect.arrayContaining([
                "Runs as a delegated implementation child, in an isolated disposable git worktree.",
                "DO: read, create, edit, and delete files in its own working copy.",
            ]),
        });
    });
});

interface ReadOnlyDecisionRun {
    result: unknown;
    classify: Mock<(model: Classifier, context: ClassifierContext) => Promise<ClassifierResult>>;
    records: BashDecisionRecord[];
}

/**
 * Drive one read-only child command through `safe-bash` with the model configured in the temp workspace.
 *
 * The classifier answers whichever question the request carries, so an inline body's capability and the
 * command's own veto can differ in one case. `commandRunner: false` is what puts the child below the
 * `command` rung, where no prompt exists and the decision consult is the only path past the allowlist.
 */
async function runReadOnlyDecision(options: {
    command: string;
    scriptCapability?: string;
    scriptConfidence?: number;
    criterion?: string;
    confidence?: number;
    apply?: boolean;
    surfaces?: string[];
    agentName?: string;
    files?: Record<string, string>;
}): Promise<ReadOnlyDecisionRun> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-readonly-"));
    tempDirs.push(cwd);
    for (const [name, contents] of Object.entries(options.files ?? {})) {
        fs.writeFileSync(path.join(cwd, name), contents);
    }

    const logPath = writeDecisionConfig(
        cwd,
        decisionSection({
            apply: options.apply ?? true,
            surfaces: options.surfaces ?? ["child"],
        }),
    );
    const sessionManager = sessionWithTask(cwd, "inspect the delegated task");

    const classify = vi.fn(
        async (model: Classifier, context: ClassifierContext): Promise<ClassifierResult> => {
            const answers: Record<string, ClassifierAnswer> = {};
            if (context.questions[SCRIPT_QUESTION] !== undefined) {
                answers[SCRIPT_QUESTION] = choiceAnswer(
                    options.scriptCapability ?? "read_only",
                    options.scriptConfidence ?? 0.9,
                );
            }
            if (context.questions[VETO_QUESTION] !== undefined) {
                answers[VETO_QUESTION] = choiceAnswer(
                    options.criterion ?? "none",
                    options.confidence ?? 0.95,
                );
            }
            return {
                api: model.api,
                provider: model.provider,
                model: model.id,
                answers,
                stopReason: "stop",
                timestamp: 0,
            };
        },
    );

    const runtime = setup(cwd, {
        commandRunner: false,
        background: false,
        sessionManager,
        modelRegistry: classifierModelRegistry(answeringRegistry([DECISION_MODEL], classify)),
        ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
    });

    const result = await runtime.handlers.tool_call[0]!(
        { toolName: "bash", toolCallId: "bash-readonly-1", input: { command: options.command } },
        runtime.ctx,
    );

    return { result, classify, records: readDecisionLog(logPath) };
}

describe("read-only child decision consult", () => {
    it("allows a literal inline read-only script the allowlist does not know", async () => {
        const run = await runReadOnlyDecision({ command: "python3 -c 'print(1)'" });

        expect(run.result).toBeUndefined();
        expect(run.classify).toHaveBeenCalledTimes(2);

        const [record] = run.records;
        expect(record?.readOnlyGate).toBe(true);
        expect(record?.resolution).toBeUndefined();
        expect(record?.decision).toBe("allow");
        expect(record?.blocked).toBe(false);
        expect(record?.classifier).toMatchObject({
            applied: true,
            outcome: "host",
            script: {
                kind: "inline",
                sources: ["inline:python3 -c"],
                answers: [{ source: "inline:python3 -c", criterion: "read_only", action: "host" }],
            },
        });
    });

    it("allows inline code whose quoted punctuation reads as a dynamic path", async () => {
        const run = await runReadOnlyDecision({
            command: `python3 -c 'import json; print(json.dumps({"ok": True}))'`,
        });

        expect(run.result).toBeUndefined();
        expect(run.classify).toHaveBeenCalledTimes(2);

        const [record] = run.records;
        expect(record?.decision).toBe("allow");
        expect(record?.classifier).toMatchObject({
            applied: true,
            outcome: "host",
            script: { kind: "inline", answers: [{ criterion: "read_only", action: "host" }] },
        });
    });

    it("blocks an inline capability above the inspect rung", async () => {
        const run = await runReadOnlyDecision({
            command: "python3 -c 'import urllib.request'",
            scriptCapability: "network",
        });

        expect(run.result).toMatchObject({ block: true });

        const [record] = run.records;
        expect(record?.decision).toBe("deny");
        expect(record?.blocked).toBe(true);
        expect(record?.classifier).toMatchObject({
            applied: false,
            criterion: "out_of_scope",
            action: "refuse",
            outcome: "abstain",
        });
    });

    it("consults one readable subject reached through a chain", async () => {
        const run = await runReadOnlyDecision({
            command: `python3 -c 'import json; print(json.dumps({"ok": True}))' && cat package.json`,
        });

        expect(run.result).toBeUndefined();
        expect(run.classify).toHaveBeenCalledTimes(2);

        const [record] = run.records;
        expect(record?.decision).toBe("allow");
        expect(record?.classifier).toMatchObject({
            applied: true,
            outcome: "host",
            script: { kind: "inline" },
        });
    });

    it("consults a read file subject that takes dynamic data arguments", async () => {
        const run = await runReadOnlyDecision({
            command: "python3 run.py $DYN",
            files: { "run.py": "print(1)\n" },
        });

        expect(run.result).toBeUndefined();
        expect(run.classify).toHaveBeenCalledTimes(2);

        const [record] = run.records;
        expect(record?.decision).toBe("allow");
        expect(record?.classifier).toMatchObject({
            applied: true,
            outcome: "host",
            script: {
                kind: "file",
                answers: [{ source: "run.py", criterion: "read_only", action: "host" }],
            },
        });
    });

    it("keeps a dynamic code-loading flag deterministic without consulting", async () => {
        const run = await runReadOnlyDecision({
            command: "node --require $DYN run.py",
            files: { "run.py": "main()\n" },
        });

        expect(run.result).toMatchObject({ block: true });
        expect(run.classify).not.toHaveBeenCalled();
        expect(run.records).toHaveLength(0);
    });

    it("records a dry-run verdict and still blocks when apply is off", async () => {
        const run = await runReadOnlyDecision({
            command: "python3 -c 'print(1)'",
            apply: false,
        });

        expect(run.result).toMatchObject({ block: true });
        expect(run.classify).toHaveBeenCalledTimes(2);

        const [record] = run.records;
        expect(record?.classifier).toMatchObject({ applied: false, outcome: "host" });
        expect(record?.blocked).toBe(true);
    });

    it("keeps an outside path deterministic without consulting", async () => {
        const run = await runReadOnlyDecision({ command: "python3 /etc/hostname" });

        expect(run.result).toMatchObject({ block: true });
        expect(run.classify).not.toHaveBeenCalled();
        expect(run.records).toHaveLength(0);
    });

    it("holds a module run whose body the model never read", async () => {
        const run = await runReadOnlyDecision({
            command: "python3 -m json.tool package.json",
        });

        expect(run.result).toMatchObject({ block: true });

        const [record] = run.records;
        expect(record?.classifier).toMatchObject({ applied: true, script: { kind: "binary" } });
        expect(record?.decision).toBe("deny");
        expect(record?.blocked).toBe(true);
        expect(record?.note).toBe("read-only gate held a script body the model never judged");
    });

    it("uses a custom read-only child's declared rung, not the runner-name baseline", async () => {
        const run = await runReadOnlyDecision({
            command: "python3 run.py",
            files: { "run.py": "open('x', 'w').write('y')" },
            scriptCapability: "writes_files",
            agentName: "tidy",
        });

        expect(run.result).toMatchObject({ block: true });

        const [record] = run.records;
        expect(record?.classifier).toMatchObject({
            applied: false,
            criterion: "out_of_scope",
            action: "refuse",
            script: {
                answers: [{ source: "run.py", criterion: "writes_files", action: "host" }],
            },
        });
    });
});

describe("child interaction tools", () => {
    it("registers both interaction tools for background children when allowed", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-background-tools-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, {
            background: true,
            allowUserInteraction: true,
            commandRunner: true,
        });

        expect(runtime.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["ask_user", "ask_parent"]),
        );
    });

    it("keeps ask_user disabled for definitions that disallow direct interaction", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-parent-only-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, {
            background: true,
            allowUserInteraction: false,
            commandRunner: true,
        });

        expect(runtime.tools.map((tool) => tool.name)).not.toContain("ask_user");
        expect(runtime.tools.map((tool) => tool.name)).toContain("ask_parent");
    });

    it("does not register ask_user when the parent is non-interactive", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-noninteractive-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { background: true, allowUserInteraction: true });

        expect(runtime.tools.map((tool) => tool.name)).not.toContain("ask_user");
        expect(runtime.tools.map((tool) => tool.name)).toContain("ask_parent");
    });
});

describe("child Bash permissions", () => {
    it("permits only heuristic-classified read-only commands", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        fs.writeFileSync(path.join(cwd, "safe.txt"), "safe");
        const runtime = setup(cwd);
        const check = runtime.handlers.tool_call[0]!;

        await expect(
            check({ toolName: "bash", input: { command: "cat safe.txt" } }, runtime.ctx),
        ).resolves.toBeUndefined();
        await expect(
            check({ toolName: "bash", input: { command: "echo changed > safe.txt" } }, runtime.ctx),
        ).resolves.toMatchObject({ block: true, reason: expect.stringContaining("SAFE_READONLY") });
        await expect(
            check({ toolName: "bash", input: { command: "cat /etc/passwd" } }, runtime.ctx),
        ).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining(
                "a path is outside the working directory [OUTSIDE_CWD]",
            ),
        });
        await expect(
            check({ toolName: "bash", input: { command: "unrecognized-command" } }, runtime.ctx),
        ).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("UNKNOWN_COMMAND"),
        });
    });

    it("records an automatic child gate outcome without a prompt", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-decision-log-"));
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-decision-log-home-"));
        tempDirs.push(cwd, home);
        fs.writeFileSync(path.join(cwd, "safe.txt"), "safe");
        const logPath = path.join(home, "decisions.jsonl");
        vi.stubEnv("SANDBOX_DECISION_LOG", "1");
        vi.stubEnv("SANDBOX_DECISION_LOG_PATH", logPath);

        const runtime = setup(cwd, { commandRunner: true, background: false });
        await expect(
            runtime.handlers.tool_call[0]!(
                {
                    toolName: "bash",
                    toolCallId: "bash-grant-1",
                    input: { command: "cat safe.txt" },
                },
                runtime.ctx,
            ),
        ).resolves.toMatchObject({ block: false });

        const records = readDecisionLog(logPath);
        expect(records).toHaveLength(1);
        const [record] = records;
        expect(record?.surface).toBe("child");
        expect(record?.agent).toBe("scout");
        expect(record?.cwd).toBe(cwd);
        expect(record?.command).toBe("cat safe.txt");
        expect(record?.prompt).toBeUndefined();
        expect(record?.resolution.source).toBe("heuristic");
        expect(record?.decision).toBe("allow:sandbox");
        expect(record?.blocked).toBe(false);
    });

    it("records a rule remembered from a child prompt answered by the parent", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-decision-prompt-"));
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-decision-prompt-home-"));
        tempDirs.push(cwd, home);
        const logPath = path.join(home, "decisions.jsonl");
        vi.stubEnv("SANDBOX_DECISION_LOG", "1");
        vi.stubEnv("SANDBOX_DECISION_LOG_PATH", logPath);

        const runtime = setup(cwd, { commandRunner: true, background: false });
        const pending = runtime.handlers.tool_call[0]!(
            {
                toolName: "bash",
                toolCallId: "bash-remember-log-1",
                input: { command: "npm run test:run" },
            },
            runtime.ctx,
        );

        await vi.waitFor(() => expect(runtime.dialogs).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 260));
        runtime.dialogs[0].handleInput(KEY.down);
        runtime.dialogs[0].handleInput(KEY.enter);
        await expect(pending).resolves.toEqual({ block: false });

        const [record] = readDecisionLog(logPath);
        expect(record?.surface).toBe("child");
        expect(record?.resolution.source).toBe("unresolved");
        expect(record?.resolution.segments[0]?.tokens).toEqual(["npm", "run", "test:run"]);
        expect(record?.prompt).toEqual({
            outcome: "remember",
            suggestion: "npm run test:run",
            rule: "npm run test:run",
        });
        expect(record?.blocked).toBe(false);
    });

    it("allows exact custom safe-Bash patterns while retaining path checks", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-custom-bash-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, {
            safeBashCommands: ["ast-outline digest *"],
        });
        const check = runtime.handlers.tool_call[0]!;

        await expect(
            check({ toolName: "bash", input: { command: "ast-outline digest src" } }, runtime.ctx),
        ).resolves.toBeUndefined();
        await expect(
            check(
                { toolName: "bash", input: { command: "ast-outline show src/index.ts" } },
                runtime.ctx,
            ),
        ).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("UNKNOWN_COMMAND"),
        });
        await expect(
            check({ toolName: "bash", input: { command: "ast-outline digest /etc" } }, runtime.ctx),
        ).resolves.toMatchObject({ block: true, reason: expect.stringContaining("OUTSIDE_CWD") });
    });

    it("allows configured additional paths for direct reads and safe Bash", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const additionalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-additional-"));
        tempDirs.push(cwd, additionalDirectory);
        const additionalPath = path.join(additionalDirectory, "memory.md");
        const sensitivePath = path.join(additionalDirectory, ".env");
        fs.writeFileSync(additionalPath, "memory");
        fs.writeFileSync(sensitivePath, "secret");
        const runtime = setup(cwd, { additionalPaths: [additionalDirectory] });
        const check = runtime.handlers.tool_call[0]!;

        expect(
            check({ toolName: "read", input: { path: additionalPath } }, runtime.ctx),
        ).toBeUndefined();
        await expect(
            check({ toolName: "bash", input: { command: `cat ${additionalPath}` } }, runtime.ctx),
        ).resolves.toBeUndefined();
        expect(
            check({ toolName: "read", input: { path: sensitivePath } }, runtime.ctx),
        ).toMatchObject({ block: true });
        await expect(
            check({ toolName: "bash", input: { command: `cat ${sensitivePath}` } }, runtime.ctx),
        ).resolves.toMatchObject({ block: true });

        const commandRunner = setup(cwd, {
            commandRunner: true,
            background: false,
            additionalPaths: [additionalDirectory],
        });
        await expect(
            commandRunner.handlers.tool_call[0]!(
                { toolName: "bash", input: { command: `cat ${additionalPath}` } },
                commandRunner.ctx,
            ),
        ).resolves.toEqual({ block: false });
    });

    it("allows reading a current child Bash output file without allowing general temp access", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-outside-"));
        tempDirs.push(cwd, outputDirectory, outside);
        const outputPath = path.join(outputDirectory, "bash-output.log");
        const outsidePath = path.join(outside, "secret.txt");
        fs.writeFileSync(outputPath, "full output");
        fs.writeFileSync(outsidePath, "secret");
        const runtime = setup(cwd);
        const result = runtime.handlers.tool_result[0]!;
        const check = runtime.handlers.tool_call[0]!;

        await result(
            {
                type: "tool_result",
                toolName: "bash",
                toolCallId: "bash-1",
                input: { command: "cat large.log" },
                content: [],
                isError: false,
                details: { fullOutputPath: outputPath },
            },
            runtime.ctx,
        );

        expect(
            check({ toolName: "read", input: { path: outputPath } }, runtime.ctx),
        ).toBeUndefined();
        expect(
            check({ toolName: "read", input: { path: outsidePath } }, runtime.ctx),
        ).toMatchObject({ block: true });
        expect(
            check(
                { toolName: "read", input: { path: path.join(os.tmpdir(), "unrelated.log") } },
                runtime.ctx,
            ),
        ).toMatchObject({ block: true });
        await expect(
            check({ toolName: "bash", input: { command: `cat ${outputPath}` } }, runtime.ctx),
        ).resolves.toMatchObject({ block: true });
    });

    it("reconstructs readable Bash output paths from a resumed child transcript", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-"));
        tempDirs.push(cwd, outputDirectory);
        const outputPath = path.join(outputDirectory, "bash-output.log");
        fs.writeFileSync(outputPath, "full output");
        const runtime = setup(cwd);
        const sessionManager = {
            getBranch: () => [
                {
                    type: "message",
                    message: {
                        role: "toolResult",
                        toolName: "bash",
                        details: { fullOutputPath: outputPath },
                    },
                },
            ],
        };
        await runtime.handlers.session_start[0]!({}, { cwd, sessionManager });

        expect(
            runtime.handlers.tool_call[0]!(
                {
                    toolName: "read",
                    input: { path: outputPath },
                },
                { cwd },
            ),
        ).toBeUndefined();
    });

    it("retains all active truncated Bash output paths", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-"));
        tempDirs.push(cwd, outputDirectory);
        const outputPaths = Array.from({ length: 100 }, (_, index) => {
            const outputPath = path.join(outputDirectory, `bash-output-${index}.log`);
            fs.writeFileSync(outputPath, `full output ${index}`);
            return outputPath;
        });
        const runtime = setup(cwd);
        const result = runtime.handlers.tool_result[0]!;
        const check = runtime.handlers.tool_call[0]!;

        for (const outputPath of outputPaths) {
            await result(
                {
                    type: "tool_result",
                    toolName: "bash",
                    toolCallId: outputPath,
                    input: { command: "cat large.log" },
                    content: [],
                    isError: false,
                    details: { fullOutputPath: outputPath },
                },
                runtime.ctx,
            );
        }

        expect(
            check({ toolName: "read", input: { path: outputPaths[0] } }, runtime.ctx),
        ).toBeUndefined();
        expect(
            check({ toolName: "read", input: { path: outputPaths.at(-1) } }, runtime.ctx),
        ).toBeUndefined();
    });

    it("rejects a Bash output path after it is replaced by a symlink", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-output-outside-"));
        tempDirs.push(cwd, outputDirectory, outside);
        const outputPath = path.join(outputDirectory, "bash-output.log");
        const outsidePath = path.join(outside, "secret.txt");
        fs.writeFileSync(outputPath, "full output");
        fs.writeFileSync(outsidePath, "secret");
        const runtime = setup(cwd);
        await runtime.handlers.tool_result[0]!(
            {
                type: "tool_result",
                toolName: "bash",
                toolCallId: "bash-1",
                input: { command: "cat large.log" },
                content: [],
                isError: false,
                details: { fullOutputPath: outputPath },
            },
            runtime.ctx,
        );
        fs.rmSync(outputPath);
        fs.symlinkSync(outsidePath, outputPath);

        expect(
            runtime.handlers.tool_call[0]!(
                {
                    toolName: "read",
                    input: { path: outputPath },
                },
                runtime.ctx,
            ),
        ).toMatchObject({ block: true });
    });

    it("routes command-runner commands through the permission gate", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-runner-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { commandRunner: true, background: false });
        const check = runtime.handlers.tool_call[0]!;
        const pending = check(
            {
                toolName: "bash",
                toolCallId: "bash-1",
                input: { command: "npm run test:run" },
            },
            runtime.ctx,
        );

        await vi.waitFor(() => expect(runtime.dialogs).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 260));
        runtime.dialogs[0].handleInput(KEY.enter);

        await expect(pending).resolves.toEqual({ block: false });
    });

    it("propagates an explicitly remembered isolated Bash rule to the parent session", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-bash-"));
        tempDirs.push(cwd);
        const sessionManager = stubSessionManager();
        const runtime = setup(cwd, {
            commandRunner: true,
            background: false,
            isolated: true,
            sessionManager,
        });
        const pending = runtime.handlers.tool_call[0]!(
            {
                toolName: "bash",
                toolCallId: "bash-remember-1",
                input: { command: "npm run test:run" },
            },
            runtime.ctx,
        );

        await vi.waitFor(() => expect(runtime.dialogs).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 260));
        runtime.dialogs[0].handleInput(KEY.down);
        runtime.dialogs[0].handleInput(KEY.enter);

        await expect(pending).resolves.toEqual({ block: false });
        const parentRule = getPermissionState(sessionManager).bashRules["npm run test:run"];
        expect(["allow", "allow:sandbox"]).toContain(parentRule);
    });

    it("permits built-in fsmonitor but blocks an external status hook", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        execFileSync("git", ["init", "-q"], { cwd });
        const runtime = setup(cwd);
        const check = runtime.handlers.tool_call[0]!;

        execFileSync("git", ["config", "core.fsmonitor", "true"], { cwd });
        await expect(
            check({ toolName: "bash", input: { command: "git status --short" } }, runtime.ctx),
        ).resolves.toBeUndefined();

        const sentinel = path.join(cwd, "fsmonitor-sentinel");
        const marker = path.join(cwd, "fsmonitor-ran");
        fs.writeFileSync(sentinel, `#!/bin/sh\ntouch ${marker}\n`);
        fs.chmodSync(sentinel, 0o755);
        execFileSync("git", ["config", "core.fsmonitor", sentinel], { cwd });

        await expect(
            check({ toolName: "bash", input: { command: "git status --short" } }, runtime.ctx),
        ).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("unsupported core.fsmonitor value"),
        });
        expect(fs.existsSync(marker)).toBe(false);
    });

    it("blocks bash when safe-bash is absent", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { safeBash: false });
        const check = runtime.handlers.tool_call[0]!;

        await expect(
            check({ toolName: "bash", input: { command: "cat safe.txt" } }, runtime.ctx),
        ).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("safe-bash capability is not enabled"),
        });
    });

    it("omits direct user interaction when the child policy disables it", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-bash-"));
        tempDirs.push(cwd);
        const runtime = setup(cwd, { background: false, allowUserInteraction: false });

        expect(runtime.tools.map((tool) => tool.name)).not.toContain("ask_user");
    });
});
