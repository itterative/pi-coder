import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, FrontmatterParseError, type MemoryMeta } from "./frontmatter";

export type { MemoryMeta } from "./frontmatter";

export interface ScanResult {
    memories: MemoryMeta[];
    errors: FrontmatterParseError[];
}

export async function scanMemories(dir: string): Promise<ScanResult> {
    if (!existsSync(dir)) return { memories: [], errors: [] };

    const entries = await readdir(dir);
    const memories: MemoryMeta[] = [];
    const errors: FrontmatterParseError[] = [];

    for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = join(dir, entry);
        try {
            const content = await readFile(filePath, "utf8");
            memories.push(parseFrontmatter(content, filePath));
        } catch (e) {
            if (e instanceof FrontmatterParseError) {
                errors.push(e);
            }
        }
    }

    return { memories, errors };
}
