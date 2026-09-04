import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ChildAgentFactoryContext, ChildProgress } from "../../src/tools/agent/contracts/runs";
import type { AgentCapability, AgentDefinition } from "../../src/tools/agent/definitions/types";
import { resolveChildGrant, type ChildGrant } from "../../src/tools/agent/child/grant";
import { registerChildExtension } from "../../src/tools/agent/child/extension";
import type { ChildProgressTracker } from "../../src/tools/agent/child/progress";
import { createPiStub, type StubHandler } from "../helpers/pi-stub";

export interface ChildRunMode {
    readonly isolated?: boolean;
    readonly workspaceId?: string;
    /** `no-ui` denies every prompt, which is the deterministic arm for decision assertions. */
    readonly parentKind?: "tui" | "no-ui";
    readonly defaultBashTimeoutSeconds?: number;
    readonly runTitle?: string;
    /** A parent with no session cannot share approvals, so a same-checkout worker prompts nothing. */
    readonly parentHasNoSession?: boolean;
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
    } = mode;
    // A real directory: the confinement checks resolve paths and stat them, so a fabricated path would
    // change which decisions the fixtures exercise.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-run-"));

    const parentContext = {
        cwd,
        hasUI: parentKind === "tui",
        mode: parentKind === "tui" ? "tui" : "print",
        sessionManager: parentHasNoSession ? undefined : { id: "parent-session" },
        ui: { theme: { bold: (text: string) => text } },
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
