import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseMemory, FrontmatterParseError, type MemoryMeta } from "./frontmatter";

export type { MemoryMeta } from "./frontmatter";

/**
 * A pinned memory's body is injected into hidden context, so it is capped far tighter than an index body.
 * The number is characters of the trimmed body, not bytes.
 */
export const PINNED_TEXT_LIMIT = 1024;

/** The total pinned text one session accepts; memories that do not fit are skipped, never truncated. */
export const PINNED_TOTAL_LIMIT = 4096;

export interface PinnedMemory {
    name: string;
    text: string;
    priority?: number;
}

export interface ScanResult {
    memories: MemoryMeta[];
    errors: FrontmatterParseError[];
    pinned: PinnedMemory[];
}

export async function scanMemories(dir: string): Promise<ScanResult> {
    if (!existsSync(dir)) return { memories: [], errors: [], pinned: [] };

    const entries = await readdir(dir);
    const memories: MemoryMeta[] = [];
    const errors: FrontmatterParseError[] = [];
    const pinned: PinnedMemory[] = [];

    for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = join(dir, entry);
        try {
            const content = await readFile(filePath, "utf8");
            const { meta, body } = parseMemory(content, filePath);
            memories.push(meta);

            if (meta.pinned === true) {
                pinned.push({
                    name: meta.name,
                    text: body.trim(),
                    ...(meta.priority === undefined ? {} : { priority: meta.priority }),
                });
            }
        } catch (e) {
            if (e instanceof FrontmatterParseError) {
                errors.push(e);
            }
        }
    }

    pinned.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.name.localeCompare(b.name));

    return { memories, errors, pinned };
}

/**
 * The pinned memories that fit the injection budgets, in scan order.
 *
 * An over-budget memory is skipped rather than truncated: half of a rule can be worse than none, and the audit
 * reports the file so the agent learns its pin stopped applying.
 */
export function budgetedPinned(pinned: readonly PinnedMemory[]): PinnedMemory[] {
    const kept: PinnedMemory[] = [];
    let used = 0;

    for (const entry of pinned) {
        if (entry.text.length > PINNED_TEXT_LIMIT) continue;
        if (used + entry.text.length > PINNED_TOTAL_LIMIT) continue;

        kept.push(entry);
        used += entry.text.length;
    }

    return kept;
}
