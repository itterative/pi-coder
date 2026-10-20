import { parseBashAst } from "./bash";

/**
 * Suggested session rules for the permission prompt.
 *
 * When a command prompts because exactly one segment is covered by neither
 * a rule nor the heuristic, the dialog can offer to remember a
 * session-scoped rule for that segment. The segment→rule mapping is a
 * curated table, not a general algorithm: each row is an explicit decision
 * about which tokens identify the "command identity" worth remembering
 * (and how far the remembered rule should reach). A segment matching no
 * row gets no suggestion — the plain dialog applies.
 *
 * Suggested rules are deliberately narrow: remembering `npx vitest *` is
 * safe even where `npx *` would be too broad (npx can run any package),
 * and a too-narrow rule merely means the next variant prompts again.
 *
 * Whether a file-like argument may be covered by the wildcard depends on the
 * runner, not the spelling: `npx vitest test/a.test.ts` selects a test to run
 * and `npx prettier src/a.ts` formats a file, while `npx tsx script.ts` executes
 * the file's contents. The table therefore keyed the decision to the package
 * identity (`CODE_EXECUTOR_PACKAGES` vs `DATA_TOOL_PACKAGES`) instead of the
 * presence of a path, and an unrecognized package with a path keeps the path
 * exact. That last case is what {@link SuggestionOutcome.widened} exists for:
 * a decision-model consult may classify the arguments as data and choose the
 * wider rule, while the pattern itself is still built here.
 */

/** What one table row decided about a segment. */
export interface SuggestionOutcome {
    /** The rule the table offers on its own; null when the row declined. */
    pattern: string | null;
    /**
     * A wider rule the decision model may choose instead when it classifies the
     * segment's arguments as data. Present only when {@link pattern} pins a
     * path-like argument of an unrecognized package runner.
     */
    widened?: string;
}

export interface SuggestionRule {
    /** literal token prefix the failing segment must start with */
    match: string[];
    /**
     * Build the rule outcome from the segment tokens, or null when a token
     * is not safe to reuse (the row is skipped and the next matching row
     * is tried, so a specific row can fall through to a broader one).
     */
    suggest: (tokens: string[]) => SuggestionOutcome | null;
}

// A token can be reused in a generated pattern only when it is plain
// printable text with no whitespace, quotes, globs,
// shell operators, or command-substitution characters. Colons and @ are
// included for npm script names (test:unit) and scoped packages
// (@scope/pkg), which have no shell meaning inside a token.
const SAFE_TOKEN = /^[A-Za-z0-9._\-/:@]+$/;

// Row builders: scope on the token at idx (null when unsafe or missing),
// or a fixed pattern with no scoping.
const scopedPattern = (prefix: string, idx: number, tokens: string[]): string | null => {
    const name = tokens[idx];
    if (name === undefined || !SAFE_TOKEN.test(name)) return null;

    // Keep an exact rule for the command that prompted. Add a wildcard
    // only when the invocation already has arguments beyond the scoped
    // command identity; wildcard arguments are one-or-more, not optional.
    return `${prefix} ${name}${tokens.length > idx + 1 ? " *" : ""}`;
};

const scoped =
    (prefix: string, idx: number) =>
    (tokens: string[]): SuggestionOutcome | null => {
        const pattern = scopedPattern(prefix, idx, tokens);

        return pattern === null ? null : { pattern };
    };

const fixed =
    (pattern: string, baseTokens = 1) =>
    (tokens: string[]): SuggestionOutcome => {
        // As with scoped rules, don't append an argument wildcard when the
        // prompting invocation has no arguments beyond the command name. A
        // multi-token command name (`node --test`) counts as the base.
        return { pattern: tokens.length > baseTokens ? pattern : pattern.replace(/ \*$/, "") };
    };

/**
 * Do not offer a remembered rule for npx invocations that carry inline code.
 * Package and file arguments remain eligible, but `npx -c`, `npx --call`, and
 * evaluator flags such as `npx tsx -e` would turn a wildcard into a rule for
 * arbitrary script contents.
 *
 * TODO: Use a Bash lexer here when one is available so inline-code forms can
 * be identified from command structure rather than token spelling.
 */
const INLINE_SCRIPT_FLAG = /^(?:-[cep]|--(?:call|eval|print)(?:=|$))/;
const FILE_ARGUMENT = /(?:^|\/)[^/]+\.(?:[cm]?[jt]sx?|json)$/i;

/**
 * Whether a token names a path rather than a value.
 *
 * The extension form is the original check; a slash also covers extension-less
 * operands (`src/index`) and directory arguments. Leading `-` excludes flags
 * and their `--flag=value` spellings.
 */
const looksLikePath = (token: string): boolean =>
    !token.startsWith("-") && (FILE_ARGUMENT.test(token) || token.includes("/"));

/**
 * Packages whose file argument is the program that runs.
 *
 * For these, a path-like argument is pinned exactly: `npx tsx script.ts` must
 * not become `npx tsx *`, which would let the remembered rule run any local
 * script. The names mirror the interpreters in `modules/decision/script.ts`
 * plus the watchers that wrap them; the list is duplicated rather than imported
 * because the sandbox module must not depend on the decision module.
 */
