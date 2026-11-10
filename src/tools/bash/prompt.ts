/**
 * The bash sandbox context section: what a user note on a command means and where it appears. Pi wraps
 * it in a `bash_sandbox` section.
 */
export function bashSandboxPrompt(): string {
    return [
        "## Bash Sandbox User Notes",
        "",
        "When requesting to run bash commands, the user may attach a note explaining their decision. These notes appear:",
        "- For blocked commands: in the block reason",
        "- For allowed commands: inside `<user_note>` tags at the start of the command output",
        "",
        "Pay attention to these notes as they provide context about the user's preferences and concerns.",
    ].join("\n");
}
