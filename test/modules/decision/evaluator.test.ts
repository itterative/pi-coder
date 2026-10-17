import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    ClassifierContext,
    ClassifierResult,
    ModelsClassifierOptions,
} from "@earendil-works/pi-ai";

import {
    DECISION_STRATEGIES,
    DecisionEvaluator,
    MAX_CONCURRENT_FORMS,
    SCRIPT_QUESTION,
    VETO_QUESTION,
    type ClassifierRegistry,
    type DecisionContext,
    type DecisionEvaluatorOptions,
    type DecisionModelConfig,
} from "../../../src/modules/decision";
import { decisionContextFor } from "../../../src/modules/decision/gate";
import { stubContext, stubSessionManager } from "../../helpers/pi-stub";

import { classifier, criterionResult, scriptResult, type Classifier } from "./classifier";
import { indentedJson, packageDeploy, sourceLabel } from "./fixtures";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

type Behavior = (
    model: Classifier,
    context: ClassifierContext,
    signal: AbortSignal | undefined,
) => Promise<ClassifierResult>;

/** Answer the criterion question with a label. */
function criterion(reason: string, confidence = 0.9): Behavior {
    return async (model) => criterionResult(model, reason, confidence);
}

interface HarnessOptions {
    models?: Classifier[];
    behavior?: Behavior;
    config?: DecisionModelConfig;
    sandboxAvailable?: boolean;
    clock?: { t: number };
}

function harness(options: HarnessOptions = {}) {
    const models = options.models ?? [classifier("typesafe", "jev-latest")];
    const behavior = options.behavior ?? criterion("none");
    const classify = vi.fn(
        (model: Classifier, context: ClassifierContext, opts?: ModelsClassifierOptions) =>
            behavior(model, context, opts?.signal),
    );
    const registry: ClassifierRegistry = {
        getModelOfType: (_type, provider, modelId) =>
            models.find((model) => model.provider === provider && model.id === modelId),
        getModelsOfType: (_type, provider) =>
            provider === undefined ? models : models.filter((model) => model.provider === provider),
        classify,
    };
    const clock = options.clock ?? { t: 0 };
    const evaluatorOptions: DecisionEvaluatorOptions = {
        registry,
        config: { enabled: true, ...options.config },
        sandboxAvailable: options.sandboxAvailable ?? true,
        now: () => clock.t,
    };
    const evaluator = new DecisionEvaluator(evaluatorOptions);

    return { evaluator, classify, models, clock };
}

const request: DecisionContext = { command: "rm -rf build", cwd: "/repo" };

