import fs from "node:fs";
import path from "node:path";

import type { ContainerMount } from "./args";

/**
 * The sandbox home's mountpoints, created before podman sees them.
 *
 * A session mounts its home at the real home path and then mounts the checkout, the scratchpad, the memory
 * directory, and every configured or discovered resource root inside it. Podman creates a missing mountpoint
 * itself, and it creates it *as container-root*: on the host that is a subuid (`589824` on the reference
 * machine), with the sticky-bit mode `1755` podman uses for its own shared parents.
 *
 * That is not cosmetic. Inside the session the directory belongs to someone else, so everything below it is
 * read-only — `~/.config/<new app>`, `~/.pi/<anything>` and `~/Repos/<new repo>` fail with `EACCES` even though
 * the container runs as the host user — and on the host the state root cannot be emptied without `sudo`.
 *
 * Creating the mountpoints first removes the cause: podman creates only what is missing. A home that an earlier
 * version left with the root-owned scaffold is not repaired here; `sudo rm -rf <state>/container/home` removes
 * it in one step (it holds only the scaffold, the npm cache, and the seeded `.gitconfig`).
 */
export interface HomeMountPointOptions {
    /** Host directory mounted as the sandbox's `$HOME`. */
    home: string;
    /** The path the home is mounted at, i.e. the host's real home path. */
    homeTarget: string;
    /** Every mount of the session, in the order podman applies them. */
    mounts: readonly ContainerMount[];
}

/** Create every mountpoint that podman would otherwise create under the home. */
export async function ensureHomeMountPoints(options: HomeMountPointOptions): Promise<void> {
    for (const target of await homeMountTargets(options)) {
        // A file mount needs its parents; creating the final component as a directory would block the mount.
        const relative = target.isFile ? path.dirname(target.relative) : target.relative;

        await fs.promises.mkdir(path.join(options.home, relative), {
            recursive: true,
            mode: 0o755,
        });
    }
}

interface HomeMountTarget {
    relative: string;
    /** A file source means the final component is the file, so only its parents are directories. */
    isFile: boolean;
}

async function homeMountTargets(options: HomeMountPointOptions): Promise<HomeMountTarget[]> {
    const targets: HomeMountTarget[] = [];

    for (const mount of options.mounts) {
        const target = mount.target ?? mount.source;
        const relative = path.relative(options.homeTarget, target);

        if (!isInsideHome(relative)) {
            continue;
        }

        targets.push({ relative, isFile: await isFile(mount.source) });
    }

    // A mount nested inside another mount's target is unreachable: the outer mount covers it, so podman never
    // needs a scaffold for it, and creating one would only leave an empty tree inside the sandbox home.
    return targets.filter(
        (candidate) =>
            !targets.some(
                (other) =>
                    other !== candidate &&
                    candidate.relative.startsWith(`${other.relative}${path.sep}`),
            ),
    );
}

function isInsideHome(relative: string): boolean {
    return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

async function isFile(source: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(source)).isFile();
    } catch {
        // A source the posture could not resolve is not a directory as far as the scaffold is concerned; podman
        // will report the missing source itself.
        return false;
    }
}
