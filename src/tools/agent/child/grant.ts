import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { agentAuthority, hasAgentAuthority, hasAgentCapability } from "../definitions/types";
import { capabilityReadRoots, capabilityTools } from "./capabilities";
import type { AgentAuthority } from "../definitions/types";
import type { ChildAgentFactoryContext } from "../contracts/runs";
import type { ChildExtensionOptions } from "./extension";

/**
 * Everything a child may do, resolved once from its definition plus the run mode and the parent's
 * ability to host a prompt.
 *
 * This is the only place that turns a capability declaration into a decision. The session bootstrap,
 * the extension set, the system prompt, the tool allowlist, and the permission gates each read a
 * field here rather than re-deriving a rule, because every one of those derivations was previously
 * duplicated in a second consumer and drifted.
 *
 * Two separate questions are kept separate on purpose:
 *
 * - `authority` orders *gate strength* (`read < inspect < command < mutate`), so it answers "may this
 *   child be gated, run serially, or carry the worker label?".
 * - `capabilityTools` answers "which tools exist at all", and `edit` deliberately does not imply shell
 *   access there. A mutation-only definition has no `bash` tool even though it sits on the top rung.
 */
export interface ChildGrant {
    /** Where this child sits on the command-and-mutation ladder. */
    authority: AgentAuthority;
    /** Tools contributed by the capability declaration, before interaction tools are added. */
    capabilityTools: string[];
    /**
     * The strict SDK allowlist for the session. `createAgentSession({ tools })` filters extension
     * tools too, so any capability that registers its own tool must appear here.
     */
    sessionTools: string[];
    /** The name the child extension registers under. */
    extensionKind: string;
    /**
     * Whether a child's tool calls must run one at a time.
     *
     * Worker mutation permission is implemented in beforeToolCall. The SDK preflights every tool in a
     * parallel batch before executing any of them; waiting for a previous tool_result from that hook
     * would therefore deadlock a batch containing multiple mutations, so a gated child runs its calls
     * one at a time and each approval can reach execution and release its gate.
     * TODO(agent): Consider moving permission/queue handling into tool execution wrappers so read-only
     * worker calls can remain parallel.
     */
    requiresSequentialToolExecution: boolean;
    /** Whether this child may ask the end user directly, once the parent can host the prompt. */
    canAskUser: boolean;
    /** Whether the run owns a workspace; a workspace id counts even when the transient flag was lost. */
    isolated: boolean;
    /** Whether the parent launched this run in the background. */
    background: boolean;
    /** Read roots beyond the working directory, including the memory directory when granted. */
    readRoots: string[];
    /** Exact command patterns the definition adds to the read-only Bash heuristic. */
    safeBashCommands: string[];
    /** Whether the child may write to a private scratchpad; the prompt and the gate read this. */
    hasScratchpad: boolean;
    /** Whether the child may read the full-output files its own Bash results report. */
    bashOutputAccess: boolean;
    /** Option bag for the child extension; replaced by per-unit installation in stage 4. */
    extensionOptions: ChildExtensionOptions;
}

/**
 * Resolves a definition into a grant.
 *
 * `context` carries the run mode and the callbacks the child reports through; only the run mode
 * affects what is decided here. The callbacks are placed verbatim into `extensionOptions` so the
 * factory call site cannot silently drop one.
 */
export function resolveChildGrant(
    context: ChildAgentFactoryContext,
    parentContext: ExtensionContext,
): ChildGrant {
    const definition = context.definition;
    const authority = agentAuthority(definition);
    const tools = capabilityTools(definition);
    const readRoots = capabilityReadRoots(definition);
    const safeBashCommands = definition.safeBashCommands ?? [];
    const hasScratchpad = hasAgentCapability(definition, "scratchpad");

    // A background or print-mode parent has no UI to answer with, so asking would strand the child:
    // the definition's own flag is necessary but not sufficient. This is the only place that rule is
    // evaluated, and both the prompt and the tool registration consume the result.
    const canAskUser =
        definition.allowUserInteraction !== false &&
        parentContext.hasUI === true &&
        parentContext.mode === "tui";

    // Restored isolated runs keep their workspace id even when the transient `isolated` flag was not
    // persisted with the run, so both spellings resolve to one value here.
    const isolated = context.isolated === true || context.workspaceId !== undefined;

    return {
        authority,
        capabilityTools: tools,
        sessionTools: [
            ...tools,
            ...(canAskUser ? ["ask_user"] : []),
            // `ask_parent` needs no UI: it pauses the run and reports through the parent.
            "ask_parent",
        ],
        extensionKind: extensionKindFor(authority),
        requiresSequentialToolExecution: hasAgentAuthority(authority, "command"),
        canAskUser,
        isolated,
        background: context.background === true,
        readRoots,
        safeBashCommands,
        hasScratchpad,
        bashOutputAccess: hasAgentCapability(definition, "safe-bash"),
        extensionOptions: {
            agentName: definition.name,
            authority,
            runId: context.runId ?? definition.name,
            runTitle: context.runTitle ?? context.runId ?? definition.name,
            isolated,
            canAskUser,
            additionalPaths: readRoots,
            safeBashCommands,
            defaultBashTimeoutSeconds: context.defaultBashTimeoutSeconds,
            onProgress: context.onProgress,
            onFileChanged: context.onFileChanged,
            onTrace: context.onTrace,
            events: context.events,
        },
    };
}

/**
 * The registered name of the child extension.
 *
 * A worker is named for its edit authority even though it also runs commands, so the top rung
 * decides the label the loader records.
 */
function extensionKindFor(authority: AgentAuthority): string {
    if (authority === "mutate") {
        return "pi-coder-worker-child";
    }
    if (hasAgentAuthority(authority, "command")) {
        return "pi-coder-command-child";
    }
    return "pi-coder-readonly-child";
}

/**
 * The `safeBash` prompt flag is the only remaining place a rung is translated back into a boolean,
 * and the comment above its call site explains why the two readings cannot disagree.
 */
