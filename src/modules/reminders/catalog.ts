import type { ReminderDefinition } from "./types";

/**
 * The first line of every reminder block.
 *
 * A reminder is delivered as a hidden message in the user role, so one that arrives alone reads as the user
 * speaking. This line marks it as automated without changing the role.
 */
export const REMINDER_NOTICE = "Automated reminder (not from the user) - ignore if not relevant.";

/**
 * The reminder that follows a changed memory list: the first turn of a session. Kept out of the rotation
 * because it is tied to the appendix being rebuilt, not to a cadence. A tree navigation does not arm it -
 * the branch is already in flight and the rebuilt list is in the next prompt - and a compaction arms
 * `COMPACTION_REMINDER` instead, which covers this re-read together with what else the fold changed.
 */
export const MEMORY_READ_REMINDER: ReminderDefinition = {
    id: "memory-read",
    text: "Before starting work, consider whether any memories listed in the `<memory_system>` section of your system prompt are relevant to the user's request and read them if so.",
    guidance: "A fresh session just changed the memory list.",
};

/**
 * The reminder a compaction arms in place of `MEMORY_READ_REMINDER`. A fold is not just a changed memory
 * list: the TODO state lives in a file the summary does not carry and the summary is lossy in a way the
 * original transcript is not. Kept out of the rotation - it fires once, at the first turn after the fold.
 */
export const COMPACTION_REMINDER: ReminderDefinition = {
    id: "compaction",
    text: "The conversation was just compacted: the summary replaces the folded transcript and is lossy - check the session JSONL if you need pre-fold detail. The memory list and the runtime `TODO.md` from your prompt were not part of the fold: re-read the relevant memories and the TODO before continuing multi-step work.",
    guidance:
        "A compaction just folded the transcript; memory and TODO state live in files it did not fold.",
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
