import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    buildState,
    readScriptFile,
    resetDecisionScriptCache,
    resolveScriptRun,
    type ScriptFileIdentity,
    type ScriptRun,
} from "../../../src/modules/decision";

/**
 * The script resolver: which command forms are recognized, which bodies the chase collects and in what
 * order, and the mtime-keyed read cache under it. Every read here is injected, so the resolver never touches
 * disk except in the read-cache cases at the bottom.
 */

/** A path map as the resolver's reader: contents when present, `ENOENT` when not. */
function virtualFiles(files: Record<string, string>) {
    const reads: string[] = [];
    return {
        reads,
        readFile: (filePath: string): string => {
            reads.push(filePath);
            const content = files[filePath];
            if (content === undefined) {
                throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
            }
            return content;
        },
    };
}

interface ResolveOptions {
    cwd?: string;
    files?: Record<string, string>;
    identities?: Record<string, ScriptFileIdentity>;
}

function resolve(command: string, options: ResolveOptions = {}): ScriptRun | undefined {
    const { readFile } = virtualFiles(options.files ?? {});
    const identities = options.identities ?? {};
    return resolveScriptRun(command, {
        cwd: options.cwd ?? "/repo",
        readFile,
        statFile: (filePath) => identities[filePath],
    });
}

const PACKAGE = "/repo/package.json";
const packageJson = JSON.stringify({
    scripts: {
        build: "node scripts/build.js",
        test: "vitest run",
        start: "node server.js",
    },
});

/** A package script line as the chase records it, for the many assertions that only differ in text. */
function packageLine(name: string, text: string, packagePath = PACKAGE) {
    return {
        source: `${path.relative("/repo", packagePath)}#${name}`,
        path: packagePath,
        text,
    };
}

describe("package script runs", () => {
    it("resolves every recognized package-manager form to its script line", () => {
        const files = { [PACKAGE]: packageJson };

        for (const command of [
            "npm run build",
            "npm run-script build",
            "pnpm run build",
            "yarn run build",
            "bun run build",
        ]) {
            expect(resolve(command, { files })).toEqual({
                kind: "package",
                artifacts: [packageLine("build", "node scripts/build.js")],
            });
        }

        expect(resolve("npm test", { files })).toEqual({
            kind: "package",
            artifacts: [packageLine("test", "vitest run")],
        });
        expect(resolve("npm start", { files })).toEqual({
            kind: "package",
            artifacts: [packageLine("start", "node server.js")],
        });
    });

    it("keeps the line whole, including newlines", () => {
        const line = "node scripts/deploy.js --prod\n&& node scripts/notify.js";
        const files = { [PACKAGE]: JSON.stringify({ scripts: { deploy: line } }) };

        expect(resolve("npm run deploy", { files })?.artifacts).toEqual([
            packageLine("deploy", line),
        ]);
    });

    it("reports the recognized form without a body when the script is missing", () => {
        expect(resolve("npm run missing", { files: { [PACKAGE]: packageJson } })).toEqual({
            kind: "package",
            artifacts: [],
        });
    });

    it("reports the recognized form without a body when no package.json exists", () => {
        expect(resolve("npm run build")).toEqual({ kind: "package", artifacts: [] });
    });

    it("stops at a malformed nearest package.json instead of reading an ancestor's", () => {
        const files = {
            "/repo/sub/package.json": "{ not json",
            [PACKAGE]: packageJson,
        };

        expect(resolve("npm run build", { cwd: "/repo/sub", files })).toEqual({
            kind: "package",
            artifacts: [],
        });
    });

    it("walks up to the nearest package.json, keeping the source relative to cwd", () => {
        const files = { [PACKAGE]: packageJson };

        expect(resolve("npm run build", { cwd: "/repo/src/deep", files })).toEqual({
            kind: "package",
            artifacts: [
                {
                    source: "../../package.json#build",
                    path: PACKAGE,
                    text: "node scripts/build.js",
                },
            ],
        });
    });

    it("leaves yarn without run alone", () => {
        expect(resolve("yarn build", { files: { [PACKAGE]: packageJson } })).toBeUndefined();
    });

    it("unwraps a transparent timeout before recognizing the form", () => {
        expect(resolve("timeout 600 npm run build", { files: { [PACKAGE]: packageJson } })).toEqual(
            {
                kind: "package",
                artifacts: [packageLine("build", "node scripts/build.js")],
            },
        );
    });
});

