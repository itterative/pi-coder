import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import type { ContainerSession } from "../../../../src/modules/sandbox/container/client";
import { runContainerGrep } from "../../../../src/modules/sandbox/container/grep-tool";

/**
 * The container-backed grep reimplements pi's own `grep` execute (pi spawns `rg` itself, so its operations
 * seam cannot reroute the search). Reimplementation is a drift risk, so this compares the two: the same
 * checkout, the same arguments, and pi's host implementation as the oracle — legitimate here because the
 * checkout is shared between the host and the container, which is the whole premise of Shape A.
 *
 * The session double runs the command on this machine instead of in a container, so the suite needs no podman
 * and still exercises the real `rg` binary, the real JSON event stream, and the real formatting.
 */

const tempDirs: string[] = [];

beforeEach(() => {});

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

/** A session whose filesystem is this one: enough to run the same search through both implementations. */
function localSession(): ContainerSession {
    const session = {
        fs: async (request: { op: string; path: string; bytes?: number }) => {
            switch (request.op) {
                case "readFile":
                    return await readFileResult(request.path, request.bytes);
                case "stat": {
                    const stat = await fs.promises.stat(request.path);

                    return {
                        isDirectory: stat.isDirectory(),
                        isFile: stat.isFile(),
                        size: stat.size,
                    };
                }
                case "exists":
                    return { exists: fs.existsSync(request.path) };
                case "access":
                    await fs.promises.access(request.path);

                    return {};
                default:
                    throw new Error(`local session double: unsupported fs op ${request.op}`);
            }
        },
        spawn: async (request: {
            file: string;
            args: readonly string[];
            cwd: string;
            signal?: AbortSignal;
            onChunk?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
        }) =>
            await new Promise((resolve, reject) => {
                const child = spawn(request.file, [...request.args], {
                    cwd: request.cwd,
                    stdio: ["ignore", "pipe", "pipe"],
                });

                request.signal?.addEventListener("abort", () => child.kill(), { once: true });
                child.stdout.on("data", (chunk: Buffer) => request.onChunk?.("stdout", chunk));
                child.stderr.on("data", (chunk: Buffer) => request.onChunk?.("stderr", chunk));
                child.once("error", reject);
                child.once("close", (code) =>
                    resolve({ exitCode: code, timedOut: false, cancelled: false, wallTimeMs: 0 }),
                );
            }),
    };

    return session as unknown as ContainerSession;
}

async function readFileResult(filePath: string, bytes: number | undefined) {
    if (bytes === undefined) {
        const buffer = await fs.promises.readFile(filePath);

        return { data: buffer.toString("base64"), size: buffer.length };
    }

    const handle = await fs.promises.open(filePath, "r");

    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);

        return { data: buffer.subarray(0, bytesRead).toString("base64"), size: bytesRead };
    } finally {
        await handle.close();
    }
}

function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-grep-parity-"));
    tempDirs.push(root);

    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    fs.writeFileSync(
        path.join(root, "src", "alpha.ts"),
        [
            "const alpha = 1;",
            "export function findMe() {}",
            "const beta = 2;",
            "export const findMeAgain = findMe;",
            "",
        ].join("\n"),
    );
    fs.writeFileSync(
        path.join(root, "src", "nested", "beta.ts"),
        ["// findMe in a comment", "const gamma = 3;", ""].join("\n"),
    );
    fs.writeFileSync(path.join(root, "README.md"), "findMe is documented here\n");
    fs.writeFileSync(path.join(root, "src", "long.ts"), `${"findMe ".repeat(120)}\n`);

    return root;
}

type Case = {
    name: string;
    /** rg walks in parallel, so the order matches arrive is not stable across runs; compare the lines. */
    sorted?: boolean;
    params: {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
    };
};

const CASES: Case[] = [
    { name: "plain match", params: { pattern: "findMe" }, sorted: true },
    { name: "scoped to a directory", params: { pattern: "findMe", path: "src" }, sorted: true },
    { name: "with a glob", params: { pattern: "findMe", glob: "*.md" } },
    { name: "case-insensitive", params: { pattern: "FINDME", ignoreCase: true }, sorted: true },
    { name: "literal", params: { pattern: "function findMe", literal: true }, sorted: true },
    { name: "with context", params: { pattern: "beta", context: 1 }, sorted: true },
    { name: "with a match limit", params: { pattern: "findMe", path: "src/alpha.ts", limit: 1 } },
    { name: "with long lines", params: { pattern: "findMe", glob: "long.ts" } },
    { name: "no matches", params: { pattern: "nothing-matches-this" } },
    { name: "single file path", params: { pattern: "findMe", path: "README.md" } },
];

describe("container grep parity with pi's implementation", () => {
    for (const testCase of CASES) {
        it(`matches pi for ${testCase.name}`, async () => {
            const root = fixture();

            const expected = await createGrepToolDefinition(root).execute(
                "call-1",
                testCase.params,
                undefined,
                undefined,
                toolContext(root),
            );
            const actual = await runContainerGrep(localSession(), testCase.params, undefined, root);

            if (testCase.sorted) {
                expect(textOf(actual).split("\n").toSorted()).toEqual(
                    textOf(expected).split("\n").toSorted(),
                );
            } else {
                expect(actual.content).toEqual(expected.content);
            }

            expect(actual.details).toEqual(expected.details);
        });
    }

    it("reports a missing path the way pi does", async () => {
        const root = fixture();

        await expect(
            runContainerGrep(
                localSession(),
                { pattern: "x", path: "no/such/dir" },
                undefined,
                root,
            ),
        ).rejects.toThrow(`Path not found: ${path.join(root, "no/such/dir")}`);
    });
});
function textOf(result: { content: { type: string; text?: string }[] }): string {
    return result.content.map((block) => block.text ?? "").join("\n");
}

/**
 * pi hands a definition an \`ExtensionToolContext\`, which adds the nested-tool surface. grep never calls it,
 * so the double carries only what is read — plus the two members the type requires, to keep the cast honest.
 */
function toolContext(cwd: string): ExtensionToolContext {
    return {
        cwd,
        tools: [],
        executeTool: async () => {
            throw new Error("grep does not execute nested tools");
        },
    } as unknown as ExtensionToolContext;
}
