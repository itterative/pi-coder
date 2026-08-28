export function oneLinePreview(text: string, maxChars = 180): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxChars
        ? normalized
        : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function firstLinePreview(text: string, maxChars = 180): string {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    return oneLinePreview(firstLine, maxChars);
}

const TOOL_GROUPS: Array<{ names: string[]; singular: string; plural: string }> = [
    { names: ["read"], singular: "read", plural: "reads" },
    { names: ["grep", "find"], singular: "search", plural: "searches" },
    { names: ["ls"], singular: "listing", plural: "listings" },
    { names: ["bash"], singular: "command", plural: "commands" },
    { names: ["edit"], singular: "edit", plural: "edits" },
    { names: ["write"], singular: "write", plural: "writes" },
    { names: ["ask_parent", "ask_user"], singular: "question", plural: "questions" },
];

export function formatToolCounts(toolCounts: Record<string, number> | undefined): string {
    if (!toolCounts) return "";
    const parts: string[] = [];
    for (const group of TOOL_GROUPS) {
        const count = group.names.reduce((total, name) => total + (toolCounts[name] ?? 0), 0);
        if (count) parts.push(`${count} ${count === 1 ? group.singular : group.plural}`);
    }
    return parts.join(" · ");
}
