#!/usr/bin/env node
/**
 * Scratch runner: bundle and run one throwaway TypeScript script.
 *
 * Usage: `npm run scratch -- <script> [args...]`
 *
 * Import contract for the script, all resolved by this runner:
 *   ./x                  a sibling file next to the script (bundled)
 *   @pi-coder/...        pi-coder source, e.g. `@pi-coder/src/...` (bundled)
 *   @earendil-works/...  the pi package (left external, resolved at runtime)
 *   <any-installed>      any other package in this repo's node_modules
 *   node:*               builtins
 *
 * The pi package stays external because it ships compiled JS that does not
 * survive bundling (dynamic `require` in cross-spawn, `import.meta` in its ESM
 * dist); pi-coder is a TS working tree, so its code is inlined by the bundle.
 *
 * The bundle is a temporary file under the OS temp dir (created with
 * `mkdtemp`), removed when the script exits. Two knobs make /tmp work:
 * esbuild's `nodePaths` lets the build find this repo's packages, and a
 * `node_modules` symlink lets the *runtime* resolve the external
 * `@earendil-works/*` imports, which node walks up to find from the bundle's
 * location. The child runs with `cwd` set to the script's own directory, so
 * relative file paths (`fs.readFileSync("./data.json")`) resolve next to the
 * script, the same way relative imports do. Crashed runs can leave a
 * `pi-coder-scratch-*` directory behind; stale ones are swept on the next
 * start.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRATCH_PREFIX = "pi-coder-scratch-";
const STALE_MS = 60 * 60 * 1000;

const [, , scriptPath, ...scriptArgs] = process.argv;

const usage = [
    "usage: npm run scratch -- <script> [args...]",
    "       npm run scratch -- -h | --help",
    "",
    "Bundles and runs one throwaway TypeScript script. Imports:",
    "  ./x                    sibling file next to the script (bundled)",
    "  @pi-coder/...          pi-coder source: src/, test/, ... (bundled)",
    "  @earendil-works/...    the pi package (external, runtime)",
    "  <any-installed>        any repo node_modules package (bundled)",
    "  node:*                 builtins",
    "",
    "Relative file paths in the script resolve against the script's own",
    "directory (the child runs with cwd set there). The bundle is a",
    "temporary file in the OS temp dir, removed when the script exits.",
].join("\n");

if (scriptPath === "-h" || scriptPath === "--help") {
    console.log(usage);
    process.exit(0);
}
if (scriptPath === undefined) {
    console.error(usage);
    process.exit(1);
}

const script = path.resolve(scriptPath);
if (!existsSync(script)) {
    console.error(`scratch: no such script: ${script}`);
    process.exit(1);
}

(function sweepStaleScratchDirs(): void {
    const pattern = new RegExp(`^${SCRATCH_PREFIX}`);
    const tempDir = tmpdir();
    for (const entry of readdirSync(tempDir)) {
        if (!pattern.test(entry)) {
            continue;
        }
        const full = path.join(tempDir, entry);
        try {
            if (Date.now() - statSync(full).mtimeMs > STALE_MS) {
                rmSync(full, { recursive: true, force: true });
            }
        } catch {
            // Raced with a concurrent scratch run; the next sweep gets it.
        }
    }
})();

const dir = mkdtempSync(path.join(tmpdir(), SCRATCH_PREFIX));
const bundle = path.join(dir, `${path.basename(script, path.extname(script))}.mjs`);
const cleanUp = (): void => rmSync(dir, { recursive: true, force: true });

try {
    // Runtime half of the /tmp story: the external `@earendil-works/*` imports are
    // resolved by node walking up from the bundle's location, so the temp dir must
    // reach this repo's node_modules. The symlink hands every other lookup to
    // node's own resolver — exports map, subpaths, nested deps included.
    symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");

    buildSync({
        entryPoints: [script],
        bundle: true,
        platform: "node",
        format: "esm",
        target: [`node${process.versions.node.split(".")[0]}`],
        sourcemap: "inline",
        alias: { "@pi-coder": REPO_ROOT },
        // Build-time half of the /tmp story: esbuild finds packages in the
        // repo's node_modules, wherever the script itself lives.
        nodePaths: [path.join(REPO_ROOT, "node_modules")],
        external: ["@earendil-works/*"],
        outfile: bundle,
        logLevel: "warning",
    });
} catch (error) {
    cleanUp();
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}

try {
    // While the child runs, swallow SIGINT/SIGTERM and forward them: the child
    // shares our process group, so it already receives a terminal Ctrl+C directly,
    // and intercepting in the parent keeps us alive long enough to clean up and
    // exit with the conventional 130.
    const child = spawn(process.execPath, ["--enable-source-maps", bundle, ...scriptArgs], {
        stdio: "inherit",
        // Runtime relative paths follow the script, not the repo: fs calls like
        // `readFileSync("./data.json")` resolve next to the script, matching how
        // relative imports resolve at build time. External resolution is
        // location-based and unaffected by cwd.
        cwd: path.dirname(script),
    });
    const forwardSignal = (signal: NodeJS.Signals): void => {
        child.kill(signal);
    };
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);
    child.on("exit", (code, signal) => {
        cleanUp();
        process.off("SIGINT", forwardSignal);
        process.off("SIGTERM", forwardSignal);
        process.exit(code ?? (signal === "SIGINT" ? 130 : 1));
    });
} catch (error) {
    cleanUp();
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
