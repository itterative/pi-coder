import { parseBash } from "./bash";

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
 */

export interface SuggestionRule {
    /** literal token prefix the failing segment must start with */
    match: string[];
    /**
     * Build the rule pattern from the segment tokens, or null when a token
     * is not safe to reuse (the row is skipped and the next matching row
     * is tried, so a specific row can fall through to a broader one).
     */
    suggest: (tokens: string[]) => string | null;
}

// A token can be reused in a pattern only if it round-trips through
// parseBash unharmed: plain printable text, no whitespace, quotes, globs,
// shell operators, or command-substitution characters. Colons and @ are
// included for npm script names (test:unit) and scoped packages
// (@scope/pkg), which have no shell meaning inside a token.
const SAFE_TOKEN = /^[A-Za-z0-9._\-/:@]+$/;

// Row builders: scope on the token at idx (null when unsafe or missing),
// or a fixed pattern with no scoping.
const scoped =
    (prefix: string, idx: number) =>
    (tokens: string[]): string | null => {
        const name = tokens[idx];
        return name !== undefined && SAFE_TOKEN.test(name) ? `${prefix} ${name} *` : null;
    };

const fixed =
    (pattern: string) =>
    (): string =>
        pattern;

// Most-specific prefixes first: a row whose scoped token is unsafe falls
// through to the broader row for the same runner (e.g. docker compose →
// docker).
const SUGGESTIONS: SuggestionRule[] = [
    { match: ["docker", "compose"], suggest: scoped("docker compose", 2) },
    { match: ["docker"], suggest: scoped("docker", 1) },
    { match: ["npm", "run"], suggest: scoped("npm run", 2) },
    { match: ["poetry", "run"], suggest: scoped("poetry run", 2) },
    { match: ["uv", "run"], suggest: scoped("uv run", 2) },
    { match: ["npx"], suggest: scoped("npx", 1) },
    { match: ["yarn"], suggest: scoped("yarn", 1) },
    { match: ["pnpm"], suggest: scoped("pnpm", 1) },
    { match: ["bun"], suggest: scoped("bun", 1) },
    { match: ["uvx"], suggest: scoped("uvx", 1) },
    { match: ["cargo"], suggest: scoped("cargo", 1) },
    { match: ["make"], suggest: fixed("make *") }, // targets vary; no scoping
    { match: ["tox"], suggest: fixed("tox *") },
    { match: ["ruff"], suggest: fixed("ruff *") },
    { match: ["pytest"], suggest: fixed("pytest *") },
];

/**
 * Suggest a rule pattern for a failing (tokenized) segment, or null when
 * no table row applies. The result is always a pattern that parses as a
 * single line of safe tokens.
 */
export function suggestRule(tokens: string[]): string | null {
    if (tokens.length === 0) return null;

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

        const pattern = rule.suggest(tokens);
        if (pattern === null) continue;

        // Defense in depth: the pattern must parse as one line of safe
        // tokens. A malformed pattern in the permissions set would make
        // getPermissions throw and disable ALL rule matching — including
        // the user's own config rules.
        try {
            const parsed = parseBash(pattern);
            if (parsed.length !== 1) continue;
            if (parsed[0].some((t) => t !== "*" && !SAFE_TOKEN.test(t))) continue;
        } catch {
            continue;
        }

        return pattern;
    }
    return null;
}
