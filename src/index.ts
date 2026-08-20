import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerBashToolHook from "./tools/bash";

export default function (pi: ExtensionAPI) {
    registerBashToolHook(pi);
}
