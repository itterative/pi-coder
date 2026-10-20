import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClassifierContext } from "@earendil-works/pi-ai";
import {
    createEventBus,
    type ExtensionContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
    SCRIPT_QUESTION,
    SUGGESTION_QUESTION_ID,
    resetDecisionScriptCache,
    type ClassifierRegistry,
    type DecisionModelConfig,
    type DecisionVerdict,
} from "../../src/modules/decision";
import { decisionEnabled, resetDecisionEvaluator } from "../../src/modules/decision/gate";
import { DECISION_STATUS_EVENT, isDecisionStatusEvent } from "../../src/modules/decision/events";
import { DECISION_PROVIDER_ID } from "../../src/modules/decision/provider";
import { DEFAULT_DECISION_STRATEGY } from "../../src/modules/decision/strategies";
import {
    appliedPermission,
    classifierRecord,
    consultForGate,
    suggestRuleForPrompt,
} from "../../src/tools/decision-model";
import { countedUsage, zeroUsage } from "../helpers/agent-doubles";
import { stubContext, stubSessionManager } from "../helpers/pi-stub";
import {
    answeringRegistry,
    classifier,
    classifierModelRegistry,
    criterionResult,
    scriptResult,
    suggestionResult,
    type Classifier,
} from "../modules/decision/classifier";

/**
 * The bridge between the decision module and the two permission gates: what a verdict may resolve, what the
 * decision log records, and the notify-once consult both gates share.
 *
 * `decisionEnabled` is deliberately not consulted here — that check belongs to the caller — so the suite
 * pins that the bridge consults regardless.
 */

const MODEL_ID = "test-classifier";
const MODEL = classifier(DECISION_PROVIDER_ID, MODEL_ID);

const temporaryDirectories: string[] = [];

afterEach(() => {
    resetDecisionEvaluator();
    resetDecisionScriptCache();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function modelConfig(overrides: DecisionModelConfig = {}): DecisionModelConfig {
    return {
        enabled: true,
        apply: true,
        provider: DECISION_PROVIDER_ID,
        model: MODEL_ID,
        ...overrides,
    };
}

function verdict(overrides: Partial<DecisionVerdict> = {}): DecisionVerdict {
    return {
        outcome: "host",
        status: "applied",
        reason: "model chose host above threshold",
        answers: {},
        latencyMs: 12,
        ...overrides,
    };
}

/** Answer both subjects: a capability for a code body, a criterion for the command. */
function bySubject(capability: string, reason = "none", confidence = 0.9) {
    return async (model: Classifier, context: ClassifierContext) =>
        context.questions[SCRIPT_QUESTION] === undefined
            ? criterionResult(model, reason, confidence)
            : scriptResult(model, capability, confidence);
}

function consultContext(registry: ClassifierRegistry): ExtensionContext {
    return stubContext({
        sessionManager: stubSessionManager({ getBranch: () => [] }),
        modelRegistry: classifierModelRegistry(registry),
    });
}

/**
 * The commands a suggestion consult should be able to see: the branch's bash tool calls, as production
 * records them. Only the fields `decisionSimilarCommands` reads are populated.
 */
function branchWith(commands: readonly string[]): SessionEntry[] {
    return commands.map(
        (command, index) =>
            ({
                type: "message",
                id: `entry-${index}`,
                parentId: null,
                timestamp: String(index + 1),
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: `call-${index}`,
                            name: "bash",
                            arguments: { command },
                        },
                    ],
                    api: "test",
                    provider: "test",
                    model: "test",
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: index + 1,
                },
            }) as SessionEntry,
    );
}

function suggestionContext(
    registry: ClassifierRegistry,
    commands: readonly string[] = [],
): ExtensionContext {
    return stubContext({
        hasUI: true,
        sessionManager: stubSessionManager({ getBranch: () => branchWith(commands) }),
        modelRegistry: classifierModelRegistry(registry),
    });
}

