import registerMemoryExtension from "../../../../modules/memory";
import registerRemindersExtension from "../../../../modules/reminders";
import { getUserMemoryDirectory } from "../../../../common/constants";
import type { ChildExtensionRuntime, NamedInlineExtension } from "./index";

/**
 * Indexed project and user memories.
 *
 * Grants the read root that the memory appendix in the child's prompt lists, so the root and the
 * extension that writes the appendix must stay together: publishing the directory without the
 * extension would expose memories the child is never told about, and the reverse would advertise a
 * list the child cannot open. The factory also registers the memory-scoped reminder schedule, so a
 * child keeps the nudge that points at the appendix.
 */
export const MEMORIES_UNIT = {
    id: "memories",
    readRoots: () => [getUserMemoryDirectory()],
    extension: (_runtime: ChildExtensionRuntime): NamedInlineExtension => ({
        name: "pi-coder-memory-child",
        hidden: true,
        // The appendix and the reminder that points at it are one unit: registering the appendix without
        // the memory-scoped reminder would drop the nudge children received before reminders existed.
        factory: (pi) => {
            registerMemoryExtension(pi);
            registerRemindersExtension(pi, { scope: "memory" });
        },
    }),
} as const;
