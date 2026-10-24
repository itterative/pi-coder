import type { ReminderPhase } from "../decision/reminder";

/** One pi-coder reminder the agent may receive as hidden context. */
export interface ReminderDefinition {
    /** Stable id, also the model's criterion label when the decision model selects. */
    id: ReminderId;
    /** The text shown to the agent inside the `<pi_coder_reminder>` block. */
    text: string;
    /** One line stating when showing this reminder helps, used as the model's criterion. */
    guidance: string;
    /**
     * Kept in the catalog but filtered out of the rotation and the model's offer. `sandbox` is disabled
     * until it can key on a real gated event (a block, prompt, or user note) instead of rotating
     * context-free; the catalog entry stays so that switch is a one-line change.
     */
    disabled?: boolean;
}

/**
 * A reminder in the rotation: one that the judged state has to offer before the model is even asked about it.
 *
 * The state is the pool's filter (`availableRotationIds`): a reminder that has nothing to act on in the state
 * the session is in is not offered, so the model cannot choose it and then be vetoed. The `guidance` above is
 * what it is judged by once offered, and the two are deliberately separate - the state says whether the advice
 * can apply at all, the score says whether it is worth showing now.
 */
export interface RotationReminderDefinition extends ReminderDefinition {
    /** The states that offer this reminder. */
    states: readonly ReminderPhase[];
}

export type ReminderId =
    | "memory-read"
    | "compaction"
    | "memory-hygiene"
    | "sandbox"
    | "delegation"
    | "todo"
    | "validation";