describe("decision evaluator", () => {
    it("abstains without calling the model when disabled", async () => {
        const { evaluator, classify } = harness({ config: { enabled: false } });
        const verdict = await evaluator.evaluate(request);

        expect(verdict).toMatchObject({
            outcome: "abstain",
            status: "abstained",
            reason: "model disabled",
        });
        expect(classify).not.toHaveBeenCalled();
    });

    it("abstains when no classifier is available", async () => {
        const { evaluator, classify } = harness({ models: [] });
        const verdict = await evaluator.evaluate(request);

        expect(verdict).toMatchObject({
            outcome: "abstain",
            status: "abstained",
            reason: "no classifier model available",
        });
        expect(classify).not.toHaveBeenCalled();
    });

    it("sends one request in the veto strategy's shape", async () => {
        const { evaluator, classify } = harness();
        const verdict = await evaluator.evaluate({
            command: "ls -la",
            cwd: "/repo",
            request: "list files",
            recent: [{ role: "assistant", text: "checking the tree" }],
        });

        expect(classify).toHaveBeenCalledTimes(1);
        const context = classify.mock.calls[0]?.[1];
        expect(context?.state).toMatchObject({
            command: "ls -la",
            cwd: "/repo",
            request: "list files",
            recent_messages: [{ role: "assistant", text: "checking the tree" }],
        });

        const question = context?.questions[VETO_QUESTION];
        expect(question?.type).toBe("choice");
        expect(question?.type === "choice" ? Object.keys(question.criteria) : []).toEqual([
            "none",
            "destructive",
            "privileged",
            "exfiltration",
            "remote_code",
            "loses_content",
            "out_of_scope",
        ]);

        expect(verdict.strategy).toBe("veto");
        expect(verdict.criterion).toBe("none");
    });

    it("reads the criterion into an action through the table", async () => {
        const sandbox = harness({ behavior: criterion("privileged") });
        expect(await sandbox.evaluator.evaluate(request)).toMatchObject({
            outcome: "sandbox",
            status: "applied",
            action: "sandbox",
            criterion: "privileged",
            confidence: 0.9,
        });

        const refuse = harness({ behavior: criterion("destructive") });
        expect(await refuse.evaluator.evaluate(request)).toMatchObject({
            outcome: "abstain",
            status: "abstained",
            reason: "refuse requires confirmation",
            action: "refuse",
            criterion: "destructive",
        });

        const host = harness({ behavior: criterion("none") });
        expect(await host.evaluator.evaluate(request)).toMatchObject({
            outcome: "host",
            status: "applied",
            action: "host",
            criterion: "none",
        });
    });

    it("never lets a refuse act, whatever the config", async () => {
        const { evaluator } = harness({
            behavior: criterion("loses_content"),
            config: { apply: true },
        });
        const verdict = await evaluator.evaluate(request);

        expect(verdict).toMatchObject({
            outcome: "abstain",
            status: "abstained",
            reason: "refuse requires confirmation",
            action: "refuse",
            criterion: "loses_content",
        });
    });

    it("keeps host behind the confidence threshold", async () => {
        const confident = harness({ behavior: criterion("none", 0.9) });
        expect((await confident.evaluator.evaluate(request)).outcome).toBe("host");

        const unsure = harness({ behavior: criterion("none", 0.5) });
        expect(await unsure.evaluator.evaluate(request)).toMatchObject({
            outcome: "abstain",
            reason: "host below confidence threshold",
        });

        const raised = harness({
            behavior: criterion("none", 0.7),
            config: { minConfidence: 0.8 },
        });
        expect(await raised.evaluator.evaluate(request)).toMatchObject({
            outcome: "abstain",
            reason: "host below confidence threshold",
        });
    });

    it("abstains on sandbox when sandboxing is unavailable", async () => {
        const { evaluator } = harness({
            behavior: criterion("privileged"),
            sandboxAvailable: false,
        });
        const verdict = await evaluator.evaluate(request);

        expect(verdict).toMatchObject({
            outcome: "abstain",
            status: "abstained",
            reason: "sandbox unavailable",
        });
    });

    it("abstains when the answer names no criterion", async () => {
        const unknown = harness({ behavior: criterion("something_else") });
        expect(await unknown.evaluator.evaluate(request)).toMatchObject({
            outcome: "abstain",
            reason: "no model answer",
        });
        expect((await unknown.evaluator.evaluate(request)).criterion).toBeUndefined();
    });

    it("asks the history strategy for the same criteria plus the command history", async () => {
        const { evaluator, classify } = harness({ config: { strategy: "history" } });
        const verdict = await evaluator.evaluate({
            command: "ls -la",
            cwd: "/repo",
            request: "list files",
            history: ["cd /repo && git status", "npm run test:run"],
        });

        expect(classify).toHaveBeenCalledTimes(1);
        const context = classify.mock.calls[0]?.[1];
        expect(context?.state).toMatchObject({
            command: "ls -la",
            request: "list files",
            command_history: [
                { command: "cd /repo && git status" },
                { command: "npm run test:run" },
            ],
        });
        expect(context?.questions[VETO_QUESTION]).toEqual(
            DECISION_STRATEGIES.veto.buildRequest({ command: "ls -la", cwd: "/repo" }).questions[
                VETO_QUESTION
            ],
        );
        expect(verdict.strategy).toBe("history");
    });

    it("abstains and cools down after an error result", async () => {
        const clock = { t: 0 };
        const { evaluator, classify } = harness({
            clock,
            config: { cooldownMs: 1000 },
            behavior: async (model) => ({
                ...criterionResult(model, "none", 1),
                stopReason: "error",
                errorMessage: "boom",
            }),
        });

        const first = await evaluator.evaluate(request);
        expect(first).toMatchObject({ outcome: "abstain", status: "error" });
        expect(first.reason).toContain("boom");

        const second = await evaluator.evaluate(request);
        expect(second.reason).toBe("model cooling down");
        expect(classify).toHaveBeenCalledTimes(1);

        clock.t = 1000;
        await evaluator.evaluate(request);
        expect(classify).toHaveBeenCalledTimes(2);
    });

    it("abstains with timeout status when the request exceeds timeoutMs", async () => {
        const { evaluator } = harness({
            config: { timeoutMs: 10 },
            behavior: (model, _context, signal) =>
                new Promise((resolve) => {
                    signal?.addEventListener(
                        "abort",
                        () => {
                            resolve({
                                ...criterionResult(model, "none", 1),
                                stopReason: "aborted",
                            });
                        },
                        { once: true },
                    );
                }),
        });

        const verdict = await evaluator.evaluate(request);

        expect(verdict.outcome).toBe("abstain");
        expect(verdict.status).toBe("timeout");
    });

    it("treats a thrown classifier call as an error", async () => {
        const { evaluator } = harness({
            behavior: async () => {
                throw new Error("network down");
            },
        });

        const verdict = await evaluator.evaluate(request);

        expect(verdict).toMatchObject({ outcome: "abstain", status: "error" });
        expect(verdict.reason).toContain("network down");
    });

    it("resolves an explicitly named model and abstains when it is missing", async () => {
        const jev = classifier("typesafe", "jev-latest");
        const laya = classifier("llamacpp", "laya");

        const named = harness({
            models: [jev, laya],
            config: { provider: "llamacpp", model: "laya" },
        });
        await named.evaluator.evaluate(request);
        expect(named.classify.mock.calls[0]?.[0]).toBe(laya);

        const missing = harness({ models: [jev], config: { provider: "llamacpp", model: "laya" } });
        const verdict = await missing.evaluator.evaluate(request);
        expect(verdict.reason).toBe("no classifier model available");
        expect(missing.classify).not.toHaveBeenCalled();
    });

    it("uses the first classifier for a named provider, and the first overall otherwise", async () => {
        const jev = classifier("typesafe", "jev-latest");
        const laya = classifier("llamacpp", "laya");

        const byProvider = harness({ models: [jev, laya], config: { provider: "llamacpp" } });
        await byProvider.evaluator.evaluate(request);
        expect(byProvider.classify.mock.calls[0]?.[0]).toBe(laya);

        const any = harness({ models: [jev, laya] });
        await any.evaluator.evaluate(request);
        expect(any.classify.mock.calls[0]?.[0]).toBe(jev);
    });
});

