/**
 * Prompt bodies for the memory module.
 *
 * `memoryPrompt` is the module's context section: the indexed memory list plus the parse-failure
 * warning. `memoryAuditGuidePrompt` is the `memory_audit` tool's guide. Pi wraps each in a section of
 * its own name (`memory_system`, `memory_audit_tool_guide`).
 */

import type { PinnedMemory } from "./memories";

/** The memory index as prompt text, so a future turn knows which memories to load. */
export function memoryPrompt(appendix: string): string {
    return appendix;
}

/**
 * The bodies of the pinned memories as one block, for the hidden context the reminders module delivers. The
 * lead-in that explains why they are here belongs to the reminder catalog, not to the memory module.
 */
export function pinnedMemoryBlocks(pinned: readonly PinnedMemory[]): string {
    return pinned.map((entry) => `**${entry.name}**\n\n${entry.text}`).join("\n\n");
}

/** When to call the audit, and how to read its findings. */
export function memoryAuditGuidePrompt(): string {
    return [
        "## memory_audit",
        "",
        "- Do not call `memory_audit` after every memory edit: the audit runs automatically after a step that changed a memory file and reports its findings as a reminder. Call the tool for the full report when a reminder says there are more findings, or when the user asks.",
        "- Weigh warnings rather than obeying them: fix the ones that hide content (a nested doc no index names, a broken link, a stale memory name), leave deliberate ones (a dense index, a long nested description) alone and say why.",
    ].join("\n");
}
