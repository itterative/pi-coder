import {
    isToolCallEventType,
    type BashToolInput,
    type ExtensionContext,
    type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { hasAgentAuthority } from "../../definitions/types";
import { guardSafeBashCommand, type SafeBashBlock } from "../safe-bash";
import { scratchpadRoots } from "../roots";
import type { ChildGateRuntime } from "../gates/runtime";

/**
 * Read-only Bash inspection, classified by the shared cwd-confinement heuristic.
 *
 * This unit contributes the `bash` tool; `command-runner` gets it too only because declaring
 * `command-runner` implies `safe-bash` in the declaration layer. The gate that decides *how much* of
 * the tool is usable without asking is selected by the rung, not here.
 */
export const SAFE_BASH_UNIT = {
    id: "safe-bash",
    tools: ["bash"],
} as const;

/**
 * The `safe-bash` scenario inside the confinement gate.
 *
 * A child below the `command` rung has no permission prompt to fall back on, so its Bash calls are
 * classified here rather than asked about: everything must be cwd-confined and heuristically read-only.
 * At or above that rung the command gate owns the decision instead, and this returns undefined so the
 * confinement handler can continue to the read-path check.
 *
 * Note the roots: this check deliberately does *not* include the Bash full-output exception, which
 * applies to direct reads rather than to command classification.
 *
 * Returns a promise when this capability governs the call. A promise is itself the "handled" signal for
 * the confinement gate, so an allowed command still stops the handler there, exactly as it did before
 * the branch was extracted.
 */
export function guardHeuristicBashCall(
    runtime: ChildGateRuntime,
    event: ToolCallEvent,
    ctx: ExtensionContext,
): Promise<SafeBashBlock | undefined> | undefined {
    const { options } = runtime;
    if (hasAgentAuthority(options.authority, "command")) {
        return undefined;
    }
    if (!isToolCallEventType<"bash", BashToolInput>("bash", event)) {
        return undefined;
    }

    const sensitiveRoots = scratchpadRoots(ctx);
    return guardSafeBashCommand(event.input.command, ctx.cwd, {
        safeBash: hasAgentAuthority(options.authority, "inspect"),
        onTrace: options.onTrace,
        additionalRoots: [...(options.additionalPaths ?? []), ...sensitiveRoots],
        sensitiveAdditionalRoots: sensitiveRoots,
        safeBashCommands: options.safeBashCommands,
    });
}
