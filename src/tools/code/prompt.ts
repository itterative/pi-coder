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
 *
 * Every claim here tracks the implementation: `search` reads names *and* doc comments and can append a
 * relevance-ranked tail, `show` locates a symbol that lives in another file, and both `show` and `usages` take
 * comma-joined symbol lists. A guide that keeps a capability the tool no longer has, or drops one it gained,
 * teaches the wrong tool.
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
        "- About to `rg`/`grep` for a declaration, or for the code that does something. Run `outline search`",
        "  instead: it matches declaration names and their doc comments and returns kinds, signatures, and line",
        "  ranges rather than matching lines, so a half-remembered name or a remembered description both land.",
        "- Need one symbol's body. `outline show` returns that block with its doc comment, not the file. The",
        "  file does not have to be the right one: a symbol that lives elsewhere is reported with its real",
        "  location.",
        "",
        "Unfamiliar code is usually `digest` the directory, `show` the symbol that matters, then `usages` before",
        "changing a signature:",
        "",
        '    outline(action="digest", path="src/auth")',
        '    outline(action="show", symbols=["Auth::login"])',
        '    outline(action="usages", symbols=["Auth::login"], kind="call")',
        "",
        'One call can carry several symbols (`symbols=["Auth::login", "Auth::logout"]`); a single',
        "comma-joined entry is accepted too, and a leading parameter list (`Auth::login(string)`) is enough to",
        "pick an overload.",
        "",
        "Stay with `rg`/`grep` while the target is not a declaration: strings, config, logs, prose, an error",
        "message, a language `outline` does not parse. `search` matches declaration names and their doc comments,",
        "and when those are thin it appends ranked `[related]` rows, so a conceptual query can land without a literal",
        "match; a literal zero-hit still means no identifier or doc comment spells it out.",
        "",
        "`usages` finds candidates, not a call graph: it is syntactic, so it does not resolve overloads, generics,",
        "macros, or dynamic dispatch. When output ends with `# next: offset=N`, call again with the same",
        "parameters and that offset.",
        "",
        "Rows tagged `[related]` were ranked by relevance because name and doc matches were thin; they are guesses,",
        "so confirm with `outline show` before relying on one.",
    ].join("\n");
}