describe("nested package scripts", () => {
    const chained = JSON.stringify({
        scripts: {
            test: "npm run build && vitest run",
            build: "tsc --noEmit",
        },
    });

    it("resolves a chained npm-script reference as a second artifact", () => {
        const run = resolve("npm run test", { files: { [PACKAGE]: chained } });

        expect(run?.artifacts).toEqual([
            packageLine("test", "npm run build && vitest run"),
            packageLine("build", "tsc --noEmit"),
        ]);
        expect(run?.omissions).toBeUndefined();
    });

    it("collects an inline body a package script line runs", () => {
        const files = {
            [PACKAGE]: JSON.stringify({ scripts: { check: "node -e 'main()'" } }),
        };

        const run = resolve("npm run check", { files });

        expect(run?.artifacts).toEqual([
            packageLine("check", "node -e 'main()'"),
            { source: "inline:node -e", text: "main()" },
        ]);
    });

    it("walks a chain breadth-first, in the order references appear", () => {
        const files = {
            [PACKAGE]: JSON.stringify({
                scripts: {
                    a: "npm run b && npm run c",
                    b: "npm run d",
                    c: "echo c",
                    d: "echo d",
                },
            }),
        };

        const run = resolve("npm run a", { files });

        expect(run?.artifacts.map((artifact) => artifact.source)).toEqual([
            "package.json#a",
            "package.json#b",
            "package.json#c",
            "package.json#d",
        ]);
    });

    it("terminates a cycle with an omission marker instead of repeating a body", () => {
        const files = {
            [PACKAGE]: JSON.stringify({
                scripts: { a: "npm run b", b: "npm run a" },
            }),
        };

        const run = resolve("npm run a", { files });

        expect(run?.artifacts).toEqual([
            packageLine("a", "npm run b"),
            packageLine("b", "npm run a"),
        ]);
        expect(run?.omissions).toEqual([{ reason: "cycle", source: "package.json#a" }]);
    });

    it("stops at the depth cap with an omission marker, never a shortened body", () => {
        const names = ["a", "b", "c", "d", "e", "f", "g"];
        const scripts: Record<string, string> = {};
        for (const [index, name] of names.entries()) {
            scripts[name] = index === names.length - 1 ? "echo end" : `npm run ${names[index + 1]}`;
        }
        const files = { [PACKAGE]: JSON.stringify({ scripts }) };

        const run = resolve("npm run a", { files });

        expect(run?.artifacts.map((artifact) => artifact.source)).toEqual(
            names.slice(0, 6).map((name) => `package.json#${name}`),
        );
        expect(run?.artifacts.map((artifact) => artifact.text)).toEqual([
            "npm run b",
            "npm run c",
            "npm run d",
            "npm run e",
            "npm run f",
            "npm run g",
        ]);
        expect(run?.omissions).toEqual([{ reason: "depth", source: "package.json#g" }]);
    });

    it("skips a reference to a script this package does not define", () => {
        const files = {
            [PACKAGE]: JSON.stringify({ scripts: { a: "npm run missing" } }),
        };

        expect(resolve("npm run a", { files })).toEqual({
            kind: "package",
            artifacts: [packageLine("a", "npm run missing")],
        });
    });

    it("resolves every nested name against the same package.json", () => {
        const files = {
            [PACKAGE]: JSON.stringify({
                scripts: { a: "cd /elsewhere && npm run b", b: "echo b" },
            }),
        };

        const run = resolve("npm run a", { files });

        expect(run?.artifacts.map((artifact) => artifact.source)).toEqual([
            "package.json#a",
            "package.json#b",
        ]);
    });

    it("keeps the source relative to the caller's cwd after a cd prefix", () => {
        const run = resolve("cd /repo/sub && npm run build", {
            cwd: "/repo",
            files: {
                "/repo/sub/package.json": JSON.stringify({
                    scripts: { build: "node build.js" },
                }),
            },
        });

        expect(run?.artifacts).toEqual([
            {
                source: "sub/package.json#build",
                path: "/repo/sub/package.json",
                text: "node build.js",
            },
        ]);
    });
});

