/**
 * A deliberately small suffix stemmer for the doc-text channel.
 *
 * Prose inflects and identifiers do not. A comment says "spilling" while the query says "spill", and the doc tier —
 * an all-tokens-required match — then misses the comment entirely because both sides were compared literally. The
 * name and signature channels stay exact on purpose (`list` and `listing` are different identifiers); the doc
 * channel is the one place where recall is worth more than precision.
 *
 * The rules are plurals, `ing`/`ed`, `ly`, and a final silent `e`, with Porter's two corrections for the verb
 * suffixes: a doubled consonant collapses (`running` → `run`) except for `l`/`s`/`z` (so `spilling` stays `spill`,
 * not `spil`), and a consonant-vowel-consonant stem gets its silent `e` back (`tuning` → `tune`) so it lines up
 * with the uninflected form.
 *
 * Input is expected to come from `tokenize`: lowercase alphanumerics. Anything else passes through untouched, so
 * `x86_64`, `2d`, and `httpserver` cannot be mangled by a suffix rule. The rules are applied in one order and the
 * silent-`e` step runs unconditionally at the end, which is what keeps `cache`/`cached`/`caching` on the same stem.
 */
export function stem(token: string): string {
    if (token.length < 4 || !/^[a-z]+$/.test(token)) {
        return token;
    }

    return dropSilentE(stripVerbSuffix(pluralStem(token)));
}

/** `ies`, `sses`/`xes`/`ches`/`shes`, and a plain plural `s`. `class` and `analysis` keep their `s`. */
function pluralStem(token: string): string {
    if (token.endsWith("ies") && token.length > 4) {
        return `${token.slice(0, -3)}y`;
    }

    for (const ending of ["sses", "xes", "zes", "ches", "shes"]) {
        if (token.endsWith(ending)) {
            return token.slice(0, -2);
        }
    }

    if (
        token.endsWith("s") &&
        !token.endsWith("ss") &&
        !token.endsWith("us") &&
        !token.endsWith("is")
    ) {
        return token.slice(0, -1);
    }

    return token;
}

/** `ing`, `ed`, and `ly`. */
function stripVerbSuffix(token: string): string {
    for (const ending of ["ing", "ed"]) {
        if (!token.endsWith(ending)) {
            continue;
        }

        return stripVerbEnding(token, ending);
    }

    return token.endsWith("ly") && token.length >= 6 ? token.slice(0, -2) : token;
}

function stripVerbEnding(token: string, ending: string): string {
    const rest = token.slice(0, -ending.length);

    if (rest.length < 3) {
        return token;
    }

    const collapsed = collapseDoubled(rest);

    if (collapsed !== rest) {
        return collapsed;
    }

    return endsInConsonantVowelConsonant(rest) ? `${rest}e` : rest;
}

function collapseDoubled(token: string): string {
    const last = token.at(-1);

    if (last === undefined || last !== token.at(-2) || "lsz".includes(last)) {
        return token;
    }

    return /[bdgmnprt]/.test(last) ? token.slice(0, -1) : token;
}

function endsInConsonantVowelConsonant(token: string): boolean {
    const first = token.at(-3);
    const second = token.at(-2);
    const third = token.at(-1);

    if (first === undefined || second === undefined || third === undefined) {
        return false;
    }

    const vowel = (character: string): boolean => "aeiou".includes(character);

    return vowel(second) && !vowel(first) && !vowel(third) && !"wxy".includes(third);
}

/** Porter's step 5a, approximated: `cache` → `cach` and `write` → `writ`, while `value` and `tune` keep theirs. */
function dropSilentE(token: string): string {
    if (token.length < 5 || !token.endsWith("e")) {
        return token;
    }

    const before = token.at(-2);

    return before === undefined || "aeiou".includes(before) ? token : token.slice(0, -1);
}