describe("suggestRuleForPrompt", () => {
    it("returns no suggestion without a table row or for multiple uncovered segments", async () => {
        const classify = vi.fn(async (model: Classifier) => suggestionResult(model, 0.1));
        const registry = answeringRegistry([MODEL], classify);
        const context = suggestionContext(registry);

        await expect(
            suggestRuleForPrompt({
                ctx: context,
                config: modelConfig(),
                unresolved: [["kindly-untagged-tool", "--now"]],
                consultModel: true,
            }),
        ).resolves.toBeNull();
        await expect(
            suggestRuleForPrompt({
                ctx: context,
                config: modelConfig(),
                unresolved: [
                    ["npx", "zorch", "script.ts"],
                    ["tail", "-5"],
                ],
                consultModel: true,
            }),
        ).resolves.toBeNull();
        expect(classify).not.toHaveBeenCalled();
    });

    it("keeps the narrow rule without consulting when asked not to", async () => {
        const classify = vi.fn(async (model: Classifier) => suggestionResult(model, 0.1));
        const registry = answeringRegistry([MODEL], classify);

        const suggestion = await suggestRuleForPrompt({
            ctx: suggestionContext(registry),
            config: modelConfig({ suggestions: false }),
            unresolved: [["npx", "zorch", "script.ts"]],
            consultModel: true,
        });

        expect(suggestion).toEqual({ pattern: "npx zorch script.ts", source: "table" });
        expect(classify).not.toHaveBeenCalled();
    });

    it("offers the table's wider rule when the model reads the arguments as data", async () => {
        const classify = vi.fn(async (model: Classifier, context: ClassifierContext) =>
            suggestionResult(model, 0.1),
        );
        const registry = answeringRegistry([MODEL], classify);

        const suggestion = await suggestRuleForPrompt({
            ctx: suggestionContext(registry, ["npx zorch run test/other.test.ts"]),
            config: modelConfig(),
            unresolved: [["npx", "zorch", "script.ts"]],
            consultModel: true,
        });

        expect(suggestion).toEqual({ pattern: "npx zorch *", source: "model" });
        expect(classify.mock.calls[0]?.[1]?.state).toMatchObject({
            command: "npx zorch script.ts",
            recent_commands: ["npx zorch run test/other.test.ts"],
        });
        // The segment's own state must not carry the question's id twice or drop it.
        expect(classify.mock.calls[0]?.[1]?.questions).toHaveProperty(SUGGESTION_QUESTION_ID);
    });

    it("keeps the exact rule when the model reads the argument as code", async () => {
        const registry = answeringRegistry([MODEL], async (model) => suggestionResult(model, 0.9));

        const suggestion = await suggestRuleForPrompt({
            ctx: suggestionContext(registry),
            config: modelConfig(),
            unresolved: [["npx", "zorch", "script.ts"]],
            consultModel: true,
        });

        expect(suggestion).toEqual({ pattern: "npx zorch script.ts", source: "table" });
    });

    it("offers a known wildcard or code executor without a request", async () => {
        const classify = vi.fn(async (model: Classifier) => suggestionResult(model, 0.1));
        const registry = answeringRegistry([MODEL], classify);
        const context = suggestionContext(registry);

        await expect(
            suggestRuleForPrompt({
                ctx: context,
                config: modelConfig(),
                unresolved: [["npx", "vitest", "test/foo.test.ts"]],
                consultModel: true,
            }),
        ).resolves.toEqual({ pattern: "npx vitest *", source: "table" });
        await expect(
            suggestRuleForPrompt({
                ctx: context,
                config: modelConfig(),
                unresolved: [["npx", "tsx", "script.ts"]],
                consultModel: true,
            }),
        ).resolves.toEqual({ pattern: "npx tsx script.ts", source: "table" });
        expect(classify).not.toHaveBeenCalled();
    });
});

