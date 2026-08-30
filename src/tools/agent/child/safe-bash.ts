import {
    describeUnsafeReason,
    getCwdConfinementAssessment,
    Heuristic,
    type HeuristicAssessment,
} from "../../../modules/sandbox/heuristics";
import type { ChildAgentFactoryContext } from "../contracts/runs";
import { getSafeBashRuntimeBlock } from "./safe-bash-rules";

import type { SandboxConfigCwdConfinement } from "../../../common/config";

const CHILD_CONFINEMENT: SandboxConfigCwdConfinement = {
    enabled: true,
    permission: "allow",
    resolveSymlinks: true,
};

export interface SafeBashBlock {
    block: true;
    reason: string;
}

/** Named options for assessing a delegated agent's bash command. */
export interface SafeBashOptions {
    additionalRoots?: readonly string[];
    sensitiveAdditionalRoots?: readonly string[];
    safeBashCommands?: readonly string[];
}

/** Named options for guarding a delegated agent's bash command. */
export interface SafeBashGuardOptions extends SafeBashOptions {
    safeBash: boolean;
    onTrace?: ChildAgentFactoryContext["onTrace"];
}

/** Assess whether a delegated agent's bash command is cwd-confined and safe. */
export function getSafeBashAssessment(
    command: string,
    cwd: string,
    options: SafeBashOptions = {},
): HeuristicAssessment {
    const { additionalRoots = [], sensitiveAdditionalRoots, safeBashCommands = [] } = options;

    return getCwdConfinementAssessment(command, {
        cwd,
        config: CHILD_CONFINEMENT,
        additionalRoots,
        sensitiveAdditionalRoots,
        customSafeBashCommands: safeBashCommands,
    });
}

/** @deprecated Use getSafeBashAssessment. */
export const getScoutBashAssessment = getSafeBashAssessment;

export function isSafeBashAllowed(
    command: string,
    cwd: string,
    options: SafeBashOptions = {},
): boolean {
    return getSafeBashAssessment(command, cwd, options).classification === Heuristic.SAFE_READONLY;
}

/** @deprecated Use isSafeBashAllowed. */
export const isScoutBashAllowed = isSafeBashAllowed;

/**
 * Applies the safe-bash capability gate. Syntax/path classification belongs to
 * the heuristic; tag-selected contextual checks live in safe-bash-rules.ts.
 */
export async function guardSafeBashCommand(
    command: string,
    cwd: string,
    options: SafeBashGuardOptions,
): Promise<SafeBashBlock | undefined> {
    const { safeBash, onTrace, additionalRoots, sensitiveAdditionalRoots, safeBashCommands } =
        options;

    if (!safeBash) {
        return {
            block: true,
            reason: "Read-only agent bash blocked: the safe-bash capability is not enabled.",
        };
    }

    const assessment = getSafeBashAssessment(command, cwd, {
        additionalRoots,
        sensitiveAdditionalRoots,
        safeBashCommands,
    });
    if (assessment.classification !== Heuristic.SAFE_READONLY) {
        const reasons = assessment.reasons
            .map((reason) => `${describeUnsafeReason(reason)} [${reason}]`)
            .join("; ");
        onTrace?.("safe_bash.blocked", {
            classification: assessment.classification,
            reasons: assessment.reasons.join(", "),
        });
        return {
            block: true,
            reason: `Read-only agent bash blocked: ${reasons}. Commands must be cwd-confined and classified SAFE_READONLY.`,
        };
    }

    const runtimeBlock = await getSafeBashRuntimeBlock(assessment, cwd);
    if (runtimeBlock) {
        onTrace?.("safe_bash.blocked", {
            classification: assessment.classification,
            reasons: runtimeBlock.traceReason,
        });
        return { block: true, reason: runtimeBlock.reason };
    }

    onTrace?.("safe_bash.allowed", { classification: assessment.classification });
    return undefined;
}
