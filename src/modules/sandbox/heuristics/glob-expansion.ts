import fs from "node:fs";
import path from "node:path";

/**
 * Expansion of live pathname-expansion patterns in command path slots.
 *
 * This module answers one question only: which operands can the shell actually pass for this
 * pattern. Confinement is not decided here — the operands are handed back to the ordinary path
 * checks, so containment, sensitive names, symlinks, and read-versus-write policy stay in exactly
 * one place. Nothing outside `heuristics/` should import this module.
 */

/** Ceiling on distinct operands produced by one pattern. */
const GLOB_MAX_MATCHES = 512;
/** Ceiling on directory entries read while matching one pattern. */
const GLOB_MAX_ENTRIES = 2000;
/**
 * Characters that mean something to a shell we do not model. Extglob operators (`@(...)`,
 * `!(...)`, `*(...)`, `?(...)`) are live when bash runs with `shopt -s extglob` and when zsh runs
 * with its default `EXTENDED_GLOB`, and the negated forms match *more* than a literal reading does,
 * which is exactly the narrower-than-the-shell direction. `]` is refused with `[` so a bare bracket
 * in a name cannot be treated as an ordinary character by one shell and as class syntax by another.
 * Refusing costs almost nothing: these characters are rare in path names and the shapes were
 * prompting before this feature existed.
 */
const UNSUPPORTED_PATTERN_CHARS = /[()[\]]/;
/** Components a pattern may span when no depth is configured. */
export const DEFAULT_GLOB_MAX_DEPTH = 10;

interface GlobBudget {
    entries: number;
    matches: number;
}

/**
 * Split a pattern into components, rejecting the forms this module will not model.
 *
 * `null` means refuse and prompt. A `**` component is refused because zsh expands it recursively by
 * default while bash needs `globstar`, so the operand set would depend on the user's login shell, and
 * `UNSUPPORTED_PATTERN_CHARS` covers the other shell-syntax families that cannot be translated
 * soundly: bracket classes (POSIX classes, locale-collated ranges, and out-of-order ranges that throw
 * while compiling) and extglob operators (live under `shopt -s extglob` and zsh's default
 * `EXTENDED_GLOB`). Keeping that syntax out of the supported alphabet also means the translator only
 * ever emits `[^/]*`, `[^/]`, and escaped literals, which cannot build an invalid expression. A
 * trailing separator is refused because it constrains matches to directories, which the operand list
 * cannot express.
 */
function splitPatternComponents(pattern: string): string[] | null {
    if (pattern === "" || pattern.endsWith("/")) {
        return null;
    }

    const absolute = pattern.startsWith("/");
    const rawComponents = pattern.split("/");
    const components = rawComponents.filter((component) => component !== "");
    const emptyComponents = rawComponents.filter((component, index) => {
        return component === "" && !(index === 0 && absolute);
    });

    if (components.length === 0 || emptyComponents.length > 0) {
        return null;
    }

    if (components.some(isUnsupportedComponent)) {
        return null;
    }

    return absolute ? ["/", ...components] : components;
}

function isUnsupportedComponent(component: string): boolean {
    return (
        component === "." ||
        component === ".." ||
        component.includes("**") ||
        UNSUPPORTED_PATTERN_CHARS.test(component)
    );
}

function hasMagic(component: string): boolean {
    return component.includes("*") || component.includes("?");
}

/** Translate one pattern component into an exact-match regular expression. */
function globComponentToRegex(component: string): RegExp {
    let source = "";

    for (const char of component) {
        if (char === "*") {
            source += "[^/]*";
            continue;
        }
        if (char === "?") {
            source += "[^/]";
            continue;
        }
        source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    return new RegExp(`^${source}$`);
}

function matchesEntry(component: string, name: string, matcher: RegExp): boolean {
    // bash never matches a leading dot with an unquoted pattern that does not ask for one.
    if (name.startsWith(".") && !component.startsWith(".")) {
        return false;
    }

    return matcher.test(name);
}

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function readEntries(directory: string): string[] | null {
    try {
        const entries = fs.readdirSync(directory);
        return entries;
    } catch (error: unknown) {
        const code = (error as { code?: string }).code;
        // A missing path or a file where a directory was expected simply cannot match.
        if (code === "ENOENT" || code === "ENOTDIR") {
            return [];
        }
        return null;
    }
}

/** Count one operand; false means the budget is blown and the pattern must be refused. */
function countOperand(budget: GlobBudget): boolean {
    budget.matches += 1;

    return budget.matches <= GLOB_MAX_MATCHES;
}

/**
 * Walk the remaining components from `directory`, collecting absolute operands.
 * `null` means the walk could not be completed safely, which refuses the whole pattern.
 *
 * The matcher is compiled once per component, not once per directory entry, and the entry budget is
 * checked as soon as a listing is read: otherwise a wide directory costs one full readdir plus a
 * stat and a regex compile per entry before anything refuses, which is slow enough to be felt
 * inside a synchronous permission decision.
 */
function collectOperands(
    directory: string,
    components: string[],
    budget: GlobBudget,
): string[] | null {
    const [component, ...rest] = components;
    if (component === undefined) {
        return countOperand(budget) ? [directory] : null;
    }

    if (!hasMagic(component)) {
        const next = path.join(directory, component);
        if (rest.length === 0) {
            return exists(next) && countOperand(budget) ? [next] : [];
        }
        return collectOperands(next, rest, budget);
    }

    const entries = readEntries(directory);
    if (entries === null) {
        return null;
    }
    budget.entries += entries.length;
    if (budget.entries > GLOB_MAX_ENTRIES) {
        return null;
    }

    const matcher = globComponentToRegex(component);
    const operands: string[] = [];
    for (const entry of entries) {
        if (!matchesEntry(component, entry, matcher)) {
            continue;
        }

        const next = path.join(directory, entry);
        if (rest.length === 0) {
            if (!countOperand(budget)) {
                return null;
            }
            operands.push(next);
            continue;
        }

        // Further components can only match inside a directory.
        if (!isDirectory(next)) {
            continue;
        }
        const nested = collectOperands(next, rest, budget);
        if (nested === null) {
            return null;
        }
        operands.push(...nested);
    }

    return operands;
}

function exists(candidate: string): boolean {
    try {
        fs.statSync(candidate);
        return true;
    } catch {
        return false;
    }
}

/**
 * Expand a live glob into the absolute operands the shell may pass for it.
 *
 * Zero matches yields the literal pattern, because `nullglob` and `failglob` are off in bash and
 * zsh fails the command outright, so checking the literal operand is sound for both without
 * detecting which shell will run the command.
 */
export function expandGlobPattern(
    pattern: string,
    cwd: string,
    maxDepth: number = DEFAULT_GLOB_MAX_DEPTH,
): string[] | null {
    const components = splitPatternComponents(pattern);
    if (components === null || components.length > maxDepth) {
        return null;
    }

    const absolute = components[0] === "/";
    const start = absolute ? "/" : path.resolve(cwd);
    const rest = absolute ? components.slice(1) : components;

    const operands = collectOperands(start, rest, { entries: 0, matches: 0 });
    if (operands === null) {
        return null;
    }

    return operands.length > 0 ? operands : [path.resolve(start, pattern)];
}