describe("appliedPermission", () => {
    it("is undefined unless apply is exactly true", () => {
        expect(appliedPermission({}, verdict({ outcome: "host" }))).toBeUndefined();
        expect(
            appliedPermission({ apply: false }, verdict({ outcome: "sandbox" })),
        ).toBeUndefined();
        expect(appliedPermission({}, verdict({ outcome: "refuse" }))).toBeUndefined();
    });

    it("is undefined for an abstain even with apply on", () => {
        expect(appliedPermission({ apply: true }, verdict({ outcome: "abstain" }))).toBeUndefined();
    });

    it("maps the three actions to permissions", () => {
        expect(appliedPermission({ apply: true }, verdict({ outcome: "host" }))).toBe("allow");
        expect(appliedPermission({ apply: true }, verdict({ outcome: "sandbox" }))).toBe(
            "allow:sandbox",
        );
        expect(appliedPermission({ apply: true }, verdict({ outcome: "refuse" }))).toBe("deny");
    });
});

describe("classifierRecord", () => {
    it("carries the verdict's fields and the applied flag", () => {
        const record = classifierRecord(
            verdict({
                strategy: "history",
                criterion: "privileged",
                action: "sandbox",
                confidence: 0.9,
                outcome: "sandbox",
                reason: "model chose sandbox",
                latencyMs: 42,
                model: { provider: "llama-local", id: "test-model" },
                usage: countedUsage(100, 10),
            }),
            { apply: true },
            true,
        );

        expect(record).toEqual({
            strategy: "history",
            provider: "llama-local",
            model: "test-model",
            criterion: "privileged",
            action: "sandbox",
            confidence: 0.9,
            outcome: "sandbox",
            status: "applied",
            reason: "model chose sandbox",
            latencyMs: 42,
            applied: true,
            tokens: { input: 100, output: 10, total: 110 },
        });
    });

    it("records the command form's own answer beside the folded one", () => {
        const record = classifierRecord(
            verdict({
                criterion: "privileged",
                action: "sandbox",
                confidence: 0.7,
                forms: [
                    {
                        subject: "command",
                        criterion: "none",
                        action: "host",
                        confidence: 0.9,
                        status: "answered",
                        answers: {},
                    },
                    {
                        subject: "script",
                        source: "run.py",
                        criterion: "privileged",
                        action: "sandbox",
                        confidence: 0.7,
                        status: "answered",
                        answers: {},
                    },
                ],
            }),
            {},
            false,
        );

        // The top level is the fold (the script won); `command` keeps the invocation judgment visible.
        expect(record.command).toEqual({
            criterion: "none",
            action: "host",
            confidence: 0.9,
            status: "answered",
        });
    });

    it("falls back to the configured strategy and then to the default", () => {
        expect(classifierRecord(verdict(), { strategy: "history" }, false).strategy).toBe(
            "history",
        );
        expect(classifierRecord(verdict(), {}, false).strategy).toBe(DEFAULT_DECISION_STRATEGY);
    });

    it("omits the optional fields the verdict does not carry", () => {
        const record = classifierRecord(
            verdict({ outcome: "abstain", status: "abstained", reason: "no model answer" }),
            {},
            false,
        );

        expect(record).not.toHaveProperty("provider");
        expect(record).not.toHaveProperty("model");
        expect(record).not.toHaveProperty("criterion");
        expect(record).not.toHaveProperty("action");
        expect(record).not.toHaveProperty("confidence");
        expect(record).not.toHaveProperty("tokens");
        expect(record).not.toHaveProperty("cached");
        expect(record).not.toHaveProperty("command");
        expect(record).not.toHaveProperty("script");
        expect(record).toMatchObject({
            strategy: DEFAULT_DECISION_STRATEGY,
            outcome: "abstain",
            status: "abstained",
            reason: "no model answer",
            applied: false,
        });
    });

    it("carries the cached flag, zero tokens, and the script summary", () => {
        const record = classifierRecord(verdict({ cached: true, usage: zeroUsage() }), {}, false, {
            kind: "package",
            artifacts: [
                { source: "package.json#run", path: "/repo/package.json", text: "python3 run.py" },
                { source: "run.py", path: "/repo/run.py", text: "print(1)" },
            ],
        });

        expect(record).toMatchObject({ cached: true });
        expect(record.tokens).toEqual({ input: 0, output: 0, total: 0 });
        expect(record.script).toEqual({
            kind: "package",
            sources: ["package.json#run", "run.py"],
            chars: "python3 run.py".length + "print(1)".length,
        });
    });

    it("summarizes an incomplete chase with its omission marker and no bodies", () => {
        const record = classifierRecord(verdict(), {}, false, {
            kind: "package",
            artifacts: [{ source: "package.json#a", text: "npm run b" }],
            omissions: [
                { reason: "cycle", source: "package.json#a" },
                { reason: "depth", source: "package.json#z" },
            ],
        });

        expect(record.script).toEqual({
            kind: "package",
            sources: ["package.json#a"],
            chars: "npm run b".length,
            omitted: ["cycle:package.json#a", "depth:package.json#z"],
        });
    });

    it("summarizes a kind-only script run without a body", () => {
        const record = classifierRecord(verdict(), {}, false, { kind: "binary", artifacts: [] });

        expect(record.script).toEqual({ kind: "binary" });
    });
});

