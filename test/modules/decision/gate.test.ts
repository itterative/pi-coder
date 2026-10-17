import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    resetDecisionScriptCache,
    type ClassifierRegistry,
    type DecisionModelConfig,
    type DecisionStrategyId,
} from "../../../src/modules/decision";
import {
    consultDecisionModel,
    decisionContextFor,
    decisionEnabled,
    resetDecisionEvaluator,
} from "../../../src/modules/decision/gate";
import { DECISION_PROVIDER_ID } from "../../../src/modules/decision/provider";
import { zeroUsage } from "../../helpers/agent-doubles";
import { stubContext, stubSessionManager } from "../../helpers/pi-stub";
import {
    answeringRegistry,
    classifier,
    classifierModelRegistry,
    criterionResult,
} from "./classifier";

/**
 * The gate is the bash hook's side of the decision module: which surfaces may consult the model, how the
 * session becomes a context, and the one-evaluator cache behind a never-throwing consult.
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

function contextWithBranch(): ExtensionContext {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decision-gate-"));
    temporaryDirectories.push(directory);
    const session = SessionManager.create(process.cwd(), directory);
    session.appendMessage({ role: "user", content: "inspect the tree", timestamp: 1 });
    session.appendMessage({
        role: "assistant",
        content: [
            { type: "text", text: "Looking at the tree." },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status" } },
        ],
        api: "test",
        provider: "test",
        model: "test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 2,
    });
    session.appendMessage({ role: "user", content: "now run the tests", timestamp: 3 });

    return stubContext({ cwd: "/repo", sessionManager: session });
}

function consultContext(registry: ClassifierRegistry): ExtensionContext {
    return stubContext({
        sessionManager: stubSessionManager({ getBranch: () => [] }),
        modelRegistry: classifierModelRegistry(registry),
    });
}

function modelConfig(overrides: DecisionModelConfig = {}): DecisionModelConfig {
    return {
        enabled: true,
        provider: DECISION_PROVIDER_ID,
        model: MODEL_ID,
        strategy: "veto",
        ...overrides,
    };
}

describe("decisionEnabled", () => {
    it("is false unless enabled is exactly true", () => {
        expect(decisionEnabled({}, "parent")).toBe(false);
        expect(decisionEnabled({ enabled: false }, "parent")).toBe(false);
    });

    it("defaults to the parent surface only", () => {
        expect(decisionEnabled({ enabled: true }, "parent")).toBe(true);
        expect(decisionEnabled({ enabled: true }, "child")).toBe(false);
    });

    it("honours an explicit surface list", () => {
        expect(decisionEnabled({ enabled: true, surfaces: ["child"] }, "parent")).toBe(false);
        expect(decisionEnabled({ enabled: true, surfaces: ["child"] }, "child")).toBe(true);
        expect(decisionEnabled({ enabled: true, surfaces: [] }, "parent")).toBe(false);
    });
});

describe("decisionContextFor", () => {
    it("builds the parent context from the active session branch", () => {
        const context = decisionContextFor(contextWithBranch(), "npm test");

        expect(context).toEqual({
            command: "npm test",
            cwd: "/repo",
            runner: "parent",
            isolation: "checkout",
            script: { kind: "package", artifacts: [] },
            request: "now run the tests",
            recent: [
                { role: "user", text: "inspect the tree" },
                { role: "assistant", text: "Looking at the tree." },
                { role: "command", text: "git status" },
            ],
        });
    });

    it("collects the script bodies the command runs, with each file's identity", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decision-script-"));
        temporaryDirectories.push(directory);
        const packageJson = path.join(directory, "package.json");
        const buildJs = path.join(directory, "build.js");
        fs.writeFileSync(packageJson, JSON.stringify({ scripts: { build: "node build.js" } }));
        fs.writeFileSync(buildJs, "build()");

        const context = decisionContextFor(
            stubContext({
                cwd: directory,
                sessionManager: stubSessionManager({ getBranch: () => [] }),
            }),
            "npm run build",
        );

        expect(context.script).toMatchObject({
            kind: "package",
            artifacts: [
                { source: "package.json#build", path: packageJson, text: "node build.js" },
                { source: "build.js", path: buildJs, text: "build()" },
            ],
        });
        for (const artifact of context.script?.artifacts ?? []) {
            expect(artifact.identity?.size).toBeGreaterThan(0);
            expect(artifact.identity?.mtimeMs).toBeGreaterThan(0);
        }
    });
});

describe("consultDecisionModel", () => {
    it("returns the classifier's verdict for the configured model", async () => {
        const registry = answeringRegistry([MODEL], async (model) =>
            criterionResult(model, "privileged", 0.9),
        );

        const verdict = await consultDecisionModel({
            ctx: consultContext(registry),
            config: modelConfig(),
            command: "sudo apt update",
            sandboxAvailable: true,
        });

        expect(verdict).toMatchObject({
            outcome: "sandbox",
            status: "applied",
            action: "sandbox",
            criterion: "privileged",
            confidence: 0.9,
            strategy: "veto",
        });
    });

    it("abstains with error status instead of throwing when the classifier throws", async () => {
        const registry = answeringRegistry([MODEL], async () => {
            throw new Error("network down");
        });

        const verdict = await consultDecisionModel({
            ctx: consultContext(registry),
            config: modelConfig(),
            command: "sudo apt update",
            sandboxAvailable: true,
        });

        expect(verdict).toMatchObject({ outcome: "abstain", status: "error" });
        expect(verdict.reason).toContain("network down");
    });

    it("keeps one evaluator per settings key and drops it on reset", async () => {
        const classify = vi.fn(async () => {
            throw new Error("boom");
        });
        const registry = answeringRegistry([MODEL], classify);
        const ctx = consultContext(registry);

        const first = await consultDecisionModel({
            ctx,
            config: modelConfig({ cooldownMs: 60_000 }),
            command: "first",
            sandboxAvailable: true,
        });
        expect(first.status).toBe("error");

        const second = await consultDecisionModel({
            ctx,
            config: modelConfig({ cooldownMs: 60_000 }),
            command: "second",
            sandboxAvailable: true,
        });
        expect(second).toMatchObject({ reason: "model cooling down" });
        expect(classify).toHaveBeenCalledTimes(1);

        // A changed setting is a different evaluator, so the cooldown does not carry over.
        await consultDecisionModel({
            ctx,
            config: modelConfig({ cooldownMs: 10_000 }),
            command: "third",
            sandboxAvailable: true,
        });
        expect(classify).toHaveBeenCalledTimes(2);

        // Sandbox availability is part of the same key.
        await consultDecisionModel({
            ctx,
            config: modelConfig({ cooldownMs: 10_000 }),
            command: "fourth",
            sandboxAvailable: false,
        });
        expect(classify).toHaveBeenCalledTimes(3);

        resetDecisionEvaluator();
        await consultDecisionModel({
            ctx,
            config: modelConfig({ cooldownMs: 10_000 }),
            command: "fifth",
            sandboxAvailable: false,
        });
        expect(classify).toHaveBeenCalledTimes(4);
    });

    it("drops cached verdicts on reset", async () => {
        const classify = vi.fn(async (model: typeof MODEL) =>
            criterionResult(model, "privileged", 0.9),
        );
        const registry = answeringRegistry([MODEL], classify);
        const ctx = consultContext(registry);
        const consult = () =>
            consultDecisionModel({
                ctx,
                config: modelConfig({ cooldownMs: 0 }),
                command: "sudo apt update",
                sandboxAvailable: true,
            });

        await consult();
        const cached = await consult();
        expect(cached.cached).toBe(true);
        expect(classify).toHaveBeenCalledTimes(1);

        resetDecisionEvaluator();
        const afterReset = await consult();
        expect(afterReset.cached).toBeUndefined();
        expect(classify).toHaveBeenCalledTimes(2);
    });

    it("falls back to the default strategy for an id that is not one", async () => {
        const registry = answeringRegistry([MODEL], async (model) =>
            criterionResult(model, "none", 1),
        );

        // `strategyField` cannot produce this any more (`Object.hasOwn`), and `resolveStrategy` guards it
        // anyway: an unknown name must not reach past the strategy lookup and take the handler down.
        const verdict = await consultDecisionModel({
            ctx: consultContext(registry),
            config: modelConfig({ strategy: "toString" as DecisionStrategyId }),
            command: "ls",
            sandboxAvailable: true,
        });

        expect(verdict).toMatchObject({ outcome: "host", status: "applied" });
        expect(verdict.strategy).toBe("veto");
    });

    it("abstains instead of rejecting when the context cannot provide a session branch", async () => {
        const registry = answeringRegistry([MODEL], async (model) =>
            criterionResult(model, "none", 1),
        );

        // Context building is inside the catch: the hook that calls this has no error handling of its own.
        const verdict = await consultDecisionModel({
            ctx: stubContext({ modelRegistry: classifierModelRegistry(registry) }),
            config: modelConfig(),
            command: "ls",
            sandboxAvailable: true,
        });

        expect(verdict).toMatchObject({ outcome: "abstain", status: "error" });
        expect(verdict.reason).toContain("decision model failed");
    });
});
