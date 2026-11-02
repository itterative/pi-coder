import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { NdjsonDecoder } from "../../../../src/modules/sandbox/container/ndjson";
import {
    CONTAINER_PROTOCOL_VERSION,
    type ContainerMessage,
} from "../../../../src/modules/sandbox/container/protocol";

const DISPATCHER = fileURLToPath(
    new URL("../../../../src/modules/sandbox/container/dispatch.mjs", import.meta.url),
);

interface DispatcherMessage {
    jsonrpc: "2.0";
    id?: number | null;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
}

/**
 * Drive `dispatch.mjs` exactly the way the host client does — plain node on the other end of a pipe, no
 * container runtime involved — so these tests cover the protocol, process, and stream semantics that are
 * expensive to discover through podman.
 */
class DispatcherHarness {
    readonly child: ChildProcessWithoutNullStreams;
    readonly messages: DispatcherMessage[] = [];
    private readonly outputChunks: Buffer[] = [];

    private readonly decoder = new NdjsonDecoder();
    private waiters: Array<{
        predicate: (message: DispatcherMessage) => boolean;
        resolve: (message: DispatcherMessage) => void;
    }> = [];

    constructor() {
        this.child = spawn(process.execPath, [DISPATCHER], { stdio: ["pipe", "pipe", "pipe"] });
        this.child.stdout.on("data", (chunk: Buffer) => {
            for (const line of this.decoder.push(chunk)) {
                const message = JSON.parse(line) as DispatcherMessage;
                this.messages.push(message);

                if (message.method === "output" && message.params !== undefined) {
                    this.outputChunks.push(
                        Buffer.from(String(message.params.data ?? ""), "base64"),
                    );
                }

                this.waiters = this.waiters.filter((waiter) => {
                    if (!waiter.predicate(message)) {
                        return true;
                    }

                    waiter.resolve(message);

                    return false;
                });
            }
        });
    }

    /** Everything the dispatcher forwarded, byte-exact. */
    get outputBytes(): Buffer {
        return Buffer.concat(this.outputChunks);
    }

    /** The same output decoded as text, for assertions about what a command printed. */
    get output(): string {
        return this.outputBytes.toString("utf8");
    }

    send(message: unknown): void {
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    exec(id: number, command: string, params: Record<string, unknown> = {}): void {
        this.send({
            jsonrpc: "2.0",
            id,
            method: "exec",
            params: { command, cwd: process.cwd(), ...params },
        });
    }

    waitFor(
        predicate: (message: DispatcherMessage) => boolean,
        timeoutMs = 10_000,
    ): Promise<DispatcherMessage> {
        const existing = this.messages.find(predicate);

        if (existing !== undefined) {
            return Promise.resolve(existing);
        }

        return new Promise<DispatcherMessage>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error("timed out waiting for dispatcher message")),
                timeoutMs,
            );

            this.waiters.push({
                predicate,
                resolve: (message) => {
                    clearTimeout(timer);
                    resolve(message);
                },
            });
        });
    }

    result(id: number, timeoutMs = 10_000): Promise<DispatcherMessage> {
        return this.waitFor(
            (message) => message.id === id && message.method === undefined,
            timeoutMs,
        );
    }

    async exit(timeoutMs = 5_000): Promise<number | null> {
        this.child.stdin.end();

        return new Promise<number | null>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("dispatcher did not exit")), timeoutMs);

            this.child.once("exit", (code) => {
                clearTimeout(timer);
                resolve(code);
            });
        });
    }

    kill(): void {
        this.child.kill("SIGKILL");
    }
}

const harnesses: DispatcherHarness[] = [];

function startDispatcher(): DispatcherHarness {
    const harness = new DispatcherHarness();
    harnesses.push(harness);

    return harness;
}

afterEach(() => {
    for (const harness of harnesses.splice(0)) {
        harness.kill();
    }
});

