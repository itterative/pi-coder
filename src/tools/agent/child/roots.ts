import { getScratchpadPath } from "../../../modules/scratchpad";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The scratchpad root visible to this child, if it has one.
 *
 * A leaf on purpose: the confinement checks, the command gate, and the gate runtime all need exactly
 * this, and each had its own copy of the three-line adapter over the scratchpad module's session lookup.
 * Keeping it here means a change to how the scratchpad is located has one place to go, and the two
 * roots lists a child is checked against cannot drift apart.
 */
export function scratchpadRoots(ctx: ExtensionContext): readonly string[] {
    const scratchpadPath = getScratchpadPath(ctx.sessionManager);
    return scratchpadPath ? [scratchpadPath] : [];
}
