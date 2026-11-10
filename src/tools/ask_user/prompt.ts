/**
 * The `ask_user` guide.
 *
 * When to ask, and how to shape the options. Pi wraps it in an `ask_user_tool_guide` section while the tool
 * is declared; the call contract stays in the tool description and parameter schemas.
 */
export function askUserGuidePrompt(): string {
    return [
        "## ask_user",
        "",
        "- Prefer asking over assuming when the request is ambiguous, several approaches are valid, or the answer would change what you do; it is better to ask than to guess wrong.",
        '- Put your recommendation in the chosen option\'s `description` field as "Recommended because …" or "(recommended)".',
        '- Include an "Unsure" or "You decide" option when the user may not have a strong preference, so you can fall back on your own judgment instead of stalling.',
    ].join("\n");
}
