import os from "node:os";

/**
 * The directory a shell expands `~` to for the current user.
 *
 * bash and zsh both expand `~` from `$HOME` and only fall back to the password database when it
 * is unset, which is also the value the bubblewrap wrapper exports into the sandbox. Classifiers
 * must use the same source: if the heuristic certifies `os.homedir()/x` while the shell opens
 * `$HOME/x`, the path that was checked is not the path that is used.
 *
 * Known limit: `sandbox.env.HOME` is applied on top of the inherited environment when the sandbox is
 * assembled (`buildEnvCmd` in `bubblewrap.ts`) and is not visible here, so a configuration that
 * reassigns HOME can still make the two disagree. Config is trusted, so that is a correctness caveat
 * rather than an escape: the tilde rule only grants what the absolute spelling of the same operand
 * already granted.
 */
export function resolveHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
    const home = env.HOME;

    // An empty or whitespace-only HOME counts as unset, as bash does. A value with surrounding
    // spaces is returned verbatim, because trimming it would certify a path the shell never opens.
    if (home === undefined || home.trim() === "") {
        return os.homedir();
    }

    return home;
}
