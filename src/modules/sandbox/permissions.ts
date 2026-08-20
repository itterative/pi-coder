import sandboxConfig, { SandboxConfigPermissions } from "../../common/config";
import {
    parseBash,
    isHeredocOperator,
    isSubshell,
    isProcessSubstitution,
    getSubshellContent,
} from "./bash";

type PermissionMatcher = PermissionMatcherSimple | PermissionMatcherSubshell;

type PermissionMatcherSimple = {
    type: "literal" | "wildcard" | "heredoc-op" | "heredoc-delim" | "chain-op";
    value: string;
    test: (value: string) => boolean;
};

type PermissionMatcherSubshell = {
    type: "subshell";
    value: string;
    // note: only a quick test, submatchers should be handled properly
    test: (value: string) => boolean;
    // For subshells: nested matchers for the content inside $() or ``
    subMatchers: PermissionMatcher[];
};

type PermissionMatch = {
    wildcard: string;
    matchers: PermissionMatcher[];
    value: Permission;
};

export type Permission = "deny" | "ask" | "allow" | "allow:sandbox";

let permissions: PermissionMatch[] = [];
let defaultPermission: Permission = "ask";

let config: SandboxConfigPermissions | null = null;

const MATCH_WILDCARD = "*";

/**
 * Convert a wildcard pattern to a regex for matching individual arguments.
 * The * wildcard matches zero or more characters within an argument.
 */
function patternToRegex(pattern: string): RegExp {
    // escape special regex characters
    let escaped = pattern
        .replaceAll("\\", "\\\\")
        .replaceAll(".", "\\.")
        .replaceAll("+", "\\+")
        .replaceAll("^", "\\^")
        .replaceAll("$", "\\$")
        .replaceAll("?", "\\?")
        .replaceAll("(", "\\(")
        .replaceAll(")", "\\)")
        .replaceAll("[", "\\[")
        .replaceAll("]", "\\]")
        .replaceAll("{", "\\{")
        .replaceAll("}", "\\}")
        .replaceAll("|", "\\|");

    escaped = escaped.replaceAll(MATCH_WILDCARD, ".*");

    return new RegExp("^" + escaped + "$");
}

/**
 * Check if a value is a chain operator (&&, ||, ;, |)
 */
function isChainOperator(value: string): boolean {
    return value === "&&" || value === "||" || value === ";" || value === "|" || value === "&";
}

/**
 * Match command arguments against a pattern.
 * Patterns can use * to match one or more arguments.
 *
 * Examples:
 * - "npm *" matches "npm install", "npm run build", etc.
 * - "* file.txt" matches "cat file.txt", "ls file.txt", etc.
 * - "npm run *" matches "npm run dev", "npm run build", etc.
 * - "cat << EOF" matches heredoc syntax (any delimiter matches any delimiter)
 * - "cat << *" matches any heredoc
 */
