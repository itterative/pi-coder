#!/usr/bin/env node
/**
 * Container-side command dispatcher.
 *
 * This file is mounted read-only from the running extension at `/run/pi/dispatch.mjs`;
 * it runs as the main process of a pi-coder sandbox container and is the only thing the host talks to.
 * It is plain JavaScript on purpose: it must run inside the image with nothing but Node installed, so it
 * cannot be TypeScript and it must not import from the extension.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 *
 *   host -> container   `exec`   { id, params: { command, cwd, env, timeoutMs } }
 *                       `spawn`  { id, params: { file, args, cwd, env, timeoutMs } }  (argv, no shell)
 *                       `fs`     { id, params: { op, path, ... } }             (file operations)
 *                       `cancel` { params: { id } }                     (notification)
 *                       `ping`   { id }                                 (liveness)
 *   container -> host   `ready`  { params: { protocol, pid, node, shell, cwd } }
 *                       `output` { params: { id, stream: "stdout"|"stderr", data: base64 } }
 *                       `result` { id, result: { exitCode, signal, timedOut, cancelled, wallTimeMs } }
 *                       `error`  { id, error: { code, message } }
 *
 * Output chunks are base64 so arbitrary bytes survive the JSON framing. One connection multiplexes any
 * number of concurrent commands by request id, which is what replaces a session pool on the host.
 *
 * `fs` exists because the host's file tools must see the same filesystem `bash` does: the host runs them
 * through these operations instead of reading its own disk, so a sandboxed `$HOME` or `/tmp` cannot show
 * one view to a tool call and another to a command.
 *
 * Process and stream semantics deliberately mirror pi's own local bash operations
 * (`createLocalShellOperations` in the agent package), because the host adapter is expected to satisfy the
 * same `BashOperations` contract:
 *
 *   - each command runs as its own process-group leader (`detached`), and cancellation kills the group;
 *   - merged stdout/stderr are forwarded as they arrive;
 *   - after the shell exits we keep reading until both pipes end, re-arming a short idle timer on every
 *     chunk, so `cmd &` neither hangs the request nor truncates a descendant's tail;
 *   - a signal death is reported as `128 + signal number`, the shell convention.
 *
 * Lifetime is the host's: when the host closes stdin this process kills its children and exits, and the
 * container goes with it. There is no watchdog and no timeout of its own.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";

const PROTOCOL_VERSION = 1;

/** How long to keep reading after the shell exits before no write arrives (pi's EXIT_STDIO_GRACE_MS). */
const EXIT_STDIO_GRACE_MS = 100;
/** Grace between SIGTERM and SIGKILL for a cancelled command. */
const CANCEL_TERM_GRACE_MS = 250;
/** Upper bound on graceful shutdown before exiting regardless. */
const SHUTDOWN_GRACE_MS = 250;

const ERROR_CODES = {
    parse: -32700,
    methodNotFound: -32601,
    duplicateRequest: -32003,
    missingCwd: -32001,
    spawnFailed: -32002,
    fsFailed: -32004,
};

/** The image decides the shell: bash when the image has it, sh otherwise. Override with PI_SANDBOX_SHELL. */
const SHELL = resolveShell();

/** The image's own environment. Per-request env is layered on top of it, so image defaults survive. */
const BASE_ENV = omitUndefined(process.env);

/** id -> execution state, for cancellation and shutdown. */
const running = new Map();

let closed = false;

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

reader.on("line", (line) => {
    const text = line.trim();

    if (text.length === 0) {
        return;
    }

    let message;

    try {
        message = JSON.parse(text);
    } catch {
        fail(null, ERROR_CODES.parse, "invalid JSON request");

        return;
    }

    handle(message);
});

reader.on("close", () => {
    shutdown();
});

// The host can also stop the container directly, and a terminal Ctrl-C reaches the container as SIGINT.
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
process.on("SIGHUP", () => shutdown());

// A closed host pipe must not crash a container that is on its way out.
process.stdout.on("error", () => {});

ready();

function ready() {
    write({
        jsonrpc: "2.0",
        method: "ready",
        params: {
            protocol: PROTOCOL_VERSION,
            pid: process.pid,
            node: process.version,
            shell: SHELL,
            cwd: process.cwd(),
        },
    });
}

