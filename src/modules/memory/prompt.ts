/**
 * Prompt bodies for the memory module.
 *
 * `memoryPrompt` is the module's context section: the indexed memory list plus the parse-failure
 * warning. `memoryAuditGuidePrompt` is the `memory_audit` tool's guide. Pi wraps each in a section of
 * its own name (`memory_system`, `memory_audit_tool_guide`).
 */

/** The memory index as prompt text, so a future turn knows which memories to load. */
export function memoryPrompt(appendix: string): string {
    return appendix;
}

/** When to run the audit, and how to read its findings. */
export function memoryAuditGuidePrompt(): string {
    return [
        "## memory_audit",
        "",
        "- Do not run the audit after every memory edit: it runs automatically after a step that changed a memory file and reports its findings as a reminder. Run it for the full report when a reminder says there are more findings, or when the user asks.",
        "- Weigh warnings rather than obeying them: fix the ones that hide content (a nested doc no index names, a broken link, a stale memory name), leave deliberate ones (a dense index, a long nested description) alone and say why.",
    ].join("\n");
}
