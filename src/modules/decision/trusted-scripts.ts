import path from "node:path";

/**
 * Skills whose bundled scripts the classifier never reads.
 *
 * This is a trust declaration, not a detection: a script under `skills/<name>/` is folded as `read_only`
 * without a request, so adding a name says the skill's code is safe to run unread. The list is deliberately
 * static and small — a skill is added here on purpose, the same way a curated command earns a spec.
 *
 * Entries are skill directory names as pi discovers them, so one entry covers the checkout, an installed
 * package, and a user-level skill directory alike.
 */
export const TRUSTED_SKILLS: readonly string[] = ["session-review"];

const TRUSTED = new Set(TRUSTED_SKILLS);

/**
 * The trusted skill a script belongs to, or `undefined` when the path is not under one.
 *
 * Matching is on the `skills/<name>` segments, walking backwards to the nearest one, so a directory that
 * merely shares a skill's name is not trusted. A resolved absolute path is expected; a relative one is
 * resolved against the process cwd.
 */
export function trustedSkillForScript(scriptPath: string | undefined): string | undefined {
    if (scriptPath === undefined) {
        return undefined;
    }

    const segments = path.resolve(scriptPath).split(path.sep);

    for (let index = segments.length - 2; index >= 0; index -= 1) {
        const skill = segments[index + 1];
        if (segments[index] === "skills" && TRUSTED.has(skill)) {
            return skill;
        }
    }

    return undefined;
}
