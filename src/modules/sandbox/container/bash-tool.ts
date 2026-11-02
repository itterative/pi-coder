import {
    createBashToolDefinition,
    type BashOperations,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { ContainerSession } from "./client";

/**
 * pi's bash tool with the container as its backend.
 *
 * The permission verdict is *not* an input here. `allow`, `allow:sandbox`, a model `host` action, and a
 * remembered rule all decide whether a command may run — never where. With this backend registered there is no
 * host-side bash tool left to fall back to, so "host" can only ever mean "no additional sandbox", which is what
 * makes the parent's view of the world consistent: a command that the gates downgraded still runs where the
 * files it touches are the ones the file tools read.
 *
 * That is also why a child runtime gets a different answer: it does not load this module, so its verbatim host
 * bash *is* the host. The deferred per-child container is the work that makes the same sentence true there.
 */
export function containerBashTool(
    sessionFor: (ctx: ExtensionContext) => Promise<ContainerSession>,
    operationsFor: (session: ContainerSession, ctx: ExtensionContext) => BashOperations,
): ReturnType<typeof createBashToolDefinition> {
    const prototype = createBashToolDefinition(process.cwd());

    return {
        ...prototype,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const session = await sessionFor(ctx);
            const tool = createBashToolDefinition(ctx.cwd, {
                operations: operationsFor(session, ctx),
            });

            return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
        },
    };
}
