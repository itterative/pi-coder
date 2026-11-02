import { describe, expect, it } from "vitest";

import type { BashOperations, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import type { ContainerSession } from "../../../../src/modules/sandbox/container/client";
import { containerBashTool } from "../../../../src/modules/sandbox/container/bash-tool";
import { createContainerBashOperations } from "../../../../src/modules/sandbox/container/operations";
import { stubContext, stubSessionManager } from "../../../helpers/pi-stub";

/**
 * The invariant this pins is the answer to "what does a `host` verdict mean?".
 *
 * Permission decides *whether* a command may run; the backend decides *where*. With the container backend
 * registered there is no host-side bash tool to fall back to, so a command the gates allowed directly — no
 * sandbox wrapper, model action `host`, a remembered rule — still runs in the container. The failure mode this
 * guards against is a future refactor that treats "host" as "use local operations": that would silently put a
 * subset of commands back on the host while the file tools stayed inside.
 */

function toolContext(): ExtensionToolContext {
    return {
        ...stubContext({
            cwd: "/repo",
            sessionManager: stubSessionManager({
                getSessionId: () => "session-1",
                getSessionFile: () => undefined,
            }),
        }),
        tools: [],
        executeTool: async () => {
            throw new Error("bash does not execute nested tools");
        },
    } as unknown as ExtensionToolContext;
}

function recordingSession() {
    const commands: string[] = [];
    const session = {
        exec: async (request: {
            command: string;
            cwd: string;
            onOutput?: (chunk: Buffer) => void;
        }) => {
            commands.push(request.command);
            request.onOutput?.(Buffer.from(`container ran: ${request.command}\n`, "utf8"));

            return { exitCode: 0, timedOut: false, cancelled: false, wallTimeMs: 1 };
        },
    };

    return { session: session as unknown as ContainerSession, commands };
}

describe("container bash tool", () => {
    it("runs a directly allowed command in the container, not on the host", async () => {
        const { session, commands } = recordingSession();
        const localOperations = (): BashOperations => createContainerBashOperations(session);
        const tool = containerBashTool(async () => session, localOperations);

        const result = await tool.execute(
            "call-1",
            { command: "echo hi", timeout: undefined },
            undefined,
            undefined,
            toolContext(),
        );

        expect(commands).toEqual(["echo hi"]);
        expect(JSON.stringify(result.content)).toContain("container ran: echo hi");
    });

    it("resolves the session per call, so a resumed session reaches its own container", async () => {
        const first = recordingSession();
        const second = recordingSession();
        const sessions = [first.session, second.session];
        let calls = 0;
        const tool = containerBashTool(
            async () => sessions[calls++] ?? second.session,
            (session) => createContainerBashOperations(session),
        );

        const run = async () =>
            await tool.execute(
                "call-1",
                { command: "pwd", timeout: undefined },
                undefined,
                undefined,
                toolContext(),
            );

        await run();
        await run();

        expect(first.commands).toEqual(["pwd"]);
        expect(second.commands).toEqual(["pwd"]);
    });
});
