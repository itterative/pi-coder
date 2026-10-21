import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { getUserMemoryDirectory } from "../../common/constants";
import { scanMemories, type MemoryMeta } from "./memories";
import { FrontmatterParseError } from "./frontmatter";
import registerMemoryAudit from "./audit-ui";

interface CachedMemoryIndex {
    projectDir: string;
    userDir: string;
    projectMemories: MemoryMeta[];
    userMemories: MemoryMeta[];
}

const ENTRY_TYPE = "pi-memory:memory-index";

const CATEGORY_ORDER = ["architecture", "meta", "workflow", "tools", "convention"];

function titleCaseCategory(category: string): string {
    return category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * A memory whose frontmatter fails to parse is dropped by `scanMemories` and vanishes from every
 * system prompt. Say so in the prompt itself: the absence is otherwise invisible.
 */
function buildNotIndexedSection(errors: FrontmatterParseError[]): string {
    if (errors.length === 0) {
        return "";
    }

    const lines = errors.map((error) => {
        const name = error.filePath.split("/").pop() ?? error.filePath;
        return `- \`${name}\`: ${error.message}`;
    });

    return `

### Not Indexed

These memory files exist but are absent from the lists above because their frontmatter failed to parse. An unquoted \`:\` in a \`description\` is the usual cause - quote the value. Run \`/memory-audit\` (or the \`memory_audit\` tool) after fixing them, and treat the lists above as incomplete until then.

${lines.join("\n")}`;
}

export function formatMemoryList(memories: MemoryMeta[]): string {
    if (memories.length === 0) return "None";

    const grouped = new Map<string, MemoryMeta[]>();
    const uncategorized: MemoryMeta[] = [];

    for (const m of memories) {
        if (m.category) {
            if (!grouped.has(m.category)) grouped.set(m.category, []);
            grouped.get(m.category)!.push(m);
        } else {
            uncategorized.push(m);
        }
    }

    const sortByPriority = (a: MemoryMeta, b: MemoryMeta) =>
        (a.priority ?? 99) - (b.priority ?? 99);
    for (const group of grouped.values()) {
        group.sort(sortByPriority);
    }
    uncategorized.sort(sortByPriority);

    // Known categories in fixed order (only those present), then any unknown
    // categories alphabetically, then uncategorized memories last under "Other".
    // This ensures a memory never disappears just because its category is new.
    const knownCategories = CATEGORY_ORDER.filter((cat) => grouped.has(cat));
    const unknownCategories = [...grouped.keys()]
        .filter((cat) => !CATEGORY_ORDER.includes(cat))
        .sort();

    const lines: string[] = [];
    let first = true;

    const renderGroup = (title: string, group: MemoryMeta[]) => {
        if (!first) lines.push("");
        first = false;
        lines.push(`#### ${title}`);
        for (const m of group) {
            const flag = m.keep_updated ? " [high-churn]" : "";
            lines.push(`- **${m.name}**${flag} — ${m.description}`);
        }
    };

    for (const cat of [...knownCategories, ...unknownCategories]) {
        renderGroup(titleCaseCategory(cat), grouped.get(cat)!);
    }

    if (uncategorized.length > 0) {
        renderGroup("Other", uncategorized);
    }

    return lines.join("\n");
}

function buildPromptAppendix(
    projectMemories: MemoryMeta[],
    userMemories: MemoryMeta[],
    projectDir: string,
    userDir: string,
    errors: FrontmatterParseError[] = [],
): string {
    const projectLines = formatMemoryList(projectMemories);
    const userLines = formatMemoryList(userMemories);
    const notIndexed = buildNotIndexedSection(errors);

    return `## Memory System

You have access to a persistent memory system for storing and recalling information across sessions.

### Locations

- Project-level indexed memories: ${projectDir}/*.md
- User-level indexed memories: ${userDir}/*.md

Indexed memories are stored directly in these directories. Detailed reference documents may be kept in subdirectories and linked from an indexed memory; they are not listed automatically, so a nested document is reachable only when an indexed memory names it - conventionally in a \`## Targeted references\` list. The \`category\` field is frontmatter metadata and does not create subdirectories.

### How to use

- Each memory file has YAML frontmatter with \`name\` (string), \`description\` (string), and optional \`category\` (string) / \`priority\` (number) / \`keep_updated\` (boolean) / \`status\` (string) fields
  - The \`name\` must match the filename without \`.md\` (e.g. \`name: conventions\` in \`conventions.md\`)
  - Keep \`description\` to one line; it appears in the system prompt to help future agents decide whether to load the memory
  - Quote a \`description\` that contains \`: \`. Unquoted, the frontmatter is invalid YAML, the file fails to parse, and the memory silently disappears from the list with only a startup warning
- Use the standard built-in tools (\`read\`, \`write\`, \`edit\`, \`bash\`) to create and edit memories - there are no custom memory-writing tools. The \`memory_audit\` tool and \`/memory-audit\` command only validate the trees
- Use the \`read\` tool to load specific memories as needed
- Use \`write\` to create new memories (include frontmatter) or \`edit\` to update existing ones
- Use \`bash\` with \`rm\` to delete a memory file

### Guidelines

- At the start of each task, proactively read any memories whose names or descriptions appear relevant to the user's request
- Only write to user-level memories when the user explicitly asks
- Proactively save project-level memories when you learn something useful about the project
  - Before finishing your task, review what you have learned
  - Add new memories or edit existing ones to keep them consistent with any changes made
- Memories marked with [high-churn] are high-churn — review and update them after relevant changes
- After creating, moving, renaming, or splitting memory files, run \`/memory-audit\` (or the \`memory_audit\` tool). Its errors mean a memory is not indexed or a reference is broken; its warnings are review indicators, not defects - a deliberately large index or a long nested description needs no fix
- The memory list below is a snapshot: it is read at session start and rebuilt after each compaction, and navigating back on the session tree to before a compaction restores the snapshot that was current on that branch. New or updated memories do not appear until one of those points

### Available Project Memories

${projectLines}

### Available User Memories

${userLines}${notIndexed}`;
}

interface MemoryDirectories {
    projectDir: string;
    userDir: string;
}

interface ScannedMemoryIndex {
    snapshot: CachedMemoryIndex;
    errors: FrontmatterParseError[];
    appendix: string;
}

function memoryDirectories(cwd: string): MemoryDirectories {
    return {
        projectDir: join(cwd, ".pi", "agent", "memory"),
        userDir: getUserMemoryDirectory(),
    };
}

function sessionCacheEnabled(): boolean {
    return process.env.PI_MEMORY_SESSION_CACHE !== "false";
}

/**
 * The snapshot the active branch should use: walking backwards, the first `pi-memory:memory-index`
 * entry wins. A `compaction` entry hit first means every snapshot on this branch predates the fold,
 * so the branch point has no usable snapshot and the caller rescans. This is what keeps the old index
 * when navigation returns to a point before a compaction while a point at or after the fold gets the
 * rebuilt one, and why the lookup walks the branch rather than every entry in the session file.
 */
function findBranchSnapshot(
    branch: readonly SessionEntry[],
    dirs: MemoryDirectories,
): CachedMemoryIndex | undefined {
    for (const entry of [...branch].reverse()) {
        if (entry.type === "compaction") {
            return undefined;
        }

        if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
            const snapshot = entry.data as CachedMemoryIndex;
            if (snapshot.projectDir !== dirs.projectDir || snapshot.userDir !== dirs.userDir) {
                return undefined;
            }

            return snapshot;
        }
    }

    return undefined;
}