describe("script lines invoking files", () => {
    it("adds the file a package script line invokes, after the line", () => {
        const run = resolve("npm run deploy", {
            files: {
                [PACKAGE]: JSON.stringify({ scripts: { deploy: "node scripts/deploy.js --prod" } }),
                "/repo/scripts/deploy.js": "deploy({ production: true });",
            },
        });

        expect(run?.artifacts).toEqual([
            packageLine("deploy", "node scripts/deploy.js --prod"),
            {
                source: "scripts/deploy.js",
                path: "/repo/scripts/deploy.js",
                text: "deploy({ production: true });",
            },
        ]);
    });

    it("collects file bodies from every line, after all script lines", () => {
        const run = resolve("npm run test", {
            files: {
                [PACKAGE]: JSON.stringify({
                    scripts: {
                        test: "npm run build && node scripts/check.js",
                        build: "node scripts/build.js",
                    },
                }),
                "/repo/scripts/check.js": "check()",
                "/repo/scripts/build.js": "build()",
            },
        });

        expect(run?.artifacts.map((artifact) => artifact.source)).toEqual([
            "package.json#test",
            "package.json#build",
            "scripts/check.js",
            "scripts/build.js",
        ]);
    });

    it("reads an interpreter path and a bare path from the same machinery", () => {
        for (const [line, source] of [
            ["python3 scripts/run.py", "scripts/run.py"],
            ["bash scripts/run.sh", "scripts/run.sh"],
            ["tsx scripts/run.ts", "scripts/run.ts"],
            ["./scripts/run.sh", "scripts/run.sh"],
            ["scripts/run.sh", "scripts/run.sh"],
        ]) {
            const run = resolve("npm run run", {
                files: {
                    [PACKAGE]: JSON.stringify({ scripts: { run: line } }),
                    [`/repo/${source}`]: "body",
                },
            });

            expect(run?.artifacts[1]).toEqual({
                source,
                path: `/repo/${source}`,
                text: "body",
            });
        }
    });

    it("resolves a line's paths against the package directory", () => {
        const run = resolve("cd /repo/sub && npm run run", {
            cwd: "/repo",
            files: {
                "/repo/sub/package.json": JSON.stringify({ scripts: { run: "node run.js" } }),
                "/repo/sub/run.js": "run()",
            },
        });

        // The line is plain, so the package.json's own directory is the runtime cwd; a `cd` in the line
        // moves it, which the next case covers.
        expect(run?.artifacts[1]).toMatchObject({ source: "sub/run.js", text: "run()" });
    });

    it("follows a cd prefix inside a script line", () => {
        const run = resolve("npm run run", {
            files: {
                "/repo/package.json": JSON.stringify({
                    scripts: { run: "cd sub && node run.js" },
                }),
                "/repo/sub/run.js": "run()",
            },
        });

        expect(run?.artifacts[1]).toMatchObject({
            source: "sub/run.js",
            path: "/repo/sub/run.js",
            text: "run()",
        });
    });

    it("carries the file's identity so the verdict cache can key on it", () => {
        const identity = { mtimeMs: 1730000000000, size: 7 };
        const run = resolve("npm run run", {
            files: {
                [PACKAGE]: JSON.stringify({ scripts: { run: "python3 run.py" } }),
                "/repo/run.py": "print(1)",
            },
            identities: { "/repo/run.py": identity },
        });

        expect(run?.artifacts[1]).toMatchObject({ identity });
    });

    it("reads the same file once even when a line invokes it twice", () => {
        const run = resolve("npm run run", {
            files: {
                [PACKAGE]: JSON.stringify({ scripts: { run: "node run.js && node run.js" } }),
                "/repo/run.js": "run()",
            },
        });

        expect(run?.artifacts.map((artifact) => artifact.source)).toEqual([
            "package.json#run",
            "run.js",
        ]);
    });
});