const CODE_EXECUTOR_PACKAGES = new Set([
    "bash",
    "deno",
    "jiti",
    "node",
    "nodemon",
    "perl",
    "php",
    "python",
    "python3",
    "ruby",
    "sh",
    "ts-node",
    "ts-node-dev",
    "tsx",
    "zsh",
]);

/**
 * Packages whose positional paths are data: test files to select or run,
 * sources to format, lint, or compile.
 *
 * A file-like argument after these is covered by the wildcard instead of
 * pinning the rule to that path. The names repeat bare rows below on purpose:
 * a row names an identity that is safe to remember bare, this set says the
 * identity's paths are data, and a package can need the one without the other.
 */
const DATA_TOOL_PACKAGES = new Set([
    "ava",
    "biome",
    "cypress",
    "esbuild",
    "eslint",
    "jest",
    "mocha",
    "next",
    "oxlint",
    "playwright",
    "prettier",
    "rollup",
    "stylelint",
    "swc",
    "tsc",
    "typedoc",
    "vite",
    "vitest",
    "webpack",
]);

/**
 * The exact rule for a code executor: everything through the first path-like
 * argument, wildcarding only later arguments. A second path-like argument keeps
 * the whole invocation exact, because the wildcard could otherwise cover a
 * second code path (`tsx --tsconfig tsconfig.json script.ts`).
 */
const exactCodeInvocation = (tokens: string[], packageIndex: number): string => {
    const operand = tokens.findIndex(
        (token, index) => index > packageIndex && looksLikePath(token),
    );
    if (operand === -1) {
        return tokens.join(" ");
    }

    const laterPath = tokens.slice(operand + 1).some((token) => looksLikePath(token));
    if (laterPath || operand + 1 === tokens.length) {
        return tokens.join(" ");
    }

    return `${tokens.slice(0, operand + 1).join(" ")} *`;
};

const suggestPackageRunner = (
    prefix: string,
    packageIndex: number,
    tokens: string[],
): SuggestionOutcome | null => {
    for (const token of tokens.slice(packageIndex)) {
        if (INLINE_SCRIPT_FLAG.test(token)) {
            return null;
        }
    }

    const packageName = tokens[packageIndex];
    if (packageName !== undefined && CODE_EXECUTOR_PACKAGES.has(packageName)) {
        return { pattern: exactCodeInvocation(tokens, packageIndex) };
    }

    // An unrecognized package with a path-like argument keeps the path exact:
    // the table cannot know whether the package executes it (`jiti script.ts`)
    // or only reads it (`vitest test/a.test.ts`), so it errs toward the narrow
    // rule. The decision model may widen it when it classifies the arguments
    // as data, which is what `widened` offers.
    const pathArgument =
        packageName !== undefined &&
        !DATA_TOOL_PACKAGES.has(packageName) &&
        tokens.some((token, index) => index > packageIndex && looksLikePath(token));
    if (pathArgument) {
        const widened = scopedPattern(prefix, packageIndex, tokens);

        return {
            pattern: tokens.join(" "),
            ...(widened === null ? {} : { widened }),
        };
    }

    return scoped(prefix, packageIndex)(tokens);
};

const suggestNpx = (tokens: string[]): SuggestionOutcome | null =>
    suggestPackageRunner("npx", 1, tokens);
const suggestBunx = (tokens: string[]): SuggestionOutcome | null =>
    suggestPackageRunner("bunx", 1, tokens);
const suggestPnpmDlx = (tokens: string[]): SuggestionOutcome | null =>
    suggestPackageRunner("pnpm dlx", 2, tokens);
const suggestYarnDlx = (tokens: string[]): SuggestionOutcome | null =>
    suggestPackageRunner("yarn dlx", 2, tokens);

const suggestPnpm = (tokens: string[]): SuggestionOutcome | null => {
    if (tokens[1] === "dlx") {
        return null;
    }

    return scoped("pnpm", 1)(tokens);
};

const suggestYarn = (tokens: string[]): SuggestionOutcome | null => {
    if (tokens[1] === "dlx") {
        return null;
    }

    return scoped("yarn", 1)(tokens);
};