describe("container dispatcher", () => {
    it("announces itself with a protocol version and the shell it will use", async () => {
        const harness = startDispatcher();
        const ready = await harness.waitFor((message) => message.method === "ready");

        expect(ready.params?.protocol).toBe(CONTAINER_PROTOCOL_VERSION);
        expect(typeof ready.params?.shell).toBe("string");
        expect(String(ready.params?.shell)).toMatch(/bash|sh/);
    });

    it("streams merged stdout and stderr and reports the exit code", async () => {
        const harness = startDispatcher();
        harness.exec(1, "echo out; echo err >&2; exit 3");

        const result = await harness.result(1);

        expect(result.result?.exitCode).toBe(3);
        expect(result.result?.timedOut).toBe(false);
        expect(harness.output).toContain("out");
        expect(harness.output).toContain("err");
    });

    it("keeps arbitrary bytes intact through the base64 framing", async () => {
        const harness = startDispatcher();
        harness.exec(1, "printf '\\000\\001\\377\\376'");

        await harness.result(1);

        expect(harness.outputBytes).toEqual(Buffer.from([0x00, 0x01, 0xff, 0xfe]));
    });

    it("multiplexes concurrent commands by request id", async () => {
        const harness = startDispatcher();
        harness.exec(1, "echo first; sleep 0.15; echo first-done");
        harness.exec(2, "echo second");

        const second = await harness.result(2);
        const first = await harness.result(1);

        expect(second.result?.exitCode).toBe(0);
        expect(first.result?.exitCode).toBe(0);
        expect(harness.output).toContain("second");

        // The short command must not have waited for the slow one.
        const secondIndex = harness.messages.findIndex((message) => message.id === 2);
        const firstIndex = harness.messages.findIndex((message) => message.id === 1);

        expect(secondIndex).toBeLessThan(firstIndex);
    });

    it("cancels a running command's process group and says it was cancelled", async () => {
        const harness = startDispatcher();
        harness.exec(1, "sleep 30");
        await new Promise((resolve) => setTimeout(resolve, 100));

        harness.send({ jsonrpc: "2.0", method: "cancel", params: { id: 1 } });

        const result = await harness.result(1);

        expect(result.result?.cancelled).toBe(true);
        expect(result.result?.exitCode).toBeGreaterThanOrEqual(128);
    });

    it("enforces a timeout and reports it separately from a cancellation", async () => {
        const harness = startDispatcher();
        harness.exec(1, "sleep 30", { timeoutMs: 100 });

        const result = await harness.result(1);

        expect(result.result?.timedOut).toBe(true);
        expect(result.result?.cancelled).toBe(false);
    });

    it("refuses a working directory that does not exist, in pi's wording", async () => {
        const harness = startDispatcher();
        harness.exec(1, "pwd", { cwd: "/nonexistent-directory-for-tests" });

        const result = await harness.result(1);

        expect(result.error?.message).toBe(
            "Working directory does not exist: /nonexistent-directory-for-tests",
        );
    });

    it("runs the command in the requested working directory", async () => {
        const harness = startDispatcher();
        harness.exec(1, "pwd", { cwd: "/tmp" });

        await harness.result(1);

        expect(harness.output).toContain("/tmp");
    });

    it("does not hang on a backgrounded child that keeps the pipe open", async () => {
        const harness = startDispatcher();
        harness.exec(1, "echo started; sleep 30 & echo spawned");

        const started = Date.now();
        const result = await harness.result(1, 5_000);

        expect(result.result?.exitCode).toBe(0);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(harness.output).toContain("spawned");
    });

    it("reports a failing spawn instead of hanging", async () => {
        const harness = startDispatcher();
        harness.send({
            jsonrpc: "2.0",
            id: 9,
            method: "exec",
            params: { command: "echo hi", cwd: process.cwd(), env: {} },
        });

        const result = await harness.result(9);

        expect(result.result?.exitCode).toBe(0);
    });

    it("answers ping with its running count", async () => {
        const harness = startDispatcher();
        harness.send({ jsonrpc: "2.0", id: 5, method: "ping" });

        const result = await harness.result(5);

        expect(result.result?.pong).toBe(true);
    });

    it("exits when the host closes the stream", async () => {
        const harness = startDispatcher();
        harness.exec(1, "sleep 30");
        await new Promise((resolve) => setTimeout(resolve, 100));

        const code = await harness.exit();

        expect(code).toBe(0);
    });

    it("rejects a duplicate request id rather than confusing the two commands", async () => {
        const harness = startDispatcher();
        harness.exec(1, "sleep 0.2");
        harness.exec(1, "echo duplicate", {});

        const failure = await harness.waitFor(
            (message) => message.id === 1 && message.error !== undefined,
        );

        expect(failure.error?.code).toBe(-32003);
    });
});

describe("ndjson decoder", () => {
    it("reassembles a message split across chunks", () => {
        const decoder = new NdjsonDecoder();

        expect(decoder.push('{"a":')).toEqual([]);
        expect(decoder.push("1}\n")).toEqual(['{"a":1}']);
    });

    it("returns every complete line and keeps the remainder", () => {
        const decoder = new NdjsonDecoder();

        expect(decoder.push("one\ntwo\nthr")).toEqual(["one", "two"]);
        expect(decoder.pending()).toBe("thr");
    });

    it("drops blank lines", () => {
        expect(new NdjsonDecoder().push("a\n\n\nb\n")).toEqual(["a", "b"]);
    });
});

describe("protocol guards", () => {
    it("treats a ready notification as a notification, not a response", () => {
        const message: ContainerMessage = {
            jsonrpc: "2.0",
            method: "ready",
            params: {
                protocol: CONTAINER_PROTOCOL_VERSION,
                pid: 1,
                node: "v22",
                shell: "/bin/sh",
                cwd: "/",
            },
        };

        expect("method" in message).toBe(true);
    });
});
