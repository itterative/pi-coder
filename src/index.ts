import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerConfigCommand from "./commands/config";
import { registerCompactionExtension } from "./modules/compaction";
import registerMemoryExtension from "./modules/memory";
import registerRemindersExtension from "./modules/reminders";
import registerScratchpadExtension from "./modules/scratchpad";
import registerTodoListExtension from "./modules/todolist";
import registerAgentTool from "./tools/agent";
import registerAskUserTool from "./tools/ask_user";
import registerBashToolHook from "./tools/bash";
import decisionConfig from "./modules/decision/config";
import { registerDecisionProvider } from "./modules/decision/provider";
import { registerDecisionModelShortcut } from "./tools/decision-settings";
import registerReadToolHook from "./tools/read";
import registerWriteToolHook from "./tools/write";
import { registerStatusFooter } from "./tui/status";

export * from "./modules/sandbox/bash";

export default function (pi: ExtensionAPI) {
    // Provider registration has to happen during the factory: pi queues it for startup, which is what lets
    // the classifier be resolved by the time the first permission prompt arrives.
    registerDecisionProvider(pi, decisionConfig.load(process.cwd()));
    registerDecisionModelShortcut(pi);
    registerStatusFooter(pi);
    registerMemoryExtension(pi);
    registerRemindersExtension(pi);
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
