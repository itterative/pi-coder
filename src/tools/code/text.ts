import { commentSyntaxFor, commentTextIn } from "./comments";
import type { Declaration, ParsedFile } from "./types";

/** Lowercase and collapse punctuation, so a query word matches hyphenated and spaced text alike. */
export function normalizeText(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * A source slice with comments removed and string literals left alone.
 *
 * A signature is a *slice*, not a syntax tree, so a regex cannot tell a comment from a URL or a glob. The old
 * block-comment pattern ate everything from `` `${directory}/**` `` to the next closing marker in the same array
 * literal, which is how a digest row came out with no slashes and unbalanced quotes — silently wrong text, not a
 * cosmetic cut. A scanner that tracks quotes and escapes is the whole distinction a signature needs.
 *
 * A marker only starts a comment when the character before it is whitespace, the start of the slice, or closing
 * punctuation. That is what keeps the `//` inside a regex literal (`/a\/\//`) or a path fragment from swallowing the
 * rest of the signature; a comment glued directly to an identifier is left as text, which is honest and rare.
 *
 * Hash comments are not stripped: no adapter strips them today, and `#` is also a C/C++ preprocessor marker.
 */
export function stripComments(text: string): string {
    const opensComment = new Set([
        "",
        " ",
        "\t",
        "\n",
        "\r",
        ";",
        "{",
        "}",
        "(",
        ")",
        "[",
        "]",
        ",",
    ]);
    let out = "";
    let index = 0;

    while (index < text.length) {
        const character = text[index];

        if (character === '"' || character === "'" || character === "`") {
            const end = literalEnd(text, index);

            out += text.slice(index, end);
            index = end;

            continue;
        }

        const before = index === 0 ? "" : (text[index - 1] ?? "");

        if (character === "/" && text[index + 1] === "*" && opensComment.has(before)) {
            const end = text.indexOf("*/", index + 2);

            out += " ";
            index = end === -1 ? text.length : end + 2;

            continue;
        }

        if (character === "/" && text[index + 1] === "/" && opensComment.has(before)) {
            const end = text.indexOf("\n", index + 2);

            index = end === -1 ? text.length : end;

            continue;
        }

        out += character;
        index += 1;
    }

    return out;
}

/** One past the closing quote of the literal that starts at `start`, or the end of the text. */
function literalEnd(text: string, start: number): number {
    const quote = text[start];
    let index = start + 1;

    while (index < text.length) {
        if (text[index] === "\\") {
            index += 2;

            continue;
        }

        if (text[index] === quote) {
            return index + 1;
        }

        index += 1;
    }

    return text.length;
}

/**
 * Version tag for the text a declaration is embedded as.
 *
 * It is part of every embedding key, so changing the text shape (fields, separators, prefix) invalidates the
 * stored vectors instead of silently mixing two representations in one index.
 *
 * v2: the doc text a Markdown heading embeds is now its section's own prose, not just the heading line, and a
 * documented declaration now embeds its signature alongside its doc comment instead of one *or* the other.
 * v3: the embedder truncates at 1024 tokens instead of 512. The text is unchanged, so the version is what forces a
 * rebuild — keys would otherwise keep a vector computed on the truncated text and quietly mix it with new ones.
 * v4: a declaration's inline body comments join the document, so a concept that lives in a note between statements
 * is reachable without a doc block. Chunked body vectors (`semantic/chunks.ts`) are keyed by the same version, and
 * the chunk header format is part of it: changing either invalidates both.
 */
export const EMBED_TEXT_VERSION = "code-retrieval-v4";

/**
 * A declaration's doc text as plain prose: a doc comment, or a Markdown section's own prose.
 *
 * A comment range includes its markers, which carry no meaning for a tokenizer or an embedding model, so they are
 * stripped and whitespace is collapsed. Markdown prose is not a comment: stripping `*` runs there would eat list
 * bullets and emphasis, so that path only collapses whitespace. Callers that need matching normalization
 * (punctuation collapsed, lowercased) apply it on top; this keeps the raw-ish text available to the embedder.
 */
export function declarationDoc(file: ParsedFile, declaration: Declaration): string {
    const range = declaration.docRange;

    if (range === undefined) {
        return "";
    }

    const text = file.source.slice(range.startIndex, range.endIndex);
    const plain =
        file.language === "markdown"
            ? text
            : text
                  .replace(/\/\*+/g, " ")
                  .replace(/\*+\//g, " ")
                  .replace(/^\s*\*+/gm, " ")
                  .replace(/^\s*\/\/+/gm, " ");

    return plain.replace(/\s+/g, " ").trim();
}

/**
 * The inline comments inside a declaration's body, with markers stripped.
 *
 * The doc channel reads the block *above* a declaration; this reads the notes *between* its statements, which is
 * where an implementation detail usually explains itself. Capped and cached per declaration: the same text is
 * embedded by the head vector on every search, so recomputing it would cost a body scan per declaration per query.
 */
const commentCache = new WeakMap<Declaration, string>();

export function declarationComments(file: ParsedFile, declaration: Declaration): string {
    const cached = commentCache.get(declaration);

    if (cached !== undefined) {
        return cached;
    }

    const syntax = commentSyntaxFor(file.language);
    const range = declaration.bodyRange;
    const text =
        syntax === undefined || range === undefined
            ? ""
            : commentTextIn(file.source, range.startIndex, range.endIndex, syntax);

    commentCache.set(declaration, text);

    return text;
}

/**
 * The exact text embedded for a declaration.
 *
 * `title:` + path mirrors the model card's code-retrieval document format. Doc text comes first because prose
 * carries the concept words an identifier does not spell out, then inline body comments, then the signature
 * because it carries the parameter and return types: a documented `connect(const Address&)` should still be
 * reachable by `Address`. Required words only, no "either/or": the parts are what the retrieval query is matched
 * against. The version is stamped outside this string by the store key, not inside it.
 */
export function embedTextOf(file: ParsedFile, declaration: Declaration): string {
    const parts = [
        declarationDoc(file, declaration),
        declarationComments(file, declaration),
        declaration.signature,
    ].filter((part) => part.length > 0);

    return `title: ${file.path} | text: ${declaration.kind} ${declaration.qualifiedName}. ${parts.join(" ")}`;
}
