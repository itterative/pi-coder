import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import sandboxConfig, { type SandboxConfigCwdConfinement } from "../../../common/config";
import { parseCustomSafeBashCommands } from "./command-access";

export const SPECIAL_ALLOWED_PATHS = new Set([
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/stdin",
    "/dev/stdout",
    "/dev/stderr",
]);

/**
 * Sensitive path segments that always make the heuristic ineligible
 * (glob-matched against every segment of the resolved path).
 */
const DEFAULT_SENSITIVE_PATTERNS = [
    // environment files
    ".env",
    ".env.*",
    // VCS internals (e.g. .git/config may embed tokens in remote URLs)
    ".git",
    // credential directories
    ".ssh",
    ".aws",
    ".azure",
    ".gnupg",
    ".kube",
    ".docker",
    ".gcloud",
    // credential files
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".pgpass",
    ".my.cnf",
    ".htpasswd",
    // private keys
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
    "id_dsa*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.keystore",
    "*.jks",
    // infra secrets
    "*.tfvars",
    "credentials",
];

export function segmentGlobToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".");
    return new RegExp("^" + escaped + "$");
}

const DEFAULT_SENSITIVE_REGEXES = DEFAULT_SENSITIVE_PATTERNS.map(segmentGlobToRegex);

export const REDIRECTION_OPERATORS = new Set([">", ">>", "<", "2>", "2>>"]);

export const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Environment variable names that can alter command behavior — code injection,
 * PATH shadowing, or relocating command state (repo, config, helper) — so any
 * assignment to them makes the heuristic ineligible. This protects against an
 * agent placing an unsafe assignment in its command text.
 *
 * The INHERITED process environment is deliberately out of scope: the
 * cwd-confinement heuristic is an approval-reduction and accidental-mutation
 * control, not a security sandbox. Pi's process environment, installed
 * executables, and local tool configuration are trusted by this policy (the
 * sandbox can instead apply an explicit inheritEnv policy when needed).
 */
const DANGEROUS_ENV_NAMES = new Set([
    "PATH",
    "IFS",
    "CDPATH",
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "BASHOPTS",
    "PROMPT_COMMAND",
    "GCONV_PATH",
    // rg config file can inject flags, including --pre (program execution)
    "RIPGREP_CONFIG_PATH",
    // pagers pipe file contents through a user script
    "LESSOPEN",
    "LESSCLOSE",
    // relocate tool config/state to an attacker-chosen file (git reads the
    // XDG config; a crafted config can select programs via core.fsmonitor)
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
]);

export function isDangerousEnvName(name: string): boolean {
    // GIT_* (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG, GIT_INDEX_FILE,
    // GIT_EXEC_PATH, ...): same risk class as git's -C/--git-dir/--exec-path
    // flags, which are unsafe for this reason
    return name.startsWith("LD_") || name.startsWith("GIT_") || DANGEROUS_ENV_NAMES.has(name);
}

export interface AdditionalRoot {
    /** Absolute lexical root supplied by a runtime such as scratchpad. */
    lexical: string;
    /** Canonical form of this exact lexical root. */
    real: string | null;
    /** Whether sensitive path segments are allowed under this root. */
    sensitiveExempt: boolean;
    /** Whether filesystem writes are forbidden under this root. */
    readOnly: boolean;
}

export interface ConfinementOptions {
    allowedCommands: Set<string> | null;
    customSafeBashCommands: string[][];
    sensitivePatterns: RegExp[];
    blockDotfiles: boolean;
    resolveSymlinks: boolean;
    /** canonical cwd for symlink resolution; null when unavailable or disabled */
    realCwd: string | null;
    /** Paired lexical/canonical runtime roots such as scratchpads. */
    additionalRoots: AdditionalRoot[];
}

export function resolvePath(p: string, cwd: string, home: string): string {
    let expanded = p;
    if (p === "~" || p.startsWith("~/")) {
        expanded = home + p.slice(1);
    }
    return path.resolve(cwd, expanded);
}

/**
 * Check whether a resolved path touches a sensitive segment.
 */
function hasSensitiveSegment(resolved: string, options: ConfinementOptions): boolean {
    const segments = resolved.split(path.sep).filter((s) => s !== "" && s !== "." && s !== "..");

    for (const segment of segments) {
        if (options.blockDotfiles && segment.startsWith(".")) {
            return true;
        }

        if (DEFAULT_SENSITIVE_REGEXES.some((r) => r.test(segment))) {
            return true;
        }

        if (options.sensitivePatterns.some((r) => r.test(segment))) {
            return true;
        }
    }

    return false;
}

/**
 * Check whether a path touches a sensitive segment. Checked against every
 * segment of the resolved path, so e.g. "src/.env" and "keys/server.pem"
 * are caught.
 */
