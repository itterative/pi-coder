import {
    FrontmatterParseError,
    parseFrontmatter as parseGenericFrontmatter,
} from "../../common/frontmatter";

export { FrontmatterParseError } from "../../common/frontmatter";

export interface MemoryMeta {
    name: string;
    description: string;
    category?: string;
    priority?: number;
    keep_updated?: boolean;
    status?: string;
}

function scalarText(value: unknown): string | undefined {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return undefined;
}

/** Parse and validate the memory-specific frontmatter schema. */
export function parseFrontmatter(content: string, filePath: string): MemoryMeta {
    const { frontmatter } = parseGenericFrontmatter(content, filePath);
    const name = scalarText(frontmatter.name);
    const description = scalarText(frontmatter.description);

    if (name === undefined) {
        throw new FrontmatterParseError(filePath, "missing required `name` field in frontmatter");
    }
    if (description === undefined) {
        throw new FrontmatterParseError(filePath, "missing required `description` field in frontmatter");
    }

    const meta: MemoryMeta = { name, description };
    const category = scalarText(frontmatter.category);
    if (category !== undefined) meta.category = category;

    const priority = scalarText(frontmatter.priority);
    if (priority !== undefined) {
        const parsedPriority = parseInt(priority, 10);
        if (!Number.isNaN(parsedPriority)) meta.priority = parsedPriority;
    }

    const keepUpdated = scalarText(frontmatter.keep_updated);
    if (keepUpdated !== undefined) {
        meta.keep_updated = keepUpdated === "true" || keepUpdated === "yes";
    }

    const status = scalarText(frontmatter.status);
    if (status !== undefined) meta.status = status;

    return meta;
}
