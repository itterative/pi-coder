import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { getUserMemoryDirectory } from "../../common/constants";
import { setPromptSection } from "../../common/prompt-section";
import { budgetedPinned, scanMemories, type MemoryMeta, type PinnedMemory } from "./memories";
import { FrontmatterParseError } from "./frontmatter";
import { memoryPrompt, pinnedMemoryBlocks } from "./prompt";
import registerMemoryAudit from "./audit-ui";

interface CachedMemoryIndex {
    projectDir: string;
    userDir: string;
    projectMemories: MemoryMeta[];
    userMemories: MemoryMeta[];
    pinned: PinnedMemory[];
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

These memory files exist but are absent from the lists above because their frontmatter failed to parse. An unquoted \`:\` in a \`description\` is the usual cause - quote the value, and treat the lists above as incomplete until the audit reports the trees clean. The audit re-runs by itself after your next memory edit; \`memory_audit\` prints the full report on demand.

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
            const flags = [
                ...(m.pinned ? ["[pinned]"] : []),
                ...(m.keep_updated ? ["[high-churn]"] : []),
            ];
            const annotation = flags.length > 0 ? ` ${flags.join(" ")}` : "";
            lines.push(`- **${m.name}**${annotation} — ${m.description}`);
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
- Use the standard built-in tools (\`read\`, \`write\`, \`edit\`, \`bash\`) to read and maintain memories.

### Guidelines

- Read relevant memories before starting work.
- Pinned memories are already in full in the hidden context you received at the start of the session and after each compaction; use that text directly and do not re-read them unless you need detail they do not carry.
- Write user-level memories only when the user asks.
- Save a project memory only for a fact the diff cannot carry: an invariant, a failure mode, a non-obvious constraint, or a memory that is now wrong. Update in place, write nothing when nothing is wrong, and never record what you changed or that validation passed.
- Review [high-churn] memories after relevant changes; update only a wrong one.
- Audits run automatically after a memory edit and report findings as a reminder; call \`memory_audit\` only for the full report. Errors mean a memory is not indexed; warnings are review indicators — a dense index needs no fix, and a warning is not a reason to restructure mid-task.

### Available Project Memories

${projectLines}

### Available User Memories

${userLines}${notIndexed}`;
}

interface MemoryDirectories {
    projectDir: string;
    userDir: string;
}

interface ScannedAppendix {
    appendix: string;
    pinnedText: string;
}

interface ScannedMemoryIndex extends ScannedAppendix {
    snapshot: CachedMemoryIndex;
    errors: FrontmatterParseError[];
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

            // A snapshot recorded before pinned memories existed cannot say what is pinned, so it is stale
            // even though its index lists are fine: rebuild from disk once and record a current one.
            if (!Array.isArray(snapshot.pinned)) {
                return undefined;
            }

            return snapshot;
        }
    }

    return undefined;
}

function appendixFromSnapshot(snapshot: CachedMemoryIndex): ScannedAppendix {
    return {
        appendix: buildPromptAppendix(
            snapshot.projectMemories,
            snapshot.userMemories,
            snapshot.projectDir,
            snapshot.userDir,
        ),
        pinnedText: pinnedTextFor(snapshot.pinned),
    };
}

/** The pinned bodies that fit the budgets, as the hidden-context block the reminder carries. */
function pinnedTextFor(pinned: readonly PinnedMemory[]): string {
    return pinnedMemoryBlocks(budgetedPinned(pinned));
}

/** Read both trees and build the snapshot and prompt appendix from disk. */
async function scanMemoryIndex(dirs: MemoryDirectories): Promise<ScannedMemoryIndex> {
    const [projectResult, userResult] = await Promise.all([
        scanMemories(dirs.projectDir),
        scanMemories(dirs.userDir),
    ]);
    const errors = [...projectResult.errors, ...userResult.errors];
    const pinned = [...projectResult.pinned, ...userResult.pinned];

    return {
        snapshot: {
            projectDir: dirs.projectDir,
            userDir: dirs.userDir,
            projectMemories: projectResult.memories,
            userMemories: userResult.memories,
            pinned,
        },
        errors,
        appendix: buildPromptAppendix(
            projectResult.memories,
            userResult.memories,
            dirs.projectDir,
            dirs.userDir,
            errors,
        ),
        pinnedText: pinnedTextFor(pinned),
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

export interface MemoryExtensionHandle {
    /** The pinned bodies that fit the budgets, as the block the reminders module delivers as hidden context. */
    pinnedText(): string;
}

export default function registerMemoryExtension(pi: ExtensionAPI): MemoryExtensionHandle {
    let cachedAppendix = "";
    let cachedPinnedText = "";

    pi.on("session_start", async (_event, ctx) => {
        const dirs = memoryDirectories(ctx.cwd);

        // Ensure directories exist
        await mkdir(dirs.projectDir, { recursive: true });
        await mkdir(dirs.userDir, { recursive: true });

        const cached = sessionCacheEnabled()
            ? findBranchSnapshot(ctx.sessionManager.getBranch(), dirs)
            : undefined;

        if (cached) {
            const restored = appendixFromSnapshot(cached);
            cachedAppendix = restored.appendix;
            cachedPinnedText = restored.pinnedText;
        } else {
            const scanned = await scanMemoryIndex(dirs);
            cachedAppendix = scanned.appendix;
            cachedPinnedText = scanned.pinnedText;
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
            const restored = appendixFromSnapshot(cached);
            cachedAppendix = restored.appendix;
            cachedPinnedText = restored.pinnedText;
        } else {
            // No snapshot at this branch point, or the session cache is off: read the trees. This path
            // appends nothing on purpose - a navigation is not a session start, and every return to a
            // point at or after a compaction would otherwise add another duplicate sibling snapshot.
            try {
                const scanned = await scanMemoryIndex(dirs);
                cachedAppendix = scanned.appendix;
                cachedPinnedText = scanned.pinnedText;
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
            cachedPinnedText = scanned.pinnedText;
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

    pi.on("before_agent_start", (event) => {
        if (!cachedAppendix) return;

        setPromptSection(event.systemPromptOptions, "memory_system", memoryPrompt(cachedAppendix));
    });

    return { pinnedText: () => cachedPinnedText };
}
