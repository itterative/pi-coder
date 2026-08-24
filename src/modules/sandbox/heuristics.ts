import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import sandboxConfig, { type SandboxConfigCwdConfinement } from "../../common/config";
import { type Permission } from "./permissions";
import {
    parseBash,
    isHeredocOperator,
    isSubshell,
    isProcessSubstitution,
    getSubshellContent,
} from "./bash";
import { KNOWN_COMMANDS } from "./commands";
import type { CommandSpec, FlagSpec } from "./commands";

// re-export the public surface so existing imports of "./heuristics" keep working
export { KNOWN_COMMANDS };
export type { CommandSpec, FlagSpec };

/**
 * Capability granted by a successful cwd-confinement heuristic.
 *
 * These are deliberately independent from bash's execution permission. A
 * caller can use them to give an agent only the capabilities it needs.
 */
export enum Heuristic {
    SAFE_READONLY = "SAFE_READONLY",
    SAFE_EDIT = "SAFE_EDIT",
    UNSAFE = "UNSAFE",
}

export type FileAccess = "read" | "write";

export function isSafeHeuristic(
    heuristic: Heuristic,
): heuristic is Heuristic.SAFE_READONLY | Heuristic.SAFE_EDIT {
    return heuristic === Heuristic.SAFE_READONLY || heuristic === Heuristic.SAFE_EDIT;
}

// pseudo-files available inside the sandbox's devtmpfs
const SPECIAL_ALLOWED_PATHS = new Set([
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
    ".env", ".env.*",
    // VCS internals (e.g. .git/config may embed tokens in remote URLs)
    ".git",
    // credential directories
    ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".gcloud",
    // credential files
    ".netrc", ".npmrc", ".pypirc", ".pgpass", ".my.cnf", ".htpasswd",
    // private keys
    "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*",
    "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks",
    // infra secrets
    "*.tfvars",
    "credentials",
];

function segmentGlobToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".");
    return new RegExp("^" + escaped + "$");
}

const DEFAULT_SENSITIVE_REGEXES = DEFAULT_SENSITIVE_PATTERNS.map(segmentGlobToRegex);

