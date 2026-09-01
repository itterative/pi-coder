import registerMemoryExtension from "../../../../modules/memory";
import { getUserMemoryDirectory } from "../../../../common/constants";
import type { ChildExtensionRuntime } from "./index";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Indexed project and user memories.
 *
 * Grants the read root that the memory appendix in the child's prompt lists, so the root and the
 * extension that writes the appendix must stay together: publishing the directory without the
 * extension would expose memories the child is never told about, and the reverse would advertise a
 * list the child cannot open.
 */
export const MEMORIES_UNIT = {
    id: "memories",
    readRoots: () => [getUserMemoryDirectory()],
    extension: (_runtime: ChildExtensionRuntime): InlineExtension => ({
        name: "pi-coder-memory-child",
        hidden: true,
        factory: registerMemoryExtension,
    }),
} as const;
