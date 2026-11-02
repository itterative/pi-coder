import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The container dispatcher is plain JavaScript on purpose, so it can be driven without podman: spawn it as a
 * normal process, speak its NDJSON protocol, and assert on the answers. That keeps the protocol honest in the
 * environments where the suite actually runs (which is inside the sandbox image, where podman is unreachable).
 */

const DISPATCHER = path.join(
    import.meta.dirname,
    "..",
    "..",
    "src",
    "modules",
    "sandbox",
    "container",
    "dispatch.mjs",
);

interface Dispatcher {
    request: (method: string, params: unknown) => Promise<Record<string, unknown>>;
    close: () => void;
}

const open = new Set<Dispatcher>();

beforeEach(() => {});

afterEach(() => {
    for (const dispatcher of open) {
        dispatcher.close();
    }

    open.clear();
});

function startDispatcher(): Promise<Dispatcher> {
    const child = spawn(process.execPath, [DISPATCHER], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: child.stdout });
    const pending = new Map<
        number,
        { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
    >();
    const ready = Promise.withResolvers<void>();
    let nextId = 1;

    lines.on("line", (line) => {
        const message = JSON.parse(line) as {
            method?: string;
            id?: number;
            result?: Record<string, unknown>;
            error?: { message: string };
        };

        if (message.method === "ready") {
            ready.resolve();

            return;
        }

        if (message.id === undefined) {
            return;
        }

        const entry = pending.get(message.id);
        if (entry === undefined) {
            return;
        }

        pending.delete(message.id);

        if (message.error !== undefined) {
            entry.reject(new Error(message.error.message));

            return;
        }

        entry.resolve(message.result ?? {});
    });

    const dispatcher: Dispatcher = {
        request: async (method, params) => {
            await ready.promise;

            const id = nextId++;
            const settled = Promise.withResolvers<Record<string, unknown>>();
            pending.set(id, {
                resolve: settled.resolve,
                reject: settled.reject,
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

            return await settled.promise;
        },
        close: () => {
            lines.close();
            child.stdin.end();
            child.kill();
        },
    };

    open.add(dispatcher);

    return ready.promise.then(() => dispatcher);
}

describe("dispatcher fs operations", () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-"));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("round-trips a write and a read as bytes", async () => {
        const dispatcher = await startDispatcher();
        const file = path.join(root, "notes.txt");

        const written = await dispatcher.request("fs", {
            op: "writeFile",
            path: file,
            content: "héllo\nworld\n",
        });
        expect(written).toEqual({ bytes: Buffer.byteLength("héllo\nworld\n") });

        const read = await dispatcher.request("fs", { op: "readFile", path: file });
        expect(Buffer.from(read.data as string, "base64").toString("utf8")).toBe("héllo\nworld\n");
    });

    it("reads only the requested prefix", async () => {
        const dispatcher = await startDispatcher();
        const file = path.join(root, "big.bin");

        fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));

        const head = await dispatcher.request("fs", { op: "readFile", path: file, bytes: 4 });
        expect(Buffer.from(head.data as string, "base64")).toEqual(
            Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        );
        expect(head.size).toBe(4);
    });

    it("creates parents, stats, lists, and reports existence", async () => {
        const dispatcher = await startDispatcher();
        const nested = path.join(root, "a", "b");

        await dispatcher.request("fs", { op: "mkdir", path: nested });
        fs.writeFileSync(path.join(nested, "one.txt"), "1");
        fs.writeFileSync(path.join(nested, "two.txt"), "2");

        const stat = await dispatcher.request("fs", { op: "stat", path: nested });
        expect(stat).toMatchObject({ isDirectory: true, isFile: false });

        const listing = await dispatcher.request("fs", { op: "readdir", path: nested });
        expect((listing.entries as string[]).toSorted()).toEqual(["one.txt", "two.txt"]);

        await expect(
            dispatcher.request("fs", { op: "exists", path: path.join(root, "missing") }),
        ).resolves.toEqual({ exists: false });
        await expect(dispatcher.request("fs", { op: "exists", path: nested })).resolves.toEqual({
            exists: true,
        });
    });

    it("reports a failed syscall instead of a transport error", async () => {
        const dispatcher = await startDispatcher();

        await expect(
            dispatcher.request("fs", { op: "readFile", path: path.join(root, "nope.txt") }),
        ).rejects.toThrow(/ENOENT/);
    });

    it("globs through ripgrep, honoring ignore patterns and the limit", async () => {
        const dispatcher = await startDispatcher();
        fs.mkdirSync(path.join(root, "src"));
        fs.mkdirSync(path.join(root, "node_modules"));
        fs.writeFileSync(path.join(root, "src", "a.ts"), "");
        fs.writeFileSync(path.join(root, "src", "b.ts"), "");
        fs.writeFileSync(path.join(root, "node_modules", "c.ts"), "");

        const all = await dispatcher.request("fs", {
            op: "glob",
            path: root,
            pattern: "*.ts",
            ignore: ["**/node_modules/**"],
        });
        expect((all.paths as string[]).map((entry) => path.basename(entry)).toSorted()).toEqual([
            "a.ts",
            "b.ts",
        ]);

        const limited = await dispatcher.request("fs", {
            op: "glob",
            path: root,
            pattern: "*.ts",
            ignore: ["**/node_modules/**"],
            limit: 1,
        });
        expect(limited.paths as string[]).toHaveLength(1);
    });
});
