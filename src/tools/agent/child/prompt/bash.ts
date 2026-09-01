/**
 * Protocol paragraphs contributed by Bash access.
 *
 * These two are the only sentences that appeared in all four run-mode profiles, which is what made
 * them worth owning here rather than repeating per profile: a wording change to either one is a
 * single edit, and the profiles keep control of where the sentence lands.
 */

/**
 * The narrow read exception for truncated Bash output.
 *
 * Deliberately not phrased as `/tmp` access: the runtime only publishes exact files it created for
 * this child's own result, and the bash-output gate (`child/gates/bash-output.ts`) validates them
 * against the temp directory on every read.
 */
export function fullOutputReadNote(): string {
    return "When Bash provides a full-output path for truncated output, use `read` with that path. This exception applies only to exact runtime-created files reported by this child; it does not grant general `/tmp` access.";
}

/**
 * Note for the exact command patterns a definition adds to the read-only heuristic.
 *
 * Returns undefined when the definition adds none, so a profile can omit the paragraph entirely
 * rather than tell the child about an empty list.
 */
export function customSafeBashNote(commands: readonly string[]): string | undefined {
    if (commands.length === 0) {
        return undefined;
    }
    const listed = commands.map((command) => JSON.stringify(command)).join(", ");
    return `The definition also permits these exact safe-Bash command patterns: ${listed}. These executables are trusted as read-only by the definition author. A trailing \`*\` matches one or more trailing arguments; matched commands still undergo path-confinement and sensitive-path checks.`;
}
