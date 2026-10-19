import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
    SessionManager,
    type ExtensionUIContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import sandboxConfig from "../../src/common/config";
import decisionConfig from "../../src/modules/decision/config";
import { resetDecisionEvaluator } from "../../src/modules/decision/gate";
import { DECISION_PROVIDER_ID } from "../../src/modules/decision/provider";
import { isFileAccessApproved } from "../../src/tools/file-permissions";
import registerFileToolHook from "../../src/tools/file-permissions";
import type { FileAccessDecisionRecord } from "../../src/modules/sandbox/decision-log";
import { ALLOWED_FILE_ENTRY_TYPE } from "../../src/common/audit";
import {
    createPiStub,
    handlerView,
    stubContext,
    stubSessionManager,
    stubUi,
} from "../helpers/pi-stub";
import {
    answeringRegistry,
    classifier,
    classifierModelRegistry,
    fileAccessResult,
} from "../modules/decision/classifier";

/**
 * The file gates' decision-model wiring: consult only an access that left every trusted root, record every
 * consultation, and replace the prompt only when `apply` licenses the verdict.
 *
 * The endpoint is a double. What these cases pin is the gate's behaviour around a verdict, not the verdict's
 * quality — that lives in `.pi/local/decision-models/file-access-report.md`, where the composite resolved 72
 * of 102 approved real accesses and granted none of the 8 the user refused.
 */

const MODEL_ID = "test-classifier";
const MODEL = classifier(DECISION_PROVIDER_ID, MODEL_ID);
const REQUEST = "read the notes file and summarize it";

const temporaryDirectories: string[] = [];
let workspace: string;
let outsideFolder: string;
let logPath: string;

function readRecords(): (FileAccessDecisionRecord & Record<string, unknown>)[] {
    if (!fs.existsSync(logPath)) {
        return [];
    }

    return fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as FileAccessDecisionRecord & Record<string, unknown>);
}

function writeDecisionConfig(section: Record<string, unknown> | undefined): void {
    const file = path.join(workspace, ".pi", "decision-model-config.json");
    if (section === undefined) {
        fs.rmSync(file, { force: true });
        return;
    }

    fs.writeFileSync(file, JSON.stringify({ decisionModel: section }));
}

function modelSection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        enabled: true,
        apply: true,
        baseUrl: "https://classifier.example",
        provider: DECISION_PROVIDER_ID,
        model: MODEL_ID,
        surfaces: ["parent"],
        fileSurfaces: ["parent"],
        ...overrides,
    };
}

function writeSandboxConfig(files: Record<string, unknown> | undefined): void {
    fs.writeFileSync(
        path.join(workspace, ".pi", "bash-sandbox-config.json"),
        JSON.stringify({
            sandbox: {
                enabled: true,
                mounts: files?.honorMounts ? { [outsideFolder]: "readwrite" } : {},
            },
            ...(files === undefined ? {} : { files }),
            permissions: {},
            decisionLog: { enabled: true, path: logPath },
        }),
    );
    sandboxConfig.load(workspace);
}

let targetCounter = 0;

/**
 * A fresh outside file per call.
 *
 * The evaluator's answer cache keys on path and request, which is the behaviour a later case asserts on; if
 * every call asked about the same path, an earlier case's verdict would answer for the later one and the test
 * would pin the cache instead of the model.
 */
function nextTarget(name = "notes.md"): string {
    targetCounter += 1;
    const folder = path.join(outsideFolder, `case-${String(targetCounter)}`);
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, name);
    fs.writeFileSync(target, `# ${name}\n`);
    return target;
}

interface GateResult {
    block: boolean;
    reason?: string;
    approved: boolean;
    classifyCalls: number;
    records: FileAccessDecisionRecord[];
    notify: Mock;
}

/**
 * Drive one file-tool call through the gate.
 *
 * `hasUI: false` is what makes the prompt path observable without a TUI: an unanswered dialog blocks, so a
 * blocked result means "the gate had nothing to act on" and an allowed one means a root, an approval, or a
 * verdict carried it.
 */
