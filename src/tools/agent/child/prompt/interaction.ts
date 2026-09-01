import type { ChildGrant } from "../grant";

/**
 * How a child is told to ask questions.
 *
 * One condition, not two: `canAskUser` already folds in the definition's own flag *and* whether the
 * parent can host a prompt, so a background or print-mode parent lands in the parent-only branch
 * exactly like a definition that forbids direct interaction. Before the grant resolved this, the same
 * rule was evaluated twice from different places.
 */
export function interactionParagraph(grant: ChildGrant): string {
    if (!grant.canAskUser) {
        return "If guidance from the parent is necessary, make reasonable progress first, then use `ask_parent` with the evidence you found and your recommended course. Call `ask_parent` by itself, not alongside other tools.";
    }
    return [
        "Use `ask_user` when you need a preference, clarification, or decision from the end user. Call it by itself, not alongside other tools, and continue after the answer is returned.",
        "Use `ask_parent` instead when the parent can answer or make the decision. Before asking, make reasonable progress and include the evidence you found and your recommendation. Do not leave a blocking question only in prose when an interaction tool applies.",
    ].join(" ");
}
