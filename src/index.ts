import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerConfigCommand from "./commands/config";
import registerMemoryExtension from "./modules/memory";
import registerScratchpadExtension from "./modules/scratchpad";
import registerTodoListExtension from "./modules/todolist";
import registerAgentTool from "./tools/agent";
import registerAskUserTool from "./tools/ask_user";
import registerBashToolHook from "./tools/bash";
import registerReadToolHook from "./tools/read";
import registerWriteToolHook from "./tools/write";
import { registerStatusWidget } from "./tui/status";

export * from "./modules/sandbox/bash";

export default function (pi: ExtensionAPI) {
    registerStatusWidget(pi);
    registerMemoryExtension(pi);
    registerScratchpadExtension(pi);
    registerTodoListExtension(pi);
    registerConfigCommand(pi);
    registerAgentTool(pi);
    registerAskUserTool(pi);
    registerBashToolHook(pi);
    registerReadToolHook(pi);
    registerWriteToolHook(pi);
}
