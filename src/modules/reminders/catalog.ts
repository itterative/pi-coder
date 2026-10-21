import type { ReminderDefinition } from "./types";

/**
 * The reminder that follows a changed memory list: the first turn of a session, a tree navigation, and the
 * first turn after a compaction. Kept out of the rotation because it is tied to the appendix being rebuilt,
 * not to a cadence.
 */
export const MEMORY_READ_REMINDER: ReminderDefinition = {
    id: "memory-read",
    text: "Before starting work, consider whether any memories listed in the `<memory_system>` section of your system prompt are relevant to the user's request and read them if so.",
    guidance: "A fresh session, branch, or compaction just changed the memory list.",
};

/**
 * The rotating catalog, in the order a deterministic schedule cycles it. A tuple so the non-empty invariant
 * the scheduler relies on is checked here rather than at each use.
 *
 * The `text` is what the agent reads; the `guidance` is what the decision model judges relevance by
 * (`reminders: true`), which is why both live together.
 */
export const ROTATION_REMINDERS = [
    {
        id: "memory-hygiene",
        text: "Before finishing, review what you learned and update or add project memories; run `/memory-audit` after editing memory files, and review `[high-churn]` memories touched by the change.",
        guidance:
            "Work was completed or is being wrapped up and the learnings may not be saved yet.",
    },
    {
        id: "sandbox",
        text: "Bash runs under pi-coder's cwd-confinement gate. A block or prompt explains its reason and any user note - request a session rule or ask the user rather than working around it. Config: `.pi/bash-sandbox-config.json`.",
        guidance:
            "Bash is in use and the cwd-confinement gate, a block, or a user note is easy to overlook.",
    },
    {
        id: "delegation",
        text: "For large independent work, delegate to `scout` (read-only) or `worker` (mutation) with a fully self-contained brief; don't duplicate a running child's work.",
        guidance:
            "Large independent work is being done inline that a scout or a worker could take.",
    },
    {
        id: "todo",
        text: "For multi-step work, keep the runtime `TODO.md` from your prompt current as steps complete.",
        guidance: "Multi-step work is underway and the runtime TODO.md may not reflect it.",
    },
    {
        id: "validation",
        // Extension-generic by design: the project's own instructions name the commands. Quoting one
        // repository's scripts here would fire wrong (or stale) guidance in every other project.
        text: "Before finishing, run the project's validation - tests, typecheck, lint, and format checks as its instructions specify - instead of assuming the change works.",
        guidance: "A change is about to be called finished without the project's validation pass.",
    },
] as const satisfies readonly [ReminderDefinition, ...ReminderDefinition[]];