function handle(message) {
    if (message === null || typeof message !== "object") {
        fail(null, ERROR_CODES.parse, "request must be an object");

        return;
    }

    const { id, method, params } = message;

    switch (method) {
        case "exec":
            startExec(id, params ?? {});

            return;
        case "spawn":
            startSpawn(id, params ?? {});

            return;
        case "fs":
            startFs(id, params ?? {});

            return;
        case "cancel":
            cancel(params?.id);

            return;
        case "ping":
            respond(id, {
                pong: true,
                running: running.size,
                pid: process.pid,
                uptimeMs: Math.round(process.uptime() * 1000),
            });

            return;
        default:
            fail(id, ERROR_CODES.methodNotFound, `unknown method ${JSON.stringify(method)}`);
    }
}

function startExec(id, params) {
    const command = typeof params.command === "string" ? params.command : "";

    launch(id, params, "exec", {
        file: SHELL,
        args: ["-c", command],
        describe: () => `cannot spawn command: ${command.slice(0, 120)}`,
    });
}

/** argv launch without a shell: what a tool that already owns its arguments should use. */
function startSpawn(id, params) {
    const file = typeof params.file === "string" ? params.file : "";
    const args = Array.isArray(params.args)
        ? params.args.filter((arg) => typeof arg === "string")
        : [];

    launch(id, params, "spawn", {
        file,
        args,
        describe: () => `cannot spawn ${JSON.stringify(file)}`,
    });
}

