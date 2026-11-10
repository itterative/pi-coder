/**
 * Named system-prompt sections.
 *
 * Pi composes the system prompt from named sections and wraps each one in a tag of that name, so an
 * extension contributes prompt text by naming it rather than by splicing the rendered prompt. Pi
 * diffs the sections it already recorded against the current build and sends only the changed ones as
 * a transcript delta, which keeps the model's view and the transcript identical.
 */

import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

/**
 * Set one section for the current run.
 *
 * The options object is a per-run copy, so assigning here never leaks into the base prompt of a later
 * run; a module assigns on every `before_agent_start` and the last value wins. Empty bodies are
 * skipped, since pi would leave an empty section out anyway.
 */
export function setPromptSection(
    options: NormalizedBuildSystemPromptOptions,
    name: string,
    body: string,
): void {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
        return;
    }

    options.sections[name] = trimmed;
}

/** Whether the model is given this tool: selected for the run and not hidden by a loadout hook. */
export function isToolDeclared(options: NormalizedBuildSystemPromptOptions, name: string): boolean {
    return options.selectedTools.includes(name) && !options.hiddenTools.includes(name);
}

/**
 * Contribute a tool's guide, in its `<tool>_tool_guide` section, while that tool is declared.
 *
 * A guide is routing and behavior guidance rather than a call contract: the contract lives in the tool
 * `description` and its parameter schemas, and a preference belongs in one place only.
 */
export function contributeToolGuide(
    options: NormalizedBuildSystemPromptOptions,
    toolName: string,
    body: string,
): void {
    if (!isToolDeclared(options, toolName)) {
        return;
    }

    setPromptSection(options, `${toolName}_tool_guide`, body);
}
