import { describe, expect, it, vi } from "vitest";

import type { ContainerSession } from "../../../../src/modules/sandbox/container/client";
import { registerContainerFileTools } from "../../../../src/modules/sandbox/container/file-tools";
import { createPiStub, stubToolInfo } from "../../../helpers/pi-stub";

/**
 * The overrides exist so a tool call and a command answer from the same filesystem, which is only true if the
 * right tools are taken over in the right runtimes. Two rules carry that: never take over a tool the session
 * has not enabled (pi's `ls`, `find`, and `grep` are optional), and never take over a tool another extension
 * registered under a built-in's name.
 */

const BUILTIN_FILE_TOOLS = ["read", "write", "edit", "ls", "find"];

function register(options: { active: string[]; all?: ReturnType<typeof stubToolInfo>[] }) {
    const stub = createPiStub();
    stub.toolSurface.active = [...options.active];
    stub.toolSurface.all = options.all ?? options.active.map((name) => stubToolInfo(name));
    const onSkip = vi.fn();
    const sessionFor = vi.fn(async () => fakeSession());

    registerContainerFileTools(stub.pi, { sessionFor, onSkip });

    return { stub, onSkip, sessionFor };
}

async function startSession(stub: ReturnType<typeof createPiStub>): Promise<void> {
    const handler = stub.handlersFor("session_start")[0];

    if (handler === undefined) {
        throw new Error("no session_start handler registered");
    }

    await handler({}, { cwd: "/repo" });
}

function fakeSession(): ContainerSession {
    return {
        fs: async (request: { op: string; path: string }) => {
            switch (request.op) {
                case "access":
                    return {};
                case "exists":
                    return { exists: true };
                case "readFile":
                    return {
                        data: Buffer.from("from the sandbox\n", "utf8").toString("base64"),
                        size: 17,
                    };
                case "stat":
                    return { isDirectory: false, isFile: true, size: 17 };
                default:
                    return {};
            }
        },
    } as unknown as ContainerSession;
}

describe("container file tool registration", () => {
    it("takes over every active built-in file tool", async () => {
        const { stub } = register({ active: BUILTIN_FILE_TOOLS });

        await startSession(stub);

        expect(stub.tools.map((tool) => tool.name).toSorted()).toEqual(
            BUILTIN_FILE_TOOLS.toSorted(),
        );
    });

    it("never activates a tool the session has not enabled", async () => {
        const { stub } = register({
            active: ["read"],
            all: BUILTIN_FILE_TOOLS.map((name) => stubToolInfo(name)),
        });

        await startSession(stub);

        expect(stub.tools.map((tool) => tool.name)).toEqual(["read"]);
    });

    it("leaves a same-named tool from another extension alone and says why", async () => {
        const { stub, onSkip } = register({
            active: ["read"],
            all: [stubToolInfo("read", { sourceInfo: { path: "/ext/team-tools/read.ts" } })],
        });

        await startSession(stub);

        expect(stub.tools).toEqual([]);
        expect(onSkip).toHaveBeenCalledWith(
            expect.anything(),
            "read",
            "provided by /ext/team-tools/read.ts",
        );
    });

    it("registers nothing twice when a second session starts", async () => {
        const { stub } = register({ active: ["read"] });

        await startSession(stub);
        // A resumed or switched session fires session_start again; the tool registry already holds the override,
        // whose source is this extension rather than a built-in.
        stub.toolSurface.all = [
            stubToolInfo("read", { sourceInfo: { path: "/ext/file-tools.ts" } }),
        ];
        await startSession(stub);

        expect(stub.tools).toHaveLength(1);
    });

    it("answers a read from the container rather than the host", async () => {
        const { stub, sessionFor } = register({ active: ["read"] });
        await startSession(stub);

        const tool = stub.tools.find((entry) => entry.name === "read");
        const result = await tool?.execute(
            "call-1",
            { path: "/repo/notes.txt" },
            undefined,
            undefined,
            { cwd: "/repo" },
        );

        expect(JSON.stringify(result?.content)).toContain("from the sandbox");
        expect(sessionFor).toHaveBeenCalled();
    });
});
