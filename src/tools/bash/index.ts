import { lookpath } from "lookpath";

import { isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type {
    ExtensionAPI,
    BashToolInput,
    EventBus,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import sandboxConfig, { type SandboxConfig } from "../../common/config";
import {
    getUserMemoryDirectory,
    PERMISSION_PROMPT_CONFIRMATION_DELAY_MS,
} from "../../common/constants";
import { getScratchpadPath } from "../../modules/scratchpad";
import { ALLOWED_COMMAND_ENTRY_TYPE, type AllowedCommandEntry } from "../../common/audit";
import sandbox from "../../modules/sandbox/bubblewrap";
import { Permission } from "../../modules/sandbox/permissions";
import {
    resolvePermissionDetails,
    unresolvedPermissionDetails,
    type ResolvePermissionDetails,
} from "../../modules/sandbox/resolve";
import {
    logBashDecision,
    type BashDecisionInput,
    type PromptOutcome,
} from "../../modules/sandbox/decision-log";
import { suggestRule } from "../../modules/sandbox/suggestions";
import { selectWithMessage, type SelectMessageItem } from "../../tui/select-with-message";
import {
    createPermissionState,
    getPermissionState,
    resetBashPermissionState,
    type PermissionState,
} from "../../modules/sandbox/permission-state";

// A prompt choice. The yes-actions are resolved at confirm time (the mode
// can change while the dialog is open); "remember" additionally saves a
// session rule whose value is the action chosen.
type PromptChoice = { kind: "remember"; saveRule: string } | { kind: "yes" } | { kind: "no" };

// FIXME: use the import instead of this (where is it exported from though? ide complains of @earendil-works/pi-coding-agent/core/extensions)
interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
}

// Optional note the permission dialog attaches to event.input when the user
// types one while approving or denying a command.
function userNote(input: Record<string, unknown>): string | undefined {
    const note = input._userMessage;
    return typeof note === "string" && note.trim() ? note.trim() : undefined;
}

interface PromptResult {
    permission: Permission;
    prompt: NonNullable<BashDecisionInput["prompt"]>;
    note?: string;
}

/**
 * Ask the user about a command that no rule or heuristic covered, and translate
 * the answer into a permission plus the session-rule side effect.
 *
 * The returned `prompt` is what the decision log records: the outcome, the rule
 * the suggestion table offered, and the rule the user chose to remember.
 */
async function promptForPermission(options: {
    command: string;
    unresolved: string[][];
    permissionState: PermissionState;
    sandboxEnabled: boolean;
    ctx: ExtensionContext;
    events?: EventBus;
}): Promise<PromptResult> {
    const { command, unresolved, permissionState, sandboxEnabled, ctx, events } = options;

    // Suggested session rule: only when exactly one segment is uncovered by
    // rules/heuristics and the suggestion table has a row for it. Multiple
    // uncovered segments keep the plain dialog (manual patterns are the tool
    // for those).
    const suggestion = unresolved.length === 1 ? suggestRule(unresolved[0]) : null;
    const items: SelectMessageItem<PromptChoice>[] = [
        {
            value: { kind: "yes" },
            label: "Yes",
            description: "run once",
        },
    ];
    if (suggestion) {
        // theme.bold (not fg/accent): accent marks the selected item. Pre-baked
        // here — the dialog component is rebuilt per prompt, so the style can't
        // go stale.
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
            // The title carries the current mode (re-evaluated per render — "s"
            // toggles it while the dialog is open)
            title: () => {
                const mode = !sandboxEnabled
                    ? "direct (sandbox off)"
                    : permissionState.bashSandboxed
                      ? "sandbox"
                      : "direct";
                return `pi-bash-sandbox: allow command? — mode: ${mode} (s)`;
            },
            contentLines: command.split("\n"),
            items,
            // The border tone doubles as a mode indicator: neutral border when
            // the command will run sandboxed, accent border when it runs direct
            // (including sandboxing disabled by config). Re-evaluated per render,
            // so "s" updates it live.
            borderTone: () =>
                sandboxEnabled && permissionState.bashSandboxed ? "border" : "borderAccent",
            handleSelectInput: (key) => {
                if (matchesKey(key, "s")) {
                    permissionState.bashSandboxed = !permissionState.bashSandboxed;
                    return true;
                }

                return false;
            },
            // Give the user a moment to notice and read the command before
            // buffered terminal input can approve it.
            confirmationDelayMs: PERMISSION_PROMPT_CONFIRMATION_DELAY_MS,
        },
        { ...ctx, events },
        ctx.signal,
    );

    const remembered = result?.value.kind === "remember" ? result.value.saveRule : null;
    const outcome: PromptOutcome = result ? result.value.kind : "dismissed";
    const prompt: PromptResult["prompt"] = {
        outcome,
        ...(suggestion === null ? {} : { suggestion }),
        ...(remembered === null ? {} : { rule: remembered }),
    };

    if (outcome === "no" || outcome === "dismissed") {
        return { permission: "deny", prompt, ...(result?.message ? { note: result.message } : {}) };
    }

    const permission = permissionState.bashSandboxed ? "allow:sandbox" : "allow";
    if (remembered !== null) {
        permissionState.bashRules[remembered] = permission;
        ctx.ui.notify(
            `pi-bash-sandbox: session rule saved: "${remembered}" → ${permission} (this session only)`,
            "info",
        );
    }

    return { permission, prompt, ...(result?.message ? { note: result.message } : {}) };
}

