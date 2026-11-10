import { parseCppFile } from "./cpp";
import { parseCSharpFile } from "./csharp";
import { parseGoFile } from "./go";
import { parseJavaFile } from "./java";
import { parseMarkdownFile } from "./markdown";
import { parsePhpFile } from "./php";
import { parsePythonFile } from "./python";
import { parseRubyFile } from "./ruby";
import { parseRustFile } from "./rust";
import type { SupportedLanguage } from "./languages";
import { neutralizeDialect } from "./preprocess";
import type { ParsedFile } from "./types";
import type { GrammarId } from "./tree-sitter";
import { parseTypeScriptFile } from "./typescript";

/**
 * One registry entry per supported language.
 *
 * This is the only place that knows how a language is parsed. In particular, preprocessing belongs to the
 * adapter rather than to a caller: HIP/C++ has a neutralized parse buffer while JavaScript and TypeScript parse
 * the original text. `usages` resolves the same entry so its index cannot drift from the adapter's grammar.
 */
export interface CallSiteSpec {
    /** Parent node type that contains a call or construction. */
    type: string;
    /** Field naming the callable node; omitted means the first named child. */
    field?: string;
}

export interface LanguageAdapter {
    /** Undefined for line-oriented adapters such as Markdown that do not use tree-sitter. */
    grammar?: GrammarId;
    /** Prepare the parse-only buffer. Implementations must preserve byte offsets and newlines. */
    preprocess(source: string): string;
    parse(source: string, filePath: string): Promise<ParsedFile>;
    /** Node shapes that make an identifier a call target rather than a plain reference. */
    callTargets: readonly CallSiteSpec[];
    /** True for C++/HIP kernel launches, which get the `[launch]` tag. */
    kernelLaunch?: boolean;
}

const identity = (source: string): string => source;

const CPP_CALLS: readonly CallSiteSpec[] = [
    { type: "call_expression", field: "function" },
    { type: "new_expression", field: "constructor" },
];

const SCRIPT_CALLS: readonly CallSiteSpec[] = [
    { type: "call_expression", field: "function" },
    { type: "new_expression", field: "constructor" },
];

const cppAdapter: LanguageAdapter = {
    grammar: "cpp",
    preprocess: neutralizeDialect,
    parse: async (source, filePath) => await parseCppFile(source, filePath, "cpp"),
    callTargets: CPP_CALLS,
    kernelLaunch: true,
};

const hipAdapter: LanguageAdapter = {
    grammar: "cpp",
    preprocess: neutralizeDialect,
    parse: async (source, filePath) => await parseCppFile(source, filePath, "hip"),
    callTargets: CPP_CALLS,
    kernelLaunch: true,
};

const typescriptAdapter: LanguageAdapter = {
    grammar: "typescript",
    preprocess: identity,
    parse: async (source, filePath) => await parseTypeScriptFile(source, filePath, "typescript"),
    callTargets: SCRIPT_CALLS,
};

const tsxAdapter: LanguageAdapter = {
    grammar: "tsx",
    preprocess: identity,
    parse: async (source, filePath) => await parseTypeScriptFile(source, filePath, "tsx"),
    callTargets: SCRIPT_CALLS,
};

const javascriptAdapter: LanguageAdapter = {
    grammar: "javascript",
    preprocess: identity,
    parse: async (source, filePath) => await parseTypeScriptFile(source, filePath, "javascript"),
    callTargets: SCRIPT_CALLS,
};

const javaAdapter: LanguageAdapter = {
    grammar: "java",
    preprocess: identity,
    parse: parseJavaFile,
    callTargets: [
        { type: "method_invocation", field: "name" },
        { type: "object_creation_expression", field: "type" },
    ],
};

const csharpAdapter: LanguageAdapter = {
    grammar: "c-sharp",
    preprocess: identity,
    parse: parseCSharpFile,
    callTargets: [
        { type: "invocation_expression", field: "function" },
        { type: "object_creation_expression", field: "type" },
    ],
};

const goAdapter: LanguageAdapter = {
    grammar: "go",
    preprocess: identity,
    parse: parseGoFile,
    callTargets: [{ type: "call_expression", field: "function" }],
};

const rustAdapter: LanguageAdapter = {
    grammar: "rust",
    preprocess: identity,
    parse: parseRustFile,
    callTargets: [
        { type: "call_expression", field: "function" },
        { type: "macro_invocation", field: "macro" },
    ],
};

const pythonAdapter: LanguageAdapter = {
    grammar: "python",
    preprocess: identity,
    parse: parsePythonFile,
    callTargets: [{ type: "call", field: "function" }],
};

const phpAdapter: LanguageAdapter = {
    grammar: "php",
    preprocess: identity,
    parse: parsePhpFile,
    callTargets: [
        { type: "function_call_expression", field: "function" },
        { type: "member_call_expression", field: "name" },
        { type: "scoped_call_expression", field: "name" },
        { type: "object_creation_expression" },
    ],
};

const rubyAdapter: LanguageAdapter = {
    grammar: "ruby",
    preprocess: identity,
    parse: parseRubyFile,
    callTargets: [{ type: "call", field: "method" }],
};

const markdownAdapter: LanguageAdapter = {
    preprocess: identity,
    parse: parseMarkdownFile,
    callTargets: [],
};

const ADAPTERS: Record<SupportedLanguage, LanguageAdapter> = {
    cpp: cppAdapter,
    csharp: csharpAdapter,
    go: goAdapter,
    hip: hipAdapter,
    java: javaAdapter,
    javascript: javascriptAdapter,
    markdown: markdownAdapter,
    php: phpAdapter,
    python: pythonAdapter,
    ruby: rubyAdapter,
    rust: rustAdapter,
    tsx: tsxAdapter,
    typescript: typescriptAdapter,
};

export function adapterForLanguage(language: string): LanguageAdapter {
    const adapter = ADAPTERS[language as SupportedLanguage];

    if (adapter === undefined) {
        throw new Error(`outline: no parser adapter for ${language}`);
    }

    return adapter;
}

/** Parse a source buffer through the language's adapter. */
export async function parseWithAdapter(
    source: string,
    filePath: string,
    language: SupportedLanguage,
): Promise<ParsedFile> {
    return await adapterForLanguage(language).parse(source, filePath);
}

/** Prepare the parse-only buffer through the language's adapter. */
export function preprocessWithAdapter(language: string, source: string): string {
    return adapterForLanguage(language).preprocess(source);
}

/** Resolve the grammar a language adapter uses. */
export function grammarForAdapter(language: string): GrammarId | undefined {
    return adapterForLanguage(language).grammar;
}
