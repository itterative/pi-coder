import type { CommandState } from "./contract";
import { runnerRulesFor } from "./runner-rules";
import { clipRequest, renderSessionWindow } from "./session-context";
import type {
    DecisionContext,
    DecisionContextShape,
    DecisionRecentMessage,
    ScriptOmission,
    ScriptRun,
} from "./types";

/** Whether a shape carries the session half. */
export function hasRequestContext(shape: DecisionContextShape): boolean {
    return shape === "request_context";
}

/**
 * Build the classifier `state` for a request.
 *
 * Every shape carries the runner's generic rules: without them the model reads an authorized in-workspace
 * file rewrite as destruction. They are the same facts for every project, so they are not project context.
 *
 * `request_context` (the default) adds the session half as one rendered `conversation`: the planned window plus
 * the request as its last `User:` line. The facts are the ones the measured arm sent as separate `request` and
 * `recent_messages` fields — accidental-destruction detection 1/6 to 5/6 and benign-edit false positives 1/6 to
 * 0/6 against `command_cwd`, for +38 tokens — sent as the line grammar the transcript already uses. That
 * grammar is what lets a refused command say so on its own line instead of looking like a command that ran.
 *
 * The strategies choose the shape: `veto` sends `request_context`, and `history` is that state plus one
 * `command_history` field.
 */
export function buildState(context: DecisionContext, shape: DecisionContextShape): CommandState {
    const state: CommandState = {
        command: context.command,
        cwd: context.cwd,
        runner_rules: [
            ...runnerRulesFor(context.runner ?? "parent", context.isolation ?? "checkout"),
        ],
    };

    // A dirty working tree is a command fact like `cwd`, so it rides in every shape: whether the files a
    // command touches are already uncommitted changes is what the `loses_content`/`out_of_scope` judgments
    // turn on. Only a dirty tree is sent; an absent field is clean or unreadable, and the model reads it the
    // same either way.
    const workspace = context.workspace;
    if (workspace !== undefined && workspace.changes.length > 0) {
        state.workspace_status = {
            changes: workspace.changes.map((change) => `${change.status}: ${change.path}`),
            ...(workspace.truncated ? { note: "more changed files are not listed" } : {}),
        };
    }

    // A script-bearing command sends the facts the command classifier needs for scope, not the code: each body
    // is classified once, as content, and its capability arrives here. A context that still carries the raw
    // script instead (the probe arms, and the strategy tests) sends the bodies under `scripts`.
    const profiles = context.scriptProfiles ?? [];
    if (profiles.length > 0) {
        state.script_capabilities = profiles.map((profile) => ({
            source: profile.source,
            capability: profile.capability,
        }));
    }

    const scripts = scriptTexts(context.script);
    if (scripts.length > 0) {
        state.scripts = scripts;
    }

    if (!hasRequestContext(shape)) {
        return state;
    }

    const conversation = commandConversation(context);
    if (conversation !== "") {
        state.conversation = conversation;
    }

    return state;
}

/**
 * The session half as the one text the state sends: the planned window, then the request as its last line.
 *
 * `recent` excludes the request item, so it is appended here at its own clip rather than re-entering the plan;
 * that is also what keeps the request last, where a reader takes it for the message the command serves. The
 * append is skipped when the window already ends with the request, so a caller that passes branch items rather
 * than the planned window cannot send it twice. The window's own omission note stays first, so a trimmed window
 * never reads as a complete one.
 */
function commandConversation(context: DecisionContext): string {
    const items: DecisionRecentMessage[] = (context.recent ?? []).filter(
        (message) => message.text.trim() !== "",
    );
    const request = clipRequest(context.request ?? "");
    const last = items.at(-1);
    const carried = last?.role === "user" && last.text.slice(0, 40) === request.slice(0, 40);
    if (request !== "" && !carried) {
        items.push({ role: "user", text: request });
    }

    return renderSessionWindow(items, context.omitted ?? 0).join("\n");
}

/**
 * What the model sees of the resolved scripts: every body whole, in order, then one bracketed marker per
 * omission so an incomplete chase is visible instead of reading as a complete list.
 */
function scriptTexts(script: ScriptRun | undefined): string[] {
    if (script === undefined) {
        return [];
    }

    const texts = script.artifacts.map((artifact) => artifact.text);
    for (const omission of script.omissions ?? []) {
        texts.push(omissionMarker(omission));
    }

    return texts;
}

function omissionMarker(omission: ScriptOmission): string {
    const label = omission.reason === "depth" ? "depth limit" : "cycle";
    return `[script not resolved: ${label} at ${omission.source}]`;
}