/** Two resolved bodies under one command: the invocation line and the file it runs. */
/** Two resolved bodies under one command: the invocation line and the file it runs. */
function scriptContext(
    fileBody = "print(1)",
    fileIdentity = { mtimeMs: 1, size: 8 },
): DecisionContext {
    return {
        command: "npm run run",
        cwd: "/repo",
        script: {
            kind: "package",
            artifacts: [
                {
                    source: "package.json#run",
                    path: "/repo/package.json",
                    text: "python3 scripts/run.py",
                    identity: { mtimeMs: 1, size: 20 },
                },
                {
                    source: "scripts/run.py",
                    path: "/repo/scripts/run.py",
                    text: fileBody,
                    identity: fileIdentity,
                },
            ],
        },
    };
}

interface SubjectAnswers {
    /** One entry per script body, keyed by its text; anything else answers a confident `read_only`. */
    scripts?: Readonly<Record<string, { capability: string; confidence?: number }>>;
    /** The command answer; defaults to a confident `none`. */
    command?: { reason: string; confidence?: number };
}

/** Answer each request by its subject: a capability for a code body, a criterion for the command. */
function bySubject(answers: SubjectAnswers = {}): Behavior {
    return async (model, context) => {
        if (context.questions[SCRIPT_QUESTION] !== undefined) {
            const code = context.state.code;
            const answer = typeof code === "string" ? answers.scripts?.[code] : undefined;

            return scriptResult(
                model,
                answer?.capability ?? "read_only",
                answer?.confidence ?? 0.9,
            );
        }

        return criterionResult(
            model,
            answers.command?.reason ?? "none",
            answers.command?.confidence ?? 0.9,
        );
    };
}

