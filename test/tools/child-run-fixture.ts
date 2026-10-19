import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ChildAgentFactoryContext, ChildProgress } from "../../src/tools/agent/contracts/runs";
import type { AgentCapability, AgentDefinition } from "../../src/tools/agent/definitions/types";
import { resolveChildGrant, type ChildGrant } from "../../src/tools/agent/child/grant";
import { registerChildExtension } from "../../src/tools/agent/child/extension";
import type { ChildProgressTracker } from "../../src/tools/agent/child/progress";
import { DECISION_PROVIDER_ID } from "../../src/modules/decision/provider";
import { createPiStub, type StubHandler } from "../helpers/pi-stub";
import {
    answeringRegistry,
    classifier,
    classifierModelRegistry,
    criterionResult,
} from "../modules/decision/classifier";

/**
 * A decision model wired into the child the way a configured session has one.
 *
 * The fixture writes a real project config and a registry that answers every classification with one
 * criterion, so a gated call reaches the same `consultForGate` path production does - including the
 * `child` surface, which the shipped default (`parent` only) deliberately leaves off.
 */
export interface ChildRunDecision {
    /** Merged over the `decisionModel` section, for the case that needs `apply` off or another floor. */
    readonly config?: Record<string, unknown>;
    /** The criterion every request answers with; a script request would need its own labels. */
    readonly criterion?: string;
    readonly confidence?: number;
}

export interface ChildRunMode {
    readonly isolated?: boolean;
    readonly workspaceId?: string;
    /** `no-ui` denies every prompt, which is the deterministic arm for decision assertions. */
    readonly parentKind?: "tui" | "no-ui";
    readonly defaultBashTimeoutSeconds?: number;
    readonly runTitle?: string;
    /** A parent with no session cannot share approvals, so a same-checkout worker prompts nothing. */
    readonly parentHasNoSession?: boolean;
    /** Absent means no endpoint is configured at all, which is the unmodified production default. */
    readonly decision?: ChildRunDecision;
}

interface ChildRunInstallation {
    /** Ordered registration log: `on:<event>` and `tool:<name>`. */
    readonly calls: string[];
    readonly toolCall: StubHandler[];
    readonly toolResult: StubHandler[];
    readonly sessionStart: StubHandler[];
    readonly tools: string[];
}

export interface ChildRunFixture {
    readonly cwd: string;
    readonly parentContext: ExtensionContext;
    readonly tracker: ChildProgressTracker;
    readonly grant: ChildGrant;
    readonly frames: ChildProgress[];
    readonly traces: string[];
    /** What the parent UI was told, so a suite can pin the notification a verdict produced. */
    readonly notifications: string[];
    /** How many classifications the fixture's registry answered. */
    classifyCalls(): number;
    install(): ChildRunInstallation;
}

export function probeDefinition(
    name: string,
    capabilities: AgentCapability[],
    extra: Partial<AgentDefinition> = {},
): AgentDefinition {
    return {
        name,
        description: `${name} description`,
        capabilities,
        systemPrompt: `You are ${name}.`,
        source: "user",
        ...extra,
    };
}

const DECISION_MODEL_ID = "test-classifier";

/**
 * A project decision config that can actually act on the child surface.
 *
 * `surfaces` defaults to `parent` only and `apply` defaults off, so a fixture that wanted the model to decide
 * would record verdicts and prompt anyway; each case overrides what it means to test.
 */
function writeDecisionConfig(cwd: string, decision: ChildRunDecision): void {
    const directory = path.join(cwd, ".pi");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, "decision-model-config.json"),
        JSON.stringify({
            decisionModel: {
                enabled: true,
                apply: true,
                surfaces: ["parent", "child"],
                baseUrl: "https://classifier.example",
                provider: DECISION_PROVIDER_ID,
                model: DECISION_MODEL_ID,
                minConfidence: 0.8,
                ...decision.config,
            },
        }),
    );
}

/**
 * Builds the inputs a child extension needs and installs it against a recording `pi`.
 *
 * Resolution goes through `resolveChildGrant`, exactly as `createAgentChild` does, so a fixture cannot
 * drift from production by hand-writing an option bag. `install()` is separate because some tests only
 * need the ordered registration and others need to drive the installed handlers.
 */
export function buildChildRun(
    definition: AgentDefinition,
    mode: ChildRunMode = {},
): ChildRunFixture {
    const {
        isolated = false,
        workspaceId,
        parentKind = "tui",
        defaultBashTimeoutSeconds,
        runTitle = "Probe title",
        parentHasNoSession = false,
        decision,
    } = mode;
    // A real directory: the confinement checks resolve paths and stat them, so a fabricated path would
    // change which decisions the fixtures exercise.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-run-"));

    const notifications: string[] = [];
    const decisionModel = classifier(DECISION_PROVIDER_ID, DECISION_MODEL_ID);
    let classifications = 0;
    if (decision !== undefined) {
        writeDecisionConfig(cwd, decision);
    }

    const parentContext = {
        cwd,
        hasUI: parentKind === "tui",
        mode: parentKind === "tui" ? "tui" : "print",
        sessionManager: parentHasNoSession ? undefined : { id: "parent-session" },
        ui: {
            theme: { bold: (text: string) => text },
            notify: (message: string) => {
                notifications.push(message);
            },
        },
        ...(decision === undefined
            ? {}
            : {
                  modelRegistry: classifierModelRegistry(
                      answeringRegistry([decisionModel], async (model) => {
                          classifications += 1;
                          return criterionResult(
                              model,
                              decision.criterion ?? "privileged",
                              decision.confidence ?? 0.9,
                          );
                      }),
                  ),
              }),
    } as unknown as ExtensionContext;

    const context = {
        cwd,
        definition,
        parentContext,
        background: false,
        isolated,
        workspaceId,
        runId: `${definition.name}-1`,
        runTitle,
        defaultBashTimeoutSeconds,
        onProgress: () => {},
    } as unknown as ChildAgentFactoryContext;

    const tracker = {
        progress: { output: "", recentActivity: [], toolCounts: {} },
        lastUpdateAt: 0,
        changedFiles: new Set<string>(),
        readFiles: new Set<string>(),
        bashApproved: false,
        interrupted: false,
    } as unknown as ChildProgressTracker;

    const frames: ChildProgress[] = [];
    const traces: string[] = [];
    const grant = resolveChildGrant(context, parentContext);
    const options = {
        ...grant.extensionOptions,
        onProgress: (progress: ChildProgress) => {
            frames.push({ ...progress, recentActivity: [...progress.recentActivity] });
        },
        onTrace: (type: string) => {
            traces.push(type);
        },
    };

    return {
        cwd,
        parentContext,
        tracker,
        grant,
        frames,
        traces,
        notifications,
        classifyCalls: () => classifications,
        install() {
            const stub = createPiStub();
            registerChildExtension(tracker, parentContext, cwd, options)(stub.pi);
            return {
                calls: stub.order,
                toolCall: stub.handlersFor("tool_call"),
                toolResult: stub.handlersFor("tool_result"),
                sessionStart: stub.handlersFor("session_start"),
                tools: stub.tools.map((tool) => tool.name),
            };
        },
    };
}
