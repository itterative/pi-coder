/**
 * HIP/CUDA dialect neutralization.
 *
 * `tree-sitter-cpp` parses standard C++ and chokes on the two things HIP and CUDA add: execution-space
 * qualifiers (`__global__`, `__shared__`, …) and launch syntax (`kernel<<<grid, block>>>(args)`). Both are
 * replaced with **same-length** stand-ins, preserving every newline and byte offset, so the tree-sitter tree
 * still indexes the original source exactly and every output slice is taken from the original text.
 *
 * The replacement values only have to parse. They are never shown: callers parse `parseSource` and slice
 * `source`. This is why `__global__` can become `constexpr ` and `__host__` can become `static  `.
 */
const QUALIFIERS = new Map<string, string>([
    ["__global__", "constexpr "],
    ["__device__", "constexpr "],
    ["__host__", "static  "],
    ["__shared__", "constexpr "],
    ["__constant__", "constexpr   "],
    ["__managed__", "constexpr  "],
    ["__restrict__", "restrict    "],
    ["__grid_constant__", "constexpr        "],
    ["__forceinline__", "inline         "],
]);

for (const [name, replacement] of QUALIFIERS) {
    if (name.length !== replacement.length) {
        throw new Error(`dialect neutralizer: ${name} replacement must preserve length`);
    }
}

/** Whether a macro is a declaration specifier the parser can drop (`MYLIB_API`, `FMT_CONSTEXPR20`). */
export function isDeclarationPrefixMacro(identifier: string): boolean {
    return DECLARATION_PREFIX_MACRO.test(identifier);
}

/** Qualifier-like macros that take a parenthesized argument list. */
const CALL_LIKE_QUALIFIERS = new Set(["__launch_bounds__", "__align__", "__attribute__"]);

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;
const ALL_CAPS_IDENTIFIER = /^[A-Z][A-Z0-9_]*$/;

/** Macro specifiers that precede a declaration and can be replaced without losing the declaration. */
const DECLARATION_PREFIX_MACRO =
    /^(?:[A-Z][A-Z0-9]*_)+(?:API|EXPORT|INLINE|CONSTEXPR\d*|FORCEINLINE|NODISCARD|DEPRECATED|MAYBE_UNUSED|NOEXCEPT|CONSTEVAL|CONSTINIT|(?:AVX|SSE|NEON|FMA)[A-Z0-9_]*)$/;

/** Prefix macros whose parenthesized argument list is part of the macro, not the declaration. */
const CALL_LIKE_PREFIX_MACRO =
    /^(?:[A-Z][A-Z0-9]*_)+(?:API|EXPORT|INLINE|NODISCARD|DEPRECATED|MAYBE_UNUSED|NOEXCEPT)$/;

interface Replacement {
    text: string;
    next: number;
}

export function neutralizeDialect(source: string): string {
    const parts: string[] = [];
    let index = 0;

    while (index < source.length) {
        const literal = consumeLiteral(source, index);

        if (literal !== undefined) {
            parts.push(literal.text);
            index = literal.next;

            continue;
        }

        const directive = consumePreprocessor(source, index);

        if (directive !== undefined) {
            parts.push(directive.text);
            index = directive.next;

            continue;
        }

        const attribute = consumeAttribute(source, index);

        if (attribute !== undefined) {
            parts.push(attribute.text);
            index = attribute.next;

            continue;
        }

        const emptyInitializer = consumeEmptyInitializer(source, index);

        if (emptyInitializer !== undefined) {
            parts.push(emptyInitializer.text);
            index = emptyInitializer.next;

            continue;
        }

        if (IDENTIFIER_START.test(source[index] ?? "")) {
            const identifier = consumeIdentifier(source, index);

            parts.push(identifier.text);
            index = identifier.next;

            continue;
        }

        parts.push(source[index] ?? "");
        index += 1;
    }

    return parts.join("");
}

/** Comments, strings, characters, and launch syntax pass through (or are blanked) before identifier handling. */
function consumeLiteral(source: string, index: number): Replacement | undefined {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (char === "/" && next === "/") {
        const end = source.indexOf("\n", index);
        const stop = end < 0 ? source.length : end;

        return { text: source.slice(index, stop), next: stop };
    }

    if (char === "/" && next === "*") {
        const end = source.indexOf("*/", index + 2);
        const stop = end < 0 ? source.length : end + 2;

        return { text: source.slice(index, stop), next: stop };
    }

    if (char === '"' || char === "'") {
        const stop = endOfQuoted(source, index, char);

        return { text: source.slice(index, stop), next: stop };
    }

    if (char === "<" && next === "<" && source[index + 2] === "<") {
        const end = source.indexOf(">>>", index + 3);

        if (end >= 0) {
            return { text: spaceOut(source.slice(index, end + 3)), next: end + 3 };
        }
    }

    return undefined;
}

function consumeIdentifier(source: string, start: number): Replacement {
    let end = start + 1;

    while (end < source.length && IDENTIFIER_PART.test(source[end] ?? "")) {
        end += 1;
    }

    const identifier = source.slice(start, end);
    const replacement = QUALIFIERS.get(identifier);

    if (replacement !== undefined) {
        return { text: replacement, next: end };
    }

    if (CALL_LIKE_QUALIFIERS.has(identifier)) {
        const stop = endOfCall(source, end);

        return { text: spaceOut(source.slice(start, stop)), next: stop };
    }

    if (isDeclarationPrefixMacro(identifier)) {
        let stop = end;

        if (CALL_LIKE_PREFIX_MACRO.test(identifier)) {
            let cursor = end;

            while (cursor < source.length && /[ \t\r]/.test(source[cursor] ?? "")) {
                cursor += 1;
            }

            if (source[cursor] === "(") {
                stop = endOfCall(source, cursor);
            }
        }

        return { text: spaceOut(source.slice(start, stop)), next: stop };
    }

    if (ALL_CAPS_IDENTIFIER.test(identifier)) {
        const stop = standaloneMacroEnd(source, end);

        if (stop !== undefined) {
            return { text: spaceOut(source.slice(start, stop)), next: stop };
        }
    }

    return { text: identifier, next: end };
}