describe("decision evaluator caches", () => {
    it("serves a second identical consult from the answer cache without a request", async () => {
        const { evaluator, classify } = harness({
            behavior: bySubject({ scripts: { "print(1)": { capability: "privileged" } } }),
        });
        const context = scriptContext();

        const first = await evaluator.evaluate(context);
        const second = await evaluator.evaluate(context);

        // Two bodies and the command on the first consult; nothing on the second.
        expect(classify).toHaveBeenCalledTimes(3);
        expect(first).toMatchObject({ outcome: "sandbox" });
        expect(first.cached).toBeUndefined();
        expect(second).toMatchObject({ outcome: "sandbox", cached: true });
        expect(second.usage?.totalTokens).toBe(0);
        expect(second.forms?.map((form) => form.status)).toEqual(["cached", "cached", "cached"]);
    });

    it("reuses one body's verdict across different commands", async () => {
        const { evaluator, classify } = harness({ behavior: bySubject() });

        await evaluator.evaluate(scriptContext());
        await evaluator.evaluate({ ...scriptContext(), command: "npm run other" });

        // Both bodies are content-keyed, so only the second command is sent on the second consult.
        expect(classify).toHaveBeenCalledTimes(4);
        expect(classify.mock.calls.at(-1)?.[1].state.command).toBe("npm run other");
    });

    it("hits when a file's identity moves but its content does not", async () => {
        const { evaluator, classify } = harness({ behavior: bySubject() });

        await evaluator.evaluate(scriptContext());
        await evaluator.evaluate(scriptContext("print(1)", { mtimeMs: 99, size: 42 }));

        // The verdict is a property of the bytes: a touch is not a new script.
        expect(classify).toHaveBeenCalledTimes(3);
    });

    it("re-asks the changed body and the command when a capability changes", async () => {
        const behavior = bySubject({
            scripts: {
                "print(1)": { capability: "read_only" },
                "rm -rf build": { capability: "destructive" },
            },
        });
        const { evaluator, classify } = harness({ behavior });

        await evaluator.evaluate(scriptContext());
        await evaluator.evaluate(scriptContext("rm -rf build"));

        // The package line is unchanged and cached; the file body and the command summary are not.
        expect(classify).toHaveBeenCalledTimes(5);
        expect(classify.mock.calls.at(-1)?.[1].state.script_capabilities).toEqual([
            { source: "package.json#run", capability: "read_only" },
            { source: "scripts/run.py", capability: "destructive" },
        ]);
    });

    it("does not reuse a command verdict for a different runner or isolation", async () => {
        const { evaluator, classify } = harness({ behavior: bySubject() });
        const base = scriptContext();

        await evaluator.evaluate(base);
        await evaluator.evaluate({ ...base, runner: "scout" });
        await evaluator.evaluate({ ...base, isolation: "worktree" });

        // Each command is a different request; the bodies stay cached.
        expect(classify).toHaveBeenCalledTimes(5);
    });

    it("caches a successful answer that names no capability, and still abstains", async () => {
        const behavior: Behavior = async (model, context) =>
            context.questions[SCRIPT_QUESTION] === undefined
                ? criterionResult(model, "none", 0.9)
                : scriptResult(model, "something_else", 0.9);
        const { evaluator, classify } = harness({ behavior });
        const context = scriptContext();

        expect(await evaluator.evaluate(context)).toMatchObject({
            outcome: "abstain",
            reason: "no model answer (package.json#run)",
        });
        expect(await evaluator.evaluate(context)).toMatchObject({
            outcome: "abstain",
            reason: "no model answer (package.json#run)",
            cached: true,
        });
        expect(classify).toHaveBeenCalledTimes(2);
    });

    it("never caches a failure, so the next consult retries", async () => {
        let attempts = 0;
        const behavior: Behavior = async (model, context) => {
            if (context.questions[SCRIPT_QUESTION] !== undefined) {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error("network down");
                }

                return scriptResult(model, "read_only", 0.9);
            }

            return criterionResult(model, "privileged", 0.9);
        };
        const { evaluator, classify } = harness({ config: { cooldownMs: 0 }, behavior });
        const context = scriptContext();

        const failed = await evaluator.evaluate(context);
        const retried = await evaluator.evaluate(context);

        expect(failed).toMatchObject({ outcome: "abstain", status: "error" });
        expect(retried).toMatchObject({ outcome: "sandbox" });
        expect(retried.cached).toBeUndefined();
        // Both bodies on the first consult (one answers, one fails), then the failed body and the command.
        expect(classify).toHaveBeenCalledTimes(4);
    });

    it("memoizes a deterministic size rejection and abstains without a second request", async () => {
        const behavior: Behavior = async (model) => ({
            ...criterionResult(model, "none", 1),
            stopReason: "error" as const,
            errorMessage:
                "input (9000 tokens) is too large to process. increase the physical batch size (current batch size: 2048)",
        });
        const { evaluator, classify } = harness({ config: { cooldownMs: 0 }, behavior });
        const context = scriptContext();

        const first = await evaluator.evaluate(context);
        const second = await evaluator.evaluate(context);

        expect(first).toMatchObject({ outcome: "abstain", status: "error" });
        expect(classify).toHaveBeenCalledTimes(2);
        expect(second).toMatchObject({
            outcome: "abstain",
            status: "abstained",
            reason: "model request previously rejected as too large (package.json#run)",
            cached: true,
        });
        expect(second.usage?.totalTokens).toBe(0);
    });

    it("retries a size-rejected body once its content changes", async () => {
        const { evaluator, classify } = harness({
            config: { cooldownMs: 0 },
            behavior: async (model) => ({
                ...criterionResult(model, "none", 1),
                stopReason: "error" as const,
                errorMessage: "input is too large to process",
            }),
        });

        await evaluator.evaluate(scriptContext());
        await evaluator.evaluate(scriptContext("print(2)"));

        // The unchanged package line stays memoized; only the changed body is sent.
        expect(classify).toHaveBeenCalledTimes(3);
    });

    it("does not reuse a kind-only run's verdict for a run that gained a body", async () => {
        const { evaluator, classify } = harness({ behavior: bySubject() });
        const bare: DecisionContext = {
            command: "npm run missing",
            cwd: "/repo",
            script: { kind: "package", artifacts: [] },
        };
        const withBody: DecisionContext = {
            ...bare,
            script: {
                kind: "package",
                artifacts: [{ source: "package.json#missing", text: "echo now" }],
            },
        };

        await evaluator.evaluate(bare);
        await evaluator.evaluate(withBody);

        expect(classify).toHaveBeenCalledTimes(3);
    });
});

