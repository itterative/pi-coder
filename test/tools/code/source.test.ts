import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContainerSession } from "../../../src/modules/sandbox/container/client";
import {
    ContainerCodeSource,
    LocalCodeSource,
    createCodeSource,
} from "../../../src/tools/code/source";
import { clearCodeCache } from "../../../src/tools/code/load";
import { createPiStub, stubContext } from "../../helpers/pi-stub";
import registerCodeTool from "../../../src/tools/code";

const tempDirectories: string[] = [];

beforeEach(() => {
    clearCodeCache();
});

afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function tempProject(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-code-"));

    tempDirectories.push(directory);

    return directory;
}

function write(root: string, relative: string, content: string): void {
    const target = path.join(root, relative);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

describe("local code source", () => {
    it("walks the project but not the default build directories", async () => {
        const root = tempProject();

        write(root, "src/a.cpp", "int main() { return 0; }\n");
        write(root, "src/a.h", "#pragma once\n");
        write(root, "build/generated.cpp", "int generated();\n");
        write(root, "src/notes.txt", "not source\n");

        const source = new LocalCodeSource(root);
        const paths = (await source.glob(root, { limit: 100 }))
            .map((entry) => path.relative(root, entry))
            .sort();

        expect(paths).toEqual(["src/a.cpp", "src/a.h", "src/notes.txt"]);
    });

    it("walks an explicitly named directory even when a parent ignore file excludes it", async () => {
        const root = tempProject();

        write(root, ".local/.ignore", "*\n");
        write(root, ".local/examples/a.cpp", "int main() { return 0; }\n");

        const source = new LocalCodeSource(root);
        const target = path.join(root, ".local", "examples");
        const paths = (await source.glob(target, { limit: 100 })).map((entry) =>
            path.relative(target, entry),
        );

        expect(paths).toEqual(["a.cpp"]);
    });

    it("still honors ignore files when scanning the working directory itself", async () => {
        const root = tempProject();

        write(root, ".ignore", "ignored/\n");
        write(root, "ignored/a.cpp", "int hidden();\n");
        write(root, "src/b.cpp", "int visible();\n");

        const source = new LocalCodeSource(root);
        const paths = (await source.glob(root, { limit: 100 })).map((entry) =>
            path.relative(root, entry),
        );

        expect(paths).toContain(path.join("src", "b.cpp"));
        expect(paths).not.toContain(path.join("ignored", "a.cpp"));
    });

    it("refuses a read outside the working directory", async () => {
        const root = tempProject();
        const outside = tempProject();

        write(outside, "secret.cpp", "int secret;\n");

        const source = new LocalCodeSource(root);

        await expect(source.assertReadable(path.join(outside, "secret.cpp"))).rejects.toThrow(
            "outside the working directory",
        );
    });

    it("refuses a symlink that points outside the working directory", async () => {
        const root = tempProject();
        const outside = tempProject();

        write(outside, "secret.cpp", "int secret;\n");
        fs.symlinkSync(path.join(outside, "secret.cpp"), path.join(root, "link.cpp"));

        const source = new LocalCodeSource(root);

        await expect(source.assertReadable(path.join(root, "link.cpp"))).rejects.toThrow(
            "outside the working directory",
        );
    });

    it("reports the stat the cache uses to invalidate", async () => {
        const root = tempProject();

        write(root, "src/a.cpp", "int main() { return 0; }\n");

        const source = new LocalCodeSource(root);
        const stat = await source.stat(path.join(root, "src/a.cpp"));

        expect(stat.isFile).toBe(true);
        expect(stat.size).toBeGreaterThan(0);
        expect(stat.mtimeMs).toBeGreaterThan(0);
    });
});

describe("container code source", () => {
    it("routes globs, reads, and stats through the session", async () => {
        const calls: Array<{ op: string; [key: string]: unknown }> = [];
        const session = {
            async fs(request: { op: string; [key: string]: unknown }) {
                calls.push(request);

                switch (request.op) {
                    case "glob":
                        return { paths: ["/project/src/a.cpp"] };
                    case "stat":
                        return {
                            isDirectory: false,
                            isFile: true,
                            size: 24,
                            mtimeMs: 1234,
                        };
                    case "readFile":
                        return {
                            data: Buffer.from("int main() {}\n").toString("base64"),
                            size: 15,
                        };
                    default:
                        throw new Error(`unexpected fs op ${request.op}`);
                }
            },
        } as unknown as ContainerSession;
        const source = new ContainerCodeSource(session, "/project");

        expect(await source.glob("/project", { limit: 50 })).toEqual(["/project/src/a.cpp"]);
        expect(await source.glob("/project/src", { limit: 5 })).toEqual(["/project/src/a.cpp"]);
        expect(await source.readFile("/project/src/a.cpp")).toBe("int main() {}\n");
        expect((await source.stat("/project/src/a.cpp")).mtimeMs).toBe(1234);

        const globCalls = calls.filter((call) => call.op === "glob");
        expect(globCalls[0]?.ignore).toEqual(
            expect.arrayContaining(["build/**", "third_party/**", "*.pb.*"]),
        );
        expect(globCalls[0]?.pattern).toBe("");
        expect(globCalls[0]?.limit).toBe(50);
        expect(globCalls[0]?.noIgnore).toBe(false);
        expect(globCalls[1]?.noIgnore).toBe(true);
    });

    it("uses a grep result to narrow a symbol search", async () => {
        const session = {
            async spawn(request: {
                file: string;
                args: readonly string[];
                onChunk?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
            }) {
                expect(request.file).toBe("rg");
                expect(request.args).toContain("--files-with-matches");
                request.onChunk?.("stdout", Buffer.from("/project/src/a.cpp\n"));

                return { exitCode: 0, timedOut: false, cancelled: false, wallTimeMs: 0 };
            },
        } as unknown as ContainerSession;
        const source = new ContainerCodeSource(session, "/project");

        expect(await source.grepFiles("connect", "/project", { limit: 10 })).toEqual([
            "/project/src/a.cpp",
        ]);
    });
});

describe("outline tool registration", () => {
    it("registers the outline tool and executes a digest against the local view", async () => {
        const root = tempProject();

        write(
            root,
            "src/socket.h",
            `namespace net {\nclass Socket {\npublic:\n  bool connect(const Address& addr);\n};\n}\n`,
        );

        const stub = createPiStub();

        registerCodeTool(stub.pi);

        const tool = stub.requireTool("outline");
        const result = await tool.execute(
            "call-1",
            { action: "digest", path: "src" },
            undefined,
            undefined,
            stubContext({ cwd: root }),
        );

        expect(tool.definition.label).toBe("Outline");
        expect(tool.definition.description).toContain("C++");
        expect(tool.definition.description).not.toContain("Type::method(const X&)");

        const schema = JSON.stringify(tool.definition.parameters);

        expect(schema).toContain('"enum":["digest","search","show","usages","deps"]');
        // A confirmation call should be able to buy one signature without paying for a whole page.
        expect(schema).toContain('"minimum":200');
        expect(tool.definition.description).toContain("path:start-end");
        expect(schema).toContain('"offset"');
        expect(schema).toContain('"limit"');
        expect(schema).not.toContain('"maxMatches"');
        expect(schema).not.toContain("anyOf");
        const content = result.content[0];

        expect(content?.type).toBe("text");

        if (content?.type === "text") {
            expect(content.text).toContain("class Socket");
        }

        expect(result.details).toMatchObject({ action: "digest", source: "local" });
    });

    it("dispatches a declaration search through the registered tool", async () => {
        const root = tempProject();

        write(
            root,
            "src/socket.h",
            `namespace net {\nclass Socket {\npublic:\n  bool connect();\n};\n}\n`,
        );

        const stub = createPiStub();

        registerCodeTool(stub.pi);

        const result = await stub
            .requireTool("outline")
            .execute(
                "call-2",
                { action: "search", path: "src", query: "Sock" },
                undefined,
                undefined,
                stubContext({ cwd: root }),
            );

        expect(result.content[0]?.type).toBe("text");

        if (result.content[0]?.type === "text") {
            expect(result.content[0].text).toContain("net::Socket");
            expect(result.content[0].text).toContain("# search");
        }

        expect(result.details).toMatchObject({ action: "search", matches: 1 });
    });

    it("selects the container source when the sandbox is active", async () => {
        const session = {} as ContainerSession;
        const source = await createCodeSource(stubContext({ cwd: "/project" }), {
            active: true,
            sessionFor: async () => session,
        });

        expect(source.kind).toBe("container");

        const local = await createCodeSource(stubContext({ cwd: "/project" }), {
            active: false,
            sessionFor: async () => session,
        });

        expect(local.kind).toBe("local");
    });
});
