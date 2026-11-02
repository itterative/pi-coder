import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PI_CODER_EXTENSION_DIR } from "../../../common/constants";
import { buildPodmanArgs, containerNameFor, type ContainerMount } from "./args";
import { gitConfigFile, type GitIdentity } from "./git-identity";
import { NdjsonDecoder } from "./ndjson";
import {
    CONTAINER_ERROR_CODES,
    CONTAINER_PROTOCOL_VERSION,
    type ContainerFsRequest,
    type ContainerFsResult,
    type ContainerFsResults,
    type ContainerMessage,
    type ContainerReadyParams,
    type ContainerResultPayload,
} from "./protocol";

/**
 * One container per session, reached through a single long-lived dispatcher process over stdin/stdout.
 *
 * Why not one `podman exec` per command: measured on the reference machine, a fresh `podman exec` costs
 * ~125 ms more than the `bwrap` call it would replace, while a command multiplexed over the session's
 * existing stdin/stdout costs ~0.6 ms. Concurrency is therefore a protocol property (one request id per
 * command) rather than a pool of exec sessions.
 *
 * Lifetime is the session's: `podman run --interactive` keeps the container attached, the dispatcher
 * treats stdin EOF as "exit", and `--rm` removes the container when that happens. No watchdog, no
 * heartbeat, no timeout guess — the reader is the lifetime.
 */

/** Injectable launch, so tests can run the dispatcher under plain node without podman. */
export type ContainerLaunch = (command: string, args: readonly string[]) => ChildProcess;

export interface ContainerSessionOptions {
    /** Session working directory: mounted at its real path and used as the container workdir. */
    cwd: string;
    image: string;
    sessionId: string;
    /** Host directory mounted as the container user's `$HOME`; shared by every session on this machine. */
    homeDir: string;
    podmanPath?: string;
    /**
     * Every mount, in the order podman should apply them — the working directory included. The caller owns
     * the list because it is a sandbox *posture*: which paths are read-only, and which of them a read-only
     * runtime may reach at all, is a policy decision, and this class is only the transport.
     */
    mounts?: readonly ContainerMount[];
    /** The dispatcher's Node binary inside the image; defaults to `node` on `PATH`. */
    nodePath?: string;
    /** Forces the in-container shell; by default the dispatcher picks bash when the image has it. */
    shell?: string;
    /**
     * The dispatcher to mount into the container. Defaults to the sibling `dispatch.mjs`; an explicit path
     * exists because a bundler rewrites `import.meta.url`, and tooling that bundles this module must still be
     * able to say where the dispatcher lives.
     */
    dispatcherPath?: string;
    /** Seeded into the sandbox home as `.gitconfig`, so commits inside are attributed like commits outside. */
    gitIdentity?: GitIdentity;
    /** `none` starts the container without a route or a resolver; `host` shares the user's network. */
    network?: "none" | "egress" | "host";
    /** Ports to publish to the host; the posture has already defaulted them to loopback. */
    publish?: readonly string[];
    /** Host device nodes to pass through, and whether to keep the user's groups so they are usable. */
    devices?: readonly string[];
    keepGroups?: boolean;
    spawn?: ContainerLaunch;
    /** Receives the container's stderr, which is diagnostics rather than protocol. */
    onDiagnostics?: (line: string) => void;
    startTimeoutMs?: number;
    stopTimeoutMs?: number;
}

export interface ContainerExecRequest {
    command: string;
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    onOutput?: (chunk: Buffer) => void;
}

/**
 * An argv launch with no shell in between, for tools that already own their arguments (ripgrep, for the
 * container-backed `grep`). Streams are delivered separately because a tool parsing structured stdout must
 * not see stderr interleaved with it.
 */
export interface ContainerSpawnRequest {
    file: string;
    args: readonly string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    onChunk?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
}

export interface ContainerExecResult {
    exitCode: number | null;
    timedOut: boolean;
    cancelled: boolean;
    wallTimeMs: number;
}