function matchArgs(
    commandArgs: string[],
    patternMatchers: PermissionMatcher[],
    depth: number = 0,
): boolean {
    const MAX_DEPTH = 50;
    const maxIterations = (commandArgs.length + patternMatchers.length) * 2;
    let iterations = 0;

    if (depth > MAX_DEPTH) {
        throw new Error(`matchArgs: exceeded maximum depth (${MAX_DEPTH})`);
    }

    // Empty pattern matches empty command
    if (patternMatchers.length === 0) {
        return commandArgs.length === 0;
    }

    let cmdIdx = 0;
    let patIdx = 0;
    let lookahead: PermissionMatcher | null = null;

    while (patIdx < patternMatchers.length) {
        if (++iterations > maxIterations) {
            throw new Error(`matchArgs: exceeded maximum iterations (${maxIterations}), possible infinite loop`);
        }

        if (cmdIdx >= commandArgs.length) {
            return false;
        }

        const pattern = patternMatchers[patIdx];
        const argument = commandArgs[cmdIdx];

        if (pattern.type === "wildcard") {
            if (lookahead === null) {
                const remainingPattern = patternMatchers.slice(patIdx + 1);
                const nextNonWildcardIdx = remainingPattern.findIndex(
                    (p) => p.type !== "wildcard",
                );

                if (nextNonWildcardIdx === -1) {
                    // no lookahead - wildcard matches remaining args except any chain operator
                    const remainingArgs = commandArgs.slice(cmdIdx);
                    const hasChainOperator =
                        remainingArgs.some(isChainOperator);

                    if (hasChainOperator) {
                        return false;
                    }

                    return true;
                }

                lookahead = remainingPattern[nextNonWildcardIdx];
            }

            if (lookahead.test(argument)) {
                patIdx++;
            } else {
                // wildcards should not consume chain operators
                if (isChainOperator(argument)) {
                    return false;
                }

                cmdIdx++;
            }
        } else {
            lookahead = null; // reset

            if (!pattern.test(argument)) {
                return false;
            }

            // for subshells and process substitutions, match the nested content
            if (pattern.type === "subshell") {
                const cmdContent = getSubshellContent(argument);
                const cmdArgsAll = parseBash(cmdContent);

                // Empty subshell matches empty subshell pattern
                if (cmdArgsAll.length === 0 && pattern.subMatchers.length === 0) {
                    // Both empty, match succeeds
                } else {
                    for (const cmdArgs of cmdArgsAll) {
                        if (!matchArgs(cmdArgs, pattern.subMatchers, depth + 1)) {
                            return false;
                        }
                    }
                }
            }

            patIdx++;
            cmdIdx++;
        }
    }

    if (cmdIdx < commandArgs.length) {
        // allow a single extra arg if the permission pattern has a heredoc operator
        // (the closing delimiter may be extra in the command)
        const hasHeredocOp = patternMatchers.some(
            (m) => m.type === "heredoc-op",
        );

        if (hasHeredocOp && cmdIdx === commandArgs.length - 1) {
            return true;
        }

        return false;
    }

    return true;
}

/**
 * Create matchers for a list of arguments, handling subshells recursively.
 */
function createMatchers(args: string[]): PermissionMatcher[] {
    return args.map((arg, idx) => {
        if (arg === MATCH_WILDCARD) {
            return {
                type: "wildcard" as const,
                value: arg,
                test: () => true,
            };
        }

        if (arg === "<<" || arg === "<<-") {
            const regex = patternToRegex(arg);
            return {
                type: "heredoc-op" as const,
                value: arg,
                test: (v: string) => regex.test(v),
            };
        }

        if (idx > 0 && isHeredocOperator(args[idx - 1])) {
            return {
                type: "heredoc-delim" as const,
                value: arg,
                test: () => true,
            };
        }

        if (isSubshell(arg) || isProcessSubstitution(arg)) {
            // subshell/process substitution content create nested matchers
            const content = getSubshellContent(arg);
            const subArgs = parseBash(content);

            // Create a test function that checks type AND prefix
            const argPrefix = arg.startsWith(">(") ? ">(" : arg.startsWith("<(") ? "<(" : arg.startsWith("`") ? "`" : "$(";
            const testFn = (v: string) => {
                // Check same type (subshell vs process substitution)
                if (!isSubshell(v) && !isProcessSubstitution(v)) return false;
                // Check same prefix ($(), ``, <(, >()
                return v.startsWith(argPrefix);
            };

            // Empty subshell is valid
            if (subArgs.length === 0) {
                return {
                    type: "subshell" as const,
                    value: arg,
                    test: testFn,
                    subMatchers: [],
                };
            }

            if (subArgs.length !== 1) {
                throw new Error(`expected a single subshell bash command, found ${subArgs.length}`);
            }

            const subMatchers = createMatchers(subArgs[0]);

            return {
                type: "subshell" as const,
                value: arg,
                test: testFn,
                subMatchers,
            };
        }

        const regex = patternToRegex(arg);
        return {
            type: "literal" as const,
            value: arg,
            test: (v: string) => regex.test(v),
        };
    });
}

