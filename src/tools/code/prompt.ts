/**
 * The `outline` guide.
 *
 * Routing and boundaries only: the call contract lives in the tool description and its parameter
 * schemas, so this says when to reach for `outline` instead of `rg`, `grep`, or `read`, and what its
 * answers do and do not contain. Pi wraps it in an `outline_tool_guide` section while the tool is declared.
 */
export function outlineGuidePrompt(): string {
    return [
        "## Outline",
        "",
        "Reach for `outline` before `rg`, `grep`, or `read` when the question is about code structure:",
        '- `digest` answers "what is in here" and orients you in a file or directory.',
        '- `search` answers "what is this called", including a name you only half-remember.',
        "- `show` returns one declaration's body instead of the whole file.",
        '- `usages` answers "where is X used".',
        "",
        "Stay with `rg`/`grep` for prose, comments, strings, config, logs, a language `outline` does not parse, and any concept whose name you do not know. A zero-hit search means no such name here; it does not mean the behavior is absent.",
        "",
        "`usages` finds candidates, not a call graph: it is syntactic, so it does not resolve overloads, generics, macros, or dynamic dispatch. When output ends with `# next: offset=N`, call again with the same parameters and that offset.",
    ].join("\n");
}