export type ContainerFailureKind =
    | "start"
    | "container-exited"
    | "protocol"
    | "cwd-missing"
    | "spawn-failed"
    | "aborted"
    | "fs-failed";

export class ContainerSessionError extends Error {
    constructor(
        message: string,
        readonly kind: ContainerFailureKind,
    ) {
        super(message);
        this.name = "ContainerSessionError";
    }
}

interface PendingExec {
    resolve: (result: ContainerExecResult) => void;
    reject: (error: Error) => void;
    onOutput?: (chunk: Buffer) => void;
    onChunk?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
    cleanup: () => void;
}

interface PendingFs {
    resolve: (result: ContainerFsResult) => void;
    reject: (error: Error) => void;
}

/** First run may pull the image, so readiness allows far longer than a warm start (~135 ms measured). */
const DEFAULT_START_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
/** A wedged dispatcher must not hang a tool call forever after the caller aborted. */
const ABORT_BACKSTOP_MS = 10_000;
const MAX_DIAGNOSTIC_LINES = 40;

export class ContainerSession {
    readonly containerName: string;

    private readonly options: ContainerSessionOptions;
    private readonly child: ChildProcess;
    private readonly decoder = new NdjsonDecoder();
    private readonly pending = new Map<number, PendingExec>();
    private readonly pendingFs = new Map<number, PendingFs>();
    private readonly diagnostics: string[] = [];

    private nextId = 1;
    private stderrBuffer = "";
    private ready: ContainerReadyParams | undefined;
    private closed = false;
    private closePromise: Promise<void> | undefined;
    private readyResolve: ((session: ContainerSession) => void) | undefined;
    private readyReject: ((error: Error) => void) | undefined;
    private readyTimer: NodeJS.Timeout | undefined;

    private constructor(options: ContainerSessionOptions, child: ChildProcess) {
        this.options = options;
        this.child = child;
        this.containerName = containerNameFor(options.sessionId);
        this.attach();
    }

    static async start(options: ContainerSessionOptions): Promise<ContainerSession> {
        // A keep-id container runs as the host user, so the image's own /root is off limits: the home has to
        // be owned by that user, because npm and git fail on their first cache or global-config write. The
        // mount target is the real home path, so `~` means the same thing inside and outside. It is shared
        // across sessions on purpose: caches then survive a session instead of being thrown away with it.
        const home = options.homeDir;
        await fs.promises.mkdir(home, { recursive: true });
        await seedGitConfig(home, options.gitIdentity);

        const args = buildPodmanArgs({
            image: options.image,
            containerName: containerNameFor(options.sessionId),
            sessionId: options.sessionId,
            cwd: options.cwd,
            dispatcherPath: resolveDispatcherPath(options.dispatcherPath),
            home: { source: home, target: os.homedir() },
            mounts: options.mounts ?? [],
            nodePath: options.nodePath,
            shell: options.shell,
            network: options.network,
            publish: options.publish,
            devices: options.devices,
            keepGroups: options.keepGroups,
        });

        const launch = options.spawn ?? defaultLaunch;
        let child: ChildProcess;

        try {
            child = launch(options.podmanPath ?? "podman", args);
        } catch (error) {
            throw new ContainerSessionError(
                `cannot start container: ${error instanceof Error ? error.message : String(error)}`,
                "start",
            );
        }

        const session = new ContainerSession(options, child);
        await session.awaitReady();

        return session;
    }

    /** The shell the dispatcher runs commands with (`bash` when the image provides it). */
    get shell(): string {
        return this.ready?.shell ?? "/bin/sh";
    }

