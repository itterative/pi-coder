import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContainerSession } from "../../../src/modules/sandbox/container/client";
import {
    ContainerCodeSource,
    LocalCodeSource,
    createCodeSource,
    ripgrepGlob,
} from "../../../src/tools/code/source";
import { runDigest } from "../../../src/tools/code/digest";
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

    it("applies a root-relative pattern with a wildcard in a middle segment", async () => {
        const root = tempProject();

        write(root, "src/modules/a/index.ts", "export const a = 1;\n");
        write(root, "src/modules/b/index.ts", "export const b = 2;\n");
        write(root, "src/modules/a/deep/index.ts", "export const deep = 3;\n");
        write(root, "src/modules/a/other.ts", "export const other = 4;\n");

        const source = new LocalCodeSource(root);
        const modules = path.join(root, "src", "modules");
        const paths = (await source.glob(modules, { limit: 100, pattern: "*/index.ts" }))
            .map((entry) => path.relative(modules, entry))
            .toSorted();

        // ripgrep matches `--glob` against the path it prints, so the root-relative pattern has to be rewritten
        // before it is handed over; passing it through matched nothing at all.
        expect(paths).toEqual([path.join("a", "index.ts"), path.join("b", "index.ts")]);
    });

    it("digests a pattern whose wildcard follows the literal prefix", async () => {
        const root = tempProject();

        write(root, "src/modules/a/index.ts", "export function alpha(): number { return 1; }\n");
        write(root, "src/modules/b/index.ts", "export function beta(): number { return 2; }\n");
        write(root, "src/modules/b/other.ts", "export function other(): number { return 3; }\n");

        const result = await runDigest(new LocalCodeSource(root), {
            action: "digest",
            path: "src/modules/*/index.ts",
        });

        expect(result.text).not.toContain("no files match");
        expect(result.text).toContain("src/modules/a/index.ts");
        expect(result.text).toContain("src/modules/b/index.ts");
        expect(result.text).not.toContain("src/modules/b/other.ts");
    });
});

describe("ripgrep glob rewriting", () => {
    it("rewrites a root-relative pattern to the path ripgrep matches against", () => {
        expect(ripgrepGlob("/project/src/modules", "*/index.ts", "/project")).toBe(
            "src/modules/*/index.ts",
        );
        expect(ripgrepGlob("/project/src", "*.ts", "/project")).toBe("src/*.ts");
        expect(ripgrepGlob("/project/src", "/project/src/*.ts", "/project")).toBe("src/*.ts");
    });

    it("keeps only what a root outside the cwd can express", () => {
        // A basename pattern matches at any depth, and `**/` absorbs a leading absolute prefix.
        expect(ripgrepGlob("/elsewhere/src", "*.ts", "/project")).toBe("*.ts");
        expect(ripgrepGlob("/elsewhere/src", "**/index.ts", "/project")).toBe("**/index.ts");
        // Anything else would be read literally and match nothing, so the post-filter owns it instead.
        expect(ripgrepGlob("/elsewhere/src", "*/index.ts", "/project")).toBeUndefined();
        expect(ripgrepGlob("/elsewhere/src", "/elsewhere/src/*.ts", "/project")).toBeUndefined();
    });

    it("asks for no pattern when the caller gave none", () => {
        expect(ripgrepGlob("/project/src", undefined, "/project")).toBeUndefined();
        expect(ripgrepGlob("/project/src", "", "/project")).toBeUndefined();
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
        await source.glob("/project/src/modules", { limit: 5, pattern: "*/index.ts" });
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
        // The container's rg matches globs the same way the local one does, so the same rewrite applies.
        expect(globCalls[2]?.pattern).toBe("src/modules/*/index.ts");
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

        expect(schema).toContain('"enum":["digest","search","show","usages","deps","flow"]');
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
