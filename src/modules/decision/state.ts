import type { JsonObject } from "@earendil-works/pi-ai";

import { runnerRulesFor } from "./runner-rules";
import type { DecisionContext, DecisionContextShape, ScriptOmission, ScriptRun } from "./types";

/** Whether a shape carries the request and the recent turns. */
export function hasRequestContext(shape: DecisionContextShape): boolean {
    return shape === "request_context";
}

/**
 * Build the classifier `state` for a request.
 *
 * Every shape carries the runner's generic rules: without them the model reads an authorized in-workspace
 * file rewrite as destruction. They are the same facts for every project, so they are not project context.
 *
 * `request_context` (the default) adds the `request` the command serves and the `recent_messages`, each as
 * its own labelled field rather than one flattened transcript. That distinction is measured, not cosmetic:
 * as separate fields it takes accidental-destruction detection from 1/6 to 5/6 and benign-edit false
 * positives from 1/6 to 0/6, for +38 tokens over `command_cwd`. Flattened into a transcript it did the
 * opposite, which is the finding that originally made `command_cwd` the default.
 *
 * The strategies choose the shape: `veto` sends `request_context`, and `history` is that state plus one
 * `command_history` field.
 */
export function buildState(context: DecisionContext, shape: DecisionContextShape): JsonObject {
    const state: JsonObject = {
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

    const requestText = context.request?.trim();
    if (requestText !== undefined && requestText !== "") {
        state.request = requestText;
    }

    const recent = (context.recent ?? []).filter((message) => message.text.trim() !== "");
    if (recent.length > 0) {
        state.recent_messages = recent.map((message) => ({
            role: message.role,
            text: message.text,
        }));
    }

    return state;
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
