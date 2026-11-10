/**
 * Memory-audit surfaces: the `memory_audit` tool for agents and the `/memory-audit` command for
 * people. Both read the same trees through the same functions that build the memory list, so a
 * file that fails to index is reported instead of silently missing.
 *
 * Neither surface is how an agent is expected to catch its own mistakes: the reminders module audits both
 * trees automatically after a step that changed a memory file (see `reminders/memory-audit.ts`). These are
 * the on-demand view of the same report.
 */
import {
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { AutocompleteItem, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { contributeToolGuide } from "../../common/prompt-section";
import { pager, type PagerItem } from "../../tui/pager";
import { memoryAuditGuidePrompt } from "./prompt";
import {
    formatAuditReport,
    runMemoryAudit,
    summarizeAudit,
    WarningsLegend,
    type AuditFinding,
    type AuditResult,
    type AuditScope,
} from "./audit";

export type { AuditScope } from "./audit";

const SCOPE_VALUES: AuditScope[] = ["both", "project", "user"];

function resolveScope(raw: string | undefined): AuditScope {
    const value = (raw ?? "").trim().toLowerCase();

    if (value === "project" || value === "user") {
        return value;
    }

    return "both";
}

async function runAudit(cwd: string, scope: AuditScope): Promise<AuditResult[]> {
    return runMemoryAudit(cwd, scope);
}

function countBySeverity(results: AuditResult[]): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;

    for (const result of results) {
        for (const finding of result.findings) {
            if (finding.severity === "error") {
                errors++;
                continue;
            }

            warnings++;
        }
    }

    return { errors, warnings };
}

export default function registerMemoryAudit(pi: ExtensionAPI) {
    pi.registerTool({
        name: "memory_audit",
        label: "Memory Audit",
        description:
            "Report the state of the memory trees: frontmatter and name rules, index size and description " +
            "budget, nested docs no index names, and broken or stale references. Errors mean a memory is not " +
            "indexed or a reference is broken; warnings are review indicators. `scope` selects the `project` " +
            "tree, the `user` tree, or `both` (the default).",
        promptSnippet: "Print the full memory-tree audit.",
        parameters: Type.Object({
            scope: Type.Optional(
                Type.String({
                    description:
                        "Which tree to audit: 'project', 'user', or 'both' (default 'both')",
                }),
            ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const results = await runAudit(ctx.cwd, resolveScope(params.scope));
            const { errors, warnings } = countBySeverity(results);

            const header =
                errors === 0 && warnings === 0
                    ? `${summarizeAudit(results)} — no findings`
                    : `${summarizeAudit(results)}`;

            return {
                content: [
                    { type: "text" as const, text: `${header}\n\n${formatAuditReport(results)}` },
                ],
                details: { errors, warnings, results },
            };
        },
    });

    pi.on("before_agent_start", (event) => {
        contributeToolGuide(event.systemPromptOptions, "memory_audit", memoryAuditGuidePrompt());
    });

    pi.registerCommand("memory-audit", {
        description: "Audit the project and user memory trees for indexing and reference problems",
        getArgumentCompletions: (prefix: string) => {
            const completions: AutocompleteItem[] = [];

            for (const value of SCOPE_VALUES) {
                if (prefix && !value.startsWith(prefix)) {
                    continue;
                }

                completions.push({
                    value,
                    label: value,
                    description: `Audit the ${value} memory tree`,
                });
            }

            return completions;
        },
        handler: async (args, ctx) => {
            const results = await runAudit(ctx.cwd, resolveScope(args));
            const { errors, warnings } = countBySeverity(results);

            if (errors === 0 && warnings === 0) {
                ctx.ui.notify(`pi-memory: ${summarizeAudit(results)} — no findings`, "info");
                return;
            }

            if (!ctx.hasUI) {
                ctx.ui.notify(
                    `pi-memory: ${summarizeAudit(results)} — run memory_audit for details`,
                    warnings > 0 && errors === 0 ? "info" : "warning",
                );
                return;
            }

            await showAuditReport(results, ctx);
        },
    });
}

type AuditLine =
    | { type: "header"; text: string }
    | { type: "summary"; text: string }
    | { type: "finding"; finding: AuditFinding }
    | { type: "blank" };

async function showAuditReport(
    results: AuditResult[],
    ctx: ExtensionCommandContext,
): Promise<void> {
    const items = buildAuditItems(results);
    const maxVisibleLines = 16;
    let scrollOffset = 0;

    await pager(
        {
            title: "pi-memory: memory audit",
            items,
            scrollOffset,
            maxVisibleLines,
            helpText: "↑/↓ scroll | Esc close",
            renderItem: (item, options) => renderAuditLine(item, options.theme),
            onKey: (key, state) => {
                if (matchesKey(key, "up") || key === "k") {
                    if (scrollOffset > 0) {
                        scrollOffset--;
                        state.scrollOffset = scrollOffset;
                    }
                    return true;
                }

                if (matchesKey(key, "down") || key === "j") {
                    const maxScroll = Math.max(0, countLines(items) - maxVisibleLines);
                    if (scrollOffset < maxScroll) {
                        scrollOffset++;
                        state.scrollOffset = scrollOffset;
                    }
                    return true;
                }

                return false;
            },
        },
        ctx,
    );
}

function buildAuditItems(results: AuditResult[]): PagerItem<AuditLine>[] {
    const items: PagerItem<AuditLine>[] = [];
    const { errors, warnings } = countBySeverity(results);

    items.push({
        value: { type: "header", text: `errors ${errors} · warnings ${warnings}` },
        label: `errors ${errors} · warnings ${warnings}`,
    });

    for (const result of results) {
        const summary = summarizeAudit([result]);
        items.push({ value: { type: "summary", text: summary }, label: summary });

        for (const finding of result.findings) {
            const label = `    ${finding.severity === "error" ? "ERROR" : "warn"} ${finding.path} [${finding.rule}] ${finding.message}`;
            items.push({ value: { type: "finding", finding }, label });
        }

        items.push({ value: { type: "blank" }, label: "" });
    }

    if (warnings > 0) {
        const legend = WarningsLegend.trim();
        items.push({ value: { type: "summary", text: legend }, label: legend });
    }

    return items;
}

function countLines(items: PagerItem<AuditLine>[]): number {
    return items.reduce((total, item) => total + item.label.split("\n").length, 0);
}

function renderAuditLine(
    item: PagerItem<AuditLine>,
    theme: { fg: (color: ThemeColor, text: string) => string },
): string {
    const line = item.value;

    switch (line.type) {
        case "header":
            return theme.fg("accent", line.text);

        case "summary":
            return theme.fg("muted", line.text);

        case "finding":
            return theme.fg(line.finding.severity === "error" ? "error" : "warning", item.label);

        case "blank":
            return "";
    }
}
