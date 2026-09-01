import type { ChildGrant } from "../grant";

/**
 * The path sentences the child protocol uses.
 *
 * Three separate questions, because the four profiles name different sets:
 *
 * - `mutationPathScope` is what a worker may write to: the checkout, plus the scratchpad when the
 *   definition holds it. Additional read-only roots never appear here.
 * - `allowedReadPathScope` is what a read-only or command-capable child may open, and it is the only
 *   place the additional roots and the Bash full-output exception are named together.
 * - `pathRule` is the sensitive-path sentence, which softens only around the scratchpad.
 *
 * `allowedReadPathScope` replaces a chain that assigned to one mutable string three times, where the
 * full-output arms *overwrote* the accumulated text instead of appending. That asymmetry is visible in
 * the rendered prompt: with additional paths configured the phrase order is "cwd or scratchpad, or
 * configured additional paths, or an exact full-output file", while without them and with a scratchpad
 * the sentence restarts as "cwd, the temporary scratchpad, or an exact full-output file". The guards
 * below keep both spellings, so do not "simplify" them into one append chain.
 */

const CWD_ONLY = "the current working directory";
const FULL_OUTPUT = "an exact full-output file reported by Bash";

/** Where a mutation-capable child may write without an approval request. */
export function mutationPathScope(grant: ChildGrant): string {
    return grant.hasScratchpad ? `${CWD_ONLY} or the temporary scratchpad` : CWD_ONLY;
}

/** Every path a child may read, phrased as one list. */
export function allowedReadPathScope(grant: ChildGrant): string {
    const scope = mutationPathScope(grant);
    const hasAdditionalPaths = grant.readRoots.length > 0;

    if (!grant.bashOutputAccess) {
        return withAdditional(scope, hasAdditionalPaths);
    }
    if (hasAdditionalPaths) {
        return `${withAdditional(scope, true)}, or ${FULL_OUTPUT}`;
    }
    if (grant.hasScratchpad) {
        return `${CWD_ONLY}, the temporary scratchpad, or ${FULL_OUTPUT}`;
    }
    return `${CWD_ONLY} or ${FULL_OUTPUT}`;
}

function withAdditional(scope: string, hasAdditionalPaths: boolean): string {
    return hasAdditionalPaths ? `${scope}, or configured additional paths` : scope;
}

/** How sensitive paths and symlink escapes are described for this run. */
export function pathRule(grant: ChildGrant): string {
    if (grant.hasScratchpad) {
        return "Sensitive-path restrictions apply outside the temporary scratchpad; paths that escape through symlinks are always blocked.";
    }
    return "Sensitive paths and paths that escape through symlinks are always blocked.";
}
