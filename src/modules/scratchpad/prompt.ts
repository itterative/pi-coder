/**
 * The scratchpad context section: where the private directory is and how long it survives. Pi wraps it
 * in a `scratchpad_system` section.
 */

import {
    DEFAULT_SCRATCHPAD_POLICY,
    formatRetention,
    formatStorageSize,
    type ScratchpadPolicy,
} from "./policy";

export function scratchpadPrompt(
    pathname: string,
    policy: ScratchpadPolicy = DEFAULT_SCRATCHPAD_POLICY,
): string {
    return [
        "## Temporary Scratchpad",
        "",
        "A private temporary scratchpad is available at:",
        "",
        `\`${pathname}\``,
        "",
        "Use it for notes, intermediate artifacts, generated reports, and other " +
            "work that should not modify the project checkout.",
        "Use this directory with the tools available in this runtime; access " +
            "remains subject to the runtime's capability policy.",
        "It is an additional confined root, equivalent to the current working " +
            "directory for path safety.",
        `Keep it small: pi-coder warns once it grows past ${formatStorageSize(policy.perScratchpadBytes)}, ` +
            "and it is not a place for large datasets or bulk output.",
        `Scratchpad contents are temporary: pi-coder removes a scratchpad that has been idle for ` +
            `${formatRetention(policy.retentionMs)}. Copy anything you need to keep into the project or memory.`,
        "When returning to this session, the recorded scratchpad path is reused while the directory still " +
            "exists; do not rely on contents surviving pruning or manual deletion.",
    ].join("\n");
}
