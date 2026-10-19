import { getPiPackageDirectory } from "../../common/constants";
import type { SandboxConfig } from "../../common/config";

/**
 * The roots the direct file tools may use beyond the working directory.
 *
 * `src/tools/file-permissions.ts` gates `read`/`grep`/`find`/`ls` and `write`/`edit` on confinement, and for a
 * long time the only roots it knew were the cwd, the session scratchpad, the user memory directory (reads), and
 * whatever a human approved during the session. That left a gap against the rest of the extension: the
 * installed pi package this harness tells every agent to read still prompted for each file, and a user's
 * declared roots were honoured by bubblewrap but not by the tools. This module turns those declarations into
 * file-access roots, so the two ways the agent reaches the host agree instead of disagreeing by accident.
 *
 * Three rules decide the whole module, and each is here because a measured consequence backs it:
 *
 * - **A root is not a sensitive-name exemption.** Callers pass these as `additionalRoots` and keep
 *   `sensitiveAdditionalRoots` for the runtime-owned roots they already trust, so a `.env`, `.git`, key, or
 *   credential path under a declared root still reaches the human.
 * - **Reads and writes are separate lists, and mounts only ever widen reads.** A `readwrite` mount says what a
 *   *sandboxed command* may write, and the containment plus the approval of that command is what makes it
 *   safe; a direct tool write has neither. `~/.pi: readwrite` is the case that settles it — honouring it for
 *   writes would silently allow edits to the user's own memory and settings files, which the gates have always
 *   prompted for.
 * - **`honorMounts` is opt-in, not the default.** A mount list is a bubblewrap view, not a statement about
 *   what may be read into a model's context: `~/.config/gh: readonly` exists so `gh` works in a sandbox, and it
 *   holds a token in a file no name filter catches. The pi-package root is the one derivation that is on by
 *   default, because those are the files the agent's own instructions tell it to read.
 *
 * `~` is left unexpanded on purpose: the confinement checks in `heuristics/path-policy.ts` expand it through
 * `resolveHomeDirectory()`, and a second expansion here would be a second owner of the same rule.
 */
export interface FileAccessRoots {
    /** Roots a read may resolve inside. */
    read: readonly string[];
    /** Roots a write or edit may resolve inside. */
    write: readonly string[];
}

/** A mount list is a sandbox view, not a read grant: widening every host path the user mounted is opt-in. */
const DEFAULT_HONOR_MOUNTS = false;

function dedupe(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const roots: string[] = [];

    for (const value of values) {
        const trimmed = value.trim();
        if (trimmed === "" || seen.has(trimmed)) {
            continue;
        }

        seen.add(trimmed);
        roots.push(trimmed);
    }

    return roots;
}

/**
 * The declared roots, in a stable order: explicit lists first, then the mounts, then the running pi package.
 *
 * When mounts are honoured, a `readwrite` entry widens writes too: at that point the user has read this
 * module's warning and opted into the mount list *as* a file-access declaration, so honouring the mode the
 * entry already states is the faithful reading. Without the flag, the write list has exactly one source.
 */
export function getFileAccessRoots(config: SandboxConfig | null | undefined): FileAccessRoots {
    const files = config?.files;
    const read: string[] = [...(files?.readRoots ?? [])];
    const write: string[] = [...(files?.writeRoots ?? [])];

    if (files?.honorMounts ?? DEFAULT_HONOR_MOUNTS) {
        for (const [source, mode] of Object.entries(config?.sandbox?.mounts ?? {})) {
            read.push(source);
            if (mode === "readwrite") {
                write.push(source);
            }
        }
    }

    if (files?.honorPiPackage !== false) {
        const piPackage = getPiPackageDirectory();
        if (piPackage !== undefined) {
            read.push(piPackage);
        }
    }

    return { read: dedupe(read), write: dedupe(write) };
}

/** The roots one operation may use, so a caller never has to remember that writes read a different list. */
export function fileRootsForOperation(
    config: SandboxConfig | null | undefined,
    operation: "read" | "write",
): readonly string[] {
    const roots = getFileAccessRoots(config);

    return operation === "read" ? roots.read : roots.write;
}
