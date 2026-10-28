/**
 * The wire shapes the decision model receives, and the question id each subject keys its answers with.
 *
 * A classifier request is a `state` (what the model reads) plus `questions` (what it is asked). This file is
 * the one place to read those outgoing shapes: the `state` types below, and the ids that key `questions` in
 * the request and `answers` in the reply. A built example of every subject is pinned as JSON in
 * `test/modules/decision/__snapshots__/decision-request.<subject>.json`; the richer cases — a whole session's
 * transcript, a dirty working tree, both script forms — are pinned beside the strategy and evaluator tests.
 *
 * The shapes are the *outgoing* keys — the snake_case names the endpoint receives — not the domain types in
 * `types.ts`, which describe what the caller gathered before a request is built.
 *
 * Each subject module keeps its builder, its wording, and its answer reader together, because the wording
 * there is measured against the state beside it; it imports its wire shape and question ids from here. Keep
 * the dependency one way: this file imports only types, and the subject modules import values from it. A value
 * import in the other direction would close an initialisation cycle.
 *
 * Two notes on the list:
 *
 *  - the **scope** verdict is absent on purpose: it is a capability × runner-rung check decided in code
 *    (`scope.ts`), so it sends no request at all;
 *  - the **tier-1 reminder state** (the session-phase question) and the **tier-2 reminder choice** are two
 *    separate requests, not one, so both are listed.
 */

import type { ReminderPhase } from "./reminder";
import type { FileDecisionOperation, ScriptCapability } from "./types";

/** The requests the module can send, in the order a reader should learn them. */
export const DECISION_REQUEST_SUBJECTS = [
    "command",
    "script",
    "file",
    "suggestion",
    "reminder-phase",
    "reminder-choice",
] as const;

/** One of the requests the module can send to the classifier. */
export type DecisionRequestSubject = (typeof DECISION_REQUEST_SUBJECTS)[number];

/** One recent conversation turn as the command state sends it: no `turn` stamp, no message id. */
export type RecentMessageState = {
    role: string;
    text: string;
};

/** The runner's uncommitted changes, clipped to a readable list. */
export type WorkspaceStatusState = {
    /** One `status: path` line per changed file, as `git status` reported it. */
    changes: string[];
    /** Present only when entries were dropped to keep the field small. */
    note?: string;
};

/** One resolved script body's capability, sent instead of the body itself. */
export type ScriptCapabilityState = {
    /** Provenance: `package.json#deploy`, or the repo-relative path of a file body. */
    source: string;
    capability: ScriptCapability;
};

/**
 * The command state: what `state.ts` builds for a strategy.
 *
 * `command`, `cwd`, and `runner_rules` are in every shape. The rest depend on the shape and the facts the
 * caller gathered: `request` and `recent_messages` when the `request_context` shape is used, `workspace_status`
 * when the tree is dirty, `script_capabilities` when the command resolved a body, and `scripts` only when a
 * probe arm sends the bodies whole.
 */
export type CommandState = {
    command: string;
    cwd: string;
    /** The runner's generic authority, not project instructions. */
    runner_rules: string[];
    /** The request the command serves, in the `request_context` shape. */
    request?: string;
    /** The turns immediately before the command, in the `request_context` shape. */
    recent_messages?: RecentMessageState[];
    /** The runner's dirty working tree, when there is one. */
    workspace_status?: WorkspaceStatusState;
    /** One summary per script body the command resolved; the bodies themselves are not re-sent. */
    script_capabilities?: ScriptCapabilityState[];
    /** Whole script bodies, sent only by a probe arm or strategy test; production sends summaries. */
    scripts?: string[];
};

/**
 * The extra field the `history` strategy adds to the command state.
 *
 * Optional because an empty history sends nothing: the field's presence is the claim that the session has
 * earlier commands, and a `[]` would say the opposite of what the strategy means by omitting it.
 */
export type CommandHistoryState = {
    command_history?: { command: string }[];
};

/**
 * The file-access state: one path, who wants it, and the rules the runner is judged by.
 *
 * A different vocabulary from the command state on purpose — no `command`, no script, no transcript — which
 * is why it is its own shape instead of more optional fields on {@link CommandState}.
 */
export type FileAccessState = {
    operation: FileDecisionOperation;
    /** Absolute, after the gate resolved symlinks. */
    path: string;
    cwd: string;
    /** The file-access phrasing of the runner's authority. */
    runner_rules: string[];
    /** The request the access serves, when it is non-blank. */
    request?: string;
};

/** The script state: one body of code, and nothing about the invocation that runs it. */
export type ScriptState = {
    code: string;
};

/** The suggestion state: one rule segment, plus the same-tool commands that precede it. */
export type SuggestionState = {
    /** The single uncovered segment, not the whole command line. */
    command: string;
    cwd: string;
    /** Earlier commands from this session naming the same tool, when there are any. */
    recent_commands?: string[];
};

/** The tier-1 reminder state: the accepted phase as an anchor, and the fitted transcript. */
export type ReminderPhaseState = {
    current_state: ReminderPhase | "none";
    conversation: string;
};

/**
 * The tier-2 reminder state: one allocator-rendered conversation, and nothing structured beside it.
 *
 * The structured signal fields were measured to hurt this answer, so an absent `conversation` — not an empty
 * one — is how a request with no window is sent.
 */
export type ReminderChoiceState = {
    conversation?: string;
};

/**
 * The question ids, which are wire names: they key `questions` in the request and `answers` in the reply.
 *
 * The wording of each question stays in its subject module, beside the state it was measured against.
 */

/** The command question: the second-opinion veto, answered by criterion. */
export const VETO_QUESTION = "veto";

/** The script question: the body's most consequential capability. */
export const SCRIPT_QUESTION = "script";

/** What a file-access path is. */
export const FILE_KIND_QUESTION = "kind";

/** What the request wants with the path. */
export const FILE_PURPOSE_QUESTION = "purpose";

/** What a write to the path would lose. */
export const FILE_LOSS_QUESTION = "loss";

/** Whether a suggestion's path-like argument is executed code or data. */
export const SUGGESTION_QUESTION_ID = "executes_code";

/** The tier-1 reminder question: the phase the session moves to next. */
export const REMINDER_PHASE_QUESTION = "next_state";
