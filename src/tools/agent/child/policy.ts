import type { SandboxConfigCwdConfinement } from "../../../common/config";

/**
 * The confinement policy every child gate checks against.
 *
 * One object rather than three look-alike copies: the heuristic bash guard, the read-path guard, and
 * the command/mutation gate must not be able to disagree about whether symlinks resolve or whether
 * confinement is on at all. `permission: "allow"` means a confined result needs no prompt; the
 * *access* mode (`read` or `write`) is supplied per call site, which is the only axis these guards
 * legitimately differ on.
 */
export const CHILD_CONFINEMENT: SandboxConfigCwdConfinement = {
    enabled: true,
    permission: "allow",
    resolveSymlinks: true,
};
