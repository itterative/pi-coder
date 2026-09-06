/**
 * One-time esbuild bundle of a TypeScript script, for suites that drive it as a real CLI.
 *
 * Spawning `node --import tsx <script>` costs ~130ms per call - the node start plus the tsx/esbuild
 * loader - and a suite that spawns the script dozens of times pays it on every call. Bundling once
 * (esbuild resolves the script's imports, inlines them, and strips the types, ~50ms) leaves each
 * spawn at a plain ~30ms node start. The bundle is the same source the tsx launcher would load, so
 * the CLI contract under test - argv, exit codes, stdout, stderr - is unchanged.
 *
 * The bundle lives in a per-run temp dir: nothing in the repo is touched, and a fresh dir per run
 * means there is no stale-cache question. Register `dispose()` with `afterAll`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSync } from "esbuild";

export interface BundledScriptResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

export interface BundledScript {
    /** The bundle file; spawn it with `node`, e.g. through `run`. */
    bundle: string;
    /** Spawn the bundle with the current node and plain argv (no launcher flags). */
    run(args: string[]): BundledScriptResult;
    /** Remove the temp dir holding the bundle. */
    dispose(): void;
}

export function bundleScript(entry: string, tmpPrefix = "pi-script-bundle-"): BundledScript {
    const dir = mkdtempSync(path.join(tmpdir(), tmpPrefix));
    const bundle = path.join(dir, `${path.basename(entry)}.mjs`);

    buildSync({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: bundle,
        logLevel: "silent",
    });

    return {
        bundle,
        run(args) {
            const result = spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8" });

            return {
                status: result.status,
                stdout: result.stdout ?? "",
                stderr: result.stderr ?? "",
            };
        },
        dispose() {
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
