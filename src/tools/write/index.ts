import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerFileToolHook from "../file-permissions";

/**
 * The parent's write gate.
 *
 * Writes get no extra root here beyond what `files`/`sandbox.mounts` declare: the user memory directory is a
 * read root only, because writing user-level memories is a decision the parent makes deliberately and a
 * folder-wide grant would make it a side effect of the last edit. The decision wiring lets an outside write be
 * resolved without a prompt only when the request named it and writing it loses nothing.
 */
export default function registerWriteToolHook(pi: ExtensionAPI): void {
    registerFileToolHook(pi, "write", { decision: { surface: "parent", events: pi.events } });
}
