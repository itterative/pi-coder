import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ClassifierContext } from "@earendil-works/pi-ai";

import decisionConfig from "../../src/modules/decision/config";
import { SUGGESTION_QUESTION_ID } from "../../src/modules/decision";
import { resetDecisionEvaluator } from "../../src/modules/decision/gate";
import { DECISION_PROVIDER_ID } from "../../src/modules/decision/provider";
import type { BashDecisionRecord } from "../../src/modules/sandbox/decision-log";
import registerBashToolHook from "../../src/tools/bash/index";
import { createPiStub, handlerView, stubContext, stubUi } from "../helpers/pi-stub";
import {
    answeringRegistry,
    classifier,
    classifierModelRegistry,
    criterionResult,
    suggestionResult,
} from "../modules/decision/classifier";

/**
 * The parent hook's decision-model wiring: consult on `ask`, record the verdict, and replace the prompt only
 * when `apply` licenses it. The model config lives in the temporary workspace the hook is invoked with, and
 * the workspace's sandbox config enables the sandbox the `sandbox` verdict needs.
 */

const MODEL_ID = "test-classifier";
const MODEL = classifier(DECISION_PROVIDER_ID, MODEL_ID);

const temporaryDirectories: string[] = [];
let workspace: string;
let logPath: string;

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

function writeDecisionFile(section: Record<string, unknown> | undefined): void {
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
        baseUrl: "https://classifier.example",
        provider: DECISION_PROVIDER_ID,
        model: MODEL_ID,
        ...overrides,
    };
}

interface HookResult {
    block: boolean;
    reason?: string;
    records: BashDecisionRecord[];
    classifyCalls: number;
    notify: Mock;
}

async function runHookCommand(options: {
    command: string;
    decision?: Record<string, unknown>;
    criterion?: string;
    confidence?: number;
    /** The probability the suggestion question answers with, when the hook asks it. */
    suggestion?: number;
}): Promise<HookResult> {
    writeDecisionFile(options.decision);
    decisionConfig.load(workspace);
    // The command answer is cached per evaluator and the cache key does not carry `apply` or the confidence
    // the mock answers with, so a second run of the same command must not inherit the first one's verdict.
    resetDecisionEvaluator();

    const classify = vi.fn(async (model: typeof MODEL, context: ClassifierContext) => {
        if (SUGGESTION_QUESTION_ID in context.questions) {
            return suggestionResult(model, options.suggestion ?? 0.1);
        }

        return criterionResult(model, options.criterion ?? "privileged", options.confidence ?? 0.9);
    });
    const notify = vi.fn();
    const ui = stubUi({ notify });
    const stub = createPiStub();
    registerBashToolHook(stub.pi);
    const handlers = handlerView(stub, "session_start", "tool_call");

    const sessionManager = SessionManager.create(workspace, path.join(workspace, "sessions"));
    sessionManager.appendMessage({
        role: "user",
        content: "please tidy the workspace",
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
    const result = (await handlers.tool_call[0](
        { toolCallId: "call-1", toolName: "bash", input: { command: options.command } },
        ctx,
    )) as { block?: boolean; reason?: string };

    return {
        block: result.block === true,
        reason: result.reason,
        records: readRecords(),
        classifyCalls: classify.mock.calls.length,
        notify,
    };
}

beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-decision-model-"));
    temporaryDirectories.push(workspace);
    logPath = path.join(workspace, "decisions.jsonl");
    fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "sessions"), { recursive: true });
    fs.writeFileSync(
        path.join(workspace, ".pi", "bash-sandbox-config.json"),
        JSON.stringify({
            sandbox: { enabled: true },
            permissions: { "echo *": "allow" },
            decisionLog: { enabled: true, path: logPath },
        }),
    );
    fs.writeFileSync(path.join(workspace, "README.md"), "# fixture\n");

    // The suite default disables logging; this file re-enables it at a temporary path. The endpoint
    // variables are blanked so only the workspace's decision config can reach the assertions, and the project
    // path is pinned non-blank because a blank one switches the walk-up off, which would hide the very file
    // these cases write.
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

