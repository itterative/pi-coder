import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

import { estimateTextTokens } from "./text";

/**
 * Rebuilding the request pi is currently sending, so a summarization call can reuse it.
 *
 * The whole point of the native strategy is that the model reads its own conversation instead of a
 * re-typed copy of it. That only pays off when the request is prefix-identical to what already went out:
 * same system prompt string, same tool array in the same order, same message objects. Hence reading the
 * active tool *names* and mapping them back onto definitions rather than taking every configured tool, and
 * hence `ctx.getSystemPrompt()`, which reflects the override `before_agent_start` handlers installed —
 * pi-coder's own memory and scratchpad blocks included.
 */

/** Tools in `agent.state.tools` order, which is the order pi serialized them in. */
export function activeToolDefinitions(pi: ExtensionAPI): Tool[] {
    const byName = new Map<string, ToolInfo>(pi.getAllTools().map((tool) => [tool.name, tool]));
    const tools: Tool[] = [];
    for (const name of pi.getActiveTools()) {
        const info = byName.get(name);
        if (!info) {
            continue;
        }
        tools.push({ name: info.name, description: info.description, parameters: info.parameters });
    }
    return tools;
}

/** Conservative chars/4 estimate over the exact payload being assembled, matching pi's own heuristic. */
export function estimateRequestTokens(context: Context): number {
    const system = context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0;
    const messages = estimateTextTokens(JSON.stringify(context.messages) ?? "");
    const tools = context.tools ? estimateTextTokens(JSON.stringify(context.tools) ?? "") : 0;
    return system + messages + tools;
}

export interface NativeContextInput {
    systemPrompt: string;
    tools: Tool[];
    messages: Message[];
    instruction: string;
    timestamp: number;
}

export function buildNativeContext(input: NativeContextInput): Context {
    const instructionMessage: Message = {
        role: "user",
        content: [{ type: "text", text: input.instruction }],
        timestamp: input.timestamp,
    };
    return {
        systemPrompt: input.systemPrompt,
        messages: [...input.messages, instructionMessage],
        tools: input.tools,
    };
}

/**
 * Whether the native request can still be sent.
 *
 * The room that matters is the *output* budget, not pi's whole `reserveTokens`: a threshold-triggered
 * compaction runs at exactly `contextWindow - reserveTokens`, so a gate that re-reserved that window would
 * reject every request this strategy exists for. What has to fit alongside the re-sent context is the
 * summary the model is about to write, which is the caller's output budget.
 *
 * Overflow-triggered compaction never reaches this gate: by definition the live context no longer fits, so
 * that reason goes straight to the serialized strategy.
 */
export function nativeRequestFits(
    context: Context,
    contextWindow: number,
    outputBudgetTokens: number,
    reportedContextTokens?: number | null,
): boolean {
    if (contextWindow <= 0) {
        return false;
    }
    // The provider's own count is ground truth and immune to how hot the chars/4 heuristic runs (measured at
    // 1.35x on a JSON-heavy session and 1.12x on a text one, which is the difference between stage 1 running
    // and quietly skipping itself on a 200k window). The live context includes the retained tail that stage 1
    // drops, so treating it as the requirement is conservative in the direction that matters.
    const needed =
        reportedContextTokens && reportedContextTokens > 0
            ? reportedContextTokens
            : estimateRequestTokens(context);
    return needed < contextWindow - outputBudgetTokens;
}