function getPermissions(
    configPermissions?: SandboxConfigPermissions,
): PermissionMatch[] {
    configPermissions = configPermissions ?? sandboxConfig.current?.permissions;

    if (config === configPermissions) {
        return permissions;
    }

    config = configPermissions ?? null;

    if (config === null) {
        return permissions;
    }

    let _permissions: PermissionMatch[] = [];
    let _defaultPermission: Permission = "ask";

    try {
        for (const permission of Object.entries(config)) {
            try {
              // Handle "**" as the default permission (fallback when no pattern matches)
              if (permission[0] === "**") {
                  _defaultPermission = permission[1] as Permission;
                  continue;
              }

              // Handle empty permission key specially
              if (permission[0] === "" || permission[0].trim() === "") {
                  _permissions.push({
                      wildcard: permission[0],
                      value: permission[1] as Permission,
                      matchers: [{ type: "literal", value: "", test: (v: string) => v === "" }],
                  });
                  continue;
              }

              const permissionArguments = parseBash(permission[0]);

              if (permissionArguments.length !== 1) {
                  throw new Error(`expected the rules to contain only one bash syntax, found ${permissionArguments.length}`);
              }

              const matchers = createMatchers(permissionArguments[0]);

              _permissions.push({
                  wildcard: permission[0],
                  value: permission[1] as Permission,
                  matchers,
              });
            } catch (e) {
                throw new Error(`could not create permission matcher for pattern (${permission[0]}): ${e}`);
            }
        }
    } catch (e) {
        throw new Error(`Failed to parse permissions in config: ${e}`);
    }

    permissions = _permissions;
    defaultPermission = _defaultPermission;
    return permissions;
}

/**
 * Get the permission level for a single command (no newlines).
 */
function getSingleCommandPermission(
    commands: string[],
    permissions: PermissionMatch[],
    fallback: Permission = "ask",
): { permission: Permission; matched: boolean } {
    let match: Permission = fallback;
    let matched = false;

    // note: this will match the last one (similar to opencode)
    //       could also try a specificity approach
    for (const permission of permissions) {
        try {
            if (!matchArgs(commands, permission.matchers)) {
                continue;
            }

            match = permission.value;
            matched = true;
        } catch {
            continue;
        }
    }

    return { permission: match, matched };
}

/**
 * Return the more restrictive of two permissions.
 * Order: deny > ask > allow:sandbox > allow
 */
export function moreRestrictive(a: Permission, b: Permission): Permission {
    const order: Permission[] = ["allow", "allow:sandbox", "ask", "deny"];
    return order.indexOf(a) > order.indexOf(b) ? a : b;
}

export function getPermissionMatch(
    command: string,
    configPermissions?: SandboxConfigPermissions,
): { permission: Permission; matched: boolean } {
    let permissions: PermissionMatch[];

    try {
        permissions = getPermissions(configPermissions);
    } catch {
        return { permission: "ask", matched: false };
    }

    // Handle empty command as a special case for backward compatibility
    if (command === "" || command.trim() === "") {
        return getSingleCommandPermission([""], permissions, defaultPermission);
    }

    const parsedCommands = parseBash(command);

    if (parsedCommands.length === 0) {
        return { permission: defaultPermission, matched: false };
    }

    // Return the most restrictive permission across all commands
    return parsedCommands.reduce<{ permission: Permission; matched: boolean }>(
        (result, cmd) => {
            const { permission, matched } = getSingleCommandPermission(
                cmd,
                permissions,
                defaultPermission,
            );
            return {
                permission: moreRestrictive(result.permission, permission),
                matched: result.matched || matched,
            };
        },
        { permission: "allow", matched: false },
    );
}

export default function getPermission(
    command: string,
    configPermissions?: SandboxConfigPermissions,
): Permission {
    return getPermissionMatch(command, configPermissions).permission;
}

/**
 * Match a single already-parsed command (list of arguments) against the
 * permission patterns.
 */
export function getArgsPermissionMatch(
    args: string[],
    configPermissions?: SandboxConfigPermissions,
): { permission: Permission; matched: boolean } {
    let permissions: PermissionMatch[];

    try {
        permissions = getPermissions(configPermissions);
    } catch {
        return { permission: "ask", matched: false };
    }

    return getSingleCommandPermission(args, permissions, defaultPermission);
}
