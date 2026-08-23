/**
 * Minimal YAML frontmatter parser for flat key-value pairs.
 *
 * Handles single-line values, quoted (single/double) values, and multi-line
 * quoted strings. Intentionally avoids importing a full YAML library since the
 * memory schema only needs `name` and `description` as plain strings.
 */

export interface MemoryMeta {
    name: string;
    description: string;
    category?: string;
    priority?: number;
    keep_updated?: boolean;
    status?: string;
}

export class FrontmatterParseError extends Error {
    constructor(
        public readonly filePath: string,
        reason: string,
    ) {
        super(`${filePath}: ${reason}`);
        this.name = "FrontmatterParseError";
    }
}

function extractFrontmatterBlock(content: string, filePath: string): string {
    if (!content.startsWith("---")) {
        throw new FrontmatterParseError(filePath, "content must start with YAML frontmatter delimiters (---)");
    }

    // Find the closing --- (skip the opening line)
    const afterOpening = content.indexOf("\n", 3);
    if (afterOpening === -1) {
        throw new FrontmatterParseError(filePath, "missing closing YAML frontmatter delimiter (---)");
    }

    const rest = content.slice(afterOpening + 1);
    const closeIdx = rest.indexOf("\n---");
    if (closeIdx === -1) {
        throw new FrontmatterParseError(filePath, "missing closing YAML frontmatter delimiter (---)");
    }

    return rest.slice(0, closeIdx);
}

function unquoteYaml(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}

function isOpenQuote(val: string): "'" | '"' | false {
    if (val.length < 1) return false;
    const q = val[0];
    if (q !== '"' && q !== "'") return false;
    // Only consider it open if the closing quote isn't on the same line
    if (val.length > 1 && val[val.length - 1] === q) return false;
    return q;
}

function findClosingQuote(lines: string[], startLineIdx: number, quote: string): number {
    for (let i = startLineIdx; i < lines.length; i++) {
        if (lines[i].endsWith(quote)) {
            return i;
        }
    }
    return -1;
}

function parseQuotedField(
    lines: string[],
    lineIdx: number,
    line: string,
    colonIdx: number,
    val: string,
    quote: string,
): { key: string; value: string; endIdx: number } {
    const key = line.slice(0, colonIdx).trim();
    const closeIdx = findClosingQuote(lines, lineIdx, quote);
    if (closeIdx === -1) {
        return { key, value: unquoteYaml(val), endIdx: lineIdx + 1 };
    }
    const firstPart = line.slice(colonIdx + 1).trimStart();
    const midParts = lines.slice(lineIdx + 1, closeIdx);
    const lastPart = lines[closeIdx];
    const raw = [firstPart, ...midParts, lastPart].join("\n");
    return { key, value: unquoteYaml(raw), endIdx: closeIdx + 1 };
}

function parseScalarField(line: string, colonIdx: number): { key: string; value: string } {
    const key = line.slice(0, colonIdx).trim();
    return { key, value: unquoteYaml(line.slice(colonIdx + 1).trim()) };
}

type ChompMode = "clip" | "strip" | "keep";

function parseBlockScalarIndicator(val: string): ChompMode | false {
    if (val === "|") return "clip";
    if (val === "|-") return "strip";
    if (val === "|+") return "keep";
    return false;
}

function applyChomping(contentLines: string[], chomp: ChompMode): string {
    // Each content line conceptually ends with \n.
    // Represent as "line1\nline2\n" by appending \n to the joined result.
    const base = contentLines.length > 0 ? contentLines.join("\n") + "\n" : "";

    if (chomp === "keep") return base;

    // For strip/clip, remove all trailing \n first
    const stripped = base.replace(/\n+$/, "");

    if (chomp === "strip") return stripped;

    // clip: add back a single trailing newline
    return stripped.length > 0 ? stripped + "\n" : "";
}

function collectBlockScalar(lines: string[], startIdx: number): { lines: string[]; endIdx: number } {
    // Determine content indentation from first non-empty line
    let contentIndent = -1;
    for (let j = startIdx; j < lines.length; j++) {
        const trimmed = lines[j].trimEnd();
        if (trimmed.length === 0) continue;
        contentIndent = lines[j].length - lines[j].trimStart().length;
        break;
    }

    if (contentIndent === -1) {
        return { lines: [], endIdx: startIdx };
    }

    const contentLines: string[] = [];
    let endIdx = startIdx;
    let foundContent = false;

    for (let j = startIdx; j < lines.length; j++) {
        const line = lines[j];
        const trimmed = line.trimEnd();

        if (trimmed.length === 0) {
            if (foundContent) {
                contentLines.push("");
            }
            endIdx = j + 1;
            continue;
        }

        const indent = line.length - line.trimStart().length;
        if (indent < contentIndent) break;

        foundContent = true;
        contentLines.push(line.slice(contentIndent).trimEnd());
        endIdx = j + 1;
    }

    return { lines: contentLines, endIdx };
}

const MAX_FRONTMATTER_LINES = 128;

export function parseFrontmatter(content: string, filePath: string): MemoryMeta {
    const block = extractFrontmatterBlock(content, filePath);
    const lines = block.split("\n");
    const fields = new Map<string, string>();

    let i = 0;
    let iterations = 0;

    while (i < lines.length && iterations < MAX_FRONTMATTER_LINES) {
        iterations++;

        const line = lines[i].trimEnd();
        if (line.length === 0 || !line.includes(":")) {
            i++;
            continue;
        }

        const colonIdx = line.indexOf(":");
        const val = line.slice(colonIdx + 1).trim();
        if (val.length === 0) {
            i++;
            continue;
        }

        const key = line.slice(0, colonIdx).trim();

        const blockIndicator = parseBlockScalarIndicator(val);
        if (blockIndicator) {
            const result = collectBlockScalar(lines, i + 1);
            fields.set(key, applyChomping(result.lines, blockIndicator));
            i = result.endIdx;
            continue;
        }

        const quote = isOpenQuote(val);
        if (quote) {
            const result = parseQuotedField(lines, i, line, colonIdx, val, quote);
            fields.set(result.key, result.value);
            i = result.endIdx;
        } else {
            const result = parseScalarField(line, colonIdx);
            fields.set(result.key, result.value);
            i++;
        }
    }

    if (iterations >= MAX_FRONTMATTER_LINES) {
        throw new FrontmatterParseError(
            filePath,
            `frontmatter exceeds ${MAX_FRONTMATTER_LINES} lines, is it malformed?`,
        );
    }

    const name = fields.get("name");
    const description = fields.get("description");

    if (name === undefined) {
        throw new FrontmatterParseError(filePath, "missing required `name` field in frontmatter");
    }
    if (description === undefined) {
        throw new FrontmatterParseError(filePath, "missing required `description` field in frontmatter");
    }

    const meta: MemoryMeta = { name, description };

    const category = fields.get("category");
    if (category !== undefined) meta.category = category;

    const priorityStr = fields.get("priority");
    if (priorityStr !== undefined) {
        const priority = parseInt(priorityStr, 10);
        if (!isNaN(priority)) meta.priority = priority;
    }

    const keepUpdatedStr = fields.get("keep_updated");
    if (keepUpdatedStr !== undefined) {
        meta.keep_updated = keepUpdatedStr === "true" || keepUpdatedStr === "yes";
    }

    const status = fields.get("status");
    if (status !== undefined) meta.status = status;

    return meta;
}
