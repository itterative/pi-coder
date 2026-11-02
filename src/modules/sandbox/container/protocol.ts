/**
 * Wire protocol between the host and the container-side dispatcher.
 *
 * The dispatcher is plain JavaScript (`dispatch.mjs`) because it runs inside the sandbox image with only
 * Node available, so these constants and types are the host's copy of a contract that cannot be imported
 * across the boundary. Keep them in step with `dispatch.mjs` when either side changes.
 */

export const CONTAINER_PROTOCOL_VERSION = 1;

export const CONTAINER_ERROR_CODES = {
    parse: -32700,
    methodNotFound: -32601,
    missingCwd: -32001,
    spawnFailed: -32002,
    duplicateRequest: -32003,
    fsFailed: -32004,
} as const;

type ContainerOutputStream = "stdout" | "stderr";

export interface ContainerReadyParams {
    protocol: number;
    pid: number;
    node: string;
    shell: string;
    cwd: string;
}

export interface ContainerResultPayload {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    cancelled: boolean;
    wallTimeMs: number;
}

/**
 * The `fs` method: one request, one result, on the container's own filesystem.
 *
 * The host's file tools are built over these operations so that `read`, `edit`, `write`, `ls`, and `find`
 * answer from the same view `bash` has. Paths are resolved and confined on the host; the dispatcher only
 * performs the syscall.
 */
export type ContainerFsRequest =
    | { op: "readFile"; path: string; bytes?: number }
    | { op: "writeFile"; path: string; content: string }
    | { op: "mkdir"; path: string }
    | { op: "access"; path: string; mode?: "r" | "w" }
    | { op: "stat"; path: string }
    | { op: "readdir"; path: string }
    | { op: "exists"; path: string }
    | { op: "glob"; path: string; pattern: string; ignore?: readonly string[]; limit?: number };

export interface ContainerFsResults {
    readFile: { data: string; size: number };
    writeFile: { bytes: number };
    mkdir: Record<string, never>;
    access: Record<string, never>;
    stat: { isDirectory: boolean; isFile: boolean; size: number };
    readdir: { entries: string[] };
    exists: { exists: boolean };
    glob: { paths: string[] };
}

export type ContainerFsResult = ContainerFsResults[keyof ContainerFsResults];

interface ContainerReadyMessage {
    jsonrpc: "2.0";
    method: "ready";
    params: ContainerReadyParams;
}

interface ContainerOutputMessage {
    jsonrpc: "2.0";
    method: "output";
    params: {
        id: number;
        stream: ContainerOutputStream;
        /** Base64 so arbitrary bytes survive the JSON framing. */
        data: string;
    };
}

interface ContainerResultMessage {
    jsonrpc: "2.0";
    id: number;
    result: ContainerResultPayload;
}

interface ContainerErrorMessage {
    jsonrpc: "2.0";
    id: number | null;
    error: {
        code: number;
        message: string;
    };
}

export type ContainerMessage =
    ContainerReadyMessage | ContainerOutputMessage | ContainerResultMessage | ContainerErrorMessage;
