import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getUserMemoryDirectory } from "../../common/constants";
import { scanMemories, type MemoryMeta } from "./memories";
import { FrontmatterParseError } from "./frontmatter";

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
): string {
    const projectLines = formatMemoryList(projectMemories);
    const userLines = formatMemoryList(userMemories);

    return `## Memory System

You have access to a persistent memory system for storing and recalling information across sessions.

### Locations

- Project-level indexed memories: ${projectDir}/*.md
- User-level indexed memories: ${userDir}/*.md

Indexed memories are stored directly in these directories. Detailed reference documents may be kept in subdirectories and linked from an indexed memory; they are not listed automatically. The \`category\` field is frontmatter metadata and does not create subdirectories.

### How to use

- Each memory file has YAML frontmatter with \`name\` (string), \`description\` (string), and optional \`category\` (string) / \`priority\` (number) / \`keep_updated\` (boolean) / \`status\` (string) fields
  - The \`name\` must match the filename without \`.md\` (e.g. \`name: conventions\` in \`conventions.md\`)
  - Keep \`description\` to one line; it appears in the system prompt to help future agents decide whether to load the memory
- Use the standard built-in tools (\`read\`, \`write\`, \`edit\`, \`bash\`) to work with memories — there are no custom memory tools
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
- The memory list below is cached at session start. New or updated memories created during this session will not appear in the list until the next session or a \`/reload\`

### Available Project Memories

${projectLines}

### Available User Memories

${userLines}`;
}

export default function registerMemoryExtension(pi: ExtensionAPI) {
    let cachedAppendix = "";
    let maxContextTokens = 0;
    let lastRemindedAt = 0;
    let currentBaseline = 0;
    let currentStreamedChars = 0;
    let needsReminder = false;

    pi.on("session_start", async (event, ctx) => {
        const projectDir = join(ctx.cwd, ".pi", "agent", "memory");
        const userDir = getUserMemoryDirectory();

        // Ensure directories exist
        await mkdir(projectDir, { recursive: true });
        await mkdir(userDir, { recursive: true });

        const useSessionCache = process.env.PI_MEMORY_SESSION_CACHE !== "false";

        let projectMemories: MemoryMeta[];
        let userMemories: MemoryMeta[];
        let allErrors: FrontmatterParseError[];

        if (useSessionCache) {
            // Try to restore from session entries (last match)
            const entries = ctx.sessionManager.getEntries();
            let cached: CachedMemoryIndex | undefined;
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i];
                if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
                    cached = entry.data as CachedMemoryIndex;
                    break;
                }
            }

            if (cached && cached.projectDir === projectDir && cached.userDir === userDir) {
                projectMemories = cached.projectMemories;
                userMemories = cached.userMemories;
                allErrors = [];
            } else {
                const [projectResult, userResult] = await Promise.all([
                    scanMemories(projectDir),
                    scanMemories(userDir),
                ]);
                projectMemories = projectResult.memories;
                userMemories = userResult.memories;
                allErrors = [...projectResult.errors, ...userResult.errors];

                pi.appendEntry(ENTRY_TYPE, {
                    projectDir,
                    userDir,
                    projectMemories,
                    userMemories,
                } satisfies CachedMemoryIndex);
            }
        } else {
            const [projectResult, userResult] = await Promise.all([
                scanMemories(projectDir),
                scanMemories(userDir),
            ]);
            projectMemories = projectResult.memories;
            userMemories = userResult.memories;
            allErrors = [...projectResult.errors, ...userResult.errors];
        }

        if (allErrors.length > 0 && ctx.hasUI) {
            for (const error of allErrors) {
                ctx.ui.notify(`pi-memory: ${error.message}`, "warning");
            }
        }

        // Build and cache the prompt appendix
        cachedAppendix = buildPromptAppendix(projectMemories, userMemories, projectDir, userDir);

        // Remind the agent to check memories on the first turn of this session
        needsReminder = true;
    });

    pi.on("session_compact", async (_event, _ctx) => {
        // Remind the agent to check memories on the first turn after compaction
        needsReminder = true;
    });

    pi.on("agent_start", async (_event, _ctx) => {
        maxContextTokens = 0;
        currentBaseline = 0;
        currentStreamedChars = 0;
    });

    pi.on("message_start", async (event, ctx) => {
        if (event.message.role !== "assistant") return;
        const usage = ctx.getContextUsage();
        currentBaseline = usage?.tokens ?? 0;
        currentStreamedChars = 0;
        if (currentBaseline > maxContextTokens) {
            maxContextTokens = currentBaseline;
        }
    });

    pi.on("message_update", async (event, _ctx) => {
        if (event.message.role !== "assistant") return;
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta" || ev.type === "thinking_delta") {
            currentStreamedChars += ev.delta.length;
        }
        const estimated = currentBaseline + Math.ceil(currentStreamedChars / 4);
        if (estimated > maxContextTokens) {
            maxContextTokens = estimated;
        }
    });

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

        const result: {
            systemPrompt: string;
            message?: { customType: string; content: string; display: boolean };
        } = {
            systemPrompt,
        };

        if (!event.systemPromptOptions) {
            return result;
        }

        // Session-start / post-compaction reminder (always enabled)
        const sessionReminder = needsReminder;
        if (sessionReminder) {
            needsReminder = false;
        }

        // Token-threshold reminder (opt-in via env var)
        const thresholdReminderEnabled = process.env.PI_MEMORY_REMINDER === "true";
        const threshold = parseInt(process.env.PI_MEMORY_REMINDER_THRESHOLD ?? "25000", 10);
        const newTokens = maxContextTokens - lastRemindedAt;
        const thresholdTriggered = thresholdReminderEnabled && newTokens >= threshold;

        if (thresholdTriggered) {
            lastRemindedAt = maxContextTokens;
        }

        if (thresholdReminderEnabled) {
            pi.appendEntry("pi-memory:debug", {
                reminderEnabled: thresholdReminderEnabled,
                threshold,
                maxContextTokens,
                newTokens,
                lastRemindedAt,
                triggered: thresholdTriggered,
                sessionReminder,
            });
        }

        if (sessionReminder || thresholdTriggered) {
            result.message = {
                customType: "pi-memory",
                content:
                    "<memory_reminder>\nBefore starting work, consider whether any memories listed in the <memory_system> section of your system prompt are relevant to the user's request and read them if so.\n</memory_reminder>",
                display: false,
            };
        }

        return result;
    });
}
