/**
 * Permission-gated command execution: the rung above `safe-bash`.
 *
 * Contributes no tool of its own, because `bash` already arrives through the implied `safe-bash`
 * capability. What it changes is how the gate behaves: heuristic-safe commands still run directly,
 * and everything else goes to the normal permission resolver, which may prompt the end user. Keeping
 * that in the ladder rather than in a tool list is what stops the two from disagreeing.
 */
export const COMMAND_RUNNER_UNIT = {
    id: "command-runner",
} as const;
