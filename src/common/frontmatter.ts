import { parseFrontmatter as parsePiFrontmatter } from "@earendil-works/pi-coding-agent";

export interface ParsedFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
    frontmatter: T;
    body: string;
}

const MAX_FRONTMATTER_LINES = 128;

export class FrontmatterParseError extends Error {
    constructor(
        public readonly filePath: string,
        reason: string,
    ) {
        super(`${filePath}: ${reason}`);
        this.name = "FrontmatterParseError";
    }
}

function normalizeNewlines(content: string): string {
    return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function extractFrontmatter(
    content: string,
    filePath: string,
): { yaml: string; body: string } | undefined {
    const normalized = normalizeNewlines(content);
    const openingEnd = normalized.indexOf("\n");
    const openingLine = openingEnd === -1 ? normalized : normalized.slice(0, openingEnd);

    if (openingLine !== "---") {
        return undefined;
    }

    if (openingEnd === -1) {
        throw new FrontmatterParseError(
            filePath,
            "missing closing YAML frontmatter delimiter (---)",
        );
    }

    let lineStart = openingEnd + 1;
    while (lineStart <= normalized.length) {
        const lineEnd = normalized.indexOf("\n", lineStart);
        const end = lineEnd === -1 ? normalized.length : lineEnd;
        const line = normalized.slice(lineStart, end);

        if (/^---[ \t]*$/.test(line)) {
            const bodyStart = lineEnd === -1 ? normalized.length : lineEnd + 1;
            return {
                yaml: normalized.slice(openingEnd + 1, lineStart),
                body: normalized.slice(bodyStart),
            };
        }

        if (lineEnd === -1) break;
        lineStart = lineEnd + 1;
    }

    throw new FrontmatterParseError(filePath, "missing closing YAML frontmatter delimiter (---)");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unquoteLegacyValue(value: string): string {
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        return value.slice(1, -1);
    }
    return value;
}

/**
 * The original memory parser accepted quoted scalar values spanning multiple
 * physical lines. That is not accepted by the YAML parser used by pi, so keep
 * this narrowly scoped compatibility path for existing memory files.
 */
function parseLegacyMultilineScalars(yaml: string): Record<string, unknown> | undefined {
    const lines = yaml.split("\n");
    const fields: Record<string, unknown> = {};
    let foundLegacyScalar = false;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trimEnd();
        const colonIndex = line.indexOf(":");
        if (colonIndex <= 0) continue;

        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        let quote: '"' | "'" | undefined;
        if (value.startsWith('"')) {
            quote = '"';
        } else if (value.startsWith("'")) {
            quote = "'";
        }
        if (!quote || value.endsWith(quote)) {
            fields[key] = unquoteLegacyValue(value);
            continue;
        }

        const parts = [value];
        let closed = false;
        for (index += 1; index < lines.length; index++) {
            const part = lines[index];
            parts.push(part);
            if (part.endsWith(quote)) {
                closed = true;
                break;
            }
        }
        if (!closed) return undefined;

        foundLegacyScalar = true;
        fields[key] = unquoteLegacyValue(parts.join("\n"));
    }

    return foundLegacyScalar ? fields : undefined;
}

/**
 * Parse YAML frontmatter while preserving the Markdown body.
 *
 * Files without an opening delimiter are treated as ordinary Markdown. Files
 * with an opening delimiter must have a closing delimiter and a mapping as
 * their YAML value. YAML parser failures are normalized to a project error so
 * callers can report the source file consistently.
 */
export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
    content: string,
    filePath = "<frontmatter>",
): ParsedFrontmatter<T> {
    const extracted = extractFrontmatter(content, filePath);
    if (!extracted) {
        return { frontmatter: {} as T, body: normalizeNewlines(content) };
    }
    if (extracted.yaml.split("\n").length > MAX_FRONTMATTER_LINES) {
        throw new FrontmatterParseError(
            filePath,
            `frontmatter exceeds ${MAX_FRONTMATTER_LINES} lines, is it malformed?`,
        );
    }

    let frontmatter: unknown;
    try {
        // Reuse pi-coding-agent's YAML-backed parser. The synthetic document
        // prevents its body extraction from affecting the body we preserve.
        frontmatter = parsePiFrontmatter(`---\n${extracted.yaml}\n---\n`).frontmatter;
    } catch (error) {
        const legacy = parseLegacyMultilineScalars(extracted.yaml);
        if (legacy) {
            frontmatter = legacy;
        } else {
            const reason = error instanceof Error ? error.message : String(error);
            throw new FrontmatterParseError(filePath, `invalid YAML frontmatter: ${reason}`);
        }
    }

    if (frontmatter === null || frontmatter === undefined) {
        return { frontmatter: {} as T, body: extracted.body };
    }
    if (!isRecord(frontmatter)) {
        throw new FrontmatterParseError(filePath, "frontmatter must contain a YAML mapping");
    }

    return { frontmatter: frontmatter as T, body: extracted.body };
}
