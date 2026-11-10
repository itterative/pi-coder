import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root of this installed pi-coder extension, for both source and compiled layouts.
 *
 * A bundled runner can rewrite `import.meta.url`, which changes what the URL resolves to. `PI_CODER_EXTENSION_DIR`
 * lets that runner name the checkout explicitly; the manifest check keeps a stale or unrelated value from winning.
 * An installed extension never sets it and keeps the URL-derived root.
 */
export const PI_CODER_EXTENSION_DIR = resolveExtensionDirectory(
    path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
);

/** Resolve the root a bundled run should use, preferring the computed root when it is a real package. */
export function resolveExtensionDirectory(
    computed: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    if (isPackageRoot(computed)) {
        return computed;
    }

    const configured = env.PI_CODER_EXTENSION_DIR;

    if (configured !== undefined) {
        const candidate = path.resolve(configured);

        if (isPackageRoot(candidate)) {
            return candidate;
        }
    }

    return computed;
}

function isPackageRoot(candidate: string): boolean {
    return fs.existsSync(path.join(candidate, "package.json"));
}