/**
 * A line containing only an all-caps macro invocation (optionally with arguments) is a declaration-boundary
 * macro, not a declaration: `FMT_BEGIN_NAMESPACE`, `FMT_END_EXPORT`, `UCLASS(...)`, `GENERATED_BODY()`.
 * Replacing it with spaces keeps every offset and lets the following declaration parse.
 */
function standaloneMacroEnd(source: string, identifierEnd: number): number | undefined {
    let cursor = identifierEnd;

    while (cursor < source.length && /[ \t\r]/.test(source[cursor] ?? "")) {
        cursor += 1;
    }

    if (source[cursor] === "(") {
        cursor = endOfCall(source, cursor);
    }

    while (cursor < source.length && /[ \t\r]/.test(source[cursor] ?? "")) {
        cursor += 1;
    }

    if (cursor >= source.length || source[cursor] === "\n") {
        return cursor;
    }

    if (source[cursor] === "/" && source[cursor + 1] === "/") {
        const end = source.indexOf("\n", cursor);

        return end < 0 ? source.length : end;
    }

    return undefined;
}

/**
 * Copy a preprocessor directive verbatim, including backslash continuations.
 *
 * The directive's identifiers are not declaration prefixes: blanking the name in `#define VIBES_AVX2` or the
 * guard in `#ifndef VIBES_KERNEL_HASH` turns a harmless directive into an error node. Code inside the branch is
 * still neutralized normally; only the directive line is skipped.
 */
function consumePreprocessor(source: string, index: number): Replacement | undefined {
    if (source[index] !== "#") {
        return undefined;
    }

    let lineStart = index;

    while (lineStart > 0 && (source[lineStart - 1] === " " || source[lineStart - 1] === "\t")) {
        lineStart -= 1;
    }

    if (lineStart > 0 && source[lineStart - 1] !== "\n") {
        return undefined;
    }

    let cursor = index;

    while (cursor < source.length) {
        const newline = source.indexOf("\n", cursor);
        const end = newline < 0 ? source.length : newline;
        const line = source.slice(cursor, end);

        cursor = newline < 0 ? source.length : newline + 1;

        if (!line.endsWith("\\")) {
            break;
        }
    }

    return { text: source.slice(index, cursor), next: cursor };
}

/** Blank a C++ `[[...]]` attribute; the declaration it decorates still has to parse. */
function consumeAttribute(source: string, index: number): Replacement | undefined {
    if (source[index] !== "[" || source[index + 1] !== "[") {
        return undefined;
    }

    const end = source.indexOf("]]", index + 2);

    if (end < 0) {
        return undefined;
    }

    return { text: spaceOut(source.slice(index, end + 2)), next: end + 2 };
}

/**
 * Turn `= {}` into `= 0` without changing its length.
 *
 * Empty brace initializers are valid C++, but tree-sitter-cpp turns a default argument like
 * `const Header& header = {}` into a compound-literal error. A scalar stand-in parses, and the output always
 * comes from the original source, so the caller still sees `= {}`.
 */
function consumeEmptyInitializer(source: string, index: number): Replacement | undefined {
    if (source[index] !== "=") {
        return undefined;
    }

    let cursor = index + 1;

    while (cursor < source.length && /\s/.test(source[cursor] ?? "")) {
        cursor += 1;
    }

    if (source[cursor] !== "{" || source[cursor + 1] !== "}") {
        return undefined;
    }

    const chars = spaceOut(source.slice(index, cursor + 2)).split("");

    chars[0] = "=";
    chars[cursor - index] = "0";

    return { text: chars.join(""), next: cursor + 2 };
}

function endOfQuoted(source: string, start: number, quote: string): number {
    let index = start + 1;

    while (index < source.length) {
        const char = source[index];

        if (char === "\\") {
            index += 2;

            continue;
        }

        index += 1;

        if (char === quote) {
            return index;
        }
    }

    return source.length;
}

/** Replace a call-like macro through its balanced close paren, preserving newlines. */
function endOfCall(source: string, start: number): number {
    let index = start;

    while (index < source.length && /\s/.test(source[index] ?? "")) {
        index += 1;
    }

    if (source[index] !== "(") {
        return index;
    }

    let depth = 0;

    while (index < source.length) {
        const char = source[index];

        if (char === "/" && source[index + 1] === "/") {
            const end = source.indexOf("\n", index);
            index = end < 0 ? source.length : end;

            continue;
        }

        if (char === "/" && source[index + 1] === "*") {
            const end = source.indexOf("*/", index + 2);
            index = end < 0 ? source.length : end + 2;

            continue;
        }

        if (char === '"' || char === "'") {
            index = endOfQuoted(source, index, char);

            continue;
        }

        if (char === "(") {
            depth += 1;
        } else if (char === ")") {
            depth -= 1;

            if (depth === 0) {
                return index + 1;
            }
        }

        index += 1;
    }

    return source.length;
}

function spaceOut(text: string): string {
    return text.replace(/[^\r\n]/g, " ");
}
