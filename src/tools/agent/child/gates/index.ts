import { BASH_OUTPUT_GATE } from "./bash-output";
import { COMMAND_GATE } from "./commands";
import { CONFINEMENT_GATE } from "./confinement";
import { FILE_ACCESS_GATE } from "./file-access";
import { INTERACTION_GATE } from "./interaction";
import { gateApplies, type ChildGate } from "./gate";
import type { ChildGateRuntime } from "./runtime";

/**
 * The gates a child runs with, in installation order.
 *
 * The order is not cosmetic; pi runs `tool_call` handlers in registration order and the gates consult
 * each other's decisions:
 *
 * 1. `bash-output` first, because every later root computation asks the ledger for live paths.
 * 2. `file-access` next, so an approval the end user grants is recorded before the command and
 *    confinement gates look for it via `isFileAccessApproved`.
 * 3. `interaction` registers the child's tools, which is independent of the hooks but was always in
 *    this position.
 * 4. `commands` claims `edit`, `write`, and `bash` at the `command` rung and above, serializing them
 *    through its own queue.
 * 5. `confinement` last, so read calls it observes have already had any shared-checkout approval
 *    applied, and a Bash call reaching it means no command gate claimed it.
 *
 * Changing this sequence is a behavior change, and `test/tools/agent-child-gates.test.ts` pins it.
 */
const CHILD_GATES: readonly ChildGate[] = [
    BASH_OUTPUT_GATE,
    FILE_ACCESS_GATE,
    INTERACTION_GATE,
    COMMAND_GATE,
    CONFINEMENT_GATE,
];

/** Installs every gate that applies to this child, in the order documented above. */
export function installChildGates(runtime: ChildGateRuntime): void {
    for (const gate of CHILD_GATES) {
        if (!gateApplies(gate, runtime)) {
            continue;
        }
        gate.install(runtime);
    }
}

// Surface the extension factory and the composition test need; each gate's own module is imported
// directly by whoever installs it, so the individual gates are deliberately not re-exported here.
export { createChildGateRuntime, type ChildGateRuntime } from "./runtime";
export { isChildPathAllowed } from "./confinement";
export { askChildUser, type ChildUserQuestion } from "./interaction";
