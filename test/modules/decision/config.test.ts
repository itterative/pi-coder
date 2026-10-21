import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DecisionModelConfig } from "../../../src/modules/decision";
import decisionConfig, {
    defaultGlobalConfigPath,
    findDecisionConfigLocations,
    loadDecisionConfig,
    saveDecisionConfig,
} from "../../../src/modules/decision/config";

/**
 * The decision model's config layering: a global file (where the endpoint credential lives), the nearest
 * project file above the working directory, and `SYSTEMONE_*` last. `test/setup.ts` blanks both path
 * variables and this suite blanks every environment value it does not set, so each location under test is
 * one this suite chose rather than the developer's.
 */

const CONFIG_FIELDS = [
    "enabled",
    "apply",
    "baseUrl",
    "apiKey",
    "provider",
    "model",
    "strategy",
    "timeoutMs",
    "cooldownMs",
    "contextWindow",
    "minConfidence",
    "surfaces",
    "fileSurfaces",
    "reminders",
    "reminderMinProbability",
] as const;

function expectUnconfigured(config: DecisionModelConfig): void {
    for (const field of CONFIG_FIELDS) {
        expect(config[field], `expected ${field} to be undefined`).toBeUndefined();
    }
}

const temporaryDirectories: string[] = [];
let root: string;
let workspace: string;
let globalPath: string;
let fallbackPath: string;

function projectConfigPath(): string {
    return path.join(workspace, ".pi", "decision-model-config.json");
}

function writeProjectConfig(data: unknown): void {
    fs.writeFileSync(projectConfigPath(), JSON.stringify(data));
}

function writeGlobalConfig(data: unknown): void {
    fs.writeFileSync(globalPath, JSON.stringify(data));
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decision-config-"));
    temporaryDirectories.push(root);
    workspace = path.join(root, "project");
    fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    globalPath = path.join(root, "global-decision-model.json");
    fallbackPath = path.join(root, "fallback-decision-model.json");

    // The developer's endpoint variables must not reach these assertions; the suite sets the ones it wants.
    vi.stubEnv("SYSTEMONE_API_URL", "");
    vi.stubEnv("SYSTEMONE_API_TOKEN", "");
    vi.stubEnv("SYSTEMONE_MODEL", "");
    vi.stubEnv("SYSTEMONE_TIMEOUT", "");
    // Non-blank so the walk-up runs at all: `test/setup.ts` blanks this variable, which means "no project
    // file", and finding one above the working directory is exactly what this suite is here to test.
    vi.stubEnv("DECISION_MODEL_CONFIG_PATH", path.join(root, "unused-fallback.json"));
    decisionConfig.reset();
});

