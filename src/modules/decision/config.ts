import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DECISION_STRATEGIES, type DecisionStrategyId } from "./strategies";
import type { DecisionModelConfig, DecisionSurface } from "./types";

/**
 * The decision model's configuration, in a file of its own.
 *
 * Deliberately not `bash-sandbox-config.json`: the model is a separate concern with a separate credential, and
 * keeping the files apart made the endpoint easy to point at a test server. The layering is the sandbox
 * config's, so folding this into `src/common/config.ts` later is a copy: the global file
 * (`~/.pi/decision-model-config.json`, where the endpoint credential lives) is overridden by the nearest
 * project file (`.pi/decision-model-config.json`, safe to commit because it holds no secret), and the
 * `SYSTEMONE_*` environment variables win over both. Those are the variables the probe scripts already read,
 * so a measured run and a live session can be aimed at the same endpoint.
 */

const PROJECT_DIR = ".pi";
const PROJECT_CONFIG_NAME = "decision-model-config.json";
/** Point the global file anywhere; set but blank means "no global file at all". */
const GLOBAL_CONFIG_ENV = "DECISION_MODEL_CONFIG_PATH_GLOBAL";
/** Fallback when no project file sits above the working directory; blank means "none". */
const PROJECT_CONFIG_ENV = "DECISION_MODEL_CONFIG_PATH";
/** How far up from the working directory a project file is looked for. */
const SEARCH_DEPTH = 20;

const API_URL_ENV = "SYSTEMONE_API_URL";
const API_TOKEN_ENV = "SYSTEMONE_API_TOKEN";
const MODEL_ENV = "SYSTEMONE_MODEL";
/** Seconds, matching the probe scripts. */
const TIMEOUT_ENV = "SYSTEMONE_TIMEOUT";

export interface DecisionConfigLocations {
    global: string | undefined;
    project: string | undefined;
}

/** The decision-model fields the settings dialog owns; every other key in a config file is preserved. */
export interface DecisionModelPatch {
    enabled?: boolean;
    apply?: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
}

export function defaultGlobalConfigPath(): string {
    return path.join(os.homedir(), PROJECT_DIR, PROJECT_CONFIG_NAME);
}

/**
 * An unset variable selects the default; a set-but-blank one means "no file".
 *
 * The blank case is what lets the test suite pin both locations to nothing, so a suite can never read the
 * developer's real endpoint credential or this checkout's project file.
 */
function resolvePath(value: string | undefined, fallback: string | undefined): string | undefined {
    if (value === undefined) {
        return fallback;
    }

    return value.trim() === "" ? undefined : value;
}

function findProjectConfigPath(cwd: string): string | undefined {
    const override = process.env[PROJECT_CONFIG_ENV];

    // A set-but-blank variable suppresses the walk as well, not just the fallback: a suite that wants no
    // project overlay must not depend on knowing which directory above it happens to hold one.
    if (override !== undefined && override.trim() === "") {
        return undefined;
    }

    let folder = cwd;

    for (let depth = 0; depth < SEARCH_DEPTH; depth += 1) {
        if (folder === "") {
            break;
        }

        const candidate = path.join(folder, PROJECT_DIR, PROJECT_CONFIG_NAME);
        if (fs.existsSync(candidate)) {
            return candidate;
        }

        const parent = path.dirname(folder);
        if (parent === folder) {
            break;
        }

        folder = parent;
    }

    return resolvePath(override, undefined);
}

export function findDecisionConfigLocations(cwd: string): DecisionConfigLocations {
    return {
        global: resolvePath(process.env[GLOBAL_CONFIG_ENV], defaultGlobalConfigPath()),
        project: findProjectConfigPath(cwd),
    };
}

