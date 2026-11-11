import type { Declaration, ParsedFile } from "./types";

/**
 * Version tag for the text a declaration is embedded as.
 *
 * It is part of every embedding key, so changing the text shape (fields, separators, prefix) invalidates the
 * stored vectors instead of silently mixing two representations in one index.
 *
 * v2: the doc text a Markdown heading embeds is now its section's own prose, not just the heading line, and a
 * documented declaration now embeds its signature alongside its doc comment instead of one *or* the other.
 */
export const EMBED_TEXT_VERSION = "code-retrieval-v2";

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
 * The exact text embedded for a declaration.
 *
 * `title:` + path mirrors the model card's code-retrieval document format. Doc text comes first because prose
 * carries the concept words an identifier does not spell out, and the signature follows because it carries the
 * parameter and return types: a documented `connect(const Address&)` should still be reachable by `Address`.
 * Required words only, no "either/or": the pair is what the retrieval query is matched against. The version is
 * stamped outside this string by the store key, not inside it.
 */
export function embedTextOf(file: ParsedFile, declaration: Declaration): string {
    const parts = [declarationDoc(file, declaration), declaration.signature].filter(
        (part) => part.length > 0,
    );

    return `title: ${file.path} | text: ${declaration.kind} ${declaration.qualifiedName}. ${parts.join(" ")}`;
}