    get nodeVersion(): string | undefined {
        return this.ready?.node;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    async exec(request: ContainerExecRequest): Promise<ContainerExecResult> {
        return await this.run(
            "exec",
            {
                command: request.command,
                cwd: request.cwd,
                env: request.env,
                timeoutMs: request.timeoutMs,
            },
            request,
        );
    }

    async spawn(request: ContainerSpawnRequest): Promise<ContainerExecResult> {
        return await this.run(
            "spawn",
            {
                file: request.file,
                args: [...request.args],
                cwd: request.cwd,
                env: request.env,
                timeoutMs: request.timeoutMs,
            },
            request,
        );
    }

    /**
     * One file operation on the container's filesystem. The generic parameter ties the request shape to its
     * result, so a caller cannot ask for `readdir` and read `.data`.
     */
    async fs<Op extends ContainerFsRequest["op"]>(
        request: Extract<ContainerFsRequest, { op: Op }>,
    ): Promise<ContainerFsResults[Op]> {
        if (this.closed) {
            throw new ContainerSessionError("container session is closed", "container-exited");
        }

        const id = this.nextId++;

        return (await new Promise<ContainerFsResult>((resolve, reject) => {
            this.pendingFs.set(id, { resolve, reject });
            this.send({ jsonrpc: "2.0", id, method: "fs", params: request });
        })) as ContainerFsResults[Op];
    }

    private async run(
        method: "exec" | "spawn",
        params: {
            command?: string;
            file?: string;
            args?: string[];
            cwd: string;
            env?: Record<string, string>;
            timeoutMs?: number;
        },
        request: {
            signal?: AbortSignal;
            onOutput?: (chunk: Buffer) => void;
            onChunk?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
        },
    ): Promise<ContainerExecResult> {
        if (this.closed) {
            throw new ContainerSessionError("container session is closed", "container-exited");
        }

        const { signal } = request;

        if (signal?.aborted) {
            throw new ContainerSessionError("aborted", "aborted");
        }

        const id = this.nextId++;

        return new Promise<ContainerExecResult>((resolve, reject) => {
            let backstop: NodeJS.Timeout | undefined;

            const cleanup = (): void => {
                if (backstop !== undefined) {
                    clearTimeout(backstop);
                }

                signal?.removeEventListener("abort", onAbort);
            };

            const onAbort = (): void => {
                this.sendNotification("cancel", { id });

                if (backstop !== undefined) {
                    return;
                }

                // The dispatcher cancels the process group itself; this only covers it becoming wedged.
                backstop = setTimeout(() => {
                    this.settle(id, (pending) =>
                        pending.reject(new ContainerSessionError("aborted", "aborted")),
                    );
                }, ABORT_BACKSTOP_MS);
            };

            this.pending.set(id, {
                resolve,
                reject,
                onOutput: request.onOutput,
                onChunk: request.onChunk,
                cleanup,
            });
            signal?.addEventListener("abort", onAbort, { once: true });

            this.send({
                jsonrpc: "2.0",
                id,
                method,
                params,
            });

            // The signal may already have fired between the check above and the listener registration.
            if (signal?.aborted) {
                onAbort();
            }
        });
    }

    async close(): Promise<void> {
        if (this.closePromise !== undefined) {
            return this.closePromise;
        }

        this.closePromise = this.closeOnce();

        return this.closePromise;
    }

    private async closeOnce(): Promise<void> {
        this.closed = true;
        this.failAll(new ContainerSessionError("container session closed", "container-exited"));

        const child = this.child;
        child.stdin?.end();

        const exited = await waitForExit(
            child,
            this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
        );

        if (!exited) {
            // The attached client did not let go: kill it and remove whatever it left behind by name.
            child.kill("SIGKILL");
            await forceRemoveContainer(this.options.podmanPath ?? "podman", this.containerName);
        }
    }

    /** Exit code for the dispatcher process itself, for tests and diagnostics. */
    async waitForExit(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<boolean> {
        return waitForExit(this.child, timeoutMs);
    }

    private attach(): void {
        this.child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
        this.child.stderr?.on("data", (chunk: Buffer) => this.onStderr(chunk));

        this.child.on("error", (error: Error) => {
            const failure = new ContainerSessionError(
                `cannot start container: ${error.message}`,
                "start",
            );
            this.readyReject?.(failure);
            this.failAll(failure);
        });

        this.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
            if (this.closed) {
                return;
            }

            const detail = this.diagnostics.length > 0 ? `\n${this.diagnostics.join("\n")}` : "";
            const failure = new ContainerSessionError(
                `container exited (${signal ?? `code ${code ?? "unknown"}`}) before the session closed${detail}`,
                "container-exited",
            );
            this.readyReject?.(failure);
            this.failAll(failure);
        });
    }