function textField(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function booleanField(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function ratioField(value: unknown): number | undefined {
    const ratio = positiveNumber(value);
    return ratio !== undefined && ratio <= 1 ? ratio : undefined;
}

function strategyField(value: unknown): DecisionStrategyId | undefined {
    // `Object.hasOwn`, not `in`: the prototype chain would accept `toString` and hand `resolveStrategy` a
    // function that has no `buildRequest`.
    if (typeof value !== "string" || !Object.hasOwn(DECISION_STRATEGIES, value)) {
        return undefined;
    }

    return value as DecisionStrategyId;
}

const VALID_SURFACES: readonly DecisionSurface[] = ["parent", "child"];

function surfacesField(value: unknown): readonly DecisionSurface[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    return value.filter((surface): surface is DecisionSurface =>
        VALID_SURFACES.includes(surface as DecisionSurface),
    );
}

/**
 * Read the `decisionModel` section of a config file.
 *
 * Every field is optional and a wrong type is dropped rather than thrown: a typo in a config file must not
 * take down the permission gate, and an absent field means "inherit", which is also what an unreadable one
 * has to mean.
 */
function readDecisionModelConfig(data: unknown): DecisionModelConfig | undefined {
    if (typeof data !== "object" || data === null) {
        return undefined;
    }

    const section = (data as Record<string, unknown>).decisionModel;
    if (typeof section !== "object" || section === null) {
        return undefined;
    }

    const raw = section as Record<string, unknown>;

    return {
        enabled: booleanField(raw.enabled),
        suggestions: booleanField(raw.suggestions),
        reminders: booleanField(raw.reminders),
        apply: booleanField(raw.apply),
        baseUrl: textField(raw.baseUrl),
        apiKey: textField(raw.apiKey),
        provider: textField(raw.provider),
        model: textField(raw.model),
        strategy: strategyField(raw.strategy),
        timeoutMs: positiveNumber(raw.timeoutMs),
        cooldownMs: positiveNumber(raw.cooldownMs),
        contextWindow: positiveNumber(raw.contextWindow),
        minConfidence: ratioField(raw.minConfidence),
        surfaces: surfacesField(raw.surfaces),
        fileSurfaces: surfacesField(raw.fileSurfaces),
    };
}

function tryLoad(filePath: string): DecisionModelConfig | undefined {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }

    try {
        return readDecisionModelConfig(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    } catch {
        return undefined;
    }
}

/** Later fields win; an absent field inherits, which is what lets a project file set one key. */
function mergeDecisionConfigs(
    base: DecisionModelConfig,
    override: DecisionModelConfig,
): DecisionModelConfig {
    return {
        enabled: override.enabled ?? base.enabled,
        suggestions: override.suggestions ?? base.suggestions,
        reminders: override.reminders ?? base.reminders,
        apply: override.apply ?? base.apply,
        baseUrl: override.baseUrl ?? base.baseUrl,
        apiKey: override.apiKey ?? base.apiKey,
        provider: override.provider ?? base.provider,
        model: override.model ?? base.model,
        strategy: override.strategy ?? base.strategy,
        timeoutMs: override.timeoutMs ?? base.timeoutMs,
        cooldownMs: override.cooldownMs ?? base.cooldownMs,
        contextWindow: override.contextWindow ?? base.contextWindow,
        minConfidence: override.minConfidence ?? base.minConfidence,
        surfaces: override.surfaces ?? base.surfaces,
        fileSurfaces: override.fileSurfaces ?? base.fileSurfaces,
    };
}

/**
 * The environment's last word, so a session can be pointed at another endpoint without editing a file.
 *
 * A blank value falls through to the config rather than clearing it: an empty `SYSTEMONE_MODEL` in a shell
 * profile must not silently move the model.
 */
function withEnvironment(config: DecisionModelConfig): DecisionModelConfig {
    const timeoutSeconds = Number(process.env[TIMEOUT_ENV]);
    const timeoutMs = positiveNumber(timeoutSeconds);

    return {
        ...config,
        baseUrl: textField(process.env[API_URL_ENV]) ?? config.baseUrl,
        apiKey: textField(process.env[API_TOKEN_ENV]) ?? config.apiKey,
        model: textField(process.env[MODEL_ENV]) ?? config.model,
        timeoutMs: timeoutMs === undefined ? config.timeoutMs : timeoutMs * 1000,
    };
}

/** The merged configuration for a working directory. No file anywhere means "not configured". */
export function loadDecisionConfig(cwd: string): DecisionModelConfig {
    const locations = findDecisionConfigLocations(cwd);
    const global = locations.global === undefined ? undefined : tryLoad(locations.global);
    const project = locations.project === undefined ? undefined : tryLoad(locations.project);

    if (global === undefined && project === undefined) {
        return withEnvironment({});
    }

    return withEnvironment(mergeDecisionConfigs(global ?? {}, project ?? {}));
}

function readRawDocument(filePath: string): Record<string, unknown> {
    try {
        const data: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
            return {};
        }
        return { ...(data as Record<string, unknown>) };
    } catch {
        // A missing, unreadable, or malformed file starts a new document.
        return {};
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge a patch into the global config file, the only file the settings dialog writes.
 *
 * Global unconditionally, because that is where the endpoint credential lives and a project file would put
 * the token in a repository. Everything else in the document — the other `decisionModel` keys and any other
 * top-level key — is preserved rather than rejected, so a hand-edited file survives a dialog change. The
 * file is written `0600` and the process cache is dropped, so the next gate consult reads the new values.
 */
export function saveDecisionConfig(patch: DecisionModelPatch): void {
    const filePath = resolvePath(process.env[GLOBAL_CONFIG_ENV], defaultGlobalConfigPath());
    if (filePath === undefined) {
        throw new Error("The global decision-model config path is disabled.");
    }

    const document = readRawDocument(filePath);
    const section = isPlainObject(document.decisionModel) ? document.decisionModel : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) {
            section[key] = value;
        }
    }
    document.decisionModel = section;

    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
    fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    cached = undefined;
}

let cached: DecisionModelConfig | undefined;

export default {
    /** The configuration for this process, read once. */
    get current(): DecisionModelConfig {
        cached ??= loadDecisionConfig(process.cwd());
        return cached;
    },

    load(cwd: string): DecisionModelConfig {
        cached = loadDecisionConfig(cwd);
        return cached;
    },

    /** Drop the cache so an edited file is picked up without a reload. */
    reset(): void {
        cached = undefined;
    },
};
