import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerConfigCommand from "./commands/config";
import registerStatsCommand from "./commands/stats";
import { registerCompactionExtension } from "./modules/compaction";
import registerContainerSandbox from "./modules/sandbox/container";
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
import registerCodeTool from "./tools/code";
import { registerStatusFooter } from "./tui/status";

export * from "./modules/sandbox/bash";

export default function (pi: ExtensionAPI) {
    // Provider registration has to happen during the factory: pi queues it for startup, which is what lets
    // the classifier be resolved by the time the first permission prompt arrives.
    registerDecisionProvider(pi, decisionConfig.load(process.cwd()));
    registerDecisionModelShortcut(pi);
    registerStatusFooter(pi);
    const memory = registerMemoryExtension(pi);
    registerRemindersExtension(pi, { pinnedText: () => memory.pinnedText() });
    registerScratchpadExtension(pi);
    registerTodoListExtension(pi);
    registerCompactionExtension(pi);
    registerConfigCommand(pi);
    registerStatsCommand(pi);
    registerAgentTool(pi);
    registerAskUserTool(pi);
    // The backend registers first so its `session_start` resolves the backend before the bash hook decides
    // whether a `bwrap` binary is needed at all; the resulting state is what the hook reads.
    const container = registerContainerSandbox(pi);
    registerBashToolHook(pi, container);
    registerReadToolHook(pi, container);
    registerWriteToolHook(pi, container);
    registerCodeTool(pi, container);
}
