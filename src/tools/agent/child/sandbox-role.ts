import type { SandboxRole } from "../../../modules/sandbox/posture";
import { hasAgentAuthority, type AgentAuthority } from "../definitions/types";

/**
 * The sandbox role a child's authority implies.
 *
 * Only the rungs that cannot run a build are read-only. A `command` child is not a mutator — it has no
 * `edit` tool — but it does run test suites and linters, which write `coverage/`, `node_modules/.cache` and
 * the like into the workspace, so binding its checkout read-only would break the very thing it exists to do.
 * The rungs below it can only read, so the kernel can enforce that instead of a prompt.
 */
export function sandboxRoleFor(authority: AgentAuthority): SandboxRole {
    return hasAgentAuthority(authority, "command") ? "write" : "readonly";
}
