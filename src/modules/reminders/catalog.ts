import type { ReminderDefinition, RotationReminderDefinition } from "./types";

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
 * original transcript is not. The text leads with the room the fold reclaimed and not with its loss: models
 * that read a fold as "nearly out of context" start wrapping up or re-planning. Kept out of the rotation - it
 * fires once, at the first turn after the fold.
 */
export const COMPACTION_REMINDER: ReminderDefinition = {
    id: "compaction",
    text: "The transcript was compacted to reclaim context: room is available again, so continue the same task rather than wrapping up, handing off, or starting over. The summary is condensed - treat it as the account of what happened, and read the session JSONL only if a specific pre-fold detail is missing or contradicted. Memory files and the runtime `TODO.md` live outside the transcript and were not folded: re-read them before continuing multi-step work.",
    guidance:
        "A compaction just folded the transcript; memory and TODO state live in files it did not fold.",
};

/**
 * The always-loaded memories' bodies, supplied at emission by the memory module.
 *
 * Kept out of the rotation and away from the decision model: this is context the agent must have, not a nudge
 * worth weighing against relevance. It rides the same two change points as the memory reminders - the session
 * start and the fold - because those are when the memory module rebuilds what it holds.
 */
export const PINNED_MEMORIES_REMINDER: ReminderDefinition = {
    id: "pinned",
    text: "The pinned memories below are reproduced in full because they must not be missed; do not re-read them unless you need detail they do not carry.",
    guidance: "Always-loaded memories are in context; their rules apply for the whole session.",
};

/**
 * The instruction a memory-audit finding rides on. Kept out of the rotation because it is tied to an event -
 * a memory edit the audit found something in - not to a cadence, and its facts (which finding, in which tree)
 * are supplied at emission. The audit runs unasked, so this is the only place the agent hears about a memory
 * that no longer parses.
 */
export const MEMORY_AUDIT_REMINDER: ReminderDefinition = {
    id: "memory-audit",
    text: "The automatic memory audit ran after this run's memory edits and found problems in the memory trees. Fix the errors - a memory whose frontmatter does not parse is dropped from every later system prompt, so the lists in the prompt are now incomplete - and fix or deliberately leave each warning, saying why for a deliberate one.",
    guidance: "A memory edit in this run left the trees with indexing or reference problems.",
};

/**
 * The first measured reading past half the context window.
 *
 * The text is the anti-economizing half of the reminder: a model that believes it is near a limit starts skipping
 * reads and shortening work that has room. The measured line is put in front of it at emission
 * (`context-usage.ts`), so the catalog entry carries only the advice. Kept out of the rotation because a
 * percentage is a real boundary and a cadence is not.
 */
export const CONTEXT_HALF_REMINDER: ReminderDefinition = {
    id: "context-half",
    text: "Half the context window is in use. That is normal for a working session, not a signal to economize: keep reading what the task needs, keep the work at the scope it needs, and do not shorten or defer steps on account of an assumed limit.",
    guidance: "The measured context just crossed half the window.",
};

/**
 * The first measured reading past three quarters of the context window.
 *
 * This is the one reminder that could talk a model into wrapping up, so the text counters that reading directly:
 * a fold is a reset, not the end of the task. What it asks for is cheap fold preparation - the state files a
 * summary cannot carry - not a narrower task. Kept out of the rotation for the same reason as `context-half`.
 */
export const CONTEXT_TIGHT_REMINDER: ReminderDefinition = {
    id: "context-tight",
    text: "Three quarters of the context window is in use. A fold may land soon, and a fold is a reset rather than the end of the task: keep the runtime `TODO.md` and any memories the next step needs current so nothing important lives only in the transcript, and continue the same task at the scope it needs instead of wrapping up or handing off.",
    guidance: "The measured context just crossed three quarters of the window; a fold may be near.",
};

/**
 * The measured count a fold reminder could not state at the time.
 *
 * The fold reminder rides the first turn after the fold, when the post-fold count is null and the estimate is
 * refused (the model changed) or impossible. This one waits for the first measured reading and is delivered at a
 * step boundary, which is why it exists as its own reminder rather than as a second fold reminder.
 */
