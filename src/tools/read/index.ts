import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerFileToolHook from "../file-permissions";

export default function registerReadToolHook(pi: ExtensionAPI): void {
    registerFileToolHook(pi, "read");
}