describe("file script runs", () => {
    const script = "/repo/scripts/run.py";

    it("resolves an interpreter followed by a script path", () => {
        expect(
            resolve("python3 scripts/run.py --flag", { files: { [script]: "print(1)" } }),
        ).toEqual({
            kind: "file",
            artifacts: [{ source: "scripts/run.py", path: script, text: "print(1)" }],
        });
        expect(
            resolve("node scripts/run.js", { files: { "/repo/scripts/run.js": "main()" } }),
        ).toMatchObject({
            kind: "file",
            artifacts: [{ source: "scripts/run.js", text: "main()" }],
        });
        expect(
            resolve("bash scripts/run.sh", { files: { "/repo/scripts/run.sh": "echo hi" } }),
        ).toMatchObject({ kind: "file", artifacts: [{ text: "echo hi" }] });
    });

    it("resolves a script behind a transparent `time` wrapper", () => {
        expect(
            resolve("time -p python3 scripts/run.py --flag", { files: { [script]: "print(1)" } }),
        ).toEqual({
            kind: "file",
            artifacts: [{ source: "scripts/run.py", path: script, text: "print(1)" }],
        });
        expect(resolve("time python3 -c 'print(1)'", { files: {} })).toEqual({
            kind: "inline",
            artifacts: [{ source: "inline:python3 -c", text: "print(1)" }],
        });
    });

    it("reads every literal path argument, so a flag value does not hide the script", () => {
        expect(
            resolve("node --import tsx scripts/run.ts", {
                files: { "/repo/scripts/run.ts": "console.log(1)" },
            }),
        ).toEqual({
            kind: "file",
            artifacts: [
                { source: "scripts/run.ts", path: "/repo/scripts/run.ts", text: "console.log(1)" },
            ],
        });
        expect(
            resolve("node scripts/run.js scripts/run.js", {
                files: { "/repo/scripts/run.js": "main()" },
            }),
        ).toMatchObject({ kind: "file", artifacts: [{ text: "main()" }] });
    });

    it("resolves a command that is itself a path to a readable file", () => {
        expect(
            resolve("./scripts/deploy.sh --prod", {
                files: { "/repo/scripts/deploy.sh": "set -e" },
            }),
        ).toEqual({
            kind: "file",
            artifacts: [
                { source: "scripts/deploy.sh", path: "/repo/scripts/deploy.sh", text: "set -e" },
            ],
        });
        expect(
            resolve("scripts/deploy.sh", { files: { "/repo/scripts/deploy.sh": "set -e" } }),
        ).toMatchObject({ kind: "file", artifacts: [{ source: "scripts/deploy.sh" }] });
    });

    it("resolves a bare name without a slash through PATH only, so it has no body", () => {
        expect(resolve("deploy.sh", { files: { "/repo/deploy.sh": "set -e" } })).toBeUndefined();
    });

    it("skips the deno run subcommand and flags before the path", () => {
        expect(
            resolve("deno run --allow-read scripts/run.ts", {
                files: { "/repo/scripts/run.ts": "export {}" },
            }),
        ).toMatchObject({ kind: "file", artifacts: [{ source: "scripts/run.ts" }] });
        expect(
            resolve("bash -x scripts/run.sh", { files: { "/repo/scripts/run.sh": "echo hi" } }),
        ).toMatchObject({ kind: "file" });
    });

    it("resolves the path relative to cwd", () => {
        expect(
            resolve("python3 run.py", { cwd: "/repo/work", files: { "/repo/work/run.py": "x" } }),
        ).toEqual({
            kind: "file",
            artifacts: [{ source: "run.py", path: "/repo/work/run.py", text: "x" }],
        });
    });

    it("uses the cd prefix for a relative path", () => {
        expect(
            resolve("cd /repo/sub && python3 run.py", { files: { "/repo/sub/run.py": "x" } }),
        ).toEqual({
            kind: "file",
            artifacts: [{ source: "sub/run.py", path: "/repo/sub/run.py", text: "x" }],
        });
    });

    it("falls back to cwd when the cd target is not literal", () => {
        const files = { "/repo/run.py": "x" };

        expect(resolve('cd "$TARGET" && python3 run.py', { files })).toMatchObject({
            kind: "file",
            artifacts: [{ path: "/repo/run.py" }],
        });
    });

    it("resolves nothing for a missing or unreadable file", () => {
        expect(resolve("python3 missing.py", { files: {} })).toBeUndefined();
        expect(resolve("python3 scripts/run.py", { files: {} })).toBeUndefined();
        expect(
            resolveScriptRun("python3 run.py", {
                cwd: "/repo",
                readFile: () => {
                    throw new Error("EACCES: permission denied");
                },
            }),
        ).toBeUndefined();
    });

    it("resolves nothing for a non-literal path or a stdin argument", () => {
        expect(resolve('python3 "$SCRIPT"', { files: {} })).toBeUndefined();
        expect(resolve("python3 -", { files: {} })).toBeUndefined();
        expect(
            resolve("./scripts/$NAME.sh", { files: { "/repo/scripts/run.sh": "x" } }),
        ).toBeUndefined();
    });

    it("carries the reader's mtime and size as the body's identity", () => {
        const identity = { mtimeMs: 1730000000000, size: 7 };
        expect(
            resolve("python3 run.py", {
                files: { "/repo/run.py": "print(1)" },
                identities: { "/repo/run.py": identity },
            }),
        ).toEqual({
            kind: "file",
            artifacts: [{ source: "run.py", path: "/repo/run.py", text: "print(1)", identity }],
        });
    });

    it("keeps a multi-kilobyte body whole, with no clipping", () => {
        const content = `# ${"y".repeat(4096)}\nprint("done")\n`;
        const files = {
            [PACKAGE]: JSON.stringify({ scripts: { run: "python3 run.py" } }),
            "/repo/run.py": content,
        };

        const run = resolve("npm run run", { files });
        const state = buildState(
            { command: "npm run run", cwd: "/repo", script: run },
            "request_context",
        );

        expect(run?.artifacts[1]?.text).toBe(content);
        expect(run?.artifacts[1]?.text.length).toBeGreaterThan(4096);
        expect(state.scripts).toEqual(["python3 run.py", content]);
    });
});

