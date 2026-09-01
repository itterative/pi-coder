/**
 * Read-only Bash inspection, classified by the shared cwd-confinement heuristic.
 *
 * This unit contributes the `bash` tool; `command-runner` gets it too only because declaring
 * `command-runner` implies `safe-bash` in the declaration layer. The gate that decides *how much* of
 * the tool is usable without asking is selected by the rung, not here.
 */
export const SAFE_BASH_UNIT = {
    id: "safe-bash",
    tools: ["bash"],
} as const;
