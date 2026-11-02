import type { ReadConfinement } from "./heuristics";

/**
 * Read confinement for one runtime.
 *
 * A runtime whose own filesystem view is the boundary — a container session — does not need reads re-checked
 * against the working directory: the mount set already decided what a path can be. Everything else (the host,
 * or a bubblewrap child of a containerized parent) keeps the host rule.
 *
 * This is deliberately a function of a per-runtime predicate rather than of `process.env`, and it says nothing
 * about the backend's *name*: a rule keyed on "container" would grant under bubblewrap the same read it grants
 * here, where that path is the host's.
 */
export function readConfinementFor(containerBash?: () => boolean): ReadConfinement {
    if (containerBash?.() === true) {
        return "runtime";
    }

    return "cwd";
}