describe("inline script runs", () => {
    it("carries the literal eval code as a body", () => {
        expect(resolve("python3 -c 'print(1)'")).toEqual({
            kind: "inline",
            artifacts: [{ source: "inline:python3 -c", text: "print(1)" }],
        });
        expect(resolve("node -e 'main()'")).toEqual({
            kind: "inline",
            artifacts: [{ source: "inline:node -e", text: "main()" }],
        });
        expect(resolve("node --eval 'main()'")).toEqual({
            kind: "inline",
            artifacts: [{ source: "inline:node --eval", text: "main()" }],
        });
    });

    it("carries no body for a dynamically assembled operand", () => {
        expect(resolve(`python3 -c "$(cat code.py)"`)).toEqual({ kind: "inline", artifacts: [] });
        expect(resolve('node -e "$SNIPPET"')).toEqual({ kind: "inline", artifacts: [] });
    });

    it("does not read a `-c` that is an argument to the script", () => {
        expect(resolve("bash script.sh -c")).toBeUndefined();
    });

    it("recognizes a heredoc feeding an interpreter", () => {
        const command = "python3 - <<'PY'\nprint(1)\nPY";
        expect(resolve(command)).toEqual({
            kind: "inline",
            artifacts: [{ source: "inline:heredoc", text: "print(1)" }],
        });
        expect(resolve("bash <<'EOF'\necho hi\nEOF")).toEqual({
            kind: "inline",
            artifacts: [{ source: "inline:heredoc", text: "echo hi" }],
        });
    });

    it("does not treat a heredoc to a non-interpreter as script code", () => {
        expect(resolve("cat <<'EOF'\nhello\nEOF")).toBeUndefined();
    });
});

describe("binary script runs", () => {
    it("recognizes package and tool runners whose code lives outside the repository", () => {
        for (const command of [
            "npx tsc --noEmit",
            "bunx prettier --write .",
            "uvx ruff check",
            "uv run pytest -q",
        ]) {
            expect(resolve(command)).toEqual({ kind: "binary", artifacts: [] });
        }
    });

    it("treats an interpreter module run as code from outside the repository", () => {
        expect(resolve("python3 -m pytest")).toEqual({ kind: "binary", artifacts: [] });
    });
});

describe("unrecognized commands", () => {
    it("resolves nothing", () => {
        for (const command of ["ls -la", "echo hello", "make deploy", "yarn build", "npm run"]) {
            expect(resolve(command)).toBeUndefined();
        }
    });

    it("handles an unparseable command without throwing", () => {
        expect(resolve("python3 'unterminated")).toBeUndefined();
        expect(resolve("")).toBeUndefined();
    });
});

describe("script body read cache", () => {
    const directories: string[] = [];

    afterEach(() => {
        resetDecisionScriptCache();
        for (const directory of directories.splice(0)) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    function temporaryFile(content: string): string {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-script-cache-"));
        directories.push(directory);
        const file = path.join(directory, "script.py");
        fs.writeFileSync(file, content);
        return file;
    }

    it("serves an unchanged file from memory", () => {
        const file = temporaryFile("first");
        const read = vi.spyOn(fs, "readFileSync");

        expect(readScriptFile(file)).toBe("first");
        expect(readScriptFile(file)).toBe("first");
        expect(read).toHaveBeenCalledTimes(1);

        read.mockRestore();
    });

    it("misses when the mtime changes, even at the same size", () => {
        const file = temporaryFile("first");
        expect(readScriptFile(file)).toBe("first");

        // Keep the byte count identical on purpose: the key must include mtime, not just size.
        fs.writeFileSync(file, "other");
        fs.utimesSync(file, new Date(2_000_000), new Date(2_000_000));

        expect(readScriptFile(file)).toBe("other");
    });

    it("drops everything on reset", () => {
        const file = temporaryFile("first");
        expect(readScriptFile(file)).toBe("first");

        resetDecisionScriptCache();
        fs.writeFileSync(file, "other");
        fs.utimesSync(file, new Date(2_000_000), new Date(2_000_000));

        expect(readScriptFile(file)).toBe("other");
    });
});
