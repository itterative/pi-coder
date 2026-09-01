import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createChildGateRuntime, installChildGates } from "./gates";
import type { ChildProgressTracker as ProgressTracker } from "./progress";
import type { ChildAgentFactoryContext } from "../contracts/runs";
import type { AgentAuthority } from "../definitions/types";

/**
 * What the child extension needs, all of it already resolved by `resolveChildGrant`.
 *
 * Nothing here is a raw capability flag to be combined: `authority` is the rung, `isolated` is the
 * reconciled run mode, and `canAskUser` already accounts for the parent's ability to host a prompt. An
 * earlier version of this bag carried `allowUserInteraction` plus `workspaceId` and re-derived both
 * decisions here, which is how the same question came to have two answers.
 */
export interface ChildExtensionOptions {
    agentName: string;
    /** Where this child sits on the command-and-mutation ladder; decides which gates get installed. */
    authority: AgentAuthority;
    /** Whether the run owns a workspace, with a workspace id already counted as isolated. */
    isolated: boolean;
    /** Whether this child may prompt the end user, with parent UI availability already counted. */
    canAskUser: boolean;
    runId: string;
    runTitle: string;
    onProgress: ChildAgentFactoryContext["onProgress"];
    onFileChanged?: ChildAgentFactoryContext["onFileChanged"];
    onTrace?: ChildAgentFactoryContext["onTrace"];
    events?: EventBus;
    additionalPaths?: readonly string[];
    safeBashCommands?: readonly string[];
    /** Default timeout applied to Bash calls when the caller sets one, for example workspace setup. */
    defaultBashTimeoutSeconds?: number;
}

/**
 * The child's own pi extension: the factory that arms the gates.
 *
 * Everything a child enforces lives in `child/gates`, in one file per authorization surface, installed
 * in the order recorded in `gates/index.ts`. What remains here is the assembly of the shared runtime
 * that those gates read from, which is why this function is three statements long rather than two
 * hundred lines: the sequencing is the only thing that is genuinely cross-cutting.
 */
export function registerChildExtension(
    tracker: ProgressTracker,
    parentContext: ExtensionContext,
    cwd: string,
    options: ChildExtensionOptions,
) {
    return (pi: ExtensionAPI): void => {
        installChildGates(createChildGateRuntime({ pi, parentContext, cwd, tracker, options }));
    };
}

export {
    getSafeBashAssessment,
    getScoutBashAssessment,
    guardSafeBashCommand,
    isSafeBashAllowed,
    isScoutBashAllowed,
    type SafeBashGuardOptions,
    type SafeBashOptions,
} from "./safe-bash";
export { isChildPathAllowed, type ChildPathOptions } from "./gates";
export {
    askChildUser,
    type ChildUserAnswerDetails,
    type ChildUserAnswerResult,
    type ChildUserQuestion,
} from "./gates";
