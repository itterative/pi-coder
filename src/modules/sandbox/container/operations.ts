import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { ContainerSessionError, type ContainerSession } from "./client";

/**
 * Adapt the container session to pi's `BashOperations`, which is how the built-in bash tool (and `!`
 * commands) reach a non-local execution backend.
 *
 * The contract is pi's, not ours, so this adapter is where the container's richer result is translated
 * back into the three failures pi's own local shell operations raise:
 *
 * - an aborted signal becomes `aborted`;
 * - an expired timeout becomes `timeout:<seconds>`, with the original value the caller passed;
 * - a missing working directory becomes pi's exact message, so both backends read the same to a model.
 */
export function createContainerBashOperations(
    session: ContainerSession,
    resolveEnv?: (env: NodeJS.ProcessEnv | undefined) => Record<string, string>,
): BashOperations {
    return {
        exec: async (command, cwd, { onData, signal, timeout, env }) => {
            if (signal?.aborted) {
                throw new Error("aborted");
            }

            try {
                const result = await session.exec({
                    command,
                    cwd,
                    env: resolveEnv ? resolveEnv(env) : definedEnv(env),
                    timeoutMs: toTimeoutMs(timeout),
                    signal,
                    onOutput: onData,
                });

                if (signal?.aborted) {
                    throw new Error("aborted");
                }

                if (result.timedOut) {
                    throw new Error(`timeout:${timeout}`);
                }

                return { exitCode: result.exitCode };
            } catch (error) {
                // An aborted caller is not interested in why the command stopped.
                if (signal?.aborted) {
                    throw new Error("aborted", { cause: error });
                }

                throw toBashError(error, cwd);
            }
        },
    };
}

function toBashError(error: unknown, cwd: string): unknown {
    if (!(error instanceof ContainerSessionError)) {
        return error;
    }

    switch (error.kind) {
        case "aborted":
            return new Error("aborted", { cause: error });
        case "cwd-missing":
            return new Error(
                `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
                {
                    cause: error,
                },
            );
        default:
            return error;
    }
}

function toTimeoutMs(timeout: number | undefined): number | undefined {
    if (timeout === undefined) {
        return undefined;
    }

    return timeout * 1000;
}

function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
    if (env === undefined) {
        return undefined;
    }

    const entries = Object.entries(env).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string";
    });

    return Object.fromEntries(entries);
}
