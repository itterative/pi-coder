import { hasAgentAuthority } from "../../definitions/types";
import type { ChildGrant } from "../grant";
import { fullOutputReadNote, customSafeBashNote } from "./bash";
import { allowedReadPathScope, mutationPathScope, pathRule } from "./paths";
import { changeReportExpectation, findingsReportExpectation } from "./reporting";

/**
 * The four run modes a child can be told about.
 *
 * A profile owns the *order* of its paragraphs, which is why the prose reads as one coherent
 * description instead of a pile of capability notes: the sentences that repeat across profiles live
 * with the capability that warrants them (`prompt/bash.ts`, `prompt/paths.ts`, `prompt/reporting.ts`),
 * and each profile decides where to place them. Selecting a profile is the ladder plus isolation, and
 * nothing else, so the number of profiles cannot grow when a capability is added.
 */
export interface ChildProfileText {
    /** Paragraphs in the order the child should read them. */
    capability: string[];
    /** Closing expectation for the child's final message to the parent. */
    reporting: string;
}

/** Includes a paragraph only when its condition holds, which keeps each list literal readable. */
function when(condition: boolean, paragraph: () => string): string[] {
    return condition ? [paragraph()] : [];
}

/** Same, for a paragraph that its owner may decline to produce at all. */
function optional(paragraph: string | undefined): string[] {
    return paragraph === undefined ? [] : [paragraph];
}

function isolatedWorkerProfile(grant: ChildGrant): ChildProfileText {
    return {
        capability: [
            "Run mode: mutation-capable worker in a separate Git worktree.",
            "This worktree is your current working directory. Changes you make there do not affect the parent's checkout unless the parent later applies your result.",
            ...when(
                grant.hasScratchpad,
                () =>
                    "This run also has a private temporary scratchpad as an additional root. You may use `edit` and `write` there without an additional approval request.",
            ),
            ...when(grant.bashOutputAccess, fullOutputReadNote),
            "Direct edit/write calls inside this worktree are already authorized; sensitive paths and symlink escapes remain blocked. Bash commands use this run's own permission state and may pause while the end user decides whether to approve them; do not assume an approval granted to the parent also applies to you.",
            ...optional(customSafeBashNote(grant.safeBashCommands)),
            "Run only one mutation tool at a time. Other isolated workers may run concurrently, so avoid destructive Git operations and keep changes narrow.",
        ],
        reporting: changeReportExpectation(),
    };
}

function sameCheckoutWorkerProfile(grant: ChildGrant): ChildProfileText {
    return {
        capability: [
            "Run mode: mutation-capable worker in the parent's current checkout. That checkout is your current working directory.",
            `You may call \`edit\` and \`write\` directly for paths inside ${mutationPathScope(grant)}; that access is already authorized and does not require an additional approval request. Eligible file access outside it may pause while the end user approves or denies the request. ${pathRule(grant)}`,
            ...when(grant.bashOutputAccess, fullOutputReadNote),
            "A Bash command covered by an existing parent permission rule runs immediately. Any other eligible command may pause while the end user approves or denies it. A denied command or one rejected by the safety checks remains blocked.",
            ...optional(customSafeBashNote(grant.safeBashCommands)),
            "Successful changes appear immediately in the parent's checkout. Inspect the latest file contents before editing, preserve unrelated changes, and run only one mutation tool at a time.",
        ],
        reporting: changeReportExpectation(),
    };
}

function commandCapableProfile(grant: ChildGrant): ChildProfileText {
    return {
        capability: [
            "Run mode: delegated agent with permission-gated command execution.",
            `You may use \`read\`, \`grep\`, \`find\`, and \`ls\`. Every direct file path, after resolving symlinks, must remain inside ${allowedReadPathScope(grant)}. ${pathRule(grant)} You cannot use direct edit or write tools.`,
            ...when(grant.bashOutputAccess, fullOutputReadNote),
            "You may use `bash`. Commands recognized as local read-only inspection run directly; other eligible commands may pause while the end user approves or denies them. Approved commands can have project side effects, so keep them relevant to validation and do not assume a command is harmless because it has a test-like name.",
            ...optional(customSafeBashNote(grant.safeBashCommands)),
        ],
        reporting: findingsReportExpectation(),
    };
}

function readOnlyProfile(grant: ChildGrant): ChildProfileText {
    return {
        capability: [
            "Run mode: read-only delegated agent.",
            `You may use \`read\`, \`grep\`, \`find\`, and \`ls\`. Every path, after resolving symlinks, must remain inside ${allowedReadPathScope(grant)}. ${pathRule(grant)} You cannot modify files.`,
            ...when(grant.bashOutputAccess, fullOutputReadNote),
            grant.authority === "inspect"
                ? "You may also use `bash`, but only for local inspection commands that the runtime recognizes as read-only. Commands that may write, use unsafe modes, access the network or sensitive paths, or cannot be classified safely are blocked. If a command is blocked, use the stated reason to choose a read/search tool or report the limitation; do not try alternate spellings to bypass the restriction."
                : "The `bash` tool is unavailable in this run.",
            ...optional(customSafeBashNote(grant.safeBashCommands)),
        ],
        reporting: findingsReportExpectation(),
    };
}

/**
 * The profile that describes this run, selected by rung and isolation only.
 *
 * `mutate` outranks everything because a worker is named for its edit authority even when it also
 * holds command access.
 */
export function childProfileText(grant: ChildGrant): ChildProfileText {
    if (grant.authority === "mutate") {
        return grant.isolated ? isolatedWorkerProfile(grant) : sameCheckoutWorkerProfile(grant);
    }
    if (hasAgentAuthority(grant.authority, "command")) {
        return commandCapableProfile(grant);
    }
    return readOnlyProfile(grant);
}
