import path from "node:path";

import {
    isToolCallEventType,
    type ExtensionContext,
    type FindToolInput,
    type GrepToolInput,
    type LsToolInput,
    type ReadToolInput,
    type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { getPathConfinementPermission, Heuristic } from "../../../../modules/sandbox/heuristics";
import { isFileAccessApproved } from "../../../file-permissions";
import { CHILD_CONFINEMENT } from "../policy";
import { guardHeuristicBashCall } from "../capabilities/safe-bash";
import type { ChildGate, ChildGateBlock } from "./gate";
import { scratchpadRoots } from "../roots";
import type { ChildGateRuntime } from "./runtime";

/** Named options for child read-path confinement checks. */
export interface ChildPathOptions {
    additionalRoots?: readonly string[];
    sensitiveAdditionalRoots?: readonly string[];
}

/** Whether a direct read path stays inside the child's allowed roots. */
export function isChildPathAllowed(
    filePath: string | undefined,
    cwd: string,
    options: ChildPathOptions = {},
): boolean {
    const { additionalRoots = [], sensitiveAdditionalRoots = [] } = options;
    const effectivePath = filePath?.trim() || cwd;
    return (
        getPathConfinementPermission(effectivePath, {
            cwd,
            config: CHILD_CONFINEMENT,
            access: "read",
            additionalRoots,
            sensitiveAdditionalRoots,
        }) === Heuristic.SAFE_READONLY
    );
}

/**
 * Confinement of direct reads, and of Bash when no command gate exists.
 *
 * This is a single `tool_call` handler on purpose. Splitting it into two would change the order pi sees
 * decisions in, and the Bash branch has to be consulted first: below the `command` rung a child has no
 * permission prompt to fall back on, so its commands are classified here rather than asked about. The
 * read branch then honours approvals the file-access gate already granted, which is why this gate is
 * installed after it rather than with the other always-on hooks.
 */
export const CONFINEMENT_GATE: ChildGate = {
    id: "confinement",
    install(runtime) {
        runtime.pi.on("tool_call", (event, ctx) => {
            const bashDecision = guardHeuristicBashCall(runtime, event, ctx);
            if (bashDecision) {
                return bashDecision;
            }
            return guardReadPathCall(runtime, event, ctx);
        });
    },
};

/** Blocks a direct read outside the child's roots, and records what it legitimately opened. */
function guardReadPathCall(
    runtime: ChildGateRuntime,
    event: ToolCallEvent,
    ctx: ExtensionContext,
): ChildGateBlock | undefined {
    const filePath = readToolPath(event);
    if (filePath === undefined) {
        return undefined;
    }

    const additionalRoots = runtime.readRoots(ctx);
    const sensitiveRoots = scratchpadRoots(ctx);
    const allowed = isChildPathAllowed(filePath, ctx.cwd, {
        additionalRoots,
        sensitiveAdditionalRoots: sensitiveRoots,
    });
    if (allowed || isFileAccessApproved(event)) {
        runtime.tracker.readFiles.add(relativeReadPath(filePath, ctx.cwd));
        return undefined;
    }

    return {
        block: true,
        reason: "Read-only child access blocked: path is outside the allowed working directory or is sensitive.",
    };
}

function readToolPath(event: ToolCallEvent): string | undefined {
    if (isToolCallEventType<"read", ReadToolInput>("read", event)) return event.input.path;
    if (isToolCallEventType<"grep", GrepToolInput>("grep", event)) return event.input.path;
    if (isToolCallEventType<"find", FindToolInput>("find", event)) return event.input.path;
    if (isToolCallEventType<"ls", LsToolInput>("ls", event)) return event.input.path;
    return undefined;
}

function relativeReadPath(filePath: string | undefined, cwd: string): string {
    const resolved = path.resolve(cwd, filePath?.trim() || ".");
    return path.relative(cwd, resolved) || ".";
}