/** The exec/spawn process machine: validation, spawn, stream fan-out, cancellation, settlement. */
function launch(id, params, method, command) {
    if (id === undefined || id === null) {
        fail(null, ERROR_CODES.parse, `${method} requires an id`);

        return;
    }

    if (running.has(id)) {
        fail(id, ERROR_CODES.duplicateRequest, `duplicate request id ${JSON.stringify(id)}`);

        return;
    }

    const cwd =
        typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : process.cwd();

    if (!isDirectory(cwd)) {
        fail(id, ERROR_CODES.missingCwd, `Working directory does not exist: ${cwd}`);

        return;
    }

    const env = { ...BASE_ENV, ...omitUndefined(params.env) };
    const timeoutMs = positiveNumber(params.timeoutMs);

    let child;

    try {
        child = spawn(command.file, command.args, {
            cwd,
            env,
            // Own process group, so a cancellation reaches descendants and not just the shell.
            detached: true,
            // Commands do not read the protocol stream: stdin is /dev/null, exactly like pi's local shell.
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
    } catch (error) {
        fail(id, ERROR_CODES.spawnFailed, `${command.describe()}: ${errorMessage(error)}`);

        return;
    }

    const state = {
        id,
        child,
        startedAt: Date.now(),
        exitCode: null,
        signal: null,
        exited: false,
        settled: false,
        stdoutEnded: false,
        stderrEnded: false,
        timedOut: false,
        cancelled: false,
        idleTimer: null,
        timeoutTimer: null,
        killTimer: null,
    };

    running.set(id, state);

    child.stdout?.on("data", (chunk) => {
        emitOutput(id, "stdout", chunk);

        if (state.exited) {
            armIdleTimer(state);
        }
    });

    child.stderr?.on("data", (chunk) => {
        emitOutput(id, "stderr", chunk);

        if (state.exited) {
            armIdleTimer(state);
        }
    });

    child.stdout?.once("end", () => {
        state.stdoutEnded = true;
        maybeFinalizeAfterExit(state);
    });

    child.stderr?.once("end", () => {
        state.stderrEnded = true;
        maybeFinalizeAfterExit(state);
    });

    child.once("error", (error) => {
        settle(state, () =>
            fail(id, ERROR_CODES.spawnFailed, `cannot run command: ${errorMessage(error)}`),
        );
    });

    child.once("exit", (code, signal) => {
        state.exited = true;
        state.exitCode = code;
        state.signal = signal;
        maybeFinalizeAfterExit(state);

        if (!state.settled) {
            armIdleTimer(state);
        }
    });

    child.once("close", (code) => {
        if (state.exitCode === null) {
            state.exitCode = code;
        }

        finalize(state);
    });

    if (timeoutMs !== undefined) {
        state.timeoutTimer = setTimeout(() => {
            state.timedOut = true;
            killGroup(state, "SIGKILL");
        }, timeoutMs);
    }
}

/**
 * File operations for the host's read/write/edit/ls/find tools.
 *
 * These answer one request with one result rather than a stream, so they run outside the `running` map and
 * cannot be cancelled: each one is a single small syscall on a path the tool already resolved. The host
 * resolves and confines paths; this side only touches the filesystem it can see.
 */
function startFs(id, params) {
    if (id === undefined || id === null) {
        fail(null, ERROR_CODES.parse, "fs requires an id");

        return;
    }

    const op = typeof params.op === "string" ? params.op : "";
    const target = typeof params.path === "string" ? params.path : "";

    if (target.length === 0) {
        fail(id, ERROR_CODES.fsFailed, "fs requires a path");

        return;
    }

    runFs(op, params, target).then(
        (result) => respond(id, result),
        (error) => fail(id, ERROR_CODES.fsFailed, `${op} ${target}: ${errorMessage(error)}`),
    );
}

async function runFs(op, params, target) {
    switch (op) {
        case "readFile": {
            const limit = positiveNumber(params.bytes);

            if (limit !== undefined) {
                const handle = await fs.promises.open(target, "r");

                try {
                    const buffer = Buffer.alloc(limit);
                    const { bytesRead } = await handle.read(buffer, 0, limit, 0);

                    return {
                        data: buffer.subarray(0, bytesRead).toString("base64"),
                        size: bytesRead,
                    };
                } finally {
                    await handle.close();
                }
            }

            const buffer = await fs.promises.readFile(target);

            // Base64 because the framing is JSON and a tool may read a binary file (images are attachments).
            return { data: buffer.toString("base64"), size: buffer.length };
        }
        case "writeFile": {
            const content = typeof params.content === "string" ? params.content : "";

            await fs.promises.writeFile(target, content, "utf8");

            return { bytes: Buffer.byteLength(content) };
        }
        case "mkdir":
            await fs.promises.mkdir(target, { recursive: true });

            return {};
        case "access": {
            const flags = params.mode === "w" ? fs.constants.W_OK : fs.constants.R_OK;

            await fs.promises.access(target, flags);

            return {};
        }
        case "stat": {
            const stat = await fs.promises.stat(target);

            return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size };
        }
        case "readdir":
            return { entries: await fs.promises.readdir(target) };
        case "exists":
            return {
                exists: await fs.promises.stat(target).then(
                    () => true,
                    () => false,
                ),
            };
        case "glob":
            return { paths: await globFiles(target, params) };
        default:
            throw new Error(`unknown fs op ${JSON.stringify(op)}`);
    }
}

/**
 * Glob through ripgrep, which is in the image for `grep` anyway: it mirrors `fd`'s gitignore awareness and
 * saves reimplementing a glob matcher in a file that must stay plain JavaScript.
 */
async function globFiles(root, params) {
    const pattern = typeof params.pattern === "string" ? params.pattern : "";
    const ignore = Array.isArray(params.ignore)
        ? params.ignore.filter((entry) => typeof entry === "string")
        : [];
    const limit = positiveNumber(params.limit);
    const args = ["--files", "--hidden", "--color=never", "--no-messages"];

    if (pattern.length > 0) {
        args.push("--glob", pattern);
    }

    for (const entry of ignore) {
        args.push("--glob", `!${entry}`);
    }

    args.push("--", root);

    return await collectLines(args, limit);
}

/** Run `rg` and return its stdout lines, stopping once `limit` arrived. Exit 1 is "no matches", not a failure. */
async function collectLines(args, limit) {
    return await new Promise((resolve, reject) => {
        const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
        const lines = [];
        let buffered = "";
        let stderr = "";
        let stoppedAtLimit = false;

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            buffered += chunk;

            const parts = buffered.split("\n");
            buffered = parts.pop() ?? "";

            for (const line of parts) {
                if (line.length > 0) {
                    lines.push(line);
                }
            }

            if (limit !== undefined && lines.length >= limit) {
                // Killing at the limit is the normal path here, so the signal death below is not a failure.
                stoppedAtLimit = true;
                child.kill();
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.once("error", (error) => {
            reject(new Error(`cannot run rg: ${errorMessage(error)}`));
        });
        child.once("close", (code) => {
            if (buffered.length > 0) {
                lines.push(buffered);
            }

            // A killed child reports a null code; only an unexpected exit is an error.
            if (!stoppedAtLimit && code !== 0 && code !== 1) {
                reject(new Error(`rg exited with ${String(code)}: ${stderr.trim()}`));

                return;
            }

            resolve(limit === undefined ? lines : lines.slice(0, limit));
        });
    });
}

function cancel(id) {
    const state = running.get(id);

    if (state === undefined) {
        return;
    }

    state.cancelled = true;
    killGroup(state, "SIGTERM");
    state.killTimer = setTimeout(() => {
        if (!state.settled) {
            killGroup(state, "SIGKILL");
        }
    }, CANCEL_TERM_GRACE_MS);
}

/** After `exit`, wait for the pipes to fall idle rather than assuming a fixed deadline from the exit. */
function armIdleTimer(state) {
    if (state.settled) {
        return;
    }

    if (state.idleTimer !== null) {
        clearTimeout(state.idleTimer);
    }

    state.idleTimer = setTimeout(() => finalize(state), EXIT_STDIO_GRACE_MS);
}

function maybeFinalizeAfterExit(state) {
    if (state.settled || !state.exited) {
        return;
    }

    if (state.stdoutEnded && state.stderrEnded) {
        finalize(state);
    }
}

function finalize(state) {
    settle(state, () => {
        respond(state.id, {
            exitCode: exitCodeFor(state.exitCode, state.signal),
            signal: state.signal,
            timedOut: state.timedOut,
            cancelled: state.cancelled,
            wallTimeMs: Date.now() - state.startedAt,
        });
    });
}

/** Run `answer` at most once per request, and release every handle and stream the request owns. */
function settle(state, answer) {
    if (state.settled) {
        return;
    }

    state.settled = true;
    running.delete(state.id);

    clearTimeout(state.idleTimer);
    clearTimeout(state.timeoutTimer);
    clearTimeout(state.killTimer);

    state.child.stdout?.destroy();
    state.child.stderr?.destroy();

    answer();
}

function killGroup(state, signal) {
    const pid = state.child.pid;

    if (pid === undefined) {
        return;
    }

    try {
        // Negative pid targets the process group the detached child leads.
        process.kill(-pid, signal);
    } catch {
        try {
            state.child.kill(signal);
        } catch {
            // already gone
        }
    }
}

function shutdown() {
    if (closed) {
        return;
    }

    closed = true;
    reader.close();

    const hadRunning = running.size > 0;

    for (const state of running.values()) {
        state.cancelled = true;
        killGroup(state, "SIGKILL");
    }

    running.clear();

    if (!hadRunning) {
        // Nothing to wait for: an idle session stops as soon as the host lets go (~1 ms, not ~250 ms).
        process.exit(0);

        return;
    }

    // Give the kills a moment to land, then leave regardless; the container runtime reaps what is left.
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
}

function respond(id, result) {
    write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
    write({ jsonrpc: "2.0", id, error: { code, message } });
}

function emitOutput(id, stream, chunk) {
    write({
        jsonrpc: "2.0",
        method: "output",
        params: { id, stream, data: chunk.toString("base64") },
    });
}

function write(message) {
    if (closed) {
        return;
    }

    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function resolveShell() {
    const configured = process.env.PI_SANDBOX_SHELL;

    if (typeof configured === "string" && configured.length > 0) {
        return configured;
    }

    return fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

function isDirectory(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function positiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function omitUndefined(record) {
    if (record === undefined || record === null) {
        return {};
    }

    const result = {};

    for (const [key, value] of Object.entries(record)) {
        if (typeof value === "string") {
            result[key] = value;
        }
    }

    return result;
}

function exitCodeFor(code, signal) {
    if (typeof code === "number") {
        return code;
    }

    const number = typeof signal === "string" ? (os.constants.signals[signal] ?? 0) : 0;

    return number > 0 ? 128 + number : 1;
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
