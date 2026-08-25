import { lookpath } from "lookpath";

import { isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type {
    ExtensionAPI,
    BashToolInput,
} from "@earendil-works/pi-coding-agent";

import sandboxConfig, { type SandboxConfig } from "../../common/config";
import { ALLOWED_COMMAND_ENTRY_TYPE, type AllowedCommandEntry } from "../../common/audit";
import sandbox from "../../modules/sandbox/bubblewrap";
import { Permission } from "../../modules/sandbox/permissions";
import { resolvePermissionDetails } from "../../modules/sandbox/resolve";
import { suggestRule } from "../../modules/sandbox/suggestions";
import { selectWithMessage, type SelectMessageItem } from "../../tui/select-with-message";

// A prompt choice. The yes-actions are resolved at confirm time (the mode
// can change while the dialog is open); "remember" additionally saves a
// session rule whose value is the action chosen.
type PromptChoice =
    | { kind: "remember"; saveRule: string }
    | { kind: "yes" }
    | { kind: "no" };

// FIXME: use the import instead of this (where is it exported from though? ide complains of @earendil-works/pi-coding-agent/core/extensions)
interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
}

export default function registerBashToolHook(pi: ExtensionAPI) {
    // Runtime-local state must not leak into another parent or child extension
    // instance. Remembered rules are still cleared on each session start.
    let sessionRules: Record<string, Permission> = {};
    let defaultSandboxed = true;
    let hasSupport =
        process.platform === "linux" || process.platform === "freebsd";

    let bwrap: string = "";

    pi.on("session_start", async (event, ctx) => {
        sessionRules = {};
        defaultSandboxed = true;

        if (!hasSupport) {
            ctx.ui.notify(
                `pi-bash-sandbox: platform ${process.platform} is not supported\n`,
                "warning",
            );

            return;
        }

        // Load config first so we know whether sandboxing is enabled at all
        let config: SandboxConfig | null = null;
        try {
            config = sandboxConfig.load(ctx.cwd);
        } catch {
            // no config file found; defaults apply
        }

        if (config !== null) {
          ctx.ui.notify(
              `pi-bash-sandbox: loaded config has ${Object.entries(config.sandbox.mounts).length} mount(s) and ${Object.entries(config.permissions).length} permission(s).\n`,
              "info",
          );
        }

        const sandboxEnabled = config?.sandbox.enabled !== false;

        if (!sandboxEnabled) {
            ctx.ui.notify(
                "pi-bash-sandbox: sandboxing disabled by config (sandbox.enabled = false); \"allow:sandbox\" commands will run unsandboxed\n",
                "info",
            );

            return;
        }

        bwrap = (await lookpath("bwrap")) ?? "";

        if (bwrap.length === 0) {
            hasSupport = false;

            ctx.ui.notify(
                "pi-bash-sandbox: bubblewrap package is required for linux sandboxing\n",
                "warning",
            );

            return;
        }
    });

    // Add system prompt instructions about user notes
    pi.on("before_agent_start", async (event) => {
        const notes = `## Bash Sandbox User Notes

When requesting to run bash commands, the user may attach a note explaining their decision. These notes appear:
- For blocked commands: in the block reason
- For allowed commands: inside \`<user_note>\` tags at the start of the command output

Pay attention to these notes as they provide context about the user's preferences and concerns.
`;

        const notesBlock = `<bash_sandbox>\n${notes}\n</bash_sandbox>`;
        let systemPrompt = event.systemPrompt;

        // Don't add if our block is already in the system prompt
        if (systemPrompt.includes("<bash_sandbox>")) {
            return { systemPrompt };
        }

        const projectContextEnd = "</project_context>";
        const idx = systemPrompt.indexOf(projectContextEnd);
        if (idx !== -1) {
            systemPrompt =
                systemPrompt.slice(0, idx + projectContextEnd.length) +
                "\n\n" +
                notesBlock +
                "\n" +
                systemPrompt.slice(idx + projectContextEnd.length);
        } else {
            systemPrompt = systemPrompt + "\n\n" + notesBlock;
        }

        return {
            systemPrompt,
        };
    });

    if (!hasSupport) {
        return;
    }

    pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
        if (!isToolCallEventType<"bash", BashToolInput>("bash", event)) {
            return { block: false };
        }

        // Master switch from config (sandbox.enabled), read at call time so
        // "/bash-sandbox-config reload" takes effect immediately. When false,
        // the extension behaves as if bubblewrap were unavailable: no
        // "Yes (sandbox)" prompt option and "allow:sandbox" degrades to
        // plain "allow".
        const sandboxEnabled = sandboxConfig.current?.sandbox.enabled !== false;

        let permission: Permission = "ask";
        let unresolved: string[][] = [];
        try {
            const details = resolvePermissionDetails(
                event.input.command,
                ctx.cwd ?? process.cwd(),
                // session rules come after config rules, so on identical
                // patterns they win (last-match-wins semantics)
                { permissions: { ...sandboxConfig.current?.permissions, ...sessionRules } },
            );
            permission = details.permission;
            unresolved = details.unresolved;
        } catch (e) {
            ctx.ui.notify(`pi-bash-sandbox: ${e}`, "warning");
        }

        if (permission === "ask") {
            // Suggested session rule: only when exactly one segment is
            // uncovered by rules/heuristics and the suggestion table has a
            // row for it. Multiple uncovered segments keep the plain
            // dialog (manual patterns are the tool for those).
            const suggestion = unresolved.length === 1
                ? suggestRule(unresolved[0])
                : null;

            const items: SelectMessageItem<PromptChoice>[] = [
                {
                    value: { kind: "yes" },
                    label: "Yes",
                    description: "run once",
                },
            ];
            if (suggestion) {
                // theme.bold (not fg/accent): accent marks the selected
                // item. Pre-baked here — the dialog component is rebuilt
                // per prompt, so the style can't go stale.
                const boldPattern = ctx.hasUI ? ctx.ui.theme.bold(suggestion) : suggestion;
                items.push({
                    value: { kind: "remember", saveRule: suggestion },
                    label: `Yes, and allow ${boldPattern}`,
                    description: "remember for this session",
                });
            }
            items.push({
                value: { kind: "no" },
                label: "No",
                placeholder: "e.g., too risky",
            });

            const result = await selectWithMessage(
                {
                    // The title carries the current mode (re-evaluated per
                    // render — "s" toggles it while the dialog is open)
                    title: () => {
                        const mode = !sandboxEnabled
                            ? "direct (sandbox off)"
                            : (defaultSandboxed ? "sandbox" : "direct");
                        return `pi-bash-sandbox: allow command? — mode: ${mode} (s)`;
                    },
                    contentLines: event.input.command.split("\n"),
                    items,
                    // The border tone doubles as a mode indicator: neutral
                    // border when the command will run sandboxed, accent
                    // border when it runs direct (including sandboxing
                    // disabled by config). Re-evaluated per render, so
                    // "s" updates it live.
                    borderTone: () =>
                        sandboxEnabled && defaultSandboxed ? "border" : "borderAccent",
                    handleSelectInput: (key) => {
                        if (matchesKey(key, "s")) {
                            defaultSandboxed = !defaultSandboxed;
                            return true;
                        }

                        return false;
                    },
                },
                { ...ctx, events: pi.events },
                ctx.signal,
            );

            if (result) {
                if (result.value.kind === "no") {
                    permission = "deny";
                } else {
                    permission = defaultSandboxed ? "allow:sandbox" : "allow";
                    if (result.value.kind === "remember") {
                        sessionRules[result.value.saveRule] = permission;
                        ctx.ui.notify(
                            `pi-bash-sandbox: session rule saved: "${result.value.saveRule}" → ${permission} (this session only)`,
                            "info",
                        );
                    }
                }
                // Attach message to input for retrieval in tool_result
                if (result.message) {
                    (event.input as any)._userMessage = result.message;
                }
            } else {
                permission = "deny";
            }
        }

        // Sandboxing disabled by config: "allow:sandbox" degrades to plain
        // "allow" (runs unsandboxed), as if bubblewrap were unavailable.
        if (permission === "allow:sandbox" && !sandboxEnabled) {
            permission = "allow";
        }

        let blocked: boolean = true;
        let sandboxed: boolean = true;
        const originalCommand = event.input.command;  // Save before sandbox wrapping

        switch (permission) {
            case "allow:sandbox":
                if (!hasSupport || bwrap.length === 0) {
                    return {
                        block: true,
                        reason: "Command execution blocked due to lack of sandboxing. If this is the first execution, you can ask the user to run the command without sandboxing and try again.",
                    };
                }

                blocked = false;
                sandboxed = true;

                break;

            case "allow":
                blocked = false;
                sandboxed = false;
                break;

            case "deny":
                blocked = true;
                break;

            default:
                blocked = true;
                ctx.ui.notify(
                    `pi-bash-sandbox: Received bad action for command: ${permission}`,
                    "warning",
                );
                break;
        }

        if (blocked) {
            const userMessage = (event.input as any)._userMessage;
            const baseReason = "Command execution blocked by user.";
            const reason = userMessage ? `${baseReason} User message: ${userMessage}` : baseReason;
            return {
                block: true,
                reason,
            };
        }

        // Track allowed command for audit
        const userMessage = (event.input as any)._userMessage;
        pi.appendEntry<AllowedCommandEntry>(ALLOWED_COMMAND_ENTRY_TYPE, {
            command: originalCommand,
            permission: sandboxed ? "allow:sandbox" : "allow",
            ...(userMessage && { userMessage }),
        });

        if (sandboxed) {
            event.input.command = sandbox(bwrap, event.input.command);
        }

        return { block: false };
    });

    // Add user message to tool result for allowed commands
    pi.on("tool_result", async (event, ctx) => {
        if (!isBashToolResult(event)) return;

        const userMessage = (event.input as any)._userMessage;
        if (!userMessage) return;

        // Prepend user message to the result content
        const trimmed = userMessage.trim();
        const hasNewlines = trimmed.includes("\n");
        const note = hasNewlines
            ? `<user_note>\nThe user has made a note: ${trimmed}\n</user_note>\n`
            : `<user_note>The user has made a note: ${trimmed}</user_note>\n`;
        return {
            content: [
                { type: "text", text: note },
                ...event.content,
            ],
        };
    });
}