function appendixFromSnapshot(snapshot: CachedMemoryIndex): string {
    return buildPromptAppendix(
        snapshot.projectMemories,
        snapshot.userMemories,
        snapshot.projectDir,
        snapshot.userDir,
    );
}

/** Read both trees and build the snapshot and prompt appendix from disk. */
async function scanMemoryIndex(dirs: MemoryDirectories): Promise<ScannedMemoryIndex> {
    const [projectResult, userResult] = await Promise.all([
        scanMemories(dirs.projectDir),
        scanMemories(dirs.userDir),
    ]);
    const errors = [...projectResult.errors, ...userResult.errors];

    return {
        snapshot: {
            projectDir: dirs.projectDir,
            userDir: dirs.userDir,
            projectMemories: projectResult.memories,
            userMemories: userResult.memories,
        },
        errors,
        appendix: buildPromptAppendix(
            projectResult.memories,
            userResult.memories,
            dirs.projectDir,
            dirs.userDir,
            errors,
        ),
    };
}

function notifyParseErrors(ctx: ExtensionContext, errors: readonly FrontmatterParseError[]): void {
    if (errors.length === 0 || !ctx.hasUI) {
        return;
    }

    for (const error of errors) {
        ctx.ui.notify(`pi-memory: ${error.message}`, "warning");
    }
}