describe("consultForGate", () => {
    it("returns a permission and a record when apply resolves the verdict", async () => {
        const registry = answeringRegistry([MODEL], async (model) =>
            criterionResult(model, "privileged", 0.9),
        );
        const notify = vi.fn();

        const consulted = await consultForGate({
            ctx: consultContext(registry),
            config: modelConfig(),
            command: "sudo apt update",
            sandboxAvailable: true,
            label: "this command",
            notify,
        });

        expect(consulted.permission).toBe("allow:sandbox");
        expect(consulted.record).toMatchObject({
            strategy: "veto",
            provider: DECISION_PROVIDER_ID,
            model: MODEL_ID,
            criterion: "privileged",
            action: "sandbox",
            outcome: "sandbox",
            status: "applied",
            applied: true,
        });
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining("decision model resolved"),
            "info",
        );
    });

    it("records the verdict but returns no permission when apply is off", async () => {
        const registry = answeringRegistry([MODEL], async (model) =>
            criterionResult(model, "privileged", 0.9),
        );
        const notify = vi.fn();

        const consulted = await consultForGate({
            ctx: consultContext(registry),
            config: modelConfig({ apply: false }),
            command: "sudo apt update",
            sandboxAvailable: true,
            label: "this command",
            notify,
        });

        expect(consulted.permission).toBeUndefined();
        expect(consulted.record).toMatchObject({
            criterion: "privileged",
            outcome: "sandbox",
            applied: false,
        });
        expect(notify).not.toHaveBeenCalled();
    });

    it("does not notify when the policy abstains", async () => {
        const registry = answeringRegistry([MODEL], async (model) =>
            criterionResult(model, "destructive", 0.9),
        );
        const notify = vi.fn();

        const consulted = await consultForGate({
            ctx: consultContext(registry),
            config: modelConfig(),
            command: "rm -rf build",
            sandboxAvailable: true,
            label: "this command",
            notify,
        });

        // A refuse never resolves, so there is nothing to notify about; the record still reaches the log.
        expect(consulted.permission).toBeUndefined();
        expect(consulted.record).toMatchObject({
            criterion: "destructive",
            outcome: "abstain",
            reason: "refuse requires confirmation",
            applied: false,
        });
        expect(notify).not.toHaveBeenCalled();
    });

    it("consults even when decisionEnabled would refuse the surface", async () => {
        const classify = vi.fn(async (model: typeof MODEL) =>
            criterionResult(model, "privileged", 0.9),
        );
        const registry = answeringRegistry([MODEL], classify);
        const config = modelConfig({ surfaces: [] });

        // This is the caller's check, and it is false here on purpose: reaching the bridge with a config
        // the surface check would reject must still consult, or the two gates would each have to repeat it.
        expect(decisionEnabled(config, "parent")).toBe(false);

        const consulted = await consultForGate({
            ctx: consultContext(registry),
            config,
            command: "sudo apt update",
            sandboxAvailable: true,
            label: "this command",
            notify: () => {},
        });

        expect(classify).toHaveBeenCalledTimes(1);
        expect(consulted.permission).toBe("allow:sandbox");
    });

    it("announces each in-flight check on the caller's bus", async () => {
        const registry = answeringRegistry([MODEL], async (model) =>
            criterionResult(model, "privileged", 0.9),
        );
        const events = createEventBus();
        const statuses: number[] = [];
        events.on(DECISION_STATUS_EVENT, (data) => {
            if (isDecisionStatusEvent(data)) statuses.push(data.checking);
        });

        await consultForGate({
            ctx: consultContext(registry),
            config: modelConfig(),
            command: "sudo apt update",
            sandboxAvailable: true,
            label: "this command",
            notify: () => {},
            events,
        });

        expect(statuses).toEqual([1, 0]);
    });

    it("serves a second identical consult from the cache, with zero tokens", async () => {
        const workspace = scriptWorkspace();
        const classify = vi.fn(bySubject("privileged"));
        const registry = answeringRegistry([MODEL], classify);
        const ctx = scriptConsultContext(workspace.directory, registry);
        const config = modelConfig({ cooldownMs: 0 });

        const first = await scriptConsult(ctx, config, workspace.directory);
        const second = await scriptConsult(ctx, config, workspace.directory);

        // The body and the command on the first consult; nothing on the second.
        expect(classify).toHaveBeenCalledTimes(2);
        expect(first.permission).toBe("allow:sandbox");
        expect(first.record.cached).toBeUndefined();
        expect(second.permission).toBe("allow:sandbox");
        expect(second.record).toMatchObject({ outcome: "sandbox", cached: true });
        expect(second.record.tokens).toEqual({ input: 0, output: 0, total: 0 });
        expect(second.record.command).toEqual({
            criterion: "none",
            action: "host",
            confidence: 0.9,
            status: "cached",
        });
        expect(second.record.script).toEqual({
            kind: "file",
            sources: ["run.py"],
            chars: "print(1)".length,
            answers: [
                {
                    source: "run.py",
                    criterion: "privileged",
                    action: "sandbox",
                    confidence: 0.9,
                    status: "cached",
                },
            ],
        });
    });

    it("misses the verdict cache when the invoked file changes, not only package.json", async () => {
        const workspace = scriptWorkspace();
        fs.writeFileSync(
            path.join(workspace.directory, "package.json"),
            JSON.stringify({ scripts: { run: "python3 run.py" } }),
        );
        const classify = vi.fn(bySubject("read_only"));
        const registry = answeringRegistry([MODEL], classify);
        const ctx = scriptConsultContext(workspace.directory, registry);
        const config = modelConfig({ cooldownMs: 0 });
        const consult = () =>
            consultForGate({
                ctx,
                config,
                command: "npm run run",
                sandboxAvailable: true,
                label: "this command",
                notify: () => {},
            });

        await consult();
        expect((await consult()).record.cached).toBe(true);
        // The invocation line, the invoked file, and the command on the first consult; none on the second.
        expect(classify).toHaveBeenCalledTimes(3);

        // Same package.json, same byte count, new content on the invoked file only.
        fs.writeFileSync(workspace.file, "print(2)");
        fs.utimesSync(workspace.file, new Date(5_000_000), new Date(5_000_000));

        const changed = await consult();
        expect(changed.record.cached).toBeUndefined();
        // Only the invoked file's body was re-asked; the line and the command summary were unchanged.
        expect(classify).toHaveBeenCalledTimes(4);
    });

    it("leaves the prompt unresolved when the cached verdict cannot act", async () => {
        const workspace = scriptWorkspace();
        const registry = answeringRegistry([MODEL], bySubject("privileged"));
        const ctx = scriptConsultContext(workspace.directory, registry);
        const config = modelConfig({ apply: false, cooldownMs: 0 });

        const first = await scriptConsult(ctx, config, workspace.directory);
        const second = await scriptConsult(ctx, config, workspace.directory);

        // The cache stores the model's answer, not its authority: policy runs again on the way out, and
        // `apply` is still the switch that decides whether that answer resolves the prompt.
        expect(first.permission).toBeUndefined();
        expect(second.permission).toBeUndefined();
        expect(second.record).toMatchObject({ outcome: "sandbox", cached: true, applied: false });
    });

    it("does not re-ask for a touched file, only for changed content", async () => {
        const workspace = scriptWorkspace();
        const classify = vi.fn(bySubject("read_only"));
        const registry = answeringRegistry([MODEL], classify);
        const ctx = scriptConsultContext(workspace.directory, registry);
        const config = modelConfig({ cooldownMs: 0 });

        await scriptConsult(ctx, config, workspace.directory);

        // A touch is not a new script: the verdict is a property of the bytes.
        fs.utimesSync(workspace.file, new Date(3_000_000), new Date(3_000_000));
        await scriptConsult(ctx, config, workspace.directory);
        expect(classify).toHaveBeenCalledTimes(2);

        // Changed content is: the body is re-asked, the unchanged command summary is not.
        fs.writeFileSync(workspace.file, "print(2)");
        fs.utimesSync(workspace.file, new Date(4_000_000), new Date(4_000_000));
        await scriptConsult(ctx, config, workspace.directory);
        expect(classify).toHaveBeenCalledTimes(3);
    });

    it("does not cache a failure, and never approves one with apply on", async () => {
        const workspace = scriptWorkspace();
        let attempt = 0;
        const classify = vi.fn(async (model: Classifier, context: ClassifierContext) => {
            if (context.questions[SCRIPT_QUESTION] === undefined) {
                return criterionResult(model, "none", 0.9);
            }

            attempt += 1;
            if (attempt === 1) {
                throw new Error("network down");
            }

            return scriptResult(model, "privileged", 0.9);
        });
        const registry = answeringRegistry([MODEL], classify);
        const ctx = scriptConsultContext(workspace.directory, registry);
        const config = modelConfig({ apply: true, cooldownMs: 0 });

        const failed = await scriptConsult(ctx, config, workspace.directory);
        const callsAfterFailure = classify.mock.calls.length;
        const retried = await scriptConsult(ctx, config, workspace.directory);

        expect(failed.permission).toBeUndefined();
        expect(failed.record).toMatchObject({ status: "error" });
        // The failed body stops the consult before the command is asked; the retry sends body and command.
        expect(callsAfterFailure).toBe(1);
        expect(retried.permission).toBe("allow:sandbox");
        expect(classify).toHaveBeenCalledTimes(3);
    });

    it("memoizes a size rejection and keeps prompting until the script changes", async () => {
        const workspace = scriptWorkspace();
        const classify = vi.fn(async (model: typeof MODEL) => ({
            ...criterionResult(model, "none", 1),
            stopReason: "error" as const,
            errorMessage:
                "input (9000 tokens) is too large to process. increase the physical batch size (current batch size: 2048)",
        }));
        const registry = answeringRegistry([MODEL], classify);
        const ctx = scriptConsultContext(workspace.directory, registry);
        const config = modelConfig({ apply: true, cooldownMs: 0 });

        const first = await scriptConsult(ctx, config, workspace.directory);
        const second = await scriptConsult(ctx, config, workspace.directory);

        expect(first.permission).toBeUndefined();
        expect(first.record).toMatchObject({ status: "error" });
        expect(classify).toHaveBeenCalledTimes(1);
        expect(second.permission).toBeUndefined();
        expect(second.record).toMatchObject({
            status: "abstained",
            reason: "model request previously rejected as too large (run.py)",
            cached: true,
        });
        expect(second.record.tokens).toEqual({ input: 0, output: 0, total: 0 });
    });
});

/** A workspace with one readable script, for the caches that key on the file's identity. */
function scriptWorkspace(): { directory: string; file: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decision-model-cache-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "run.py");
    fs.writeFileSync(file, "print(1)");
    return { directory, file };
}

function scriptConsultContext(directory: string, registry: ClassifierRegistry): ExtensionContext {
    return stubContext({
        cwd: directory,
        sessionManager: stubSessionManager({ getBranch: () => [] }),
        modelRegistry: classifierModelRegistry(registry),
    });
}

function scriptConsult(
    ctx: ExtensionContext,
    config: DecisionModelConfig,
    directory: string,
): ReturnType<typeof consultForGate> {
    return consultForGate({
        ctx,
        config,
        command: `python3 ${path.join(directory, "run.py")}`,
        sandboxAvailable: true,
        label: "this command",
        notify: () => {},
    });
}
