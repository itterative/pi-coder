import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerConfigCommand from "./commands/config";
import registerMemoryExtension from "./modules/memory";
import registerAskUserTool from "./tools/ask_user";
import registerBashToolHook from "./tools/bash";

export default function (pi: ExtensionAPI) {
    registerMemoryExtension(pi);
    registerConfigCommand(pi);
    registerAskUserTool(pi);
    registerBashToolHook(pi);
}
