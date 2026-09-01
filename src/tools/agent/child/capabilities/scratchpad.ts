import registerScratchpadExtension from "../../../../modules/scratchpad";
import type { ChildExtensionRuntime } from "./index";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * A private temporary directory for the run.
 *
 * The extension owns publishing the path and blocking symlink escapes from it; this unit owns that the
 * extension exists. `todolist` implies this capability, which is why the todo file can live inside the
 * scratchpad.
 */
export const SCRATCHPAD_UNIT = {
    id: "scratchpad",
    extension: (_runtime: ChildExtensionRuntime): InlineExtension => ({
        name: "pi-coder-scratchpad-child",
        hidden: true,
        factory: registerScratchpadExtension,
    }),
} as const;
