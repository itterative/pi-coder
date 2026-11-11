import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { effectiveSemanticMode } from "../../../src/tools/code/semantic/config";
import { MODEL_DIMS, MODEL_ID } from "../../../src/tools/code/semantic/config";
import { NATIVE_CPUS, nativeRuntimeDir } from "../../../src/tools/code/semantic/native";
import {
    emptyManifest,
    indexDir,
    namespaceFor,
    writeManifest,
} from "../../../src/tools/code/semantic/store";
import { EMBED_TEXT_VERSION } from "../../../src/tools/code/text";
import registerCodeTool from "../../../src/tools/code";
import { createPiStub, stubContext } from "../../helpers/pi-stub";

const dirs: string[] = [];
const previousModelDir = process.env.PI_CODER_OUTLINE_MODEL_DIR;
const previousMode = process.env.PI_CODER_OUTLINE_SEMANTIC;

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    restoreEnv("PI_CODER_OUTLINE_MODEL_DIR", previousModelDir);
    restoreEnv("PI_CODER_OUTLINE_SEMANTIC", previousMode);
});

beforeEach(() => {
    delete process.env.PI_CODER_OUTLINE_SEMANTIC;
});

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];

        return;
    }

    process.env[name] = value;
}

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-mode-"));

    dirs.push(dir);

    return dir;
}

/** A model dir with one state file and one fabricated namespace. */
function stateDir(options: {
    consent: string;
    sourceKind?: string;
    root?: string;
    vectors?: number;
}): string {
    const dir = tempDir();

    fs.writeFileSync(
        path.join(dir, "state.json"),
        JSON.stringify({ consent: options.consent, modelId: MODEL_ID }),
    );

    if (options.sourceKind !== undefined) {
        const root = options.root ?? "/project";
        const namespace = namespaceFor(options.sourceKind, root, MODEL_ID, EMBED_TEXT_VERSION);
        const manifest = {
            ...emptyManifest(MODEL_ID, MODEL_DIMS, EMBED_TEXT_VERSION),
            sourceKind: options.sourceKind,
            root,
            builtAt: "2026-11-11T11:00:00.000Z",
            entries: Object.fromEntries(
                Array.from({ length: options.vectors ?? 2 }, (_, index) => [
                    `key${index}`,
                    { shard: "shard-1", offset: index * 4 },
                ]),
            ),
        };

        writeManifest(indexDir(dir, namespace), manifest);
    }

    return dir;
}

async function statusLines(options: { cwd: string; state: string }): Promise<string[]> {
    process.env.PI_CODER_OUTLINE_MODEL_DIR = options.state;

    const stub = createPiStub();
    registerCodeTool(stub.pi);
    const lines: string[] = [];
    const context = stubContext({ cwd: options.cwd });

    await stub.requireCommand("outline").handler?.("status", {
        ...context,
        ui: {
            notify: (message: string) => lines.push(message),
            setStatus: () => undefined,
        },
    } as never);

    return lines;
}

describe("effective semantic mode", () => {
    it("runs hybrid when the user consented, whatever the environment default says", () => {
        // The reported bug: `/outline status` said `mode=bm25 consent=enabled` while search used embeddings.
        expect(effectiveSemanticMode({}, { consent: "enabled" })).toEqual({
            mode: "hybrid",
            source: "consent",
        });
    });

    it("defaults to bm25 without consent, and names the reason", () => {
        expect(effectiveSemanticMode({}, { consent: "unset" })).toEqual({
            mode: "bm25",
            source: "default",
        });
        expect(effectiveSemanticMode({}, { consent: "never" })).toEqual({
            mode: "bm25",
            source: "default",
        });
    });

    it("lets an explicit setting win over a stored consent", () => {
        expect(
            effectiveSemanticMode({ PI_CODER_OUTLINE_SEMANTIC: "bm25" }, { consent: "enabled" }),
        ).toEqual({ mode: "bm25", source: "config" });
        expect(
            effectiveSemanticMode({ PI_CODER_OUTLINE_SEMANTIC: "off" }, { consent: "enabled" }),
        ).toEqual({ mode: "off", source: "config" });
        expect(
            effectiveSemanticMode({ PI_CODER_OUTLINE_SEMANTIC: "hybrid" }, { consent: "never" }),
        ).toEqual({ mode: "hybrid", source: "config" });
    });
});

describe("/outline status", () => {
    const cwd = "/project";

    it("reports the mode a search will use, not the configured default", async () => {
        const lines = await statusLines({ cwd, state: stateDir({ consent: "enabled" }) });

        expect(lines.join("\n")).toContain("mode=hybrid (consent) · consent=enabled");
    });

    it("says when this session's root has no index, because another view's index will not be used", async () => {
        const lines = await statusLines({
            cwd,
            state: stateDir({ consent: "enabled", sourceKind: "container", root: cwd, vectors: 5 }),
        });
        const text = lines.join("\n");

        expect(text).toContain("this session: no local index for .");
        expect(text).toContain("container . · 5 vectors");
    });

    it("says when the native runtime is missing, since the wasm fallback is silent and slow", async () => {
        const state = stateDir({ consent: "enabled", sourceKind: "local", root: cwd, vectors: 3 });
        const text = (await statusLines({ cwd, state })).join("\n");

        expect(text).toContain("native runtime: not installed");
        expect(text).toContain("/outline on installs it");
    });

    it("reports the native runtime once both pinned files are there", async () => {
        const state = stateDir({ consent: "enabled", sourceKind: "local", root: cwd, vectors: 3 });
        const cpu = NATIVE_CPUS[0]!;
        const dir = nativeRuntimeDir(state)!;

        fs.mkdirSync(dir, { recursive: true });
        // Sparse files: `nativeRuntimePresent` checks the pinned sizes, not the bytes.
        fs.writeFileSync(path.join(dir, "onnxruntime_binding.node"), "");
        fs.truncateSync(path.join(dir, "onnxruntime_binding.node"), cpu.binding.bytes);
        fs.writeFileSync(path.join(dir, cpu.library), "");
        fs.truncateSync(path.join(dir, cpu.library), cpu.libraryFile.bytes);

        expect((await statusLines({ cwd, state })).join("\n")).toContain(
            "native runtime: installed",
        );
    });

    it("names the vectors this session's own root has", async () => {
        const lines = await statusLines({
            cwd,
            state: stateDir({
                consent: "enabled",
                sourceKind: "local",
                root: cwd,
                vectors: 12_345,
            }),
        });

        expect(lines.join("\n")).toContain("this session: local . · 12.3k vectors");
    });
});