describe("bash decision-model wiring", () => {
    const unresolved = "kindly-untagged-tool --now";

    it("prompts and records no classifier when no decision config exists", async () => {
        const { block, records, classifyCalls } = await runHookCommand({ command: unresolved });

        expect(classifyCalls).toBe(0);
        expect(records).toHaveLength(1);

        const [record] = records;
        expect(record).not.toHaveProperty("classifier");
        expect(record?.prompt).toEqual({ outcome: "dismissed" });
        expect(record?.decision).toBe("deny");
        expect(block).toBe(true);
    });

    it("records a dry-run sandbox verdict and still prompts when apply is off", async () => {
        const { block, records, classifyCalls, notify } = await runHookCommand({
            command: unresolved,
            decision: modelSection({ apply: false }),
            criterion: "privileged",
        });

        expect(classifyCalls).toBe(1);

        const [record] = records;
        expect(record?.classifier).toMatchObject({
            strategy: "veto",
            provider: DECISION_PROVIDER_ID,
            model: MODEL_ID,
            criterion: "privileged",
            action: "sandbox",
            outcome: "sandbox",
            status: "applied",
            applied: false,
        });
        expect(record?.prompt).toEqual({ outcome: "dismissed" });
        expect(record?.decision).toBe("deny");
        expect(block).toBe(true);
        expect(notify).not.toHaveBeenCalledWith(
            expect.stringContaining("decision model resolved"),
            "info",
        );
    });

    it("applies a sandbox verdict without a prompt when apply is on", async () => {
        const { block, records, classifyCalls, notify } = await runHookCommand({
            command: unresolved,
            decision: modelSection({ apply: true }),
            criterion: "privileged",
        });

        expect(classifyCalls).toBe(1);

        const [record] = records;
        expect(record?.classifier).toMatchObject({
            criterion: "privileged",
            outcome: "sandbox",
            status: "applied",
            applied: true,
        });
        expect(record?.prompt).toBeUndefined();
        expect(record?.decision).toBe("allow:sandbox");
        expect(record?.sandboxed).toBe(true);
        expect(block).toBe(false);
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining("decision model resolved"),
            "info",
        );
    });

    it("keeps a refuse verdict behind the prompt when apply is on", async () => {
        const { block, records } = await runHookCommand({
            command: unresolved,
            decision: modelSection({ apply: true }),
            criterion: "destructive",
        });

        const [record] = records;
        expect(record?.classifier).toMatchObject({
            criterion: "destructive",
            action: "refuse",
            outcome: "abstain",
            status: "abstained",
            applied: false,
            reason: "refuse requires confirmation",
        });
        expect(record?.prompt).toEqual({ outcome: "dismissed" });
        expect(record?.decision).toBe("deny");
        expect(block).toBe(true);
    });

    it("ignores a leftover autoRefuse in the config file", async () => {
        const { block, records } = await runHookCommand({
            command: unresolved,
            decision: modelSection({ apply: true, autoRefuse: true }),
            criterion: "destructive",
        });

        const [record] = records;
        expect(record?.classifier).toMatchObject({
            criterion: "destructive",
            action: "refuse",
            outcome: "abstain",
            status: "abstained",
            applied: false,
            reason: "refuse requires confirmation",
        });
        expect(record?.prompt).toEqual({ outcome: "dismissed" });
        expect(record?.decision).toBe("deny");
        expect(record?.blocked).toBe(true);
        expect(block).toBe(true);
    });

    /**
     * The block reason the agent reads, per kind of no.
     *
     * Every case runs headless (`hasUI: false`), which is what makes the attribution observable: with an
     * interface present a person answers, and "blocked by user" is simply true. The wording is model-facing
     * text, so each case owns an inline snapshot that `-u` rewrites.
     */
    it("attributes a block to whoever actually resolved it", async () => {
        const withheld = await runHookCommand({
            command: unresolved,
            decision: modelSection({ apply: true }),
            criterion: "destructive",
        });
        expect(withheld.block).toBe(true);
        expect(withheld.reason).toMatchInlineSnapshot(
            `"Command execution blocked; the decision model judged it able to destroy data irreversibly (0.90), and only a person can approve a command it refuses. There was no user to ask."`,
        );

        const recordOnly = await runHookCommand({
            command: unresolved,
            decision: modelSection({ apply: false }),
            criterion: "none",
            confidence: 0.95,
        });
        expect(recordOnly.block).toBe(true);
        expect(recordOnly.reason).toMatchInlineSnapshot(
            `"Command execution blocked; the decision model judged it an ordinary command for this runner (0.95), and this session records verdicts without acting on them (record-only mode). There was no user to ask."`,
        );

        const unsure = await runHookCommand({
            command: unresolved,
            decision: modelSection({ apply: true }),
            criterion: "none",
            confidence: 0.4,
        });
        expect(unsure.block).toBe(true);
        expect(unsure.reason).toMatchInlineSnapshot(
            `"Command execution blocked; the decision model judged it an ordinary command for this runner (0.40), and it was not confident enough to let the command through. There was no user to ask."`,
        );

        // With no endpoint configured the model never spoke, and the human-shaped wording is the true one.
        const unconsulted = await runHookCommand({ command: unresolved });
        expect(unconsulted.block).toBe(true);
        expect(unconsulted.reason).toMatchInlineSnapshot(`"Command execution blocked by user."`);

        const granted = await runHookCommand({
            command: unresolved,
            decision: modelSection({ apply: true }),
            criterion: "none",
            confidence: 0.95,
        });
        expect(granted.block).toBe(false);
        expect(granted.reason).toBeUndefined();
        expect(granted.records.at(-1)?.decision).toBe("allow");
    });
});

describe("rule suggestions without an interface", () => {
    it("keeps the table's exact rule and does not ask the model", async () => {
        const { records, classifyCalls } = await runHookCommand({
            command: "npx zorch script.ts",
            decision: modelSection({ apply: false }),
            suggestion: 0.1,
        });

        // The veto consult only: a prompt with no interface will never show a suggestion.
        expect(classifyCalls).toBe(1);
        expect(records[0]?.prompt).toEqual({
            outcome: "dismissed",
            suggestion: "npx zorch script.ts",
            suggestionSource: "table",
        });
    });
});
