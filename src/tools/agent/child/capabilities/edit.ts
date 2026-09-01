/**
 * Direct edit and write authority: the top rung of the ladder.
 *
 * Granting the tools is only half of what makes a worker; the run mode decides whether writes inside
 * the checkout are pre-approved or prompted, and that lives with the permission gate rather than here.
 * Only the built-in `worker` may declare this capability, which `definitions/discovery.ts` enforces.
 */
export const EDIT_UNIT = {
    id: "edit",
    tools: ["edit", "write"],
} as const;