describe("decision evaluator subjects", () => {
    it("classifies each body as code, then the command with their capabilities", async () => {
        const { evaluator, classify } = harness({
            behavior: bySubject({ scripts: { "print(1)": { capability: "writes_files" } } }),
        });
        await evaluator.evaluate(scriptContext());

        expect(classify).toHaveBeenCalledTimes(3);
        const requests = classify.mock.calls.map(([, context]) => context);
        expect(requests[0]?.state).toEqual({ code: "python3 scripts/run.py" });
        expect(requests[1]?.state).toEqual({ code: "print(1)" });
        expect(requests[2]?.state).toMatchObject({
            command: "npm run run",
            cwd: "/repo",
            script_capabilities: [
                { source: "package.json#run", capability: "read_only" },
                { source: "scripts/run.py", capability: "writes_files" },
            ],
        });
    });

    it("folds a dangerous capability into the command's verdict", async () => {
        const { evaluator } = harness({
            behavior: bySubject({
                scripts: { "print(1)": { capability: "privileged", confidence: 0.7 } },
            }),
        });
        const verdict = await evaluator.evaluate(scriptContext());

        expect(verdict).toMatchObject({
            outcome: "sandbox",
            status: "applied",
            action: "sandbox",
            criterion: "privileged",
        });
        expect(verdict.forms).toMatchObject([
            { criterion: "none", action: "host", status: "answered" },
            {
                source: "package.json#run",
                criterion: "read_only",
                action: "host",
                status: "answered",
            },
            {
                source: "scripts/run.py",
                criterion: "privileged",
                action: "sandbox",
                status: "answered",
            },
        ]);
    });

    it("gates host on the command answer, not on a capability's confidence", async () => {
        const { evaluator } = harness({
            behavior: bySubject({
                scripts: {
                    "python3 scripts/run.py": { capability: "read_only", confidence: 0.95 },
                    "print(1)": { capability: "read_only", confidence: 0.7 },
                },
                command: { reason: "none", confidence: 0.9 },
            }),
            config: { minConfidence: 0.8 },
        });
        const verdict = await evaluator.evaluate(scriptContext());

        // A capability is a fact about code, not an authority judgment: it can withhold, but it cannot
        // grant, so an unsure `read_only` does not drag a confident command behind the floor.
        expect(verdict).toMatchObject({
            outcome: "host",
            action: "host",
            criterion: "none",
            confidence: 0.9,
        });
    });

    it("abstains when the command answer is below the floor, however sure the capabilities are", async () => {
        const { evaluator } = harness({
            behavior: bySubject({
                scripts: {
                    "python3 scripts/run.py": { capability: "read_only", confidence: 0.95 },
                    "print(1)": { capability: "read_only", confidence: 0.95 },
                },
                command: { reason: "none", confidence: 0.5 },
            }),
            config: { minConfidence: 0.8 },
        });
        const verdict = await evaluator.evaluate(scriptContext());

        expect(verdict).toMatchObject({
            outcome: "abstain",
            reason: "host below confidence threshold",
            action: "host",
            criterion: "none",
            confidence: 0.5,
        });
    });

    it("applies host when every form is confident", async () => {
        const { evaluator } = harness({
            behavior: bySubject({
                scripts: {
                    "python3 scripts/run.py": { capability: "read_only", confidence: 0.8 },
                    "print(1)": { capability: "read_only", confidence: 0.8 },
                },
                command: { reason: "none", confidence: 0.9 },
            }),
            config: { minConfidence: 0.8 },
        });

        expect((await evaluator.evaluate(scriptContext())).outcome).toBe("host");
    });

    it("sends a named danger on any body to the human as a refusal", async () => {
        const { evaluator } = harness({
            behavior: bySubject({
                scripts: { "print(1)": { capability: "destructive", confidence: 0.7 } },
            }),
        });
        const verdict = await evaluator.evaluate(scriptContext());

        expect(verdict).toMatchObject({
            outcome: "abstain",
            reason: "refuse requires confirmation",
            action: "refuse",
            criterion: "destructive",
        });
    });

    it("withholds a capability the runner's authority does not cover", async () => {
        const { evaluator, classify } = harness({
            behavior: bySubject({
                scripts: { "print(1)": { capability: "writes_outside" } },
            }),
        });
        const verdict = await evaluator.evaluate({ ...scriptContext(), runner: "reviewer" });

        // The command answer may be lenient; the scope gate is not the model's to give away.
        expect(verdict).toMatchObject({
            outcome: "abstain",
            reason: "refuse requires confirmation",
            action: "refuse",
            criterion: "out_of_scope",
        });
        expect(classify).toHaveBeenCalledTimes(3);
        expect(verdict.forms?.at(-1)).toMatchObject({
            subject: "scope",
            criterion: "out_of_scope",
            action: "refuse",
            status: "answered",
        });
    });

    it("leaves a mutating runner's capabilities to the command and script tables", async () => {
        const { evaluator, classify } = harness({
            behavior: bySubject({
                scripts: { "print(1)": { capability: "writes_outside" } },
            }),
        });
        const verdict = await evaluator.evaluate(scriptContext());

        expect(verdict).toMatchObject({ outcome: "sandbox", criterion: "writes_outside" });
        // No scope form was added: the parent's authority covers the capability.
        expect(classify).toHaveBeenCalledTimes(3);
        expect(verdict.forms?.some((form) => form.subject === "scope")).toBe(false);
    });

    it("abstains before asking the command when a body has no answer", async () => {
        const { evaluator, classify } = harness({
            behavior: async (model, context) => {
                if (context.questions[SCRIPT_QUESTION] === undefined) {
                    return criterionResult(model, "none", 0.9);
                }
                if (context.state.code === "print(1)") {
                    throw new Error("network down");
                }

                return scriptResult(model, "read_only", 0.9);
            },
        });
        const verdict = await evaluator.evaluate(scriptContext());

        expect(verdict).toMatchObject({ outcome: "abstain", status: "error" });
        expect(verdict.reason).toContain("network down");
        expect(verdict.reason).toContain("scripts/run.py");
        expect(verdict.forms).toMatchObject([
            { source: "package.json#run", status: "answered" },
            { source: "scripts/run.py", status: "error" },
        ]);
        // The command was never asked: it would be judging an invocation whose code nobody read.
        expect(classify).toHaveBeenCalledTimes(2);
    });

    it("classifies a deep chase in waves, never more than the endpoint's slots", async () => {
        let inFlight = 0;
        let peak = 0;
        const { evaluator, classify } = harness({
            behavior: async (model, context) => {
                if (context.questions[SCRIPT_QUESTION] === undefined) {
                    return criterionResult(model, "none", 0.9);
                }

                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await Promise.resolve();
                inFlight -= 1;

                return scriptResult(model, "read_only", 0.9);
            },
        });
        const artifacts = Array.from({ length: 6 }, (_, index) => ({
            source: `scripts/s${index}.js`,
            path: `/repo/scripts/s${index}.js`,
            text: `// body ${index}`,
            identity: { mtimeMs: 1, size: 8 },
        }));

        await evaluator.evaluate({
            command: "node scripts/s0.js",
            cwd: "/repo",
            script: { kind: "file", artifacts },
        });

        expect(classify).toHaveBeenCalledTimes(7);
        expect(peak).toBe(MAX_CONCURRENT_FORMS);
    });
});