const REDIRECTION_OPERATORS = new Set([">", ">>", "<", "2>", "2>>"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Environment variable names that can alter how the (trusted) command itself
 * behaves — code injection, PATH shadowing, or relocating the command's state
 * (repo, config, helper) — so any assignment to them makes the heuristic
 * ineligible. NOTE: this only covers assignments on the command line; the
 * INHERITED process environment is not checked (the sandbox passes it through
 * unless inheritEnv is configured). E.g. a shell-exported GIT_DIR still
 * relocates git — accepted risk, and the reason env-dominated commands
 * (less/more with LESSOPEN) are excluded from the whitelist entirely.
 */
const DANGEROUS_ENV_NAMES = new Set([
    "PATH", "IFS", "CDPATH",
    "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PROMPT_COMMAND",
    "GCONV_PATH",
    // rg config file can inject flags, including --pre (program execution)
    "RIPGREP_CONFIG_PATH",
    // pagers pipe file contents through a user script
    "LESSOPEN", "LESSCLOSE",
    // relocate tool config/state to an attacker-chosen file (git reads the
    // XDG config; a crafted config can select programs via core.fsmonitor)
    "XDG_CONFIG_HOME", "XDG_DATA_HOME",
]);

function isDangerousEnvName(name: string): boolean {
    // GIT_* (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG, GIT_INDEX_FILE,
    // GIT_EXEC_PATH, ...): same risk class as git's -C/--git-dir/--exec-path
    // flags, which are unsafe for this reason
    return name.startsWith("LD_") || name.startsWith("GIT_") || DANGEROUS_ENV_NAMES.has(name);
}

interface ConfinementOptions {
    allowedCommands: Set<string> | null;
    sensitivePatterns: RegExp[];
    blockDotfiles: boolean;
    /** canonical cwd for symlink resolution; null disables the realpath check */
    realCwd: string | null;
}

/** Shell directory state while evaluating one command line. */
export interface CwdConfinementState {
    currentCwd: string;
    previousCwd: string | null;
    directoryStack: string[];
    /** Set when an unsupported state-changing builtin makes cwd uncertain. */
    blocked: boolean;
}

export function createCwdConfinementState(cwd: string): CwdConfinementState {
    return {
        currentCwd: path.resolve(cwd),
        previousCwd: null,
        directoryStack: [],
        blocked: false,
    };
}

export function cloneCwdConfinementState(state: CwdConfinementState): CwdConfinementState {
    return { ...state, directoryStack: [...state.directoryStack] };
}

export function restoreCwdConfinementState(
    target: CwdConfinementState,
    source: CwdConfinementState,
): void {
    target.currentCwd = source.currentCwd;
    target.previousCwd = source.previousCwd;
    target.directoryStack = [...source.directoryStack];
    target.blocked = source.blocked;
}

function resolvePath(p: string, cwd: string, home: string): string {
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
    const segments = resolved
        .split(path.sep)
        .filter((s) => s !== "" && s !== "." && s !== "..");

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
function isSensitivePath(
    p: string,
    cwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    return hasSensitiveSegment(resolvePath(p, cwd, home), options);
}

/**
 * Check whether a path stays within the working directory, using lexical
 * resolution only (symlinks are not followed).
 */
function isLexicallyWithin(
    p: string,
    root: string,
    cwd: string,
    home: string,
): boolean {
    const resolved = resolvePath(p, cwd, home);
    const resolvedRoot = resolvePath(root, cwd, home);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function isAllowedPath(
    p: string,
    cwd: string,
    home: string,
    root = cwd,
): boolean {
    if (p === "") {
        return true;
    }

    if (SPECIAL_ALLOWED_PATHS.has(p)) {
        return true;
    }

    return isLexicallyWithin(p, root, cwd, home);
}

/**
 * Canonicalize a path while allowing nonexistent trailing components. This is
 * used for write targets as well as existing read targets. An existing
 * dangling symlink is deliberately rejected instead of being treated as a
 * nonexistent path.
 */
function canonicalizePath(p: string): string | null {
    let current = path.resolve(p);
    const trailing: string[] = [];

    while (true) {
        let stat: fs.Stats | undefined;
        try {
            stat = fs.lstatSync(current);
        } catch {
            stat = undefined;
        }

        if (stat) {
            let real: string;
            try {
                real = fs.realpathSync(current);
            } catch {
                return null;
            }
            return trailing.reduce((value, segment) => path.join(value, segment), real);
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        trailing.unshift(path.basename(current));
        current = parent;
    }
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
        const resolvedFile = resolvePath(filePath, resolvedCwd, home);
        const resolvedDirectory = resolvePath(directory, resolvedCwd, home);
        const realFile = canonicalizePath(resolvedFile);
        const realDirectory = canonicalizePath(resolvedDirectory);

        if (realFile === null || realDirectory === null) {
            return false;
        }

        return isLexicallyWithin(realFile, realDirectory, realDirectory, home);
    }

    return true;
}

/**
 * Check that a path stays within the canonical working directory after
 * resolving symlinks. The kernel resolves full symlink chains (including
 * intermediate directory components and loops), so a single realpath call
 * catches e.g. `link1 -> link2 -> /etc/passwd`.
 *
 * Non-existent trailing components (e.g. write targets) are handled by
 * canonicalizing the nearest existing ancestor — anything below it does not
 * exist, so it cannot contain symlinks. Dangling symlinks (unresolvable
 * target) are rejected: writing through them would create the file at the
 * target location.
 */
function isRealPathConfined(
    p: string,
    cwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    if (p === "" || SPECIAL_ALLOWED_PATHS.has(p)) {
        return true;
    }

    const realCwd = options.realCwd;
    if (realCwd === null) {
        return true;
    }

    let current = resolvePath(p, cwd, home);

    while (true) {
        let stat: fs.Stats | undefined;
        try {
            stat = fs.lstatSync(current);
        } catch {
            stat = undefined;
        }

        if (stat) {
            let real: string;
            try {
                real = fs.realpathSync(current);
            } catch {
                // dangling symlink or otherwise unresolvable path
                return false;
            }
            if (real !== realCwd && !real.startsWith(realCwd + path.sep)) {
                return false;
            }
            // a symlink can hide a sensitive target behind an innocent name
            // (e.g. notes.txt -> .env), so check the canonical path too
            return !hasSensitiveSegment(real, options);
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return false;
        }
        current = parent;
    }
}

/**
 * Check if any argument provides the pattern for a "first-pattern" command
 * (e.g. grep -e foo, grep -ffoo, grep --regexp=foo). When present, all
 * positional arguments are paths.
 *
 * False positives are safe: they only turn pattern arguments into
 * path-checked arguments.
 */
function hasPatternBypass(args: string[], spec: CommandSpec): boolean {
    const bypass = spec.patternBypassFlags ?? [];
    const shortBypass = bypass
        .filter((f) => !f.startsWith("--"))
        .map((f) => f[1]);
    const longBypass = bypass.filter((f) => f.startsWith("--"));

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            break;
        }

        if (arg.startsWith("--")) {
            const name = arg.split("=", 1)[0];
            if (longBypass.includes(name)) {
                return true;
            }
        } else if (arg.length > 1 && arg.startsWith("-")) {
            const cluster = arg.slice(1);
            if (shortBypass.some((c) => cluster.includes(c))) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Whether any argument provides one of the spec's safeModeFlags
 * (e.g. unzip -l, unzip --list).
 */
function hasSafeModeFlag(args: string[], spec: CommandSpec): boolean {
    const safe = spec.safeModeFlags ?? [];
    const shortSafe = safe
        .filter((f) => !f.startsWith("--"))
        .map((f) => f[1]);
    const longSafe = safe.filter((f) => f.startsWith("--"));

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            break;
        }

        if (arg.startsWith("--")) {
            if (longSafe.includes(arg.split("=", 1)[0])) {
                return true;
            }
        } else if (arg.length > 1 && arg.startsWith("-")) {
            const cluster = arg.slice(1);
            if (shortSafe.some((c) => cluster.includes(c))) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Handle a short-flag cluster (e.g. -la, -n5, -efoo).
 * Returns the new argument index, or null if the command is ineligible.
 */
function handleShortCluster(
    args: string[],
    index: number,
    spec: CommandSpec,
    paths: string[],
    cwd: string,
    options: ConfinementOptions,
    writes: { value: boolean },
): number | null {
    const cluster = args[index].slice(1);

    const inspectValue = (value: string, pathContext: boolean): boolean => {
        const substitution = inspectShellSubstitution(value, cwd, options, pathContext);
        if (substitution === null) return false;
        if (substitution !== undefined) {
            paths.push(...substitution.paths);
            writes.value = writes.value || substitution.heuristic === Heuristic.SAFE_EDIT;
        } else if (pathContext) {
            paths.push(value);
        }
        return true;
    };

    for (let j = 0; j < cluster.length; j++) {
        const flag = "-" + cluster[j];
        const flagSpec = spec.flags?.[flag];

        if (flagSpec?.unsafe) {
            return null;
        }

        const values = flagSpec?.values ?? 0;
        if (values > 0) {
            if (values > 1) {
                // multi-value short flag: cannot be classified safely
                return null;
            }
            // inline value is the rest of the cluster, otherwise next arg
            if (j === cluster.length - 1) {
                const value = args[index + 1];
                if (value === undefined || !inspectValue(value, hasPathSlot(flagSpec, 0))) {
                    return null;
                }
                return index + 1;
            }
            if (!inspectValue(cluster.slice(j + 1), hasPathSlot(flagSpec, 0))) {
                return null;
            }
            return index;
        }

        // boolean (known or unknown): continue with the cluster
    }

    return index;
}

function hasPathSlot(flagSpec: FlagSpec | undefined, slot: number): boolean {
    return flagSpec?.pathSlots?.includes(slot) ?? false;
}

function combineHeuristics(
    a: Heuristic | undefined,
    b: Heuristic | undefined,
): Heuristic | undefined {
    if (a === undefined || b === undefined) return undefined;
    return a === Heuristic.SAFE_EDIT || b === Heuristic.SAFE_EDIT
        ? Heuristic.SAFE_EDIT
        : Heuristic.SAFE_READONLY;
}

function hasShellSubstitution(value: string): boolean {
    return value.includes("$(") || value.includes("`") ||
        value.includes("<(") || value.includes(">(");
}

/**
 * Return the literal paths that a narrowly modeled command substitution can
 * produce when it is used as a filesystem path. A safe inner command alone is
 * not enough: `$(echo /etc/passwd)` is safe to execute but unsafe as `cat`'s
 * path argument.
 */
function getStaticSubstitutionPaths(
    value: string,
    cwd: string,
): string[] | null {
    if (!isSubshell(value)) return null;

    let parsed: string[][];
    try {
        parsed = parseBash(getSubshellContent(value));
    } catch {
        return null;
    }

    if (parsed.length !== 1 || parsed[0].length === 0) return null;
    const args = parsed[0];
    if (args.length === 1 && args[0] === "pwd") return [cwd];
    if (args.length !== 2 || (args[0] !== "echo" && args[0] !== "printf")) return null;

    const output = args[1];
    if (isSubshell(output)) {
        return getStaticSubstitutionPaths(output, cwd);
    }
    if (!/^[A-Za-z0-9._+@/:-]+$/.test(output)) return null;
    if (output.includes("%")) return null;
    return [output];
}

interface ShellSubstitutionAccess {
    heuristic: Heuristic;
    paths: string[];
}

/**
 * Inspect shell substitutions embedded in one token. `null` means the token
 * is not safely classifiable; `undefined` means it contains no substitution.
 */
function inspectShellSubstitution(
    value: string,
    cwd: string,
    options: ConfinementOptions,
    pathContext: boolean,
): ShellSubstitutionAccess | null | undefined {
    const processSubstitution = isProcessSubstitution(value);
    const commandSubstitution = isSubshell(value);

    if (!processSubstitution && !commandSubstitution) {
        return hasShellSubstitution(value) ? null : undefined;
    }

    const inner = isConfined(getSubshellContent(value), cwd, options);
    if (inner === undefined) return null;

    if (processSubstitution) {
        return { heuristic: inner, paths: [] };
    }

    if (!pathContext) {
        return { heuristic: inner, paths: [] };
    }

    const paths = getStaticSubstitutionPaths(value, cwd);
    return paths === null ? null : { heuristic: inner, paths };
}

/**
 * Extract all filesystem paths accessed by a single known command.
 * Returns null if the command usage cannot be classified safely.
 * args[0] is the command name.
 */
interface ExtractedCommandAccess {
    paths: string[];
    writes: boolean;
}

function extractCommandPaths(
    args: string[],
    spec: CommandSpec,
    cwd: string,
    options: ConfinementOptions,
): ExtractedCommandAccess | null {
    const paths: string[] = [];
    let writes = false;
    let afterDoubleDash = false;
    let positionalSeen = false;

    // Commands with subcommands (e.g. git) dispatch on the first positional:
    // it must name a known subcommand, after which the subcommand's spec
    // governs the remaining arguments. The parent's unsafe flags apply before
    // dispatch only (after it they would collide with subcommand flags,
    // e.g. `git log -C` means detect-copies, not change directory).
    const subcommands = spec.subcommands;
    let activeSpec = spec;
    let activeStart = 0;
    let dispatched = subcommands === undefined;
    let positionals = activeSpec.positionals ?? "paths";
    let patternProvided =
        positionals !== "first-pattern" || hasPatternBypass(args, activeSpec);

    const adoptSpec = (s: CommandSpec) => {
        activeSpec = s;
        positionals = s.positionals ?? "paths";
        patternProvided =
            positionals !== "first-pattern" || hasPatternBypass(args, s);
    };

    const inspectValue = (value: string, pathContext: boolean): boolean => {
        const substitution = inspectShellSubstitution(value, cwd, options, pathContext);
        if (substitution === null) return false;
        if (substitution !== undefined) {
            paths.push(...substitution.paths);
            writes = writes || substitution.heuristic === Heuristic.SAFE_EDIT;
        } else if (pathContext) {
            paths.push(value);
        }
        return true;
    };

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        if (!afterDoubleDash) {
            if (arg === "--") {
                afterDoubleDash = true;
                continue;
            }

            if (isHeredocOperator(arg)) {
                // skip the delimiter
                i++;
                continue;
            }

            if (REDIRECTION_OPERATORS.has(arg)) {
                const target = args[++i];
                if (target === undefined) {
                    return null;
                }

                if (!inspectValue(target, true)) {
                    return null;
                }
                // File-descriptor duplication (for example 2>&1) is not
                // a filesystem write. All other non-special redirection
                // targets can create or overwrite a file.
                if (!isProcessSubstitution(target) && arg !== "<" &&
                    !target.startsWith("&") && !SPECIAL_ALLOWED_PATHS.has(target)) {
                    writes = true;
                }
                continue;
            }

            if (isProcessSubstitution(arg)) {
                if (!inspectValue(arg, false)) {
                    return null;
                }
                continue;
            }

            if (arg.startsWith("--")) {
                const eq = arg.indexOf("=");
                const name = eq === -1 ? arg : arg.slice(0, eq);
                const inline = eq === -1 ? undefined : arg.slice(eq + 1);
                const flagSpec = activeSpec.flags?.[name];

                if (flagSpec?.unsafe) {
                    return null;
                }
                if (flagSpec?.writes) {
                    writes = true;
                }

                const values = flagSpec?.values ?? 0;
                if (values > 0) {
                    if (inline !== undefined) {
                        // inline value fills slot 0; multi-value flags do
                        // not have a usable inline form
                        if (values > 1) {
                            return null;
                        }
                        if (!inspectValue(inline, hasPathSlot(flagSpec, 0))) {
                            return null;
                        }
                        continue;
                    }
                    for (let slot = 0; slot < values; slot++) {
                        const value = args[i + 1 + slot];
                        if (value === undefined) {
                            return null;
                        }
                        if (!inspectValue(value, hasPathSlot(flagSpec, slot))) {
                            return null;
                        }
                    }
                    i += values;
                    continue;
                }

                // unknown long flag with inline value: treat value as path
                if (inline !== undefined && !inspectValue(inline, true)) {
                    return null;
                }
                continue;
            }

            if (arg.length > 1 && arg.startsWith("-")) {
                // whole-arg unsafe flags: find's expression actions are
                // single-dash multi-character tokens, not short clusters
                // (-delete, -exec, -fprint, ...)
                if (activeSpec.flags?.[arg]?.unsafe) {
                    return null;
                }

                const cluster = arg.slice(1);
                for (let j = 0; j < cluster.length; j++) {
                    if (activeSpec.flags?.[`-${cluster[j]}`]?.writes) {
                        writes = true;
                        break;
                    }
                    if ((activeSpec.flags?.[`-${cluster[j]}`]?.values ?? 0) > 0) {
                        break;
                    }
                }

                const writeState: { value: boolean } = { value: writes };
                const next = handleShortCluster(
                    args,
                    i,
                    activeSpec,
                    paths,
                    cwd,
                    options,
                    writeState,
                );
                writes = writeState.value;
                if (next === null) {
                    return null;
                }
                i = next;
                continue;
            }
        }

        // positional argument
        if (!dispatched) {
            const sub = subcommands![arg];
            if (sub === undefined) {
                return null;
            }
            adoptSpec(sub);
            activeStart = i;
            dispatched = true;
            continue;
        }

        switch (positionals) {
            case "none":
                return null;
            case "ignore":
                if (!inspectValue(arg, false)) {
                    return null;
                }
                continue;
            case "first-pattern":
                if (!positionalSeen && !patternProvided) {
                    positionalSeen = true;
                    if (!inspectValue(arg, false)) {
                        return null;
                    }
                    continue;
                }
                if (!inspectValue(arg, true)) {
                    return null;
                }
                continue;
            case "first-path":
                if (!positionalSeen) {
                    positionalSeen = true;
                    if (!inspectValue(arg, true)) {
                        return null;
                    }
                } else if (!inspectValue(arg, false)) {
                    return null;
                }
                continue;
            case "assignments": {
                // env-assignment positional (the export builtin): NAME=VALUE
                // is checked like a leading env assignment (dangerous names
                // ineligible, value path-checked); a bare NAME only marks an
                // existing variable for export — nothing to check
                const eq = arg.indexOf("=");
                if (eq === -1) {
                    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
                        return null;
                    }
                    continue;
                }
                const name = arg.slice(0, eq);
                if (eq === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                    return null;
                }
                if (isDangerousEnvName(name)) {
                    return null;
                }
                if (!inspectValue(arg.slice(eq + 1), true)) {
                    return null;
                }
                continue;
            }
            default:
                if (!inspectValue(arg, true)) {
                    return null;
                }
                continue;
        }
    }

    // a subcommand-taking command with no subcommand (e.g. bare `git`)
    if (!dispatched) {
        return null;
    }

    // Subcommands may have their own invocation-level safety check (the
    // parent check is performed by isCommandConfined before extraction).
    if (
        activeSpec !== spec &&
        activeSpec.validate &&
        !activeSpec.validate(args.slice(activeStart))
    ) {
        return null;
    }

    // default mode is unsafe unless a read-only mode flag is present
    if (activeSpec.safeModeFlags && !hasSafeModeFlag(args, activeSpec)) {
        return null;
    }

    return { paths, writes };
}

const CHAIN_OPERATORS = new Set(["&&", "||", "|", ";", "&"]);

/**
 * Split a parsed command at chain operators. parseBash keeps operators like
 * && and | as arguments of a single command, so each segment between them
 * must be evaluated as its own command.
 */
export interface ChainSegment {
    args: string[];
    operatorAfter: string | null;
}

export function splitAtChainOperatorsWithOperators(args: string[]): ChainSegment[] {
    const segments: ChainSegment[] = [];
    let current: string[] = [];

    for (const arg of args) {
        if (CHAIN_OPERATORS.has(arg)) {
            if (current.length > 0) {
                segments.push({ args: current, operatorAfter: arg });
                current = [];
            }
        } else {
            current.push(arg);
        }
    }

    if (current.length > 0) {
        segments.push({ args: current, operatorAfter: null });
    }

    return segments;
}

export function splitAtChainOperators(args: string[]): string[][] {
    return splitAtChainOperatorsWithOperators(args).map((segment) => segment.args);
}

export function isNonPersistentChainOperator(operator: string | null): boolean {
    return operator === "|" || operator === "&";
}

function isDynamicDirectoryPath(value: string): boolean {
    // Expansion and globbing can select a directory outside the lexical cwd;
    // do not guess what a state-changing builtin will receive.
    return /[$`*?\[\]~]/.test(value);
}

function isConfinedDirectoryPath(
    value: string,
    cwd: string,
    rootCwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    if (isDynamicDirectoryPath(value)) {
        return false;
    }
    if (!isLexicallyWithin(value, rootCwd, cwd, home)) {
        return false;
    }
    if (isSensitivePath(value, cwd, home, options)) {
        return false;
    }
    return isRealPathConfined(value, cwd, home, options);
}

/**
 * Apply the cwd-changing Bash builtins we can model precisely. A false result
 * means the builtin itself is not eligible for the heuristic; state is still
 * updated when its destination is known, so a later `cd` can recover.
 */
function applyDirectoryCommand(
    args: string[],
    state: CwdConfinementState,
    rootCwd: string,
    options: ConfinementOptions,
): boolean | undefined {
    const command = args[0];
    if (command !== "cd" && command !== "pushd" && command !== "popd") {
        return undefined;
    }

    const operands: string[] = [];
    let afterDoubleDash = false;
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (!afterDoubleDash && arg === "--") {
            afterDoubleDash = true;
            continue;
        }
        if (!afterDoubleDash && command === "cd" && (arg === "-L" || arg === "-P")) {
            continue;
        }
        if (!afterDoubleDash && command === "cd" && arg === "-") {
            operands.push(arg);
            continue;
        }
        if (!afterDoubleDash && arg.startsWith("-")) {
            state.blocked = true;
            return false;
        }
        operands.push(arg);
    }

    const home = os.homedir();
    if (command === "popd") {
        if (operands.length > 0) {
            state.blocked = true;
            return false;
        }
        if (state.directoryStack.length === 0) {
            // Bash reports an error and leaves cwd unchanged.
            return true;
        }
        const oldCwd = state.currentCwd;
        state.currentCwd = state.directoryStack.pop()!;
        state.previousCwd = oldCwd;
        return isConfinedDirectoryPath(state.currentCwd, state.currentCwd, rootCwd, home, options);
    }

    if (command === "pushd" && operands.length === 0) {
        // The no-argument form rotates the existing stack, which we do not
        // model because its result depends on stack indices.
        state.blocked = true;
        return false;
    }
    if (command === "pushd" && /^[+-]\d+$/.test(operands[0] ?? "")) {
        // +N/-N also rotates/selects an existing stack entry.
        state.blocked = true;
        return false;
    }
    if (operands.length > 1) {
        state.blocked = true;
        return false;
    }

    const oldCwd = state.currentCwd;
    let target = operands[0];
    if (command === "cd" && target === undefined) {
        target = home;
    } else if (command === "cd" && target === "-") {
        if (state.previousCwd === null) return false;
        target = state.previousCwd;
    }

    if (target === undefined) {
        state.blocked = true;
        return false;
    }
    if (isDynamicDirectoryPath(target)) {
        state.blocked = true;
        return false;
    }

    const lexicalTarget = resolvePath(target, oldCwd, home);
    state.currentCwd = lexicalTarget;
    if (options.realCwd !== null) {
        try {
            // Track the kernel's actual cwd, not merely Bash's logical PWD;
            // otherwise `cd symlink && cat ../file` could resolve `..` from
            // the wrong directory.
            state.currentCwd = fs.realpathSync(lexicalTarget);
        } catch {
            // A missing target makes cd fail, so the shell remains in oldCwd.
            state.currentCwd = oldCwd;
        }
    }
    state.previousCwd = oldCwd;
    if (command === "pushd") {
        state.directoryStack.push(oldCwd);
    }

    return isConfinedDirectoryPath(target, oldCwd, rootCwd, home, options);
}

/**
 * Check whether a single parsed command is a known command whose file
 * accesses all stay within the working directory.
 */
function isCommandConfined(
    args: string[],
    cwd: string,
    rootCwd: string,
    options: ConfinementOptions,
    state: CwdConfinementState,
): Heuristic | undefined {
    if (state.blocked) {
        return undefined;
    }
    // skip leading environment assignments (FOO=bar cmd ...), but reject
    // assignments that can alter the command's behavior (LD_PRELOAD, PATH,
    // ...) and path-check the values of the rest
    let idx = 0;
    const envValues: string[] = [];
    while (idx < args.length && ENV_ASSIGNMENT.test(args[idx])) {
        const eq = args[idx].indexOf("=");
        const name = args[idx].slice(0, eq);
        if (isDangerousEnvName(name)) {
            return undefined;
        }
        envValues.push(args[idx].slice(eq + 1));
        idx++;
    }

    if (idx >= args.length) {
        return undefined;
    }

    const commandName = args[idx];

    // commands invoked by path are not trusted to be the real binary
    if (commandName.includes("/") || commandName.includes("\\")) {
        return undefined;
    }

    const spec = KNOWN_COMMANDS[commandName];
    if (!spec) {
        return undefined;
    }

    const commandArgs = args.slice(idx);
    const directoryResult = applyDirectoryCommand(commandArgs, state, rootCwd, options);
    if (directoryResult !== undefined) {
        const home = os.homedir();
        const envConfined = envValues.every((p) =>
            isAllowedPath(p, cwd, home, rootCwd) &&
            !isSensitivePath(p, cwd, home, options) &&
            isRealPathConfined(p, cwd, home, options),
        );
        const commandAllowed =
            options.allowedCommands === null || options.allowedCommands.has(commandName);
        return directoryResult && envConfined && commandAllowed
            ? Heuristic.SAFE_READONLY
            : undefined;
    }

    if (options.allowedCommands !== null && !options.allowedCommands.has(commandName)) {
        return undefined;
    }

    if (spec.validate && !spec.validate(commandArgs)) {
        return undefined;
    }

    const access = extractCommandPaths(commandArgs, spec, cwd, options);
    if (access === null) {
        return undefined;
    }

    const home = os.homedir();
    const allPaths = [...envValues, ...access.paths];
    const confined = allPaths.every((p) => {
        if (!isAllowedPath(p, cwd, home, rootCwd)) {
            return false;
        }
        if (isSensitivePath(p, cwd, home, options)) {
            return false;
        }
        if (!isRealPathConfined(p, cwd, home, options)) {
            return false;
        }
        return true;
    });

    return confined
        ? (access.writes ? Heuristic.SAFE_EDIT : Heuristic.SAFE_READONLY)
        : undefined;
}

/**
 * Check whether every command in a (possibly multi-line or chained) command
 * string is known and confined to the working directory.
 */
function isConfined(
    command: string,
    cwd: string,
    options: ConfinementOptions,
): Heuristic | undefined {
    let parsed: string[][];
    try {
        parsed = parseBash(command);
    } catch {
        return undefined;
    }

    if (parsed.length === 0) {
        return undefined;
    }

    const state = createCwdConfinementState(cwd);
    let heuristic: Heuristic | null = null;
    for (const cmdArgs of parsed) {
        const segments = splitAtChainOperatorsWithOperators(cmdArgs);
        let nonPersistentBase: CwdConfinementState | null = null;

        if (segments.length === 0) {
            return undefined;
        }

        for (const { args, operatorAfter } of segments) {
            const beforeSegment = cloneCwdConfinementState(state);
            if (nonPersistentBase === null && isNonPersistentChainOperator(operatorAfter)) {
                nonPersistentBase = beforeSegment;
            }
            const segmentState = nonPersistentBase
                ? cloneCwdConfinementState(nonPersistentBase)
                : state;
            const result = isCommandConfined(
                args,
                segmentState.currentCwd,
                cwd,
                options,
                segmentState,
            );

            if (nonPersistentBase !== null) {
                restoreCwdConfinementState(state, nonPersistentBase);
                if (!isNonPersistentChainOperator(operatorAfter)) {
                    nonPersistentBase = null;
                }
            }
            if (result === undefined) {
                return undefined;
            }
            heuristic = combineHeuristics(heuristic ?? Heuristic.SAFE_READONLY, result)
                ?? Heuristic.SAFE_READONLY;
        }
    }

    return heuristic ?? undefined;
}

function buildConfinementOptions(
    confinement: SandboxConfigCwdConfinement | undefined,
    cwd: string,
): ConfinementOptions {
    let realCwd: string | null = null;
    if (confinement?.resolveSymlinks ?? true) {
        try {
            realCwd = fs.realpathSync(cwd);
        } catch {
            realCwd = null;
        }
    }

    return {
        allowedCommands: confinement?.commands ? new Set(confinement.commands) : null,
        sensitivePatterns: (confinement?.denyPaths ?? []).map(segmentGlobToRegex),
        blockDotfiles: confinement?.blockDotfiles ?? false,
        realCwd,
    };
}

function resolveConfinementConfig(
    config?: SandboxConfigCwdConfinement | null,
): SandboxConfigCwdConfinement | undefined {
    return config === undefined
        ? sandboxConfig.current?.heuristics?.cwdConfinement
        : (config ?? undefined);
}

/** Return the configured execution permission for a successful heuristic. */
export function getConfiguredCwdConfinementPermission(
    config?: SandboxConfigCwdConfinement | null,
): Permission {
    return resolveConfinementConfig(config)?.permission ?? "allow:sandbox";
}

/**
 * Cwd-confinement heuristic for a direct file-tool access. A path is granted
 * only when it is inside cwd and does not touch a sensitive segment. The
 * symlink check also handles nonexistent write targets. Read access returns
 * SAFE_READONLY; write access returns SAFE_EDIT. Rejected accesses return
 * UNSAFE so callers can distinguish them from a successful classification.
 */
export function getPathConfinementPermission(
    filePath: string,
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
    access: FileAccess = "read",
): Heuristic {
    const confinement = resolveConfinementConfig(config);

    if (confinement?.enabled === false || filePath.trim() === "") {
        return Heuristic.UNSAFE;
    }

    const resolvedCwd = path.resolve(cwd);
    const home = os.homedir();
    const options = buildConfinementOptions(confinement, resolvedCwd);

    if (!isLexicallyWithin(filePath, resolvedCwd, resolvedCwd, home)) {
        return Heuristic.UNSAFE;
    }

    if (isSensitivePath(filePath, resolvedCwd, home, options)) {
        return Heuristic.UNSAFE;
    }

    if ((confinement?.resolveSymlinks ?? true) &&
        !isRealPathConfined(filePath, resolvedCwd, home, options)) {
        return Heuristic.UNSAFE;
    }

    return access === "write" ? Heuristic.SAFE_EDIT : Heuristic.SAFE_READONLY;
}

/**
 * Cwd-confinement heuristic: known, safe commands whose file accesses all
 * resolve inside the working directory are classified by capability.
 *
 * Returns UNSAFE for unknown commands, paths outside the working directory,
 * or unclassifiable usage. Callers should fall back to the permission system.
 */
export function getCwdConfinementPermission(
    command: string,
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
): Heuristic {
    const confinement = resolveConfinementConfig(config);

    if (confinement?.enabled === false) {
        return Heuristic.UNSAFE;
    }

    if (command.trim() === "") {
        return Heuristic.UNSAFE;
    }

    const resolvedCwd = path.resolve(cwd);
    return isConfined(command, resolvedCwd, buildConfinementOptions(confinement, resolvedCwd))
        ?? Heuristic.UNSAFE;
}

/**
 * Segment-level variant of the cwd-confinement heuristic: evaluates a single
 * already-parsed command (list of arguments, no chain operators).
 *
 * Returns UNSAFE when the heuristic does not apply.
 */
export function getArgsConfinementPermission(
    args: string[],
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
    state?: CwdConfinementState,
): Heuristic {
    const confinement = resolveConfinementConfig(config);

    if (confinement?.enabled === false || args.length === 0) {
        return Heuristic.UNSAFE;
    }

    const resolvedCwd = path.resolve(cwd);
    const confinementState = state ?? createCwdConfinementState(resolvedCwd);

    return isCommandConfined(
        args,
        confinementState.currentCwd,
        resolvedCwd,
        buildConfinementOptions(confinement, resolvedCwd),
        confinementState,
    ) ?? Heuristic.UNSAFE;
}
