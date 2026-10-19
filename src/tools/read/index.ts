import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getUserMemoryDirectory } from "../../common/constants";
import registerFileToolHook from "../file-permissions";

/**
 * The parent's read gate.
 *
 * The user-level memory directory is a read root because the memory system tells the agent to load memories;
 * the decision-model wiring says which outside-root reads may be resolved without asking. `events` is the
 * parent's own bus, which is what makes the footer's auto badge animate while a check is in flight.
 */
export default function registerReadToolHook(pi: ExtensionAPI): void {
    registerFileToolHook(pi, "read", {
        additionalReadRoots: () => [getUserMemoryDirectory()],
        decision: { surface: "parent", events: pi.events },
    });
}
