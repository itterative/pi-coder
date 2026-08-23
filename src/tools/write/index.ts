import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerFileToolHook from "../file-permissions";

export default function registerWriteToolHook(pi: ExtensionAPI): void {
    registerFileToolHook(pi, "write");
}
