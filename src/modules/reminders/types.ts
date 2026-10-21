/** One pi-coder reminder the agent may receive as hidden context. */
export interface ReminderDefinition {
    /** Stable id, also the model's criterion label when the decision model selects. */
    id: ReminderId;
    /** The text shown to the agent inside the `<pi_coder_reminder>` block. */
    text: string;
    /** One line stating when showing this reminder helps, used as the model's criterion. */
    guidance: string;
}

export type ReminderId =
    "memory-read" | "memory-hygiene" | "sandbox" | "delegation" | "todo" | "validation";
