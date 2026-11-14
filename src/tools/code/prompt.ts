/**
 * The `outline` guide.
 *
 * Routing and boundaries only: the call contract lives in the tool description and its parameter
 * schemas, so this says when to reach for `outline` instead of `rg`, `grep`, or `read`. Pi wraps it in
 * an `outline_tool_guide` section while the tool is declared.
 *
 * The triggers name things the agent is already about to do (read a file, run a grep, write a test) rather than an
 * intent it would have to classify ("is this a structure question"), because a rule that asks the agent to judge its
 * own intent is the one it can always talk itself out of. The boundary is stated as a real limitation instead of a
 * preference: a guide that claims everything gets discounted, and an agent that discovers the limitation through a
 * wasted turn learns to prefer `rg`. The literal invocations carry the workflow, because an example is imitated more
 * reliably than a rule that describes it. Triggers and prose name the `action=` field rather than a bare
 * `outline digest`, and the guide says outright that this is a tool call: the earlier "run `outline digest`" phrasing
 * read as a command line, and models tried it in bash.
 *
 * **The framing is structure, not declarations.** An agent that reads this as a declaration tool correctly concludes
 * it does not apply to a test suite, an entrypoint, or a script — and those are exactly the files whose shape is
 * worth one call. So the digest trigger names the files whose structure is not a declaration list, and `flow` is
 * offered for the behaviour question a `read` would otherwise answer.
 *
 * Every claim here tracks the implementation: `search` reads names *and* doc comments *and* literal body text and
 * unowned comment blocks, and can append a relevance-ranked tail; `show` locates a symbol that lives in another file
 * and matches prose titles loosely; blocks make `describe`/`it` trees and named callbacks part of the map; and both
 * `show` and `usages` take comma-joined symbol lists. A guide that keeps a capability the tool no longer has, or drops
 * one it gained, teaches the wrong tool.
 */

export function outlineGuidePrompt(): string {
    return [
        "## Outline",
        "",
        "`outline` maps structure without reading whole files — declarations, test suites and cases, call",
        "sites. Its triggers are checkable before you act, and it is cheaper than the alternative, not",
        "just tidier:",
        "",
        "- About to `read` a long file, or `read` any file just to find one declaration:",
        '  `action="digest"` first. You get the map with line ranges, so you open the 30 lines you need',
        "  instead of pulling 900 into the context.",
        "- A file whose answer is not a declaration list is the same question: `digest` maps a",
        '  `describe`/`it` tree, a named callback (`router.get("/users", handler)`), and a script\'s',
        "  module constants. Test suite, entrypoint, config, script: digest before reading. Before",
        "  writing a test, digest the test file — the neighbouring cases are the house style.",
        '- About to `rg`/`grep` for a declaration, or for code that does something: `action="search"`',
        "  instead. It matches declaration names, doc comments, frontmatter, literal text inside bodies,",
        "  and comment blocks no declaration owns (a file header, a note between statements), and answers",
        "  with kinds, signatures, and line ranges rather than matching lines.",
        '- Need one symbol\'s body: `action="show"` returns that block with its doc comment. The file need',
        "  not be the right one, and a heading or a test title matches by prefix and substring.",
        '- Need what a function, a file, or a script *does*: `action="flow"` lists its call sites grouped',
        '  by scope. Need what a file imports, or who imports it: `action="deps"`.',
        "",
        "`outline` is a tool call, not a shell command — `outline digest src/auth` typed into a terminal",
        "is not a command:",
        "",
        '    outline(action="digest", path="src/auth")',
        '    outline(action="show", query="Auth::login")',
        '    outline(action="usages", query="Auth::login", kind="call")',
        '    outline(action="flow", path="src/auth/socket.ts")',
        "",
        "Stay with `rg`/`grep` for line-level work: regex, counts, context lines, config, logs, and prose",
        "in a file `outline` does not parse. A file's own headings and frontmatter match too, so for that",
        "file's map search the file itself (`path=<file>`). `search` reads literal body text and unowned",
        "comment blocks only for a query of two or more words, because a single word is an identifier",
        "question; a body row names the declaration that contains the text, and a comment row quotes the",
        "matching line, since no `show` can return it. A `path` may name any readable tree, including a",
        "memory directory.",
        "",
        "Rows are tagged by channel: `[doc]` matched the doc comment, `[body]` literal text inside a",
        "body, `[frontmatter]`, `[def]`/`[decl]` a definition versus only a declaration, and `[related]`",
        'a ranked guess rather than a match — confirm those with `action="show"`. `usages` and `flow` are',
        "syntactic, so overloads, generics, macros, and dynamic dispatch are not resolved. When output",
        "ends with `# next: offset=N`, call again with the same parameters and that offset.",
    ].join("\n");
}