export function isSensitivePath(
    p: string,
    cwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    const resolved = resolvePath(p, cwd, home);
    if (
        options.additionalRoots.some(
            (root) =>
                root.sensitiveExempt && isLexicallyWithin(resolved, root.lexical, resolved, home),
        )
    ) {
        return false;
    }
    return hasSensitiveSegment(resolved, options);
}

/**
 * Check whether a path stays within the working directory, using lexical
 * resolution only (symlinks are not followed).
 */
export function isLexicallyWithin(p: string, root: string, cwd: string, home: string): boolean {
    const resolved = resolvePath(p, cwd, home);
    const resolvedRoot = resolvePath(root, cwd, home);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

export function isAllowedPath(
    p: string,
    cwd: string,
    home: string,
    options: ConfinementOptions,
    root = cwd,
): boolean {
    if (p === "") {
        return true;
    }

    if (SPECIAL_ALLOWED_PATHS.has(p)) {
        return true;
    }

    return (
        isLexicallyWithin(p, root, cwd, home) ||
        options.additionalRoots.some((additionalRoot) =>
            isLexicallyWithin(p, additionalRoot.lexical, cwd, home),
        )
    );
}

export function findAdditionalRoot(
    p: string,
    cwd: string,
    home: string,
    options: ConfinementOptions,
): AdditionalRoot | undefined {
    const matches = options.additionalRoots.filter((root) =>
        isLexicallyWithin(p, root.lexical, cwd, home),
    );

    return matches.reduce<AdditionalRoot | undefined>((mostSpecific, root) => {
        if (!mostSpecific || root.lexical.length > mostSpecific.lexical.length) {
            return root;
        }
        return mostSpecific;
    }, undefined);
}

export function makeAbsolutePath(p: string, cwd: string, home: string): string {
    let expanded = p;
    if (p === "~" || p.startsWith("~/")) {
        expanded = home + p.slice(1);
    }
    if (path.isAbsolute(expanded)) {
        return expanded;
    }
    return cwd.endsWith(path.sep) ? cwd + expanded : cwd + path.sep + expanded;
}

export function isWithinRoot(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return (
        relative === "" ||
        (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
    );
}

function hasDotPathComponent(value: string): boolean {
    const root = path.parse(value).root;
    return value
        .slice(root.length)
        .split(path.sep)
        .some((component) => component === "." || component === "..");
}

export function isExistingDirectoryOperand(value: string, cwd: string, home: string): boolean {
    try {
        return fs.statSync(resolvePath(value, cwd, home)).isDirectory();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code !== "ENOENT" && code !== "ENOTDIR";
    }
}

export function isHardLinkedFileOperand(value: string, cwd: string, home: string): boolean {
    try {
        const stat = fs.statSync(resolvePath(value, cwd, home));
        return !stat.isDirectory() && stat.nlink > 1;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code !== "ENOENT" && code !== "ENOTDIR";
    }
}

export function isPathWithinAdditionalRoot(
    p: string,
    cwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    const root = findAdditionalRoot(p, cwd, home, options);
    if (!root) {
        return false;
    }

    if (!options.resolveSymlinks) {
        return true;
    }
    if (root.real === null) {
        return false;
    }

    const realPath = canonicalizePath(makeAbsolutePath(p, cwd, home));
    return realPath !== null && isWithinRoot(realPath, root.real);
}

/**
 * Canonicalize a path while allowing nonexistent trailing components. Path
 * components are processed from left to right so a symlink is resolved before
 * a following `..`, matching kernel lookup order. Existing dangling symlinks
 * are rejected instead of being treated as nonexistent write targets.
 */
export function canonicalizePath(p: string): string | null {
    if (!path.isAbsolute(p)) {
        return null;
    }

    const root = path.parse(p).root;
    const components = p.slice(root.length).split(path.sep);
    let current = root;
    let missingAncestor = false;

    for (const component of components) {
        if (component === "" || component === ".") {
            continue;
        }
        if (component === "..") {
            current = path.dirname(current);
            continue;
        }

        const candidate = path.join(current, component);
        if (missingAncestor) {
            current = candidate;
            continue;
        }

        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(candidate);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") {
                return null;
            }
            missingAncestor = true;
            current = candidate;
            continue;
        }

        if (!stat.isSymbolicLink()) {
            current = candidate;
            continue;
        }

        try {
            current = fs.realpathSync(candidate);
        } catch {
            return null;
        }
    }

    return current;
}

/**
 * Check a path against an explicitly approved directory. Unlike the cwd
 * heuristic, this intentionally does not apply sensitive-path filtering: the
 * directory is an explicit, session-scoped user approval. Symlinks are still
 * resolved when configured so an approved path cannot escape that directory.
 */