export const CONTEXT_AFTER_FOLD_REMINDER: ReminderDefinition = {
    id: "context-after-fold",
    text: "The measured count is available again after the fold. Do not budget the work from the pre-fold number - continue the same task at the scope it needs.",
    guidance: "A fold landed and its reminder could not state a measured number at the time.",
};

/**
 * The nudge that follows repeated `rg`/`grep` exploration without `outline`.
 *
 * Kept out of the rotation because a cadence cannot time it to the behavior it is about: it is delivered at
 * the step boundary right after the search that crosses the threshold (`outline-nudge.ts`), which is the point
 * where the model is choosing its next tool. The selection model gates the emission whenever the decision model
 * is enabled; a deliberate `none` suppresses it, and an unavailable answer leaves the deterministic nudge in charge.
 */
export const OUTLINE_NUDGE_REMINDER: ReminderDefinition = {
    id: "outline",
    text: "Your native tool `outline` might help you navigate more efficiently: `digest` maps a file or directory with signatures and line ranges, `search` finds declarations by name or doc comment, `show` returns a symbol's exact source, and `usages` lists call sites. `rg`/`grep` still fit strings, config, logs, prose, and comments inside a function body.",
    guidance:
        "The agent is exploring code with line-oriented searches or long reads instead of the `outline` tool, which would locate the declarations, definitions, or call sites directly.",
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
        text: "Before finishing, review what you learned and update or add project memories, and review `[high-churn]` memories touched by the change.",
        guidance:
            "Work was completed and its learnings are not saved yet; never for a turn that only read or searched.",
        // Something has to have been produced before there is anything to record, and the hand-back states
        // are where "before finishing" bites.
        states: ["implementing", "validating", "documenting", "reporting"],
    },
    {
        id: "sandbox",
        text: "Bash runs under pi-coder's cwd-confinement gate. A block or prompt explains its reason and any user note - request a session rule or ask the user rather than working around it. Config: `.pi/bash-sandbox-config.json`.",
        guidance:
            "Bash is in use and the cwd-confinement gate, a block, or a user note is easy to overlook.",
        // Disabled for now: the text restates the always-present sandbox guidance and rotation cannot time
        // it to a real gated event. Re-enable once it is keyed on a block, prompt, or user note.
        disabled: true,
        states: ["implementing", "validating"],
    },
    {
        id: "delegation",
        text: "For large independent work, delegate to `scout` (read-only) or `worker` (mutation) with a fully self-contained brief; don't duplicate a running child's work.",
        guidance:
            "Large independent work is being done inline that a scout or a worker could take.",
        // The advice is about work already underway: offering it while the turn is still reading or deciding
        // asks for a split before there is anything to split.
        states: ["exploring", "implementing"],
    },
    {
        id: "todo",
        text: "For multi-step work, keep the runtime `TODO.md` from your prompt current as steps complete.",
        guidance: "Multi-step work is underway and the runtime TODO.md may not reflect it.",
        // The list is worth offering from the moment a multi-step task is being worked out, not only once
        // files change; its open-item gate is separate and lives in `availableRotationIds`.
        states: ["discussing", "exploring", "implementing"],
    },
    {
        id: "validation",
        // Extension-generic by design: the project's own instructions name the commands. Quoting one
        // repository's scripts here would fire wrong (or stale) guidance in every other project.
        text: "Before finishing, run the project's validation - tests, typecheck, lint, and format checks as its instructions specify - instead of assuming the change works.",
        guidance: "A change is about to be called finished without the project's validation pass.",
        // Offered from the moment a change exists, not only once a run has happened: the case this text is
        // about is an unvalidated change being built (`implementing`), where an agent can call the work done
        // without running anything. The later states keep it offered while the work is confirmed or recorded.
        states: ["implementing", "validating", "documenting", "reporting"],
    },
] as const satisfies readonly [RotationReminderDefinition, ...RotationReminderDefinition[]];

/**
 * The rotation the scheduler and the decision model actually use: the catalog minus entries marked
 * `disabled`. Filtering stays here so a disabled reminder is a one-line catalog change; an empty result is
 * handled by the scheduler as "emit nothing" rather than dividing by zero.
 */
export const ACTIVE_ROTATION_REMINDERS: readonly RotationReminderDefinition[] =
    ROTATION_REMINDERS.filter((reminder: RotationReminderDefinition) => reminder.disabled !== true);
