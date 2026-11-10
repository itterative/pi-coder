/** Case- and separator-insensitive form used for approximate name matching. */
export function normalizeName(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Split an identifier at camel-case and separator boundaries. */
export function nameTokens(name: string): string[] {
    const spaced = name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

    return spaced.split(/[^A-Za-z0-9]+/).filter((token) => token.length > 0);
}

/**
 * The edit-distance budget for one query.
 *
 * Two edits recover a typo in a long identifier; shorter queries would only collect unrelated names, so they
 * are not fuzzed at all.
 */
export function fuzzyLimit(query: string): number | undefined {
    const length = normalizeName(query).length;

    if (length < 3) {
        return undefined;
    }

    return length <= 5 ? 1 : 2;
}

/** The smallest distance from the query to the full name or one of its tokens, within the budget. */
export function fuzzyNameDistance(
    query: string,
    name: string,
    maxDistance: number,
): number | undefined {
    const target = normalizeName(query);

    if (target.length === 0) {
        return undefined;
    }

    const candidates = [normalizeName(name), ...nameTokens(name).map(normalizeName)];
    let best = maxDistance + 1;

    for (const candidate of candidates) {
        if (candidate.length === 0 || Math.abs(candidate.length - target.length) > maxDistance) {
            continue;
        }

        const distance = boundedDamerauLevenshtein(target, candidate, maxDistance);

        if (distance < best) {
            best = distance;
        }

        if (best === 0) {
            return 0;
        }
    }

    return best <= maxDistance ? best : undefined;
}

/**
 * Damerau-Levenshtein with adjacent transpositions, bounded by `max`.
 *
 * The matrix only runs over one identifier, and the length check in `fuzzyNameDistance` skips most candidates
 * before this point.
 */
export function boundedDamerauLevenshtein(left: string, right: string, max: number): number {
    if (left === right) {
        return 0;
    }

    if (Math.abs(left.length - right.length) > max) {
        return max + 1;
    }

    if (left.length === 0 || right.length === 0) {
        const distance = Math.max(left.length, right.length);

        return distance <= max ? distance : max + 1;
    }

    let beforePrevious = new Array<number>(right.length + 1).fill(0);
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let row = 1; row <= left.length; row += 1) {
        const current = new Array<number>(right.length + 1).fill(0);

        current[0] = row;

        for (let column = 1; column <= right.length; column += 1) {
            const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
            let distance = Math.min(
                (previous[column] ?? 0) + 1,
                (current[column - 1] ?? 0) + 1,
                (previous[column - 1] ?? 0) + substitution,
            );

            if (
                row > 1 &&
                column > 1 &&
                left[row - 1] === right[column - 2] &&
                left[row - 2] === right[column - 1]
            ) {
                distance = Math.min(distance, (beforePrevious[column - 2] ?? 0) + 1);
            }

            current[column] = distance;
        }

        beforePrevious = previous;
        previous = current;
    }

    const distance = previous[right.length] ?? max + 1;

    return distance <= max ? distance : max + 1;
}
