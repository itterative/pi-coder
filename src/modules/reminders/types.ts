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

export type ReminderId =
    "memory-read" | "memory-hygiene" | "sandbox" | "delegation" | "todo" | "validation";