async function runGate(options: {
    operation?: "read" | "write";
    toolName?: string;
    target?: string;
    decision?: Record<string, unknown>;
    files?: Record<string, unknown>;
    request?: string;
    /** Keep the evaluator, and with it its answer cache, from the previous call in the same case. */
    keepEvaluator?: boolean;
    /**
     * Share one classifier double across calls.
     *
     * The evaluator is one instance per configuration and it holds the registry it was first built with, so a
     * case that measures cache behaviour must count on one mock rather than on a fresh one per call.
     */
    classify?: Mock;
    answer?: { kind: string; purpose: string; confidence?: number; loss?: number };
}): Promise<GateResult> {
    const operation = options.operation ?? "read";
    writeDecisionConfig(options.decision);
    writeSandboxConfig(options.files ?? { honorPiPackage: false });
    decisionConfig.load(workspace);
    if (!options.keepEvaluator) {
        resetDecisionEvaluator();
    }

    const classify =
        options.classify ??
        vi.fn(async () =>
            fileAccessResult(MODEL, {
                kind: options.answer?.kind ?? "code",
                purpose: options.answer?.purpose ?? "routine",
                confidence: options.answer?.confidence ?? 0.9,
                loss: options.answer?.loss,
            }),
        );
    const notify = vi.fn();
    const ui = stubUi({
        notify,
        theme: { bold: (value: string) => value } as ExtensionUIContext["theme"],
    });
    const stub = createPiStub();
    registerFileToolHook(stub.pi, operation, { decision: { surface: "parent" } });
    const handlers = handlerView(stub, "session_start", "tool_call");

    const sessionManager = SessionManager.create(workspace, path.join(workspace, "sessions"));
    sessionManager.appendMessage({
        role: "user",
        content: options.request ?? REQUEST,
        timestamp: 1,
    });

    const ctx = stubContext({
        cwd: workspace,
        hasUI: false,
        ui,
        sessionManager,
        modelRegistry: classifierModelRegistry(answeringRegistry([MODEL], classify)),
    });
    await handlers.session_start[0]({}, ctx);

    const event = {
        toolCallId: "call-1",
        toolName: options.toolName ?? operation,
        input: { path: options.target ?? nextTarget() },
    };
    const result = (await handlers.tool_call[0](event, ctx)) as {
        block?: boolean;
        reason?: string;
    };

    return {
        block: result.block === true,
        reason: result.reason,
        approved: isFileAccessApproved(event),
        classifyCalls: classify.mock.calls.length,
        records: readRecords(),
        notify,
    };
}

beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-decision-workspace-"));
    outsideFolder = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-decision-outside-"));
    temporaryDirectories.push(workspace, outsideFolder);
    logPath = path.join(workspace, "files.jsonl");
    fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(outsideFolder, "notes.md"), "# notes\n");

    vi.stubEnv("SANDBOX_DECISION_LOG", "1");
    vi.stubEnv("SYSTEMONE_API_URL", "");
    vi.stubEnv("SYSTEMONE_API_TOKEN", "");
    vi.stubEnv("SYSTEMONE_MODEL", "");
    vi.stubEnv("SYSTEMONE_TIMEOUT", "");
    vi.stubEnv("DECISION_MODEL_CONFIG_PATH", path.join(workspace, "unused-fallback.json"));
    decisionConfig.reset();
    resetDecisionEvaluator();
});

