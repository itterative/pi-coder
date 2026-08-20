/**
 * Semantics of a single flag, used by the cwd-confinement heuristic to
 * figure out which arguments may access the filesystem.
 */
export interface FlagSpec {
    /**
     * How many value tokens this flag consumes (default 0 = boolean).
     * Values are consumed as separate arguments, or inline for one value
     * (`--flag=value` fills slot 0). Multi-value flags in inline form are
     * ineligible. Consumed values are data unless listed in `pathSlots`.
     */
    values?: number;
    /**
     * Indices (0-based) of the consumed value slots that are filesystem
     * paths and must resolve inside the working directory.
     */
    pathSlots?: number[];
    /**
     * The flag makes the command ineligible for the heuristic (it writes
     * files, executes programs, or follows symlinks).
     */
    unsafe?: boolean;
}

/**
 * Argument semantics for a known command, used by the cwd-confinement
 * heuristic to figure out which arguments may access the filesystem.
 *
 * Extraction is conservative: any argument that cannot be classified is
 * treated as a file path and must resolve inside the working directory.
 * Arguments are only skipped when consumed as a flag value (unless the
 * value's slot is a path slot) or by the "first-pattern"/"first-path"
 * positional modes (e.g. grep's pattern argument).
 */
export interface CommandSpec {
    /**
     * How to treat positional (non-flag) arguments:
     * - "paths" (default): every positional is a file path
     * - "none": the command takes no positionals; any positional is ineligible
     * - "ignore": positionals are data, not paths (e.g. echo)
     * - "first-pattern": the first positional is a pattern (e.g. grep),
     *   the rest are paths, unless a patternBypassFlag appears anywhere in
     *   the arguments (then all positionals are paths)
     * - "first-path": the first positional is a path, the rest are data
     *   (e.g. archive tools: the archive, then member names)
     * - "assignments": positionals are environment assignments (e.g. the
     *   export builtin): NAME=VALUE positionals are checked like leading
     *   env assignments (dangerous names ineligible, value path-checked);
     *   a bare NAME only marks an existing variable for export (no access)
     */
    positionals?: "paths" | "none" | "ignore" | "first-pattern" | "first-path" | "assignments";
    /** Flag semantics, keyed by full flag name ("-n" or "--max-count"). */
    flags?: Record<string, FlagSpec>;
    /** For "first-pattern": flags that provide the pattern, making all positionals paths. */
    patternBypassFlags?: string[];
    /**
     * For commands that dispatch on a subcommand (e.g. git): the first
     * positional must be one of these names, otherwise the command is
     * ineligible. The remaining arguments are evaluated against the
     * subcommand's spec, which governs the flags after it; the parent spec
     * governs the flags before it (this is what keeps `git -C dir status`
     * unsafe while `git log -C` means detect-copies, not change directory).
     */
    subcommands?: Record<string, CommandSpec>;
    /**
     * When set, the command is eligible only if at least one of these flags
     * is present: the default mode is unsafe (e.g. unzip extracts files
     * unless given a read-only mode like -l or -p).
     */
    safeModeFlags?: string[];
}

// FlagSpec shorthands for the registry
/** consumes one value (data, never a path) */
export const VALUE: FlagSpec = { values: 1 };
/** consumes two values (data, never paths), e.g. jq --arg name value */
export const VALUE2: FlagSpec = { values: 2 };
/** consumes one value that IS a path */
export const PATH_VALUE: FlagSpec = { values: 1, pathSlots: [0] };
/** makes the command ineligible */
export const UNSAFE: FlagSpec = { unsafe: true };
