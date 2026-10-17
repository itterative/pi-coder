import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerConfigCommand from "./commands/config";
import { registerCompactionExtension } from "./modules/compaction";
import registerMemoryExtension from "./modules/memory";
import registerScratchpadExtension from "./modules/scratchpad";
import registerTodoListExtension from "./modules/todolist";
import registerAgentTool from "./tools/agent";
import registerAskUserTool from "./tools/ask_user";
import registerBashToolHook from "./tools/bash";
import decisionConfig from "./modules/decision/config";
import { registerDecisionProvider } from "./modules/decision/provider";
import registerReadToolHook from "./tools/read";
import registerWriteToolHook from "./tools/write";
import { registerStatusWidget } from "./tui/status";

export * from "./modules/sandbox/bash";

export default function (pi: ExtensionAPI) {
    // Provider registration has to happen during the factory: pi queues it for startup, which is what lets
    // the classifier be resolved by the time the first permission prompt arrives.
    registerDecisionProvider(pi, decisionConfig.load(process.cwd()));
    registerStatusWidget(pi);
    registerMemoryExtension(pi);
    registerScratchpadExtension(pi);
    registerTodoListExtension(pi);
    registerCompactionExtension(pi);
    registerConfigCommand(pi);
    registerAgentTool(pi);
    registerAskUserTool(pi);
    registerBashToolHook(pi);
    registerReadToolHook(pi);
    registerWriteToolHook(pi);
}