function notifyRescanFailure(ctx: ExtensionContext, what: string, error: unknown): void {
    if (!ctx.hasUI) {
        return;
    }

    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`pi-memory: ${what}: ${message}`, "warning");
}

export default function registerMemoryExtension(pi: ExtensionAPI) {
    let cachedAppendix = "";

    pi.on("session_start", async (_event, ctx) => {
        const dirs = memoryDirectories(ctx.cwd);

        // Ensure directories exist
        await mkdir(dirs.projectDir, { recursive: true });
        await mkdir(dirs.userDir, { recursive: true });

        const cached = sessionCacheEnabled()
            ? findBranchSnapshot(ctx.sessionManager.getBranch(), dirs)
            : undefined;

        if (cached) {
            cachedAppendix = appendixFromSnapshot(cached);
        } else {
            const scanned = await scanMemoryIndex(dirs);
            cachedAppendix = scanned.appendix;
            notifyParseErrors(ctx, scanned.errors);

            if (sessionCacheEnabled()) {
                pi.appendEntry(ENTRY_TYPE, scanned.snapshot);
            }
        }
    });

    pi.on("session_tree", async (_event, ctx) => {
        const dirs = memoryDirectories(ctx.cwd);
        const cached = sessionCacheEnabled()
            ? findBranchSnapshot(ctx.sessionManager.getBranch(), dirs)
            : undefined;

        if (cached) {
            cachedAppendix = appendixFromSnapshot(cached);
        } else {
            // No snapshot at this branch point, or the session cache is off: read the trees. This path
            // appends nothing on purpose - a navigation is not a session start, and every return to a
            // point at or after a compaction would otherwise add another duplicate sibling snapshot.
            try {
                cachedAppendix = (await scanMemoryIndex(dirs)).appendix;
            } catch (error) {
                // A failed rescan must cost freshness, never the appendix already in the prompt.
                notifyRescanFailure(ctx, "rescan after tree navigation failed", error);
            }
        }
    });

    pi.on("session_compact", async (_event, ctx) => {
        // Rebuild against the filesystem: compaction is where the frozen session list is allowed to
        // change. Doing it here, not in `session_before_compact`, keeps the prompt unchanged through
        // the pipeline that measured it as a cached prefix, while the prefix is rebuilt for the fold
        // anyway.
        try {
            const dirs = memoryDirectories(ctx.cwd);
            const scanned = await scanMemoryIndex(dirs);
            cachedAppendix = scanned.appendix;
            notifyParseErrors(ctx, scanned.errors);

            if (sessionCacheEnabled()) {
                pi.appendEntry(ENTRY_TYPE, scanned.snapshot);
            }
        } catch (error) {
            // A failed rescan must cost freshness, never the appendix already in the prompt.
            notifyRescanFailure(ctx, "post-compaction rescan failed", error);
        }
    });

    registerMemoryAudit(pi);

    pi.on("before_agent_start", async (event, _ctx) => {
        if (!cachedAppendix) return;

        let systemPrompt = event.systemPrompt;

        // Skip if already injected (e.g. sub-agent inheriting parent's prompt)
        if (systemPrompt.includes("<memory_system>")) {
            return;
        }

        const memoryBlock = `<memory_system>\n${cachedAppendix}\n</memory_system>`;
        const projectContextEnd = "</project_context>";
        const idx = systemPrompt.indexOf(projectContextEnd);
        if (idx !== -1) {
            systemPrompt =
                systemPrompt.slice(0, idx + projectContextEnd.length) +
                "\n\n" +
                memoryBlock +
                "\n" +
                systemPrompt.slice(idx + projectContextEnd.length);
        } else {
            systemPrompt = systemPrompt + "\n" + memoryBlock;
        }

        return { systemPrompt };
    });
}
