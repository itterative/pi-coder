import { spawnSync } from "node:child_process";

/**
 * Which external binaries this machine actually has.
 *
 * Some suites exercise the real sandbox path, which shells out to `bwrap`. On a machine without it — a CI
 * container, a slim image, or the pi-coder sandbox itself — those tests fail while saying nothing about the
 * code under test. `describe.skipIf`/`it.skipIf` against these helpers keeps the suite honest instead:
 * a skipped test is visible, a red one is misleading.
 *
 * Results are cached per process: `spawnSync` per test would add a fork to every case.
 */

const availability = new Map<string, boolean>();

function hasBinary(name: string): boolean {
    const cached = availability.get(name);

    if (cached !== undefined) {
        return cached;
    }

    const result = spawnSync(name, ["--version"], { stdio: "ignore" });
    const available = result.error === undefined && result.status !== null;

    availability.set(name, available);

    return available;
}

/** The sandbox wrapper binary the bash sandbox shells out to when it is active. */
export function hasBwrap(): boolean {
    return hasBinary("bwrap");
}
