import sandboxConfig, { SandboxConfigPermissions } from "../../common/config";
import { BashAst, parseBashAst } from "./bash";
import { unwrapWrapperCommand } from "./command-wrappers";
import type {
    BashAstNode,
    BashCommand,
    BashStatement,
    BashSubstitutionNode,
    BashWordNode,
} from "./bash";

type PermissionToken = {
    value: string;
    word?: BashWordNode;
    heredocOperator?: boolean;
};

type PermissionMatcher = PermissionMatcherSimple | PermissionMatcherSubshell;

type PermissionMatcherSimple = {
    type: "literal" | "wildcard" | "heredoc-op" | "heredoc-delim" | "chain-op";
    value: string;
    test: (value: PermissionToken) => boolean;
};

type PermissionMatcherSubshell = {
    type: "subshell";
    value: string;
    // note: only a quick test, submatchers should be handled properly
    test: (value: PermissionToken) => boolean;
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
function patternToRegex(pattern: string, allowWildcard = true): RegExp {
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

    if (allowWildcard) {
        escaped = escaped.replaceAll(MATCH_WILDCARD, ".*");
    }

    return new RegExp("^" + escaped + "$");
}

/**
 * Check if a value is a chain operator (&&, ||, ;, |)
 */
function isChainOperator(value: string): boolean {
    return (
        value === "&&" ||
        value === "||" ||
        value === ";" ||
        value === "|" ||
        value === "|&" ||
        value === "&"
    );
}

function commandTokens(command: BashCommand["node"]): PermissionToken[] {
    const tokens: PermissionToken[] = [];
    for (const commandPart of command.parts) {
        if (commandPart.type === "word") {
            tokens.push({ value: commandPart.value, word: commandPart });
            continue;
        }
        tokens.push({
            value: commandPart.operator,
            heredocOperator: commandPart.operator === "<<" || commandPart.operator === "<<-",
        });
        if (commandPart.target !== undefined) {
            tokens.push({
                value: commandPart.target.value,
                word: commandPart.target,
            });
        }
    }
    return tokens;
}

function statementTokens(statement: BashStatement["node"]): PermissionToken[] {
    const tokens: PermissionToken[] = [];
    for (const part of statement.parts) {
        if (part.type === "operator") {
            tokens.push({ value: part.value });
            continue;
        }
        tokens.push(...commandTokens(part));
    }
    return tokens;
}

function getNestedCommandTokens(argument: PermissionToken): PermissionToken[][] {
    const substitution =
        argument.word === undefined
            ? undefined
            : BashAst.substitutionFor(argument.word, argument.value);
    if (substitution !== undefined) {
        return substitution.ast.statements.map(statementTokens);
    }

    const parsed = parseBashAst(argument.value);
    const ast = parsed.singleCommand?.singleSubstitution?.ast ?? parsed.tree;
    return ast.statements.map(statementTokens);
}

const MAX_MATCH_DEPTH = 50;

type WildcardMatchResult =
    | { type: "advance-pattern"; lookahead: PermissionMatcher }
    | { type: "advance-command" }
    | { type: "return"; matched: boolean };

function hasIncompleteSubstitution(token: PermissionToken): boolean {
    return token.word?.substitutions.some((substitution) => !substitution.complete) ?? false;
}

function findWildcardLookahead(
    patternMatchers: readonly PermissionMatcher[],
    patternIndex: number,
): PermissionMatcher | undefined {
    return patternMatchers.slice(patternIndex + 1).find((pattern) => pattern.type !== "wildcard");
}

function matchRemainingWildcard(
    commandArgs: readonly PermissionToken[],
    commandIndex: number,
): WildcardMatchResult {
    const remainingArgs = commandArgs.slice(commandIndex);
    if (remainingArgs.some(hasIncompleteSubstitution)) {
        return { type: "return", matched: false };
    }
    if (remainingArgs.some((value) => isChainOperator(value.value))) {
        return { type: "return", matched: false };
    }
    return { type: "return", matched: true };
}

function matchWildcard(
    commandArgs: readonly PermissionToken[],
    patternMatchers: readonly PermissionMatcher[],
    patternIndex: number,
    commandIndex: number,
    lookahead: PermissionMatcher | null,
): WildcardMatchResult {
    const nextPattern = lookahead ?? findWildcardLookahead(patternMatchers, patternIndex);
    if (nextPattern === undefined) {
        return matchRemainingWildcard(commandArgs, commandIndex);
    }

    const argument = commandArgs[commandIndex];
    if (nextPattern.test(argument)) {
        return { type: "advance-pattern", lookahead: nextPattern };
    }
    if (isChainOperator(argument.value)) {
        return { type: "return", matched: false };
    }
    return { type: "advance-command" };
}

function matchNestedPattern(
    argument: PermissionToken,
    pattern: PermissionMatcherSubshell,
    depth: number,
): boolean {
    const nestedCommands = getNestedCommandTokens(argument);
    if (nestedCommands.length === 0 && pattern.subMatchers.length === 0) {
        return true;
    }
    return nestedCommands.every((nestedArgs) =>
        matchArgs(nestedArgs, pattern.subMatchers, depth + 1, false),
    );
}

function matchPattern(
    argument: PermissionToken,
    pattern: PermissionMatcher,
    depth: number,
): boolean {
    if (!pattern.test(argument)) {
        return false;
    }
    if (pattern.type !== "subshell") {
        return true;
    }
    return matchNestedPattern(argument, pattern, depth);
}

function matchTrailingHeredocArgument(
    commandArgs: readonly PermissionToken[],
    patternMatchers: readonly PermissionMatcher[],
    commandIndex: number,
    allowHeredocTrailingArg: boolean,
): boolean {
    if (commandIndex >= commandArgs.length) {
        return true;
    }

    const hasHeredocOperator = patternMatchers.some((pattern) => pattern.type === "heredoc-op");
    if (!allowHeredocTrailingArg || !hasHeredocOperator) {
        return false;
    }
    if (commandIndex !== commandArgs.length - 1) {
        return false;
    }
    return !hasIncompleteSubstitution(commandArgs[commandIndex]);
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
    commandArgs: readonly PermissionToken[],
    patternMatchers: readonly PermissionMatcher[],
    depth: number = 0,
    allowHeredocTrailingArg = true,
): boolean {
    const maxIterations = (commandArgs.length + patternMatchers.length) * 2;
    let iterations = 0;

    if (depth > MAX_MATCH_DEPTH) {
        throw new Error(`matchArgs: exceeded maximum depth (${MAX_MATCH_DEPTH})`);
    }

    // Empty pattern matches empty command
    if (patternMatchers.length === 0) {
        return commandArgs.length === 0;
    }

    let commandIndex = 0;
    let patternIndex = 0;
    let lookahead: PermissionMatcher | null = null;

    while (patternIndex < patternMatchers.length) {
        if (++iterations > maxIterations) {
            throw new Error(
                `matchArgs: exceeded maximum iterations (${maxIterations}), possible infinite loop`,
            );
        }
        if (commandIndex >= commandArgs.length) {
            return false;
        }

        const argument = commandArgs[commandIndex];
        if (hasIncompleteSubstitution(argument)) {
            return false;
        }

        const pattern = patternMatchers[patternIndex];
        if (pattern.type === "wildcard") {
            const result = matchWildcard(
                commandArgs,
                patternMatchers,
                patternIndex,
                commandIndex,
                lookahead,
            );
            if (result.type === "return") {
                return result.matched;
            }
            if (result.type === "advance-pattern") {
                lookahead = result.lookahead;
                patternIndex++;
                continue;
            }
            commandIndex++;
            continue;
        }

        lookahead = null;
        if (!matchPattern(argument, pattern, depth)) {
            return false;
        }
        patternIndex++;
        commandIndex++;
    }

    return matchTrailingHeredocArgument(
        commandArgs,
        patternMatchers,
        commandIndex,
        allowHeredocTrailingArg,
    );
}

/**
 * Create matchers for a list of arguments, handling subshells recursively.
 */
function createMatchers(tokens: readonly PermissionToken[]): PermissionMatcher[] {
    return tokens.map((token, idx) => {
        const arg = token.value;
        const substitution =
            token.word === undefined ? undefined : BashAst.substitutionFor(token.word, arg);
        if (arg === MATCH_WILDCARD) {
            return {
                type: "wildcard" as const,
                value: arg,
                test: () => true,
            };
        }

        const parsedValue = token.word === undefined ? parseBashAst(arg) : undefined;
        const valueSubstitution = parsedValue?.singleCommand?.singleSubstitution;
        const heredocOperator =
            token.heredocOperator ||
            parsedValue?.singleCommand?.singleRedirection?.operator === "<<" ||
            parsedValue?.singleCommand?.singleRedirection?.operator === "<<-";
        if (heredocOperator) {
            const regex = patternToRegex(arg);
            return {
                type: "heredoc-op" as const,
                value: arg,
                test: (value: PermissionToken) => regex.test(value.value),
            };
        }

        if (idx > 0 && tokens[idx - 1].heredocOperator) {
            return {
                type: "heredoc-delim" as const,
                value: arg,
                test: () => true,
            };
        }

        const commandSubstitution =
            substitution?.kind === "command" ||
            substitution?.kind === "backtick" ||
            valueSubstitution?.kind === "command" ||
            valueSubstitution?.kind === "backtick";
        const processSubstitution =
            substitution?.kind === "process-input" ||
            substitution?.kind === "process-output" ||
            valueSubstitution?.kind === "process-input" ||
            valueSubstitution?.kind === "process-output";
        if (commandSubstitution || processSubstitution) {
            // Subshell/process-substitution content creates nested matchers.
            const nestedAst = substitution?.ast ?? valueSubstitution?.ast ?? parseBashAst(arg).tree;
            if (nestedAst.statements.length === 0) {
                return {
                    type: "subshell" as const,
                    value: arg,
                    test: (value: PermissionToken) => isMatchingSubstitution(value, substitution),
                    subMatchers: [],
                };
            }
            if (nestedAst.statements.length !== 1) {
                throw new Error(
                    `expected a single subshell bash command, found ${nestedAst.statements.length}`,
                );
            }

            const subMatchers = createMatchers(statementTokens(nestedAst.statements[0]));
            return {
                type: "subshell" as const,
                value: arg,
                test: (value: PermissionToken) => isMatchingSubstitution(value, substitution),
                subMatchers,
            };
        }

        const regex = patternToRegex(arg);
        const patternHasSubstitution =
            token.word !== undefined && token.word.substitutions.length > 0;
        return {
            type: "literal" as const,
            value: arg,
            test: (value: PermissionToken) => {
                const inputHasSubstitution =
                    value.word !== undefined && value.word.substitutions.length > 0;
                if (patternHasSubstitution !== inputHasSubstitution) {
                    return false;
                }
                return regex.test(value.value);
            },
        };
    });
}

function isMatchingSubstitution(
    token: PermissionToken,
    patternSubstitution?: BashSubstitutionNode,
): boolean {
    const value = token.value;
    const inputSubstitution =
        token.word === undefined
            ? parseBashAst(value).singleCommand?.singleSubstitution
            : BashAst.substitutionFor(token.word, value);
    if (patternSubstitution !== undefined && inputSubstitution !== undefined) {
        if (!patternSubstitution.complete || !inputSubstitution.complete) {
            return false;
        }
        return inputSubstitution.kind === patternSubstitution.kind;
    }

    const commandSubstitution =
        inputSubstitution?.kind === "command" || inputSubstitution?.kind === "backtick";
    const processSubstitution =
        inputSubstitution?.kind === "process-input" || inputSubstitution?.kind === "process-output";
    if (!commandSubstitution && !processSubstitution) {
        return false;
    }

    let prefix: string;
    if (patternSubstitution?.kind === "process-output") {
        prefix = ">(";
    } else if (patternSubstitution?.kind === "process-input") {
        prefix = "<(";
    } else if (patternSubstitution?.kind === "backtick") {
        prefix = "`";
    } else if (patternSubstitution?.kind === "command") {
        prefix = "$(";
    } else if (value.startsWith(">(")) {
        prefix = ">(";
    } else if (value.startsWith("<(")) {
        prefix = "<(";
    } else if (value.startsWith("`")) {
        prefix = "`";
    } else {
        prefix = "$(";
    }
    return value.startsWith(prefix);
}

function getPermissions(configPermissions?: SandboxConfigPermissions): PermissionMatch[] {
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
                    const emptyMatcher = {
                        type: "literal" as const,
                        value: "",
                        test: (value: PermissionToken) => value.value === "",
                    };
                    _permissions.push({
                        wildcard: permission[0],
                        value: permission[1] as Permission,
                        matchers: [emptyMatcher],
                    });
                    continue;
                }

                const parsed = parseBashAst(permission[0]);
                if (parsed.statements.length !== 1) {
                    throw new Error(
                        `expected the rules to contain only one bash syntax, found ${parsed.statements.length}`,
                    );
                }

                const statement = parsed.statements[0];
                const matchers = createMatchers(statementTokens(statement.node));

                _permissions.push({
                    wildcard: permission[0],
                    value: permission[1] as Permission,
                    matchers,
                });
            } catch (e) {
                throw new Error(
                    `could not create permission matcher for pattern (${permission[0]}): ${e}`,
                );
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
    if (permissions.length === 0) {
        return { permission: fallback, matched: false };
    }

    const tokens = commands.map((value) => ({
        value,
        word: parseBashAst(value).singleCommand?.singleWord,
    }));
    let match: Permission = fallback;
    let matched = false;

    // note: this will match the last one (similar to opencode)
    //       could also try a specificity approach
    for (const permission of permissions) {
        try {
            if (!matchArgs(tokens, permission.matchers)) {
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

function getSingleAstCommandPermission(
    statement: BashStatement,
    permissions: PermissionMatch[],
    fallback: Permission = "ask",
): { permission: Permission; matched: boolean } {
    if (permissions.length === 0) {
        return { permission: fallback, matched: false };
    }

    const tokens = statementTokens(statement.node);
    let match: Permission = fallback;
    let matched = false;

    for (const permission of permissions) {
        try {
            if (!matchArgs(tokens, permission.matchers, 0, false)) {
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

    const parsed = parseBashAst(command);

    if (parsed.statements.length === 0) {
        return { permission: defaultPermission, matched: false };
    }

    // Return the most restrictive permission across all commands
    return parsed.statements.reduce<{ permission: Permission; matched: boolean }>(
        (result, statement) => {
            const { permission, matched } = getSingleAstCommandPermission(
                statement,
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

export function getBashStatementPermissionMatch(
    statement: BashStatement,
    configPermissions?: SandboxConfigPermissions,
): { permission: Permission; matched: boolean } {
    let parsedPermissions: PermissionMatch[];
    try {
        parsedPermissions = getPermissions(configPermissions);
    } catch {
        return { permission: "ask", matched: false };
    }
    return getSingleAstCommandPermission(statement, parsedPermissions, defaultPermission);
}

export function getBashCommandPermissionMatch(
    command: BashCommand,
    configPermissions?: SandboxConfigPermissions,
): { permission: Permission; matched: boolean } {
    let parsedPermissions: PermissionMatch[];
    try {
        parsedPermissions = getPermissions(configPermissions);
    } catch {
        return { permission: "ask", matched: false };
    }

    if (parsedPermissions.length === 0) {
        return { permission: defaultPermission, matched: false };
    }

    const tokens = commandTokens(command.node);
    // Take the alternative view from the same command-node transform the classifier uses, so nesting,
    // word order, and redirections cannot drift between what is judged safe and what is matched.
    const wrappedCommand = unwrapWrapperCommand(command);
    const wrappedTokens = wrappedCommand ? commandTokens(wrappedCommand.node) : undefined;
    let match: Permission = defaultPermission;
    let matched = false;
    for (const permission of parsedPermissions) {
        try {
            // Consider the literal segment and, when a transparent wrapper prefixes it, the command
            // being wrapped. Both views are evaluated inside this one pass so pattern order and
            // last-match-wins semantics are unchanged; a rule remembered for `npm run test:run`
            // therefore also covers `timeout 600 npm run test:run`, while an explicit rule naming the
            // wrapper keeps matching the literal line.
            const covered =
                matchArgs(tokens, permission.matchers, 0, false) ||
                (wrappedTokens !== undefined &&
                    matchArgs(wrappedTokens, permission.matchers, 0, false));
            if (!covered) {
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
