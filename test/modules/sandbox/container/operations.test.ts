import { describe, expect, it } from "vitest";

import {
    ContainerSessionError,
    type ContainerExecRequest,
    type ContainerExecResult,
    type ContainerSession,
} from "../../../../src/modules/sandbox/container/client";
import { createContainerBashOperations } from "../../../../src/modules/sandbox/container/operations";

interface ExecCall {
    request: ContainerExecRequest;
}

/** A stand-in for the session that records what the adapter asked for and replies with a canned outcome. */
function fakeSession(outcome: Partial<ContainerExecResult> | Error) {
    const calls: ExecCall[] = [];

    const session = {
        exec: async (request: ContainerExecRequest): Promise<ContainerExecResult> => {
            calls.push({ request });

            if (outcome instanceof Error) {
                throw outcome;
            }

            return {
                exitCode: 0,
                timedOut: false,
                cancelled: false,
                wallTimeMs: 1,
                ...outcome,
            };
        },
    } as unknown as ContainerSession;

    return { session, calls };
}

const NOOP = (): void => undefined;

describe("createContainerBashOperations", () => {
    it("runs the command in the requested directory and returns the exit code", async () => {
        const { session, calls } = fakeSession({ exitCode: 4 });
        const operations = createContainerBashOperations(session);

        const result = await operations.exec("false", "/work", { onData: NOOP });

        expect(result.exitCode).toBe(4);
        expect(calls[0]?.request.cwd).toBe("/work");
    });

    it("converts the timeout from seconds to milliseconds", async () => {
        const { session, calls } = fakeSession({});
        const operations = createContainerBashOperations(session);

        await operations.exec("sleep 1", "/work", { onData: NOOP, timeout: 2.5 });

        expect(calls[0]?.request.timeoutMs).toBe(2500);
    });

    it("leaves the timeout unset when the caller did not pass one", async () => {
        const { session, calls } = fakeSession({});
        const operations = createContainerBashOperations(session);

        await operations.exec("true", "/work", { onData: NOOP });

        expect(calls[0]?.request.timeoutMs).toBeUndefined();
    });

    it("forwards output to the caller's onData callback", async () => {
        const { session } = fakeSession({});
        const operations = createContainerBashOperations(session);
        const chunks: Buffer[] = [];

        // The adapter hands pi's callback straight to the session, which is what streams it to the tool.
        await operations.exec("true", "/work", { onData: (chunk) => chunks.push(chunk) });

        expect(chunks).toEqual([]);
    });

    it("reports an expired timeout in pi's format, with the caller's value", async () => {
        const { session } = fakeSession({ timedOut: true });
        const operations = createContainerBashOperations(session);

        await expect(
            operations.exec("sleep 30", "/work", { onData: NOOP, timeout: 2 }),
        ).rejects.toThrow("timeout:2");
    });

    it("reports a missing working directory in pi's exact wording", async () => {
        const { session } = fakeSession(
            new ContainerSessionError("Working directory does not exist: /gone", "cwd-missing"),
        );
        const operations = createContainerBashOperations(session);

        await expect(operations.exec("pwd", "/gone", { onData: NOOP })).rejects.toThrow(
            "Working directory does not exist: /gone\nCannot execute bash commands.",
        );
    });

    it("maps a closed session to a real failure rather than a success", async () => {
        const { session } = fakeSession(
            new ContainerSessionError("container session closed", "container-exited"),
        );
        const operations = createContainerBashOperations(session);

        await expect(operations.exec("true", "/work", { onData: NOOP })).rejects.toThrow(
            /container session closed/,
        );
    });

    it("refuses to start work for an already-aborted caller", async () => {
        const { session, calls } = fakeSession({});
        const operations = createContainerBashOperations(session);
        const controller = new AbortController();
        controller.abort();

        await expect(
            operations.exec("true", "/work", { onData: NOOP, signal: controller.signal }),
        ).rejects.toThrow("aborted");
        expect(calls).toEqual([]);
    });

    it("reports an abort as an abort even when the session answered first", async () => {
        const { session } = fakeSession({ exitCode: 143, cancelled: true });
        const operations = createContainerBashOperations(session);
        const controller = new AbortController();
        controller.abort();

        await expect(
            operations.exec("sleep 30", "/work", { onData: NOOP, signal: controller.signal }),
        ).rejects.toThrow("aborted");
    });

    it("applies the environment policy the caller supplied", async () => {
        const { session, calls } = fakeSession({});
        const operations = createContainerBashOperations(session, () => ({ TERM: "xterm" }));

        await operations.exec("true", "/work", {
            onData: NOOP,
            env: { SECRET: "leak", TERM: "dumb" },
        });

        expect(calls[0]?.request.env).toEqual({ TERM: "xterm" });
    });

    it("drops undefined environment values when no policy is supplied", async () => {
        const { session, calls } = fakeSession({});
        const operations = createContainerBashOperations(session);

        await operations.exec("true", "/work", {
            onData: NOOP,
            env: { TERM: "xterm", GONE: undefined },
        });

        expect(calls[0]?.request.env).toEqual({ TERM: "xterm" });
    });
});