// Most-specific prefixes first: a row whose scoped token is unsafe falls
// through to the broader row for the same runner (e.g. docker compose →
// docker).
const SUGGESTIONS: SuggestionRule[] = [
    { match: ["docker", "compose"], suggest: scoped("docker compose", 2) },
    { match: ["docker"], suggest: scoped("docker", 1) },
    { match: ["npm", "run"], suggest: scoped("npm run", 2) },
    { match: ["poetry", "run"], suggest: scoped("poetry run", 2) },
    { match: ["uv", "run"], suggest: scoped("uv run", 2) },
    { match: ["npx"], suggest: suggestNpx },
    { match: ["yarn", "dlx"], suggest: suggestYarnDlx },
    { match: ["yarn"], suggest: suggestYarn },
    { match: ["pnpm", "dlx"], suggest: suggestPnpmDlx },
    { match: ["pnpm"], suggest: suggestPnpm },
    { match: ["bunx"], suggest: suggestBunx },
    { match: ["bun"], suggest: scoped("bun", 1) },
    { match: ["uvx"], suggest: scoped("uvx", 1) },
    { match: ["cargo"], suggest: scoped("cargo", 1) },
    { match: ["go", "test"], suggest: scoped("go", 1) },
    { match: ["go", "vet"], suggest: scoped("go", 1) },
    { match: ["go", "fmt"], suggest: scoped("go", 1) },
    { match: ["go", "generate"], suggest: scoped("go", 1) },
    { match: ["dotnet", "test"], suggest: scoped("dotnet", 1) },
    { match: ["mvn", "test"], suggest: scoped("mvn", 1) },
    { match: ["gradle", "test"], suggest: scoped("gradle", 1) },
    { match: ["bazel", "test"], suggest: scoped("bazel", 1) },
    { match: ["flutter", "test"], suggest: scoped("flutter", 1) },
    { match: ["dart", "test"], suggest: scoped("dart", 1) },
    { match: ["swift", "test"], suggest: scoped("swift", 1) },
    { match: ["mix", "test"], suggest: scoped("mix", 1) },
    { match: ["deno", "test"], suggest: scoped("deno", 1) },
    { match: ["deno", "fmt"], suggest: scoped("deno", 1) },
    { match: ["deno", "lint"], suggest: scoped("deno", 1) },
    { match: ["cmake", "--build"], suggest: scoped("cmake", 1) },
    { match: ["npm", "test"], suggest: scoped("npm", 1) },
    { match: ["node", "--test"], suggest: fixed("node --test *", 2) },
    { match: ["vitest"], suggest: fixed("vitest *") },
    { match: ["jest"], suggest: fixed("jest *") },
    { match: ["mocha"], suggest: fixed("mocha *") },
    { match: ["ava"], suggest: fixed("ava *") },
    { match: ["playwright"], suggest: fixed("playwright *") },
    { match: ["cypress"], suggest: fixed("cypress *") },
    { match: ["make"], suggest: fixed("make *") }, // targets vary; no scoping
    { match: ["just"], suggest: fixed("just *") },
    { match: ["task"], suggest: fixed("task *") },
    { match: ["ninja"], suggest: fixed("ninja *") },
    { match: ["eslint"], suggest: fixed("eslint *") },
    { match: ["prettier"], suggest: fixed("prettier *") },
    { match: ["biome"], suggest: fixed("biome *") },
    { match: ["tsc"], suggest: fixed("tsc *") },
    { match: ["stylelint"], suggest: fixed("stylelint *") },
    { match: ["tox"], suggest: fixed("tox *") },
    { match: ["ruff"], suggest: fixed("ruff *") },
    { match: ["pytest"], suggest: fixed("pytest *") },
];

/**
 * Whether a generated pattern is one line of safe tokens.
 *
 * Defense in depth: a malformed pattern in the permissions set would make
 * getPermissions throw and disable ALL rule matching — including the user's own
 * config rules.
 */
function isSafePattern(pattern: string): boolean {
    try {
        const parsed = parseBashAst(pattern);
        if (parsed.statements.length !== 1) {
            return false;
        }
        const statement = parsed.statements[0];
        if (statement.parts.length !== 1 || statement.commands.length !== 1) {
            return false;
        }
        const [command] = statement.commands;
        if (command.redirections.length > 0) {
            return false;
        }
        if (command.words.some((word) => word.value !== "*" && !SAFE_TOKEN.test(word.value))) {
            return false;
        }
    } catch {
        return false;
    }

    return true;
}

/**
 * Suggest a rule pattern for a failing (tokenized) segment, or null when
 * no table row applies. The result is always a pattern that parses as a
 * single line of safe tokens.
 */
export function suggestRule(tokens: string[]): string | null {
    return suggestRuleOutcome(tokens).pattern;
}

/**
 * The suggested rule plus the wider alternative a decision model may choose.
 *
 * {@link SuggestionOutcome.widened} is populated only where the table pinned a
 * path-like argument because the package runner was unrecognized; a model that
 * classifies the invocation's arguments as data may switch to it. Both patterns
 * are parsed here, so a caller never has to re-check what the model picks.
 */
export function suggestRuleOutcome(tokens: string[]): SuggestionOutcome {
    if (tokens.length === 0) return { pattern: null };

    for (const rule of SUGGESTIONS) {
        if (rule.match.length > tokens.length) continue;
        let prefixOk = true;
        for (let i = 0; i < rule.match.length; i++) {
            if (tokens[i] !== rule.match[i]) {
                prefixOk = false;
                break;
            }
        }
        if (!prefixOk) continue;

        const outcome = rule.suggest(tokens);
        if (outcome === null || outcome.pattern === null || !isSafePattern(outcome.pattern)) {
            continue;
        }

        const widened =
            outcome.widened !== undefined && isSafePattern(outcome.widened)
                ? outcome.widened
                : undefined;

        return {
            pattern: outcome.pattern,
            ...(widened === undefined ? {} : { widened }),
        };
    }

    return { pattern: null };
}