afterEach(() => {
    decisionConfig.reset();
    resetDecisionEvaluator();
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("file gate decision model", () => {
    it("asks nothing when no decision config exists and the prompt still blocks", async () => {
        const { block, classifyCalls, records } = await runGate({ decision: undefined });

        expect(classifyCalls).toBe(0);
        expect(block).toBe(true);

        // The record is still the point: an access that reached a human is evidence whether or not a model
        // had an opinion about it, and this population is the denominator a later measurement reads.
        const [record] = records;
        expect(record).toMatchObject({ gate: "file", resolvedBy: "unavailable", decision: "deny" });
        expect(record).not.toHaveProperty("classifier");
    });

    it("resolves an outside read without a prompt when apply licenses the verdict", async () => {
        const { block, approved, classifyCalls, records, notify } = await runGate({
            decision: modelSection(),
            answer: { kind: "code", purpose: "routine", confidence: 0.93 },
        });

        expect(classifyCalls).toBe(1);
        expect(block).toBe(false);
        expect(approved).toBe(true);
        expect(notify).toHaveBeenCalled();

        const [record] = records;
        expect(record).toMatchObject({
            gate: "file",
            surface: "parent",
            operation: "read",
            resolvedBy: "classifier",
            decision: "allow",
            blocked: false,
        });
        expect(record?.classifier).toMatchObject({
            strategy: "file-access",
            criterion: "routine",
            action: "host",
            outcome: "host",
            applied: true,
        });
    });

    it("keeps the withheld verdict on the record when the access still reaches the human", async () => {
        const { block, classifyCalls, records } = await runGate({
            decision: modelSection(),
            answer: { kind: "code", purpose: "unrelated", confidence: 0.95 },
        });

        expect(classifyCalls).toBe(1);
        expect(block).toBe(true);

        const [record] = records;
        expect(record?.resolvedBy).toBe("unavailable");
        expect(record?.classifier).toMatchObject({
            outcome: "abstain",
            criterion: "unrelated",
            applied: false,
        });
    });

    it("never lets a verdict deny an access: withhold means ask", async () => {
        const { records, block } = await runGate({
            decision: modelSection(),
            answer: { kind: "secret", purpose: "asked_for", confidence: 0.99 },
        });

        expect(block).toBe(true);
        expect(records[0]?.classifier).toMatchObject({ criterion: "secret", outcome: "abstain" });
        expect(readRecords().some((record) => record.classifier?.applied === true)).toBe(false);
    });

    it("records and still prompts when apply is off", async () => {
        const { block, records, classifyCalls } = await runGate({
            decision: modelSection({ apply: false }),
            answer: { kind: "code", purpose: "routine", confidence: 0.93 },
        });

        expect(classifyCalls).toBe(1);
        expect(block).toBe(true);
        // `applied: false` beside `status: "applied"` is the dry-run signature the Bash log already carries:
        // the policy would have resolved the prompt, and `apply` is what kept the human in the loop.
        expect(records[0]?.classifier).toMatchObject({ applied: false, status: "applied" });
    });

    it("holds a grant to the confidence floor, which reads the kind answer", async () => {
        const below = await runGate({
            decision: modelSection({ minConfidence: 0.95 }),
            answer: { kind: "code", purpose: "routine", confidence: 0.93 },
        });
        expect(below.block).toBe(true);

        const above = await runGate({
            decision: modelSection({ minConfidence: 0.9 }),
            answer: { kind: "code", purpose: "routine", confidence: 0.93 },
        });
        expect(above.block).toBe(false);
    });

    it("does not let a routine purpose carry a write", async () => {
        const routine = await runGate({
            operation: "write",
            toolName: "edit",
            decision: modelSection(),
            answer: { kind: "code", purpose: "routine", confidence: 0.95, loss: 0.02 },
        });
        expect(routine.block).toBe(true);

        const asked = await runGate({
            operation: "write",
            toolName: "edit",
            decision: modelSection(),
            answer: { kind: "code", purpose: "asked_for", confidence: 0.95, loss: 0.02 },
        });
        expect(asked.block).toBe(false);
    });

    it("withholds a write that would destroy unasked content", async () => {
        const { records, block } = await runGate({
            operation: "write",
            toolName: "edit",
            decision: modelSection(),
            answer: { kind: "code", purpose: "asked_for", confidence: 0.95, loss: 0.71 },
        });

        expect(block).toBe(true);
        expect(records[0]?.classifier).toMatchObject({ criterion: "loses_content" });
    });

    it("never asks about a sensitive path, which is not a root question", async () => {
        const secret = path.join(outsideFolder, "credentials");
        fs.writeFileSync(secret, "token=abc\n");

        const { classifyCalls, block } = await runGate({
            decision: modelSection(),
            target: secret,
        });

        expect(classifyCalls).toBe(0);
        expect(block).toBe(true);
    });

    it("never asks about an access a declared root already covers", async () => {
        const { classifyCalls, block } = await runGate({
            decision: modelSection(),
            files: { readRoots: [outsideFolder], honorPiPackage: false },
        });

        expect(classifyCalls).toBe(0);
        expect(block).toBe(false);
    });

    it("honours the mount list only when it is declared as a file source", async () => {
        const withFlag = await runGate({
            decision: modelSection(),
            files: { honorMounts: true, honorPiPackage: false },
        });
        expect(withFlag.classifyCalls).toBe(0);
        expect(withFlag.block).toBe(false);

        const withoutFlag = await runGate({
            decision: modelSection(),
            files: { honorPiPackage: false },
        });
        expect(withoutFlag.classifyCalls).toBe(1);
    });

    it("answers a repeated access from the cache and asks again under another request", async () => {
        const target = nextTarget();
        const classify = vi.fn(async () =>
            fileAccessResult(MODEL, { kind: "code", purpose: "routine", confidence: 0.93 }),
        );

        // The double is shared because the evaluator is one instance per configuration: the count is the
        // measurement, and a fresh mock per call would read zero whether the answer was cached or the
        // evaluator was rebuilt.
        await runGate({ decision: modelSection(), target, classify });
        expect(classify).toHaveBeenCalledTimes(1);

        await runGate({ decision: modelSection(), target, classify, keepEvaluator: true });
        expect(classify).toHaveBeenCalledTimes(1);

        // A different request is a different question: the purpose answer is about the request, so an
        // approval earned while the user was asking about notes must not carry into an unrelated turn.
        await runGate({
            decision: modelSection(),
            target,
            classify,
            keepEvaluator: true,
            request: "clean up the scratch files in that other folder",
        });
        expect(classify).toHaveBeenCalledTimes(2);
    });

    it("leaves a session folder approval ahead of the model", async () => {
        const folder = path.join(outsideFolder, "approved");
        fs.mkdirSync(folder, { recursive: true });
        const target = path.join(folder, "notes.md");
        fs.writeFileSync(target, "# notes\n");
        writeDecisionConfig(modelSection());
        writeSandboxConfig({ honorPiPackage: false });
        decisionConfig.load(workspace);

        const classify = vi.fn(async () =>
            fileAccessResult(MODEL, { kind: "personal", purpose: "unrelated", confidence: 0.9 }),
        );
        const stub = createPiStub();
        registerFileToolHook(stub.pi, "read", { decision: { surface: "parent" } });
        const handlers = handlerView(stub, "session_start", "tool_call");
        // The approval is the session entry the prompt's "always allow folder" choice writes, and the user
        // message is the request half of the context. A person's standing decision is never second-guessed by
        // a model opinion, so the classifier is not asked about a path in an approved folder.
        const ctx = stubContext({
            cwd: workspace,
            hasUI: false,
            ui: stubUi({ notify: vi.fn() }),
            sessionManager: stubSessionManager({
                getBranch: () =>
                    [
                        {
                            type: "message",
                            message: { role: "user", content: [{ type: "text", text: REQUEST }] },
                        },
                        {
                            type: "custom",
                            customType: ALLOWED_FILE_ENTRY_TYPE,
                            data: { operation: "read", folder },
                        },
                    ] as unknown as SessionEntry[],
            }),
            modelRegistry: classifierModelRegistry(answeringRegistry([MODEL], classify)),
        });
        await handlers.session_start[0]({}, ctx);

        const result = await handlers.tool_call[0](
            { toolCallId: "call-2", toolName: "read", input: { path: target } },
            ctx,
        );

        expect(result).toEqual({ block: false });
        expect(classify).not.toHaveBeenCalled();
    });
});
