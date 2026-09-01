import registerFileToolHook from "../../../file-permissions";
import { CHILD_CONFINEMENT } from "../policy";
import type { ChildGate } from "./gate";

/**
 * End-user approval for file access outside the child's working directory.
 *
 * Only a same-checkout worker gets these hooks: it borrows the parent's read and write approvals, so an
 * already-approved folder must not prompt twice, while an isolated child relies on its own permission
 * state inside the command gate instead. The read hook's roots deliberately exclude the scratchpad,
 * because `file-permissions` adds that itself; passing it here would silently widen what the shared hook
 * trusts.
 *
 * Installed before the command gate and the confinement handler, both of which consult
 * `isFileAccessApproved` on the same events.
 */
export const FILE_ACCESS_GATE: ChildGate = {
    id: "file-access",
    applies: (runtime) => runtime.options.authority === "mutate",
    install(runtime) {
        const { options, parentContext, bashOutputs, runLabel } = runtime;
        const { agentName, additionalPaths = [] } = options;
        const permissionState = runtime.permissionState;
        // A worker only prompts for outside-cwd access when it actually shares the parent's approval
        // state, and that state exists for exactly the same-checkout case (see `runtime.permissionState`).
        // Testing it here rather than repeating `nonIsolated` in `applies` keeps one owner for the rule,
        // and narrows the type without an assertion.
        if (permissionState === undefined) {
            return;
        }

        const fileHookOptions = {
            state: permissionState,
            promptContext: parentContext,
            restoreSession: false,
            persistSession: false,
            childAccess: true,
            confinement: CHILD_CONFINEMENT,
            permissionPending: runtime.reportPermissionPending,
        };

        registerFileToolHook(runtime.pi, "read", {
            ...fileHookOptions,
            additionalReadRoots: () => [...additionalPaths, ...bashOutputs.active()],
            promptTitle: `[${runLabel}] ${agentName}: allow read path?`,
        });
        registerFileToolHook(runtime.pi, "write", {
            ...fileHookOptions,
            promptTitle: `[${runLabel}] ${agentName}: allow write path?`,
        });
    },
};