    private awaitReady(): Promise<ContainerSession> {
        if (this.ready !== undefined) {
            return Promise.resolve(this);
        }

        return new Promise<ContainerSession>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
            this.readyTimer = setTimeout(() => {
                reject(
                    new ContainerSessionError(
                        `container did not become ready within ${this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS} ms${this.diagnosticTail()}`,
                        "start",
                    ),
                );
            }, this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
        });
    }

    private onStdout(chunk: Buffer): void {
        for (const line of this.decoder.push(chunk)) {
            this.onLine(line);
        }
    }

    private onStderr(chunk: Buffer): void {
        this.stderrBuffer += chunk.toString("utf8");

        let newline = this.stderrBuffer.indexOf("\n");

        while (newline >= 0) {
            const line = this.stderrBuffer.slice(0, newline).trimEnd();
            this.stderrBuffer = this.stderrBuffer.slice(newline + 1);

            if (line.length > 0) {
                this.recordDiagnostic(line);
            }

            newline = this.stderrBuffer.indexOf("\n");
        }
    }

    private recordDiagnostic(line: string): void {
        this.diagnostics.push(line);

        if (this.diagnostics.length > MAX_DIAGNOSTIC_LINES) {
            this.diagnostics.shift();
        }

        this.options.onDiagnostics?.(line);
    }

    private onLine(line: string): void {
        let message: ContainerMessage;

        try {
            message = JSON.parse(line) as ContainerMessage;
        } catch {
            this.failAll(
                new ContainerSessionError(
                    `malformed message from dispatcher: ${line.slice(0, 200)}`,
                    "protocol",
                ),
            );

            return;
        }

        if ("method" in message) {
            this.onNotification(message);

            return;
        }

        this.onResponse(message);
    }

    private onNotification(message: ContainerMessage): void {
        if (!("method" in message)) {
            return;
        }

        switch (message.method) {
            case "ready":
                this.onReady(message.params);

                return;
            case "output": {
                const pending = this.pending.get(message.params.id);
                const chunk = Buffer.from(message.params.data, "base64");

                pending?.onOutput?.(chunk);
                pending?.onChunk?.(message.params.stream, chunk);

                return;
            }
            default:
                // A newer dispatcher may emit notifications this host does not know yet.
                return;
        }
    }

    private onReady(params: ContainerReadyParams): void {
        if (params.protocol !== CONTAINER_PROTOCOL_VERSION) {
            this.readyReject?.(
                new ContainerSessionError(
                    `dispatcher protocol ${params.protocol} does not match host protocol ${CONTAINER_PROTOCOL_VERSION}`,
                    "protocol",
                ),
            );

            return;
        }

        this.ready = params;

        if (this.readyTimer !== undefined) {
            clearTimeout(this.readyTimer);
            this.readyTimer = undefined;
        }

        this.readyResolve?.(this);
        this.readyResolve = undefined;
        this.readyReject = undefined;
    }

    private onResponse(message: ContainerMessage): void {
        if ("method" in message) {
            return;
        }

        if (message.id === null) {
            // A dispatcher-level parse error names no request, so there is nothing to fail individually: the
            // stream can no longer be trusted to answer the requests already in flight.
            this.failAll(
                new ContainerSessionError(
                    "error" in message
                        ? message.error.message
                        : "dispatcher reported a response without a request id",
                    "protocol",
                ),
            );

            return;
        }

        const fsPending = this.pendingFs.get(message.id);

        if (fsPending !== undefined) {
            this.pendingFs.delete(message.id);

            if ("error" in message) {
                fsPending.reject(this.failureFor(message.error.code, message.error.message));

                return;
            }

            fsPending.resolve(message.result as unknown as ContainerFsResult);

            return;
        }

        this.settle(message.id, (pending) => {
            if ("error" in message) {
                pending.reject(this.failureFor(message.error.code, message.error.message));

                return;
            }

            pending.resolve(resultFrom(message.result));
        });
    }

    private failureFor(code: number, message: string): ContainerSessionError {
        switch (code) {
            case CONTAINER_ERROR_CODES.missingCwd:
                return new ContainerSessionError(message, "cwd-missing");
            case CONTAINER_ERROR_CODES.spawnFailed:
                return new ContainerSessionError(message, "spawn-failed");
            case CONTAINER_ERROR_CODES.fsFailed:
                return new ContainerSessionError(message, "fs-failed");
            default:
                return new ContainerSessionError(message, "protocol");
        }
    }

    private settle(id: number, action: (pending: PendingExec) => void): void {
        const pending = this.pending.get(id);

        if (pending === undefined) {
            return;
        }

        this.pending.delete(id);
        pending.cleanup();
        action(pending);
    }

    private failAll(error: Error): void {
        for (const [id, pending] of [...this.pending]) {
            this.settle(id, () => pending.reject(error));
        }

        for (const [id, pending] of [...this.pendingFs]) {
            this.pendingFs.delete(id);
            pending.reject(error);
        }
    }

    private sendNotification(method: string, params: unknown): void {
        this.send({ jsonrpc: "2.0", method, params });
    }

    private send(message: unknown): void {
        if (this.closed) {
            return;
        }

        try {
            this.child.stdin?.write(`${JSON.stringify(message)}\n`);
        } catch {
            // A dead pipe surfaces through the child 'exit' handler, which owns the error path.
        }
    }

    private diagnosticTail(): string {
        if (this.diagnostics.length === 0) {
            return "";
        }

        return `\n${this.diagnostics.join("\n")}`;
    }
}