export default function registerBashToolHook(pi: ExtensionAPI) {
    // Runtime-local state must not leak into another parent or child extension
    // instance. Remembered rules are still cleared on each session start.
    let hasSupport = process.platform === "linux" || process.platform === "freebsd";

    let bwrap: string = "";
    const localPermissionState = createPermissionState();
    const permissionStateFor = (ctx: { sessionManager?: object }) =>
        ctx.sessionManager ? getPermissionState(ctx.sessionManager) : localPermissionState;

    pi.on("session_start", async (event, ctx) => {
        resetBashPermissionState(permissionStateFor(ctx));

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
                'pi-bash-sandbox: sandboxing disabled by config (sandbox.enabled = false); "allow:sandbox" commands will run unsandboxed\n',
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
        let details: ResolvePermissionDetails = unresolvedPermissionDetails();
        let prompt: BashDecisionInput["prompt"];
        const permissionState = permissionStateFor(ctx);
        const scratchpadPath = getScratchpadPath(ctx.sessionManager);
        const userMemoryDirectory = getUserMemoryDirectory();
        const additionalRoots = [...(scratchpadPath ? [scratchpadPath] : []), userMemoryDirectory];
        const readOnlyAdditionalRoots = [userMemoryDirectory];
        try {
            details = resolvePermissionDetails(
                event.input.command,
                ctx.cwd ?? process.cwd(),
                // session rules come after config rules, so on identical
                // patterns they win (last-match-wins semantics)
                {
                    permissions: {
                        ...sandboxConfig.current?.permissions,
                        ...permissionState.bashRules,
                    },
                    additionalRoots,
                    readOnlyAdditionalRoots,
                },
            );
            permission = details.permission;
            unresolved = details.unresolved;
        } catch (e) {
            ctx.ui.notify(`pi-bash-sandbox: ${e}`, "warning");
        }

        if (permission === "ask") {
            const answered = await promptForPermission({
                command: event.input.command,
                unresolved,
                permissionState,
                sandboxEnabled,
                ctx,
                events: pi.events,
            });
            permission = answered.permission;
            prompt = answered.prompt;

            // Attach message to input for retrieval in tool_result
            if (answered.note) {
                (event.input as Record<string, unknown>)._userMessage = answered.note;
            }
        }

        // Sandboxing disabled by config: "allow:sandbox" degrades to plain
        // "allow" (runs unsandboxed), as if bubblewrap were unavailable.
        if (permission === "allow:sandbox" && !sandboxEnabled) {
            permission = "allow";
        }

        let blocked: boolean;
        let sandboxed: boolean = true;
        let blockReason: string | undefined;
        const originalCommand = event.input.command; // Save before sandbox wrapping

        switch (permission) {
            case "allow:sandbox":
                if (!hasSupport || bwrap.length === 0) {
                    blocked = true;
                    blockReason =
                        "Command execution blocked due to lack of sandboxing. If this is the first execution, you can ask the user to run the command without sandboxing and try again.";
                    break;
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
                sandboxed = false;
                break;

            default:
                blocked = true;
                sandboxed = false;
                ctx.ui.notify(
                    `pi-bash-sandbox: Received bad action for command: ${permission}`,
                    "warning",
                );
                break;
        }

        // Record the decision for offline mining before any early return, so the
        // log covers denials and approvals that could not be executed.
        const decisionNote = userNote(event.input as Record<string, unknown>);
        logBashDecision({
            surface: "parent",
            cwd: ctx.cwd ?? process.cwd(),
            command: originalCommand,
            details,
            ...(prompt === undefined ? {} : { prompt }),
            decision: permission,
            sandboxed,
            blocked,
            ...(decisionNote === undefined ? {} : { note: decisionNote }),
        });

        if (blocked) {
            if (blockReason !== undefined) {
                return { block: true, reason: blockReason };
            }

            const baseReason = "Command execution blocked by user.";
            const reason = decisionNote
                ? `${baseReason} User message: ${decisionNote}`
                : baseReason;
            return {
                block: true,
                reason,
            };
        }

        // Track allowed command for audit
        pi.appendEntry<AllowedCommandEntry>(ALLOWED_COMMAND_ENTRY_TYPE, {
            command: originalCommand,
            permission: sandboxed ? "allow:sandbox" : "allow",
            ...(decisionNote && { userMessage: decisionNote }),
        });

        if (sandboxed) {
            event.input.command = sandbox(bwrap, event.input.command, {
                cwd: ctx.cwd,
                additionalRoots,
                readOnlyAdditionalRoots,
            });
        }

        return { block: false };
    });

    // Add user message to tool result for allowed commands
    pi.on("tool_result", async (event, _ctx) => {
        if (!isBashToolResult(event)) return;

        const userMessage = userNote(event.input as Record<string, unknown>);
        if (!userMessage) return;

        // Prepend user message to the result content
        const trimmed = userMessage.trim();
        const hasNewlines = trimmed.includes("\n");
        const note = hasNewlines
            ? `<user_note>\nThe user has made a note: ${trimmed}\n</user_note>\n`
            : `<user_note>The user has made a note: ${trimmed}</user_note>\n`;
        return {
            content: [{ type: "text", text: note }, ...event.content],
        };
    });
}