export function isPathWithinDirectory(
    filePath: string,
    directory: string,
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
): boolean {
    if (filePath === "" || directory === "") {
        return false;
    }

    const confinement = resolveConfinementConfig(config);
    const resolvedCwd = path.resolve(cwd);
    const home = os.homedir();

    if (!isLexicallyWithin(filePath, directory, resolvedCwd, home)) {
        return false;
    }

    if (confinement?.resolveSymlinks ?? true) {
        const resolvedDirectory = resolvePath(directory, resolvedCwd, home);
        const realFile = canonicalizePath(makeAbsolutePath(filePath, resolvedCwd, home));
        const realDirectory = canonicalizePath(makeAbsolutePath(directory, resolvedCwd, home));

        if (realFile === null || realDirectory === null) {
            return false;
        }

        return isLexicallyWithin(realFile, realDirectory, realDirectory, home);
    }

    return true;
}

export function hasSymlinkComponent(p: string): boolean {
    const resolved = path.resolve(p);
    const real = canonicalizePath(resolved);
    return real === null || real !== resolved;
}

/**
 * Check that a path stays within the canonical root that lexically authorized
 * it after resolving symlinks. The kernel resolves full symlink chains
 * (including intermediate directory components and loops), so a single
 * realpath call catches e.g. `link1 -> link2 -> /etc/passwd`.
 *
 * Non-existent trailing components (e.g. write targets) are handled by
 * canonicalizing the nearest existing ancestor — anything below it does not
 * exist, so it cannot contain symlinks. Dangling symlinks (unresolvable
 * target) are rejected: writing through them would create the file at the
 * target location.
 */
export function isRealPathConfined(
    p: string,
    cwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    if (p === "" || SPECIAL_ALLOWED_PATHS.has(p) || !options.resolveSymlinks) {
        return true;
    }

    const additionalRoot = findAdditionalRoot(p, cwd, home, options);
    const expectedRoot = additionalRoot ? additionalRoot.real : options.realCwd;
    if (expectedRoot === null) {
        // Preserve the legacy lexical-only fallback for a synthetic/nonexistent
        // cwd. Runtime-managed additional roots are expected to exist, so a
        // selected root that cannot be canonicalized fails closed.
        return additionalRoot === undefined;
    }

    const realPath = canonicalizePath(makeAbsolutePath(p, cwd, home));
    if (realPath === null || !isWithinRoot(realPath, expectedRoot)) {
        return false;
    }

    // A scratchpad may contain names such as `.env`, but a symlink from it
    // into a sensitive project path must remain blocked.
    return additionalRoot !== undefined || !hasSensitiveSegment(realPath, options);
}

function resolveConfinementConfig(
    config?: SandboxConfigCwdConfinement | null,
): SandboxConfigCwdConfinement | undefined {
    return config === undefined
        ? sandboxConfig.current?.heuristics?.cwdConfinement
        : (config ?? undefined);
}

export function buildConfinementOptions(
    confinement: SandboxConfigCwdConfinement | undefined,
    cwd: string,
    additionalRoots: readonly string[] = [],
    sensitiveAdditionalRoots?: readonly string[],
    readOnlyAdditionalRoots: readonly string[] = [],
    customSafeBashCommands: readonly string[] = [],
): ConfinementOptions {
    const resolveSymlinks = confinement?.resolveSymlinks ?? true;
    let realCwd: string | null = null;
    if (resolveSymlinks) {
        try {
            realCwd = fs.realpathSync(cwd);
        } catch {
            realCwd = null;
        }
    }

    const home = os.homedir();
    const resolveAdditionalRoots = (roots: readonly string[]): string[] =>
        roots
            .flatMap((root) => {
                const absolute = makeAbsolutePath(root, cwd, home);
                if (hasDotPathComponent(absolute)) {
                    return [];
                }
                return [path.resolve(absolute)];
            })
            .filter((root, index, roots) => roots.indexOf(root) === index);
    const resolvedAdditionalRoots = resolveAdditionalRoots(additionalRoots);
    const sensitiveRoots =
        sensitiveAdditionalRoots === undefined
            ? new Set(resolvedAdditionalRoots)
            : new Set(resolveAdditionalRoots(sensitiveAdditionalRoots));
    const readOnlyRoots = new Set(resolveAdditionalRoots(readOnlyAdditionalRoots));
    const pairedAdditionalRoots = resolvedAdditionalRoots.map((lexical): AdditionalRoot => {
        const rootPolicy = {
            sensitiveExempt: sensitiveRoots.has(lexical),
            readOnly: readOnlyRoots.has(lexical),
        };
        if (!resolveSymlinks) {
            return { lexical, real: null, ...rootPolicy };
        }

        try {
            return { lexical, real: fs.realpathSync(lexical), ...rootPolicy };
        } catch {
            return { lexical, real: null, ...rootPolicy };
        }
    });

    return {
        allowedCommands: confinement?.commands ? new Set(confinement.commands) : null,
        customSafeBashCommands: parseCustomSafeBashCommands(customSafeBashCommands),
        sensitivePatterns: (confinement?.denyPaths ?? []).map(segmentGlobToRegex),
        blockDotfiles: confinement?.blockDotfiles ?? false,
        resolveSymlinks,
        realCwd,
        additionalRoots: pairedAdditionalRoots,
    };
}
