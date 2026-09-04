/**
 * Config Command Extension
 *
 * Provides a /bash-sandbox-config command that displays the currently loaded
 * sandbox configuration.
 *
 * Subcommands:
 * - show (default): Display the current configuration
 * - reload: Reload the configuration from disk
 */

import {
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ThemeColor,
} from "@earendil-works/pi-coding-agent";

import { AutocompleteItem, matchesKey } from "@earendil-works/pi-tui";

import sandboxConfig from "../common/config";
import { pager, type PagerItem } from "../tui/pager";

// Types for config display items
type ConfigLineType =
    | { type: "header"; text: string }
    | { type: "dim"; text: string }
    | { type: "mount"; path: string; access: string }
    | { type: "env"; key: string; value: string }
    | { type: "inherit-env"; key: string; action: string }
    | { type: "permission"; pattern: string; perm: string }
    | { type: "audit-model"; provider: string; model: string }
    | { type: "audit-default" }
    | { type: "blank" };

// Build config display lines as items for the pager
function buildConfigItems(
    config: NonNullable<typeof sandboxConfig.current>,
): PagerItem<ConfigLineType>[] {
    const items: PagerItem<ConfigLineType>[] = [];

    // Sandbox section
    items.push({ value: { type: "header", text: "Sandbox:" }, label: "Sandbox:" });

    // Mounts
    const mounts = Object.entries(config.sandbox.mounts);
    if (mounts.length > 0) {
        items.push({ value: { type: "dim", text: "Mounts:" }, label: "Mounts:" });
        for (const [path, access] of mounts) {
            items.push({ value: { type: "mount", path, access }, label: `${path} → ${access}` });
        }
    } else {
        items.push({ value: { type: "dim", text: "(no mounts)" }, label: "(no mounts)" });
    }

    // Env vars
    if (config.sandbox.env && Object.keys(config.sandbox.env).length > 0) {
        items.push({ value: { type: "dim", text: "Environment:" }, label: "Environment:" });
        for (const [key, value] of Object.entries(config.sandbox.env)) {
            items.push({ value: { type: "env", key, value }, label: `${key}=${value}` });
        }
    }

    // Inherit env filter
    if (config.sandbox.inheritEnv && Object.keys(config.sandbox.inheritEnv).length > 0) {
        items.push({
            value: { type: "dim", text: "Inherit env filter:" },
            label: "Inherit env filter:",
        });
        for (const [key, action] of Object.entries(config.sandbox.inheritEnv)) {
            items.push({
                value: { type: "inherit-env", key, action },
                label: `${key} → ${action}`,
            });
        }
    }

    items.push({ value: { type: "blank" }, label: "" });

    // Permissions section
    items.push({ value: { type: "header", text: "Permissions:" }, label: "Permissions:" });

    const permissions = Object.entries(config.permissions);
    if (permissions.length > 0) {
        const maxPatternLength = Math.max(...permissions.map(([p]) => p.length));
        for (const [pattern, perm] of permissions) {
            items.push({
                value: { type: "permission", pattern, perm },
                label: `${pattern.padEnd(maxPatternLength)} ${perm}`,
            });
        }
    } else {
        items.push({
            value: { type: "dim", text: "(no permissions defined)" },
            label: "(no permissions defined)",
        });
    }

    items.push({ value: { type: "blank" }, label: "" });

    // Audit section
    items.push({ value: { type: "header", text: "Audit:" }, label: "Audit:" });
    if (config.audit?.provider && config.audit?.model) {
        items.push({
            value: {
                type: "audit-model",
                provider: config.audit.provider,
                model: config.audit.model,
            },
            label: `Model: ${config.audit.provider}/${config.audit.model}`,
        });
    } else {
        items.push({
            value: { type: "audit-default" },
            label: "Model: (using current session model)",
        });
    }

    return items;
}

