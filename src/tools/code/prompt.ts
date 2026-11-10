/**
 * The `outline` guide.
 *
 * Routing and boundaries only: the call contract lives in the tool description and its parameter
 * schemas, so this says when to reach for `outline` instead of `rg`, `grep`, or `read`. Pi wraps it in
 * an `outline_tool_guide` section while the tool is declared.
 *
 * The triggers name things the agent is already about to do (read a file, run a grep) rather than an
 * intent it would have to classify ("is this a structure question"), because a rule that asks the agent
 * to judge its own intent is the one it can always talk itself out of. The boundary is stated as a real
 * limitation instead of a preference: a guide that claims everything gets discounted, and an agent that
 * discovers the limitation through a wasted turn learns to prefer `rg`. The three literal invocations
 * carry the workflow, because an example is imitated more reliably than a rule that describes it.
 */
export function outlineGuidePrompt(): string {
    return [
        "## Outline",
        "",
        "Three triggers, all checkable before you act. `outline` is cheaper than the alternative, not just tidier:",
        "",
        "- About to `read` a long file, or `read` any file just to find one declaration. Run `outline digest`",
        "  first. It returns the declaration map with line ranges, so you go straight to the 30 lines you need",
        "  instead of pulling 900 into the conversation.",
        "- About to `rg`/`grep` for a declaration. Run `outline search` instead: the same directory scan comes",
        "  back with kinds, signatures, and line ranges rather than matching lines, and it tolerates a",
        "  half-remembered name.",
        "- Have a symbol name and want its body. `outline show` returns that block with its doc comment, not",
        "  the file.",
        "",
        "Unfamiliar code is usually `digest` the directory, `show` the symbol that matters, then `usages` before",
        "changing a signature:",
        "",
        '    outline(action="digest", path="src/auth")',
        '    outline(action="show", symbols=["Auth::login"])',
        '    outline(action="usages", symbols=["Auth::login"], kind="call")',
        "",
        "Stay with `rg`/`grep` while you still have no name: comments, strings, config, logs, prose, an error",
        "message, a language `outline` does not parse. `search` matches declaration names, so it cannot answer a",
        "concept you cannot name yet; a zero-hit search means no such name here, not no such behavior.",
        "",
        "`usages` finds candidates, not a call graph: it is syntactic, so it does not resolve overloads, generics,",
        "macros, or dynamic dispatch. When output ends with `# next: offset=N`, call again with the same",
        "parameters and that offset.",
    ].join("\n");
}
