import {
    isToolCallEventType,
    type BashToolInput,
    type ExtensionContext,
    type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { readConfinementFor } from "../../../../modules/sandbox/read-confinement";
import { hasAgentAuthority } from "../../definitions/types";
import { guardSafeBashCommand, type SafeBashBlock } from "../safe-bash";
import { createSafeBashConsult } from "../safe-bash-decision";
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
 * the branch was extracted. An allowlist block also gets the decision model's second opinion when the child
 * surface is enabled; everything else — confinement, flags, parse failures — stays deterministic.
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

    const command = event.input.command;
    const sensitiveRoots = scratchpadRoots(ctx);
    // A container-backed child's own mount set is its boundary, so reads are not re-checked against the cwd.
    // Per runtime: a bubblewrap child of a containerized parent keeps cwd-confined reads. It belongs in
    // `roots`, not only in the guard options below, because the consult re-derives the relaxed assessment
    // from that same object: without it, an allowlist miss naming an absolute container-visible path failed
    // the relaxed pass on `OUTSIDE_CWD`, was reported as unconsultable, and the child saw a plain allowlist
    // refusal for a command its own read boundary allows.
    const readConfinement = readConfinementFor(options.containerBash);
    const roots = {
        additionalRoots: [...(options.additionalPaths ?? []), ...sensitiveRoots],
        sensitiveAdditionalRoots: sensitiveRoots,
        readConfinement,
        ...(options.safeBashCommands === undefined
            ? {}
            : { safeBashCommands: options.safeBashCommands }),
    };

    return guardSafeBashCommand(command, ctx.cwd, {
        ...roots,
        safeBash: hasAgentAuthority(options.authority, "inspect"),
        onTrace: options.onTrace,
        allowUnsafeCommand: createSafeBashConsult({ runtime, ctx, command, roots }),
    });
}
