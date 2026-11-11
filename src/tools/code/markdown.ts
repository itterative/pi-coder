import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import type { Declaration, ParsedFile } from "./types";
import { DeclarationVisitor, cleanName } from "./visitor";

/**
 * Markdown has no tree-sitter grammar in the bundled WASM package. Headings are simple enough to map with a
 * line scanner: ATX (`## Title`) and setext (`Title` + `---`) headings, excluding fenced code blocks.
 *
 * A heading is a declaration whose range runs to the next heading of the same or higher level, so `show`
 * returns the entire section. Nested headings are children, which makes `digest` read like a table of contents.
 * Markdown has no identifiers, so `usages` has nothing to index for these files.
 */
export async function parseMarkdownFile(source: string, filePath: string): Promise<ParsedFile> {
    const visitor = new MarkdownVisitor(source);

    visitor.scan();

    return {
        path: filePath,
        language: "markdown",
        size: Buffer.byteLength(source),
        lineCount: visitor.lineCount,
        parseErrors: 0,
        source,
        roots: visitor.roots,
        all: visitor.all,
    };
}

interface Heading {
    level: number;
    title: string;
    startIndex: number;
    signatureEnd: number;
    /** Where the section's own prose starts: after the heading line, or after a setext underline. */
    bodyStart: number;
}

class MarkdownVisitor extends DeclarationVisitor {
    constructor(source: string) {
        super(source, "markdown");
    }

    visit(_root: SyntaxNode): void {
        // The line scanner owns the structure; the base class owns ranges, signatures, and dedupe.
    }

    scan(): void {
        this.visitHeadings(scanHeadings(this.source, this.lineStarts));
    }

    private visitHeadings(headings: readonly Heading[]): void {
        const stack: Array<{ level: number; declaration: Declaration }> = [];

        for (const [index, heading] of headings.entries()) {
            while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) {
                stack.pop();
            }

            const parent = stack.at(-1)?.declaration;
            const declaration = this.addDeclaration(
                {
                    kind: "heading",
                    name: cleanName(heading.title),
                    scope: parent?.qualifiedName ?? "",
                    startIndex: heading.startIndex,
                    endIndex: sectionEnd(headings, heading, this.source.length),
                    signatureEnd: heading.signatureEnd,
                    // A heading has no comment, so its doc text is its own prose. The doc tier, BM25, and the
                    // embedding channel all read this field, which is what makes a memory findable by content
                    // instead of by title.
                    docRange: proseRange(this.source, headings, index),
                    isDefinition: true,
                    dedupeKey: `heading\u0000${heading.startIndex}`,
                },
                parent,
            );

            stack.push({ level: heading.level, declaration });
        }
    }
}

function scanHeadings(source: string, lineStarts: readonly number[]): Heading[] {
    const lines = source.split("\n");
    const headings: Heading[] = [];
    const state: ScanState = { frontMatter: false, fence: undefined };

    for (let index = 0; index < lines.length; index += 1) {
        const line = withoutCarriageReturn(lines[index] ?? "");

        if (consumeFrontMatter(line, index, state)) {
            continue;
        }

        if (consumeFence(line, state)) {
            continue;
        }

        const found = headingAt(
            line,
            withoutCarriageReturn(lines[index + 1] ?? ""),
            lineStarts[index] ?? 0,
            lineEnd(source, lineStarts, index),
        );

        if (found === undefined) {
            continue;
        }

        headings.push(found.heading);

        if (found.setext) {
            // The underline belongs to the heading, not to the prose that follows it.
            found.heading.bodyStart = lineEnd(source, lineStarts, index + 1);
            index += 1;
        }
    }

    return headings;
}

interface ScanState {
    frontMatter: boolean;
    fence?: { marker: string; length: number };
}

interface FoundHeading {
    heading: Heading;
    setext: boolean;
}

function consumeFrontMatter(line: string, index: number, state: ScanState): boolean {
    if (index === 0 && line.trim() === "---") {
        state.frontMatter = true;

        return true;
    }

    if (!state.frontMatter) {
        return false;
    }

    if (line.trim() === "---" || line.trim() === "...") {
        state.frontMatter = false;
    }

    return true;
}

function consumeFence(line: string, state: ScanState): boolean {
    if (state.fence !== undefined) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        const marker = closing?.[1] ?? "";

        if (
            marker.length > 0 &&
            marker[0] === state.fence.marker &&
            marker.length >= state.fence.length
        ) {
            state.fence = undefined;
        }

        return true;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (opening === null) {
        return false;
    }

    const marker = opening[1] ?? "";

    state.fence = { marker: marker[0] ?? "", length: marker.length };

    return true;
}

function headingAt(
    line: string,
    nextLine: string,
    startIndex: number,
    signatureEnd: number,
): FoundHeading | undefined {
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);

    if (atx !== null) {
        const title = cleanHeading(atx[2] ?? "");

        return title.length === 0
            ? undefined
            : {
                  heading: {
                      level: (atx[1] ?? "").length,
                      title,
                      startIndex,
                      signatureEnd,
                      bodyStart: signatureEnd,
                  },
                  setext: false,
              };
    }

    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(nextLine);
    const title = cleanHeading(line);

    if (setext === null || title.length === 0) {
        return undefined;
    }

    return {
        heading: {
            level: setext[1]?.startsWith("=") === true ? 1 : 2,
            title,
            startIndex,
            signatureEnd,
            bodyStart: signatureEnd,
        },
        setext: true,
    };
}

function lineEnd(source: string, lineStarts: readonly number[], index: number): number {
    const next = lineStarts[index + 1];

    return next === undefined ? source.length : next - 1;
}

function withoutCarriageReturn(line: string): string {
    return line.replace(/\r$/, "");
}

function sectionEnd(headings: readonly Heading[], heading: Heading, sourceLength: number): number {
    const next = headings.find(
        (candidate) =>
            candidate.startIndex > heading.startIndex && candidate.level <= heading.level,
    );

    return next?.startIndex ?? sourceLength;
}

/**
 * The section's own prose: from the end of the heading line to the next heading of *any* level.
 *
 * Not the whole section, which `range` already covers: a parent heading that carried its children's text would
 * duplicate every subsection in the doc tier, the BM25 document, and the embedded vector. Surrounding blank
 * lines are trimmed, and a heading with no prose gets no doc range at all.
 */
function proseRange(
    source: string,
    headings: readonly Heading[],
    index: number,
): { startIndex: number; endIndex: number } | null {
    const heading = headings[index];
    let start = heading?.bodyStart ?? 0;
    let end = headings[index + 1]?.startIndex ?? source.length;

    while (start < end && isWhitespace(source[start])) {
        start += 1;
    }

    while (end > start && isWhitespace(source[end - 1])) {
        end -= 1;
    }

    return end > start ? { startIndex: start, endIndex: end } : null;
}

function isWhitespace(character: string | undefined): boolean {
    return character === undefined || /\s/.test(character);
}

function cleanHeading(text: string): string {
    return cleanName(text.replace(/[ \t]+#+[ \t]*$/, ""));
}
