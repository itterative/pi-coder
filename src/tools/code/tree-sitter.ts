import { createRequire } from "node:module";
import path from "node:path";

import treeSitter from "@vscode/tree-sitter-wasm";
import type { Node as SyntaxNode, Parser, Tree } from "@vscode/tree-sitter-wasm";

import { PI_CODER_EXTENSION_DIR } from "../../common/constants";

/**
 * One tree-sitter runtime for the extension.
 *
 * The grammar package ships both the `web-tree-sitter` runtime and the compiled grammars, so the parser and
 * the grammar are guaranteed to agree on the ABI. Resolving from the extension root rather than this module's
 * URL keeps a bundled copy working: the wasm files are data, not something a bundler can inline.
 */
export type GrammarId =
    | "c-sharp"
    | "cpp"
    | "go"
    | "java"
    | "javascript"
    | "php"
    | "python"
    | "ruby"
    | "rust"
    | "tsx"
    | "typescript";

// Resolve dependencies from the extension package, not from this module's URL: a bundled copy can move the
// module or rewrite `import.meta.url`, while the package manifest still names the installed dependency tree.
// The scratch runner marks this package external so Node loads its real CommonJS file and it can find its
// own WASM assets; the default import is the form that works both bundled and loaded externally.
const requireFromExtension = createRequire(path.join(PI_CODER_EXTENSION_DIR, "package.json"));
const packageDirectory = path.dirname(
    requireFromExtension.resolve("@vscode/tree-sitter-wasm/package.json"),
);

let initialization: Promise<void> | undefined;
const parsers = new Map<GrammarId, Promise<Parser>>();

export interface SyntaxTree {
    tree: Tree;
    root: SyntaxNode;
}

export async function parseSyntax(grammar: GrammarId, source: string): Promise<SyntaxTree> {
    const parser = await parserFor(grammar);
    const tree = parser.parse(source);

    if (tree === null) {
        throw new Error(`tree-sitter returned no tree for ${grammar}`);
    }

    return { tree, root: tree.rootNode };
}

export async function parserFor(grammar: GrammarId): Promise<Parser> {
    let pending = parsers.get(grammar);

    if (pending === undefined) {
        pending = createParser(grammar);
        parsers.set(grammar, pending);
    }

    return await pending;
}

async function createParser(grammar: GrammarId): Promise<Parser> {
    await initialize();

    const language = await treeSitter.Language.load(
        path.join(packageDirectory, "wasm", `tree-sitter-${grammar}.wasm`),
    );
    const parser = new treeSitter.Parser();
    parser.setLanguage(language);

    return parser;
}

async function initialize(): Promise<void> {
    initialization ??= treeSitter.Parser.init({
        locateFile: (file) => path.join(packageDirectory, "wasm", file),
    });

    await initialization;
}

/** Count `ERROR` and missing nodes. A file with macro damage is reported, not rejected. */
export function countParseErrors(root: SyntaxNode, limit = 99): number {
    let count = 0;
    const stack = [root];

    while (stack.length > 0 && count < limit) {
        const node = stack.pop();

        if (node === undefined) {
            continue;
        }

        if (node.isError || node.isMissing) {
            count += 1;
        }

        for (let index = node.namedChildCount - 1; index >= 0; index -= 1) {
            const child = node.namedChild(index);

            if (child !== null) {
                stack.push(child);
            }
        }
    }

    return count;
}
