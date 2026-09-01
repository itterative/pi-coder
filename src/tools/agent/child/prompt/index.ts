import type { ChildGrant } from "../grant";
import { interactionParagraph } from "./interaction";
import { childProfileText } from "./profiles";

/**
 * The delegated-run protocol appended to a child's own instructions.
 *
 * Composition is `profile paragraphs`, then `how to ask`, then `what to report`: the child's mode of
 * work, its interaction surface, and its deliverable. Everything each paragraph needs is already
 * resolved on the grant, so this function holds no capability logic of its own and no combination of
 * flags to keep in step.
 *
 * The rendered text is model-facing and pinned by file snapshots in `test/tools/agent-prompt.test.ts`;
 * changing wording is a behavior decision, not a cleanup. See `docs/agent-tool.md` (**Prompt design**)
 * before editing.
 */
export function childProtocolPrompt(grant: ChildGrant): string {
    const profile = childProfileText(grant);
    return [...profile.capability, interactionParagraph(grant), profile.reporting].join("\n\n");
}
