import fs from "node:fs";
import path from "node:path";

import { discoverFiles } from "../discovery";
import { loadParsedFiles } from "../load";
import type { CodeSource } from "../source";
import type { ParsedFile } from "../types";
import { MODEL_ID } from "./config";
import { liveEntryKeys } from "./index";
import { indexDir, namespaceFor, readManifest, readManifestHeader } from "./store";
import { EMBED_TEXT_VERSION } from "../text";

/**
 * How many declarations one idle refresh may embed on its own.
 *
 * Larger than `AUTO_REFRESH_LIMIT` because this runs while nothing else is happening: no turn waits for it, and the
 * build is capped at four threads. Past it, drift is a job for `/outline build`, with its estimate and progress.
 */
export const IDLE_REFRESH_LIMIT = 2_000;

/** A namespace of this project, as recorded by its manifest header. */
export interface IndexedRoot {
    dir: string;
    root: string;
}

/** What one root's scan found. */
export interface ScanFinding {
    root: string;
    /** Files modified since the build recorded in the manifest. */
    changed: number;
    /** Those files, parsed: the only input the refresh needs. */
    files: ParsedFile[];
    /** Declarations among them whose content key has no vector yet. */
    missing: number;
}

/**
 * Roots an idle refresh should look at: every current index of this project, in this session's source kind.
 *
 * A namespace is keyed by root *and* source kind, and one built by a container session is invisible to a host one, so
 * a scan has to match the kind it will read through. A namespace of another embed-text version is a stale index
 * waiting for a rebuild, not drift, and one rooted outside the project is not this session's business.
 */
export function projectRoots(options: {
    modelDir: string;
    cwd: string;
    sourceKind: string;
}): IndexedRoot[] {
    const indexRoot = path.join(options.modelDir, "index");
    const names = fs.existsSync(indexRoot) ? fs.readdirSync(indexRoot) : [];
    const project = path.resolve(options.cwd);
    const roots: IndexedRoot[] = [];

    for (const name of names) {
        const dir = path.join(indexRoot, name);
        const header = readManifestHeader(dir);

        if (
            header === undefined ||
            header.modelId !== MODEL_ID ||
            header.textVersion !== EMBED_TEXT_VERSION ||
            header.sourceKind !== options.sourceKind ||
            header.root === undefined
        ) {
            continue;
        }

        const root = path.resolve(header.root);
        const inside = root === project || root.startsWith(`${project}${path.sep}`);

        if (inside) {
            roots.push({ dir, root });
        }
    }

    return roots;
}

/** What one idle pass did, which is also what the caller reports. */
export interface RefreshOutcome {
    /** Declarations that had no vector when the pass started. */
    missing: number;
    /** Roots that were rebuilt, and declarations actually embedded. */
    rebuilt: number;
    embedded: number;
    /** True when the drift was too large to fix unattended, so the caller should name `/outline build`. */
    overBudget: boolean;
}

/**
 * Decide what one idle pass does, given how much each root is missing.
 *
 * Kept apart from the timer and the UI so the policy is testable: a pass under `IDLE_REFRESH_LIMIT` rebuilds each
 * root from the files the scan found changed, and above it the pass reports instead of spending minutes of CPU on a
 * refactor nobody asked it to chase.
 */
export async function refreshOnce(deps: {
    roots: readonly IndexedRoot[];
    scan: (root: IndexedRoot) => Promise<ScanFinding | undefined>;
    build: (root: IndexedRoot, files: ParsedFile[]) => Promise<number>;
    budget?: number;
}): Promise<RefreshOutcome> {
    const findings: Array<{ root: IndexedRoot; finding: ScanFinding }> = [];
    let missing = 0;

    for (const root of deps.roots) {
        const finding = await deps.scan(root);

        if (finding === undefined || finding.missing === 0) {
            continue;
        }

        missing += finding.missing;
        findings.push({ root, finding });
    }

    const budget = deps.budget ?? IDLE_REFRESH_LIMIT;

    if (missing === 0 || missing > budget) {
        return { missing, rebuilt: 0, embedded: 0, overBudget: missing > budget };
    }

    let rebuilt = 0;
    let embedded = 0;

    for (const { root, finding } of findings) {
        if (finding.files.length === 0) {
            continue;
        }

        embedded += await deps.build(root, finding.files);
        rebuilt += 1;
    }

    return { missing, rebuilt, embedded, overBudget: false };
}

/**
 * Find what a root's index is missing, without embedding anything.
 *
 * The cheap pass is a glob plus one `stat` per file: a file whose mtime is newer than the manifest's `builtAt` may
 * have changed, and only those are parsed. That is what makes an idle scan affordable on a large tree — the vibes
 * fixture never has its 1.4 GB read unless something under it moved. A file rewritten with its mtime preserved is
 * invisible to this, which is why `/outline build` remains the authoritative re-parse.
 *
 * Deleted files need no work here: their vectors belong to keys no parsed declaration claims, so they are never
 * candidates to rank, and the next build that covers the root prunes them.
 */
export async function scanRoot(options: {
    source: CodeSource;
    root: string;
    modelDir: string;
    signal?: AbortSignal;
}): Promise<ScanFinding | undefined> {
    const dir = indexDir(
        options.modelDir,
        namespaceFor(options.source.kind, options.root, MODEL_ID, EMBED_TEXT_VERSION),
    );
    const header = readManifestHeader(dir);
    const manifest = header === undefined ? undefined : readManifest(dir);

    if (manifest === undefined) {
        return undefined;
    }

    const discovery = await discoverFiles(options.source, options.root, options.signal);
    const builtAt = Date.parse(header?.builtAt ?? "");
    const changed: string[] = [];

    for (const file of discovery.files) {
        options.signal?.throwIfAborted();

        const stat = await options.source.stat(file);

        // No usable `builtAt` means no evidence either way: treat every file as possibly changed.
        if (Number.isNaN(builtAt) || stat.mtimeMs > builtAt) {
            changed.push(file);
        }
    }

    if (changed.length === 0) {
        return { root: options.root, changed: 0, files: [], missing: 0 };
    }

    const batch = await loadParsedFiles(options.source, changed, options.signal);
    // Heads plus body chunks: a body-only edit changes chunk keys without changing a declaration's head text, so
    // scanning heads alone would report a warm index for a file whose chunks are stale.
    const keys = liveEntryKeys(batch.parsed);
    const missing = Array.from(keys).filter((key) => manifest.entries[key] === undefined).length;

    return { root: options.root, changed: changed.length, files: batch.parsed, missing };
}
