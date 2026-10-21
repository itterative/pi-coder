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
            "Work was completed and its learnings are not saved yet; never for a turn that only read or searched.",
    },
    {
        id: "sandbox",
        text: "Bash runs under pi-coder's cwd-confinement gate. A block or prompt explains its reason and any user note - request a session rule or ask the user rather than working around it. Config: `.pi/bash-sandbox-config.json`.",
        guidance:
            "Bash is in use and the cwd-confinement gate, a block, or a user note is easy to overlook.",
        // Disabled for now: the text restates the always-present sandbox guidance and rotation cannot time
        // it to a real gated event. Re-enable once it is keyed on a block, prompt, or user note.
        disabled: true,
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

/**
 * The rotation the scheduler and the decision model actually use: the catalog minus entries marked
 * `disabled`. Filtering stays here so a disabled reminder is a one-line catalog change; an empty result is
 * handled by the scheduler as "emit nothing" rather than dividing by zero.
 */
export const ACTIVE_ROTATION_REMINDERS = ROTATION_REMINDERS.filter(
    (reminder: ReminderDefinition) => reminder.disabled !== true,
);