// Render a config line with theme styling
function renderConfigLine(
    item: PagerItem<ConfigLineType>,
    theme: { fg: (color: ThemeColor, text: string) => string },
): string {
    const line = item.value;

    switch (line.type) {
        case "header":
            return theme.fg("success", line.text);

        case "dim":
            return theme.fg("dim", `  ${line.text}`);

        case "mount": {
            const accessColor = line.access === "readonly" ? "warning" : "success";
            return `    ${line.path} → ${theme.fg(accessColor, line.access)}`;
        }

        case "env":
            return `    ${line.key}=${theme.fg("muted", line.value)}`;

        case "inherit-env": {
            const actionColor = line.action === "allow" ? "success" : "error";
            return `    ${line.key} → ${theme.fg(actionColor, line.action)}`;
        }

        case "permission": {
            let permColor: ThemeColor;
            switch (line.perm) {
                case "allow":
                    permColor = "success";
                    break;
                case "allow:sandbox":
                    permColor = "warning";
                    break;
                case "deny":
                    permColor = "error";
                    break;
                default:
                    permColor = "muted";
            }
            return `  ${line.pattern} ${theme.fg(permColor, line.perm)}`;
        }

        case "audit-model":
            return `  Model: ${theme.fg("accent", `${line.provider}/${line.model}`)}`;

        case "audit-default":
            return theme.fg("dim", "  Model: (using current session model)");

        case "blank":
            return "";
    }
}

async function showConfig(_args: string, ctx: ExtensionCommandContext) {
    const config = sandboxConfig.current;

    if (!config) {
        ctx.ui.notify("pi-bash-sandbox: No config loaded (using defaults)", "info");
        return;
    }

    if (!ctx.hasUI) {
        // Non-UI mode: just print the config
        ctx.ui.notify(`pi-bash-sandbox config:\n${JSON.stringify(config, null, 2)}`, "info");
        return;
    }

    const items = buildConfigItems(config);
    const maxVisibleLines = 15;
    let scrollOffset = 0;

    // Calculate total lines for scroll bounds
    let totalLines = 0;
    for (const item of items) {
        totalLines += item.label.split("\n").length;
    }

    const maxScrollOffset = Math.max(0, totalLines - maxVisibleLines);

    await pager(
        {
            title: "pi-bash-sandbox: Current configuration",
            items,
            scrollOffset,
            maxVisibleLines,
            helpText: "↑/↓ scroll | Esc close",
            renderItem: (item, options) => {
                return renderConfigLine(item, options.theme);
            },
            onKey: (key, state) => {
                if (matchesKey(key, "up") || key === "k") {
                    if (scrollOffset > 0) {
                        scrollOffset--;
                        state.scrollOffset = scrollOffset;
                    }
                    return true;
                }

                if (matchesKey(key, "down") || key === "j") {
                    if (scrollOffset < maxScrollOffset) {
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

export default function registerConfigCommand(pi: ExtensionAPI) {
    const configSubcommands: AutocompleteItem[] = [
        {
            value: "show",
            label: "show (default)",
            description: "Display the currently loaded sandbox configuration",
        },
        {
            value: "reload",
            label: "reload",
            description: "Reload the configuration from disk",
        },
    ];

    pi.registerCommand("bash-sandbox-config", {
        description: "Show the currently loaded sandbox configuration",
        getArgumentCompletions: (prefix: string) => {
            const completions: AutocompleteItem[] = [];

            for (const subcommand of configSubcommands) {
                if (prefix && !subcommand.value.startsWith(prefix)) {
                    continue;
                }

                completions.push(subcommand);
            }

            return completions;
        },
        handler: async (args, ctx) => {
            const subcommand = args.trim();

            switch (subcommand) {
                case "reload":
                    try {
                        sandboxConfig.load(ctx.cwd);
                        ctx.ui.notify("pi-bash-sandbox: Configuration reloaded from disk", "info");
                    } catch (e) {
                        const error = e as Error;
                        ctx.ui.notify(
                            `pi-bash-sandbox: Failed to reload config: ${error.message}`,
                            "error",
                        );
                    }
                    break;

                case "show":
                case "":
                    await showConfig(args, ctx);
                    break;

                default:
                    ctx.ui.notify(`pi-bash-sandbox: Unknown subcommand: ${args}.`, "warning");
            }
        },
    });
}