afterEach(() => {
    decisionConfig.reset();
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("decision config files", () => {
    it("returns an unconfigured config when no file exists anywhere", () => {
        expectUnconfigured(loadDecisionConfig(workspace));
    });

    it("reads the global file when the project has none", () => {
        writeGlobalConfig({
            decisionModel: { enabled: true, baseUrl: "https://global.example", model: "global" },
        });
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH_GLOBAL", globalPath);

        expect(loadDecisionConfig(workspace)).toMatchObject({
            enabled: true,
            baseUrl: "https://global.example",
            model: "global",
        });
    });

    it("lets the project file override single fields and inherit the rest", () => {
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH_GLOBAL", globalPath);
        writeGlobalConfig({
            decisionModel: {
                enabled: true,
                apply: true,
                baseUrl: "https://global.example",
                apiKey: "global-token",
                model: "global",
                timeoutMs: 4000,
            },
        });
        writeProjectConfig({ decisionModel: { apply: false, model: "project" } });

        expect(loadDecisionConfig(workspace)).toMatchObject({
            enabled: true,
            apply: false,
            baseUrl: "https://global.example",
            apiKey: "global-token",
            model: "project",
            timeoutMs: 4000,
        });
    });

    it("finds the nearest project file by walking up from a nested cwd", () => {
        writeProjectConfig({ decisionModel: { enabled: true, model: "project" } });
        const nested = path.join(workspace, "src", "deep");
        fs.mkdirSync(nested, { recursive: true });

        expect(findDecisionConfigLocations(nested).project).toBe(projectConfigPath());
        expect(loadDecisionConfig(nested)).toMatchObject({ enabled: true, model: "project" });
    });

    it("falls back to DECISION_MODEL_CONFIG_PATH when no project file exists", () => {
        fs.writeFileSync(
            fallbackPath,
            JSON.stringify({ decisionModel: { enabled: true, model: "fallback" } }),
        );
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH", fallbackPath);

        expect(findDecisionConfigLocations(workspace).project).toBe(fallbackPath);
        expect(loadDecisionConfig(workspace)).toMatchObject({ enabled: true, model: "fallback" });
    });

    it("suppresses the walk-up too when DECISION_MODEL_CONFIG_PATH is blank", () => {
        writeProjectConfig({ decisionModel: { enabled: true, model: "project" } });
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH", "");

        // Blank means "no project file", not "no fallback": a suite (or a shell) that wants no project
        // overlay must not have to know which directory above it happens to hold one. This is what keeps
        // `test/setup.ts`'s pin from being defeated by a checkout's own `.pi/decision-model-config.json`.
        expect(findDecisionConfigLocations(workspace).project).toBeUndefined();
        expect(loadDecisionConfig(workspace).model).toBeUndefined();
    });

    it("treats a blank global path as no global file, even when the default file exists", () => {
        const home = path.join(root, "home");
        const homeConfig = path.join(home, ".pi", "decision-model-config.json");
        fs.mkdirSync(path.dirname(homeConfig), { recursive: true });
        fs.writeFileSync(
            homeConfig,
            JSON.stringify({ decisionModel: { enabled: true, model: "home" } }),
        );
        vi.stubEnv("HOME", home);
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH_GLOBAL", "");

        // The default path names that file; the blank variable is what suppresses reading it.
        expect(defaultGlobalConfigPath()).toBe(homeConfig);
        expect(fs.existsSync(defaultGlobalConfigPath())).toBe(true);
        expect(findDecisionConfigLocations(workspace).global).toBeUndefined();
        expectUnconfigured(loadDecisionConfig(workspace));
    });

    it("uses the default global path when the variable is unset", () => {
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH_GLOBAL", undefined);

        expect(findDecisionConfigLocations(workspace).global).toBe(defaultGlobalConfigPath());
    });

    it("ignores a missing decisionModel section and invalid JSON", () => {
        writeProjectConfig({ sandbox: {} });
        expectUnconfigured(loadDecisionConfig(workspace));

        fs.writeFileSync(projectConfigPath(), "{ not json");
        expectUnconfigured(loadDecisionConfig(workspace));
    });
});

describe("decision config field validation", () => {
    it.each([
        ["enabled", "yes"],
        ["apply", 1],
        ["baseUrl", "   "],
        ["apiKey", 7],
        ["provider", ""],
        ["model", false],
        ["strategy", "nope"],
        ["timeoutMs", -5],
        ["cooldownMs", 0],
        ["contextWindow", "big"],
        ["minConfidence", 2],
        ["reminderMinProbability", 2],
        ["surfaces", "parent"],
        ["reminders", "yes"],
    ] as Array<[keyof DecisionModelConfig, unknown]>)("drops a wrong-typed %s", (field, value) => {
        writeProjectConfig({ decisionModel: { [field]: value } });

        expect(loadDecisionConfig(workspace)[field]).toBeUndefined();
    });

    it("filters surfaces to the two known ids instead of rejecting the field", () => {
        writeProjectConfig({ decisionModel: { surfaces: ["parent", 7, "child", "nope"] } });

        expect(loadDecisionConfig(workspace).surfaces).toEqual(["parent", "child"]);
    });

    it("keeps the file list separate from the Bash list", () => {
        // One shared list would make `["parent", "child"]` mean "resolve file prompts too", which is a wider
        // claim than the config was written to make: a command verdict can be contained by the sandbox and a
        // path verdict cannot.
        writeProjectConfig({ decisionModel: { surfaces: ["parent", "child"] } });

        expect(loadDecisionConfig(workspace).fileSurfaces).toBeUndefined();

        writeProjectConfig({ decisionModel: { fileSurfaces: ["child", "elsewhere"] } });
        expect(loadDecisionConfig(workspace).fileSurfaces).toEqual(["child"]);
    });

    it("reads reminders as its own opt-in", () => {
        // Reminders are hidden context, not a permission verdict, so the switch is separate from `surfaces`
        // and the subject stays off until the file names it.
        writeProjectConfig({
            decisionModel: { enabled: true, reminders: true, reminderMinProbability: 0.5 },
        });

        expect(loadDecisionConfig(workspace).reminders).toBe(true);
        expect(loadDecisionConfig(workspace).reminderMinProbability).toBe(0.5);
        expect(loadDecisionConfig(workspace).surfaces).toBeUndefined();
    });

    it("ignores removed fields instead of reviving them", () => {
        writeProjectConfig({
            decisionModel: {
                enabled: true,
                autoHost: true,
                autoRefuse: true,
                applySurfaces: ["child"],
            },
        });

        const config = loadDecisionConfig(workspace);

        // A file that still sets the old keys is not an error, and `apply` is the only switch left.
        expect(config.enabled).toBe(true);
        expect(config).not.toHaveProperty("autoHost");
        expect(config).not.toHaveProperty("autoRefuse");
        expect(config).not.toHaveProperty("applySurfaces");
    });

    it("drops a strategy name that is not a strategy id", () => {
        writeProjectConfig({ decisionModel: { strategy: "toString" } });

        // `Object.hasOwn`, not `in`: the prototype chain would accept this and hand `resolveStrategy` a
        // function with no `buildRequest`.
        expect(loadDecisionConfig(workspace).strategy).toBeUndefined();

        writeProjectConfig({ decisionModel: { strategy: "veto" } });
        expect(loadDecisionConfig(workspace).strategy).toBe("veto");
    });

    it("keeps valid fields beside invalid ones", () => {
        writeProjectConfig({
            decisionModel: {
                enabled: true,
                model: "  spaced-model  ",
                timeoutMs: -1,
                minConfidence: 0.8,
                surfaces: ["child"],
            },
        });

        const config = loadDecisionConfig(workspace);

        expect(config).toMatchObject({
            enabled: true,
            model: "spaced-model",
            minConfidence: 0.8,
            surfaces: ["child"],
        });
        expect(config.timeoutMs).toBeUndefined();
    });
});

describe("decision config environment overrides", () => {
    it("lets SYSTEMONE_* override the file, with the timeout in seconds", () => {
        writeProjectConfig({
            decisionModel: {
                enabled: true,
                baseUrl: "https://file.example",
                apiKey: "file-token",
                model: "file-model",
                timeoutMs: 5000,
            },
        });
        vi.stubEnv("SYSTEMONE_API_URL", "https://env.example");
        vi.stubEnv("SYSTEMONE_API_TOKEN", "env-token");
        vi.stubEnv("SYSTEMONE_MODEL", "env-model");
        vi.stubEnv("SYSTEMONE_TIMEOUT", "2");

        expect(loadDecisionConfig(workspace)).toMatchObject({
            enabled: true,
            baseUrl: "https://env.example",
            apiKey: "env-token",
            model: "env-model",
            timeoutMs: 2000,
        });
    });

    it("keeps the file value when an overridden variable is blank", () => {
        writeProjectConfig({
            decisionModel: {
                baseUrl: "https://file.example",
                model: "file-model",
                timeoutMs: 5000,
            },
        });
        vi.stubEnv("SYSTEMONE_API_URL", "");
        vi.stubEnv("SYSTEMONE_MODEL", "   ");
        vi.stubEnv("SYSTEMONE_TIMEOUT", "");

        expect(loadDecisionConfig(workspace)).toMatchObject({
            baseUrl: "https://file.example",
            model: "file-model",
            timeoutMs: 5000,
        });
    });
});

describe("decision config singleton", () => {
    it("load caches the working directory's config and re-reads on demand", () => {
        writeProjectConfig({ decisionModel: { model: "first" } });
        expect(decisionConfig.load(workspace).model).toBe("first");
        expect(decisionConfig.current.model).toBe("first");

        writeProjectConfig({ decisionModel: { model: "second" } });
        expect(decisionConfig.current.model).toBe("first");
        expect(decisionConfig.load(workspace).model).toBe("second");
    });

    it("current reads process.cwd() once, and reset makes it re-read", () => {
        const originalCwd = process.cwd();
        process.chdir(workspace);
        try {
            writeProjectConfig({ decisionModel: { model: "first" } });
            expect(decisionConfig.current.model).toBe("first");

            writeProjectConfig({ decisionModel: { model: "second" } });
            expect(decisionConfig.current.model).toBe("first");

            decisionConfig.reset();
            expect(decisionConfig.current.model).toBe("second");
        } finally {
            process.chdir(originalCwd);
        }
    });
});

describe("decision config saving", () => {
    beforeEach(() => {
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH_GLOBAL", globalPath);
        decisionConfig.reset();
    });

    it("writes the patch into the global file and keeps the rest of the document", () => {
        writeGlobalConfig({
            decisionModel: { strategy: "veto", minConfidence: 0.7 },
            other: { keep: true },
        });

        saveDecisionConfig({ enabled: true, provider: "systemone", model: "qwen" });

        const document = JSON.parse(fs.readFileSync(globalPath, "utf-8"));
        expect(document.decisionModel).toEqual({
            strategy: "veto",
            minConfidence: 0.7,
            enabled: true,
            provider: "systemone",
            model: "qwen",
        });
        expect(document.other).toEqual({ keep: true });
        expect(loadDecisionConfig(workspace)).toMatchObject({
            enabled: true,
            provider: "systemone",
            model: "qwen",
            strategy: "veto",
            minConfidence: 0.7,
        });
    });

    it("writes the file private and creates a missing parent directory", () => {
        const nested = path.join(root, "nested", "decision-model.json");
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH_GLOBAL", nested);

        saveDecisionConfig({ apply: true });

        expect(fs.statSync(nested).mode & 0o777).toBe(0o600);
        expect(JSON.parse(fs.readFileSync(nested, "utf-8"))).toEqual({
            decisionModel: { apply: true },
        });
    });

    it("keeps a project file untouched when the dialog saves", () => {
        writeProjectConfig({ decisionModel: { model: "project-model" } });
        writeGlobalConfig({ decisionModel: { model: "global-model" } });

        saveDecisionConfig({ enabled: true });

        expect(JSON.parse(fs.readFileSync(projectConfigPath(), "utf-8"))).toEqual({
            decisionModel: { model: "project-model" },
        });
        // The project overlay still wins for the keys it sets, which is why the dialog stays global-only.
        const effective = loadDecisionConfig(workspace);
        expect(effective.model).toBe("project-model");
        expect(effective.enabled).toBe(true);
    });

    it("throws when the global path is disabled rather than guessing at a file", () => {
        vi.stubEnv("DECISION_MODEL_CONFIG_PATH_GLOBAL", "");
        expect(() => saveDecisionConfig({ enabled: true })).toThrow(/disabled/);
    });
});
