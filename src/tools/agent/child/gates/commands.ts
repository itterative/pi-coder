import { registerCommandPermissionHooks } from "../command-permissions";
import { hasAgentAuthority } from "../../definitions/types";
import type { ChildGate } from "./gate";

/**
 * The permission gate for commands and mutations.
 *
 * Installed at the `command` rung and above, which is the whole of what used to be spelled
 * `canEdit || commandRunner`: a child that can run gated commands, or edit directly, must serialize its
 * calls and route the unresolved ones to the end user. Below that rung the heuristic bash guard handles
 * commands instead, and no prompt exists at all.
 *
 * The gate itself decides *how* each call is approved and how the dialog queue, sandbox mode, and
 * remembered rules behave; it does not decide who gets gated, and holds no capability flags of its own
 * beyond the identity and roots it is handed.
 */
export const COMMAND_GATE: ChildGate = {
    id: "commands",
    applies: (runtime) => hasAgentAuthority(runtime.options.authority, "command"),
    install(runtime) {
        const { options, parentContext, tracker, permissionState, parentPermissionState } = runtime;
        const {
            agentName,
            runId,
            runTitle,
            isolated,
            additionalPaths = [],
            safeBashCommands = [],
            defaultBashTimeoutSeconds,
            events,
            onTrace,
            onFileChanged,
        } = options;

        registerCommandPermissionHooks(runtime.pi, {
            parentContext,
            events,
            runId,
            runTitle,
            agentName,
            isolated,
            defaultBashTimeoutSeconds,
            additionalReadRoots: additionalPaths,
            safeBashCommands,
            permissionState,
            permissionPending: runtime.reportPermissionPending,
            fileChanged(filePath) {
                const wasChanged = tracker.changedFiles.has(filePath);
                tracker.changedFiles.add(filePath);
                if (!wasChanged) {
                    onFileChanged?.(filePath);
                }
                onTrace?.("mutation.file_changed", { path: filePath });
            },
            bashApproved() {
                tracker.bashApproved = true;
                onTrace?.("mutation.bash_approved");
            },
            bashRuleRemembered(pattern, permission) {
                // An isolated child does not inherit parent rules, but an explicit end-user remember
                // choice is an instruction to update the parent session for later parent calls.
                if (!isolated || parentPermissionState === undefined) {
                    return;
                }
                parentPermissionState.bashRules[pattern] = permission;
            },
        });
    },
};
