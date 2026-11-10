/** Defaults shared by discovery, limits, and formatting. Callers can narrow them per request. */

/** The adapters `parseCodeFile` can dispatch to. */
export type SupportedLanguage =
    | "cpp"
    | "csharp"
    | "go"
    | "hip"
    | "java"
    | "javascript"
    | "markdown"
    | "php"
    | "python"
    | "ruby"
    | "rust"
    | "tsx"
    | "typescript";

/** Files above this size are listed as skipped instead of parsed. A generated source file can be enormous. */
export const MAX_FILE_BYTES = 1_000_000;

/** Upper bound on files considered by one call; the digest degrades to a directory map beyond this. */
export const MAX_FILES = 2_000;

/** Default maximum rendered result size, in characters. */
export const DEFAULT_CHAR_LIMIT = 4_000;

/** Lowest character limit worth honoring; below this the header alone is most of the output. */
export const MIN_CHAR_LIMIT = 800;

export const CXX_EXTENSIONS = new Set([
    ".h",
    ".hh",
    ".hpp",
    ".hxx",
    ".h++",
    ".c",
    ".cc",
    ".cpp",
    ".cxx",
    ".c++",
    ".ipp",
    ".tpp",
    ".inl",
    ".inc",
    ".ixx",
    ".cppm",
    ".hip",
    ".cu",
    ".cuh",
]);

const HIP_EXTENSIONS = new Set([".hip", ".cu", ".cuh"]);

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

const JAVA_EXTENSIONS = new Set([".java"]);

const CSHARP_EXTENSIONS = new Set([".cs"]);

const GO_EXTENSIONS = new Set([".go"]);

const RUST_EXTENSIONS = new Set([".rs"]);

const PYTHON_EXTENSIONS = new Set([".py", ".pyi", ".pyw"]);

const PHP_EXTENSIONS = new Set([".php", ".phtml"]);

const RUBY_EXTENSIONS = new Set([".rb", ".rake", ".gemspec"]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

/** Directories that never belong in a source navigation result. */
const IGNORED_DIRECTORIES = new Set([
    ".git",
    ".cache",
    "build",
    "out",
    "dist",
    "CMakeFiles",
    "_deps",
    "node_modules",
    "third_party",
    "vendor",
    "external",
    "generated",
    "gen",
]);

/** Globs handed to the container's rg-backed glob. Kept in step with `shouldIgnorePath`. */
export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
    ...Array.from(IGNORED_DIRECTORIES, (directory) => `${directory}/**`),
    "cmake-build-*/**",
    "moc_*/**",
    "ui_*/**",
    "*.pb.*",
    "*_generated.*",
    "*.min.*",
    "*.g.h",
];

/** The language label for a supported path, or undefined when the file is not parsed by this tool. */
export function languageForPath(filePath: string): SupportedLanguage | undefined {
    const extension = extensionOf(filePath);

    if (extension === ".tsx") {
        return "tsx";
    }

    if (TYPESCRIPT_EXTENSIONS.has(extension)) {
        return "typescript";
    }

    if (JAVASCRIPT_EXTENSIONS.has(extension)) {
        return "javascript";
    }

    if (JAVA_EXTENSIONS.has(extension)) {
        return "java";
    }

    if (CSHARP_EXTENSIONS.has(extension)) {
        return "csharp";
    }

    if (GO_EXTENSIONS.has(extension)) {
        return "go";
    }

    if (RUST_EXTENSIONS.has(extension)) {
        return "rust";
    }

    if (PYTHON_EXTENSIONS.has(extension)) {
        return "python";
    }

    if (PHP_EXTENSIONS.has(extension)) {
        return "php";
    }

    if (RUBY_EXTENSIONS.has(extension)) {
        return "ruby";
    }

    if (MARKDOWN_EXTENSIONS.has(extension)) {
        return "markdown";
    }

    if (HIP_EXTENSIONS.has(extension)) {
        return "hip";
    }

    if (CXX_EXTENSIONS.has(extension)) {
        return "cpp";
    }

    return undefined;
}

export function isSupportedPath(filePath: string): boolean {
    return languageForPath(filePath) !== undefined;
}

export function extensionOf(filePath: string): string {
    const base = filePath.slice(filePath.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");

    return dot < 0 ? "" : base.slice(dot).toLowerCase();
}

/** True for a path that a local walk should not descend into or report. */
export function shouldIgnorePath(relativePath: string): boolean {
    const segments = relativePath.split(/[\\/]/).filter((segment) => segment.length > 0);

    if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) {
        return true;
    }

    if (
        segments.some(
            (segment) =>
                segment.startsWith("cmake-build-") || segment === "moc" || segment === "ui",
        )
    ) {
        return true;
    }

    const name = segments.at(-1) ?? "";

    return (
        name.startsWith("moc_") ||
        name.startsWith("ui_") ||
        name.endsWith(".pb.h") ||
        name.endsWith(".pb.cc") ||
        name.includes("_generated.") ||
        name.endsWith(".min.js") ||
        name.endsWith(".min.css") ||
        name.endsWith(".g.h")
    );
}

/** A compact size label for one file in a digest. */
export function sizeLabel(lineCount: number): "tiny" | "medium" | "large" | "huge" {
    if (lineCount <= 120) {
        return "tiny";
    }

    if (lineCount <= 500) {
        return "medium";
    }

    if (lineCount <= 1_500) {
        return "large";
    }

    return "huge";
}
