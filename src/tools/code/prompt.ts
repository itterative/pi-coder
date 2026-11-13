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
 * carry the workflow, because an example is imitated more reliably than a rule that describes it. Triggers
 * and prose name the `action=` field rather than a bare `outline digest`, and the guide says outright that
 * this is a tool call: the earlier "run `outline digest`" phrasing read as a command line, and models tried
 * it in bash.
 *
 * Every claim here tracks the implementation: `search` reads names *and* doc comments *and* literal body text and
 * can append a relevance-ranked tail, `show` locates a symbol that lives in another file, and both `show` and
 * `usages` take comma-joined symbol lists. A guide that keeps a capability the tool no longer has, or drops one it
 * gained, teaches the wrong tool.
 */
export function outlineGuidePrompt(): string {
    return [
        "## Outline",
        "",
        "Four triggers, all checkable before you act. `outline` is cheaper than the alternative, not just tidier:",
        "",
        "- About to `read` a long file, or `read` any file just to find one declaration. Call `outline` with",
        '  `action="digest"` first. It returns the declaration map with line ranges, so you go straight to the',
        "  30 lines you need instead of pulling 900 into the conversation.",
        "- About to `rg`/`grep` for a declaration, or for the code that does something. Call `outline` with",
        '  `action="search"` instead: it matches declaration names, doc comments, and literal text inside bodies,',
        "  and returns kinds, signatures, and line ranges rather than matching lines, so a half-remembered name, a",
        "  remembered description, or a remembered error string all land.",
        '- Need one symbol\'s body. `action="show"` returns that block with its doc comment, not the file. The',
        "  file does not have to be the right one: a symbol that lives elsewhere is reported with its real",
        "  location.",
        '- Need what a file imports, or who imports it. `action="deps"` takes one file and lists its imports plus the',
        "  files that import it, with unresolved paths separated from external modules. It is file-level and",
        "  syntactic: a call graph is `usages`, and re-exports or dynamic `import()` are not followed.",
        "",
        "`outline` is a tool call, not a shell command: it takes structured arguments, and",
        "`outline digest src/auth` typed into a terminal is not a command. Unfamiliar code is",
        "usually `digest` the directory, `show` the symbol that matters, then `usages` before",
        "changing a signature:",
        "",
        '    outline(action="digest", path="src/auth")',
        '    outline(action="show", query="Auth::login")',
        '    outline(action="usages", query="Auth::login", kind="call")',
        '    outline(action="deps", path="src/auth/socket.ts")',
        "",
        'One call can carry several symbols (`query="Auth::login, Auth::logout"`); selectors split at',
        "top-level commas, a comma inside a parameter list belongs to the selector, and a leading parameter",
        "list (`Auth::login(string)`) is enough to pick an overload.",
        "",
        "Stay with `rg`/`grep` for line-level work: regex, counts, context lines, config, logs, prose outside a",
        "parsed language, and any file `outline` does not parse. `search` does read literal body text — a thrown",
        "error, a log message, an inline comment — but it answers with the declaration that contains it, one row per",
        "declaration, and only for a query of two or more words; a single word is an identifier question, not a text",
        "scan. `search` also matches declaration names, doc comments, and document frontmatter, and when those are",
        "thin it appends ranked `[related]` rows, so a conceptual query can land without a literal match; a literal",
        "zero-hit still means no identifier or doc comment spells it out. A multi-word query matches those words in",
        'any order: quote it (`"page table"`) to require them adjacent. One doc or frontmatter row means those rows',
        "are skipped, so for a file's section map search that file itself (`path=<file>`). `path` may be a",
        "literal file or directory, or an rg-style pattern: a pattern with `/` is anchored (`*` is one level,",
        '`**` crosses), and one without `/` matches the file name at any depth (`path="src/**/*.ts"`, `path="*.rs"`).',
        "`kind` narrows `digest`/`search` to one declaration kind and `usages` to `def`, `call`, or `ref`; the",
        "footer says what the filter hid, and the `# filter:` line names it even when it removed nothing. `within`",
        'limits `search`/`usages` to one file\'s direct imports (`within="src/x.ts"`, relative to the literal prefix',
        "of `path`), or with a `dependents:` prefix to the files that import it; the anchor is always included, the",
        "pattern still bounds the tree, and the `# within:` line names the scope.",
        "",
        "`path` may name any tree, not just the checkout: a memory directory (`.pi/agent/memory`,",
        "`~/.pi/agent/memory`) or a directory this session declares readable. An explicitly named tree is scanned",
        "literally, so a tree git ignores is still searchable, and the first search of a tree with no index starts",
        "one in the background — that is what makes a memory tree answer by content, not by heading title.",
        "",
        "`usages` finds candidates, not a call graph: it is syntactic, so it does not resolve overloads, generics,",
        "macros, or dynamic dispatch. When output ends with `# next: offset=N`, call again with the same",
        "parameters and that offset.",
        "",
        "Rows tagged `[related]` were ranked by relevance because name and doc matches were thin; they are",
        'guesses, so confirm with `action="show"` before relying on one.',
    ].join("\n");
}