describe("decision evaluator production requests", () => {
    it("pins the script and command requests for a two-body run", async () => {
        const { evaluator, classify } = harness({ behavior: bySubject() });
        await evaluator.evaluate(packageDeploy);

        const artifacts = packageDeploy.script?.artifacts ?? [];
        const requests = classify.mock.calls.map(([, context]) => context);
        expect(requests).toHaveLength(artifacts.length + 1);

        for (const [index, artifact] of artifacts.entries()) {
            const request = requests[index];
            expect(request?.state.code).toBe(artifact.text);
            await expect(indentedJson(request)).toMatchFileSnapshot(
                `__snapshots__/decision-evaluator.script.package-deploy.${sourceLabel(artifact.source)}.json`,
            );
        }

        const command = requests.at(-1);
        expect(command?.state.script_capabilities).toEqual([
            { source: "package.json#deploy", capability: "read_only" },
            { source: "scripts/deploy.js", capability: "read_only" },
        ]);
        await expect(indentedJson(command)).toMatchFileSnapshot(
            "__snapshots__/decision-evaluator.command.package-deploy.json",
        );
    });

    it("pins the script and command requests for bodies read from disk", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decision-evaluator-"));
        temporaryDirectories.push(directory);
        fs.writeFileSync(
            path.join(directory, "package.json"),
            JSON.stringify({ scripts: { run: "python3 run.py" } }),
        );
        fs.writeFileSync(path.join(directory, "run.py"), 'print("hello from run.py")\n');

        // The context comes from the production builder, so the resolver's chase reads both bodies itself
        // and the snapshots hold the text a script really carries rather than a fixture string.
        const context = decisionContextFor(
            stubContext({
                cwd: directory,
                sessionManager: stubSessionManager({ getBranch: () => [] }),
            }),
            "npm run run",
        );
        expect(context.script?.artifacts.map((artifact) => artifact.source)).toEqual([
            "package.json#run",
            "run.py",
        ]);

        const { evaluator, classify } = harness({ behavior: bySubject() });
        await evaluator.evaluate(context);

        const artifacts = context.script?.artifacts ?? [];
        const requests = classify.mock.calls.map(([, request]) => request);
        expect(requests).toHaveLength(artifacts.length + 1);

        for (const [index, artifact] of artifacts.entries()) {
            const request = requests[index];
            expect(request?.state.code).toBe(artifact.text);

            // The temp directory's absolute path changes per run and machine; the bodies are the point of
            // this pin, and they are relative text, so only `cwd` needs the placeholder.
            const pinned = indentedJson(request).replaceAll(directory, "<test-directory>");
            await expect(pinned).toMatchFileSnapshot(
                `__snapshots__/decision-evaluator.script.real-package-run.${sourceLabel(artifact.source)}.json`,
            );
        }

        const command = requests.at(-1);
        const pinnedCommand = indentedJson(command).replaceAll(directory, "<test-directory>");
        await expect(pinnedCommand).toMatchFileSnapshot(
            "__snapshots__/decision-evaluator.command.real-package-run.json",
        );
    });
});
