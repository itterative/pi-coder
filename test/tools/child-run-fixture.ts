import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ChildAgentFactoryContext } from "../../src/tools/agent/contracts/runs";
import type { AgentCapability, AgentDefinition } from "../../src/tools/agent/definitions/types";
import { resolveChildGrant, type ChildGrant } from "../../src/tools/agent/child/grant";
import { registerChildExtension } from "../../src/tools/agent/child/extension";
import type { ChildProgress, ChildProgressTracker } from "../../src/tools/agent/child/progress";

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

export interface ChildRunInstallation {
    /** Ordered registration log: `on:<event>` and `tool:<name>`. */
    readonly calls: string[];
    readonly toolCall: Array<(event: unknown, ctx: unknown) => unknown>;
    readonly toolResult: Array<(event: unknown, ctx: unknown) => unknown>;
    readonly sessionStart: Array<(event: unknown, ctx: unknown) => unknown>;
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
            const calls: string[] = [];
            const tools: string[] = [];
            const toolCall: ChildRunInstallation["toolCall"] = [];
            const toolResult: ChildRunInstallation["toolResult"] = [];
            const sessionStart: ChildRunInstallation["sessionStart"] = [];
            const sink = {
                on(event: string, handler: unknown) {
                    calls.push(`on:${event}`);
                    if (event === "tool_call") {
                        toolCall.push(handler as (event: unknown, ctx: unknown) => unknown);
                    }
                    if (event === "tool_result") {
                        toolResult.push(handler as (event: unknown, ctx: unknown) => unknown);
                    }
                    if (event === "session_start") {
                        sessionStart.push(handler as (event: unknown, ctx: unknown) => unknown);
                    }
                },
                registerTool(tool: { name: string }) {
                    calls.push(`tool:${tool.name}`);
                    tools.push(tool.name);
                },
            } as unknown as ExtensionAPI;

            registerChildExtension(tracker, parentContext, cwd, options)(sink);
            return { calls, toolCall, toolResult, sessionStart, tools };
        },
    };
}

/** The context pi hands a handler: the child's cwd, its session manager, and a live signal. */
export function handlerContext(cwd: string): unknown {
    return { cwd, sessionManager: undefined, signal: new AbortController().signal };
}
