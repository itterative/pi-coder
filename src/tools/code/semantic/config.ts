import fs from "node:fs";
import path from "node:path";

import { PI_CODER_STATE_DIR } from "../../../common/constants";

export type SemanticMode = "off" | "bm25" | "hybrid";

/** Where the mode came from, so `/outline status` can explain a surprising answer instead of just printing one. */
export type SemanticModeSource = "config" | "consent" | "default";

export interface EffectiveSemanticMode {
    mode: SemanticMode;
    source: SemanticModeSource;
}

/**
 * How much of the search tail runs.
 *
 * `bm25` is the default because it needs no download and measured the same composed R@1 as the fused
 * embedding channel. `hybrid` adds the embedding channel once it is consented to and warm; `off` keeps
 * literal-only search.
 */
export function semanticMode(env: NodeJS.ProcessEnv = process.env): SemanticMode {
    const raw = (env.PI_CODER_OUTLINE_SEMANTIC ?? "").trim().toLowerCase();

    if (raw === "off" || raw === "bm25" || raw === "hybrid") {
        return raw;
    }

    return "bm25";
}

/**
 * Root for the downloaded runtime/model and the vector indexes.
 *
 * It lives under pi-coder's runtime state, never inside the extension checkout: pi updates a git-installed
 * package with `git clean -fdx`, which would delete a model cache and force a 200 MB re-download. The
 * `PI_CODER_OUTLINE_MODEL_DIR` override points the tool at an already-prepared bundle (tests, images).
 */
export function semanticRoot(env: NodeJS.ProcessEnv = process.env): string {
    const override = (env.PI_CODER_OUTLINE_MODEL_DIR ?? "").trim();

    if (override.length > 0) {
        return path.resolve(override);
    }

    return path.join(PI_CODER_STATE_DIR, "outline", "semantic");
}

/**
 * The mode a search will actually use, and why.
 *
 * `semanticMode()` reads only the environment, which defaults to `bm25`; a session where the user answered the
 * consent dialog has `consent: enabled` and runs hybrid. Reporting the configured mode to the user was therefore
 * wrong in the one case they asked about: `/outline status` printed `mode=bm25 consent=enabled`, which reads as
 * "embeddings are off" while the search was already fusing them. One function decides, and both the search and the
 * status line call it, so the two cannot disagree again.
 *
 * An explicit `PI_CODER_OUTLINE_SEMANTIC` always wins, including `off` over a stored consent: the environment is how
 * a caller turns the channel off for one run regardless of what an earlier session answered.
 */
export function effectiveSemanticMode(
    env: NodeJS.ProcessEnv = process.env,
    consent: ConsentState = readConsent(),
): EffectiveSemanticMode {
    const configured = (env.PI_CODER_OUTLINE_SEMANTIC ?? "").trim().toLowerCase();

    if (configured === "off" || configured === "hybrid" || configured === "bm25") {
        return { mode: configured, source: "config" };
    }

    if (consent.consent === "enabled") {
        return { mode: "hybrid", source: "consent" };
    }

    return { mode: "bm25", source: "default" };
}

export type Consent = "unset" | "enabled" | "not-now" | "never";

export interface ConsentState {
    consent: Consent;
    modelId?: string;
    updatedAt?: string;
}

const CONSENT_FILE = "state.json";

export function readConsent(root: string = semanticRoot()): ConsentState {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, CONSENT_FILE), "utf8"));

        if (typeof parsed !== "object" || parsed === null) {
            return { consent: "unset" };
        }

        const state = parsed as Partial<ConsentState>;
        const consent = state.consent;

        if (
            consent === "enabled" ||
            consent === "not-now" ||
            consent === "never" ||
            consent === "unset"
        ) {
            return { consent, modelId: state.modelId, updatedAt: state.updatedAt };
        }
    } catch {
        // A missing or unreadable state file means nobody has answered yet.
    }

    return { consent: "unset" };
}

export function writeConsent(state: ConsentState, root: string = semanticRoot()): void {
    const file = path.join(root, CONSENT_FILE);
    const temporary = `${file}.tmp.${process.pid}`;

    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
        temporary,
        `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    fs.renameSync(temporary, file);
}