function resultFrom(payload: ContainerResultPayload): ContainerExecResult {
    return {
        exitCode: payload.exitCode,
        timedOut: payload.timedOut === true,
        cancelled: payload.cancelled === true,
        wallTimeMs: payload.wallTimeMs,
    };
}

function defaultLaunch(command: string, args: readonly string[]): ChildProcess {
    return nodeSpawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
}

/** Write the host identity into the shared home, and only when it differs from what is already there. */
async function seedGitConfig(home: string, identity: GitIdentity | undefined): Promise<void> {
    if (identity === undefined) {
        return;
    }

    const file = path.join(home, ".gitconfig");
    const text = gitConfigFile(identity);

    try {
        if ((await fs.promises.readFile(file, "utf8")) === text) {
            return;
        }
    } catch {
        // Missing or unreadable: the write below is the answer either way.
    }

    await fs.promises.writeFile(file, text, "utf8");
}

function resolveDispatcherPath(explicit: string | undefined): string {
    if (explicit !== undefined) {
        return explicit;
    }

    const candidates = [
        fileURLToPath(new URL("./dispatch.mjs", import.meta.url)),
        // A compiled or bundled layout may not keep the sibling `.mjs` next to this module; the installed
        // extension keeps its sources, so the extension root is the other place it can be.
        path.join(PI_CODER_EXTENSION_DIR, "src", "modules", "sandbox", "container", "dispatch.mjs"),
    ];

    const found = candidates.find((candidate) => fs.existsSync(candidate));

    if (found === undefined) {
        throw new ContainerSessionError(
            `container dispatcher not found; looked in ${candidates.join(", ")}`,
            "start",
        );
    }

    return found;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve(false);
        }, timeoutMs);

        const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
        };

        child.once("exit", onExit);
    });
}

/** Best-effort cleanup by name, for the case where the attached client was killed rather than stopped. */
async function forceRemoveContainer(podmanPath: string, containerName: string): Promise<void> {
    await new Promise<void>((resolve) => {
        try {
            const child = nodeSpawn(podmanPath, ["rm", "--force", "--time", "0", containerName], {
                stdio: "ignore",
            });
            child.once("error", () => resolve());
            child.once("exit", () => resolve());
        } catch {
            resolve();
        }
    });
}
