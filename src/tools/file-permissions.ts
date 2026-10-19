import fs from "node:fs";
import path from "node:path";

import {
    isReadToolResult,
    isWriteToolResult,
    type EventBus,
    type ExtensionAPI,
    type ExtensionContext,
    type ReadToolInput,
    type ToolCallEventResult,
    type WriteToolInput,
} from "@earendil-works/pi-coding-agent";

import sandboxConfig, { type SandboxConfigCwdConfinement } from "../common/config";
import { resolveHomeDirectory } from "../common/home-directory";
import { getScratchpadPath } from "../modules/scratchpad";
import {
    createPermissionState,
    getPermissionState,
    type PermissionState,
} from "../modules/sandbox/permission-state";
import { fileRootsForOperation } from "../modules/sandbox/file-roots";
import { ALLOWED_FILE_ENTRY_TYPE, type AllowedFileEntry } from "../common/audit";
import {
    getPathConfinementAssessment,
    isPathWithinDirectory,
    isSafeHeuristic,
    UnsafeReason,
    type HeuristicAssessment,
    type PathConfinementOptions,
} from "../modules/sandbox/heuristics";
import {
    decisionConfig,
    type ClassifierRegistry,
    type DecisionIsolation,
    type DecisionRunner,
    type DecisionSurface,
} from "../modules/decision";
import { consultFileAccessForGate } from "./decision-model";
import {
    logFileAccessDecision,
    type BashClassifierRecord,
    type FileDecisionResolution,
    type PromptOutcome,
} from "../modules/sandbox/decision-log";
import {
    selectWithMessage,
    type SelectMessageItem,
    type SelectWithMessageResult,
} from "../tui/select-with-message";

type FileOperation = "read" | "write";
type PromptChoice = { kind: "remember"; folder: string } | { kind: "yes" } | { kind: "no" };

const approvedToolCalls = new WeakSet<object>();

export function isFileAccessApproved(event: object): boolean {
    return approvedToolCalls.has(event);
}

function operationLabel(operation: FileOperation): string {
    return operation === "read" ? "read from" : "write to";
}

function isAllowedFileEntry(data: unknown): data is AllowedFileEntry {
    if (!data || typeof data !== "object") {
        return false;
    }

    const entry = data as Partial<AllowedFileEntry>;
    return (
        (entry.operation === "read" || entry.operation === "write") &&
        typeof entry.folder === "string" &&
        entry.folder.length > 0 &&
        path.isAbsolute(entry.folder)
    );
}

function restoreSessionFolders(
    ctx: ExtensionContext,
    operation: FileOperation,
    sessionFolders: Set<string>,
): void {
    sessionFolders.clear();

    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== ALLOWED_FILE_ENTRY_TYPE) {
            continue;
        }

        if (isAllowedFileEntry(entry.data) && entry.data.operation === operation) {
            sessionFolders.add(entry.data.folder);
        }
    }
}

export interface ApprovedFileFolderOptions {
    operation: FileOperation;
    state: PermissionState;
    confinement?: SandboxConfigCwdConfinement;
}

export function getApprovedFileFolder(
    filePath: string,
    cwd: string,
    options: ApprovedFileFolderOptions,
): string | undefined {
    const {
        operation,
        state,
        confinement = sandboxConfig.current?.heuristics?.cwdConfinement,
    } = options;

    for (const folder of state.fileFolders[operation]) {
        if (isPathWithinDirectory(filePath, folder, cwd, confinement)) {
            return folder;
        }
    }

    return undefined;
}

/** The target as the tool will open it: `~` expanded, relative parts resolved against the cwd. */
function resolveTargetPath(filePath: string, cwd: string): string {
    const expanded =
        filePath === "~" || filePath.startsWith("~/")
            ? resolveHomeDirectory() + filePath.slice(1)
            : filePath;

    return path.resolve(cwd, expanded);
}

function sessionFolderFor(filePath: string, cwd: string): string {
    // File tools operate on files, so the containing directory is the narrowest
    // useful scope for the "always allow" choice.
    const resolved = resolveTargetPath(filePath, cwd);

    try {
        if (fs.statSync(resolved).isDirectory()) {
            return resolved;
        }
    } catch {
        // A write target, or a missing read target, uses its parent folder.
    }

    return path.dirname(resolved);
}

/**
 * Whether the only thing wrong with this access is that the path sits outside every trusted root.
 *
 * That is the one question the decision model is allowed to answer. A sensitive name, a symlink escape, or a
 * dynamic target is a different kind of "no" — the confinement checks that produced those reasons are the
 * guarantees the file gates exist to keep, and a classifier cannot trade one for fewer prompts. The same test
 * is what the child branch already uses to choose block-versus-prompt, so the two gates cannot disagree about
 * when the model gets a vote.
 */
function isOutsideEveryRoot(assessment: HeuristicAssessment): boolean {
    return assessment.reasons.length === 1 && assessment.reasons[0] === UnsafeReason.OUTSIDE_CWD;
}

// Optional note the permission dialog attaches to event.input when the user
// types one while approving or denying an operation.
function userNote(input: Record<string, unknown>): string | undefined {
    const note = input._userMessage;
    return typeof note === "string" && note.trim() ? note.trim() : undefined;
}

async function promptForFileAccess(
    operation: FileOperation,
    filePath: string,
    folder: string,
    uiContext: ExtensionContext,
    signal: AbortSignal | undefined,
    events: ExtensionAPI["events"],
    promptTitle?: string | (() => string),
): Promise<SelectWithMessageResult<PromptChoice> | undefined> {
    if (!uiContext.hasUI) {
        return undefined;
    }

    const boldFolder = uiContext.ui.theme.bold(folder);
    const items: SelectMessageItem<PromptChoice>[] = [
        {
            value: { kind: "yes" },
            label: "Yes",
            description: "allow once",
        },
        {
            value: { kind: "remember", folder },
            label: `Yes, and always allow ${boldFolder}`,
            description: "for this session",
        },
        {
            value: { kind: "no" },
            label: "No",
            placeholder: "e.g., do not access that folder",
        },
    ];

    const result = await selectWithMessage(
        {
            title:
                promptTitle ?? `pi-${operation}-sandbox: allow ${operationLabel(operation)} path?`,
            contentLines: [filePath],
            items,
        },
        { ...uiContext, events },
        signal,
    );

    return result;
}

/**
 * How this surface asks the decision model about an access that left every trusted root.
 *
 * Absent wiring means the gate never consults: the model is an optional second opinion on a prompt, not a
 * third gate, and a hook installed without it cannot reach the endpoint even when the user's config enables
 * the surface.
 */
export interface FileDecisionWiring {
    /** Which surface is asking: `parent` for the user's own session, `child` for a delegated runner. */
    surface: DecisionSurface;
    /** Who is asking, when that is not the parent. */
    runner?: DecisionRunner;
    /** Where a mutating runner's working copy is. */
    isolation?: DecisionIsolation;
    /** The registry the classifier resolves from; a child passes its parent's. */
    registry?: ClassifierRegistry;
    /** The bus the parent footer listens to, so a child's check animates the parent's badge too. */
    events?: EventBus;
}

/**
 * Guard one of pi's built-in file tools.
 *
 * Paths inside a trusted root pass: the working directory, the runtime scratchpad, the roots the user
 * declared in `files`/`sandbox.mounts`, the extra roots this hook was given, and the folders a human already
 * approved. Anything else asks the decision model when this surface is wired for it, and then asks the human —
 * in that order, and never the other way, because a session approval is a person's standing decision and
 * outranks a model's opinion about the same path.
 */
export interface FilePermissionHookOptions {
    /** Permission state shared with the parent runtime for non-isolated children. */
    state?: PermissionState;
    /** Use the parent UI when this is a child extension. */
    promptContext?: ExtensionContext;
    /** Child hooks must not restore/reset their own transcript's folder entries. */
    restoreSession?: boolean;
    /** Child approvals update shared state but must not append to the child transcript. */
    persistSession?: boolean;
    /** Preserve child confinement by refusing sensitive/symlink paths without prompting. */
    childAccess?: boolean;
    /** Child hooks use their fixed confinement rather than parent config defaults. */
    confinement?: SandboxConfigCwdConfinement;
    /** Additional exact paths that are readable for this child runtime. */
    additionalReadRoots?: (ctx: ExtensionContext) => readonly string[];
    /** Worker hooks report dialogs through the child progress tracker. */
    permissionPending?: (pending: boolean, activity: string) => void;
    /** Optional run-labelled title for child permission dialogs. */
    promptTitle?: string | (() => string);
    /** Decision-model wiring for this surface; absent means the gate never consults. */
    decision?: FileDecisionWiring;
    /** Agent name recorded on the decision log line for a child surface. */
    agentName?: string;
}

/** One access that left every trusted root, with everything the log line needs to say what happened. */
interface OutsideRootAccess {
    operation: FileOperation;
    cwd: string;
    /** The path as the tool asked for it, which is what the dialog shows. */
    requestedPath: string;
    /** The target as the tool will open it: expanded and resolved, which is what the model judges. */
    path: string;
    /** The folder a human's "always allow" would have covered. */
    folder: string;
    reasons: UnsafeReason[];
    /** Session approval state, threaded through so the prompt path uses the same state the gate checked. */
    state: PermissionState;
    /** Set once the model has been consulted, so whichever path the access takes records the same verdict. */
    classifier?: BashClassifierRecord;
}

export default function registerFileToolHook(
    pi: ExtensionAPI,
    operation: FileOperation,
    options: FilePermissionHookOptions = {},
): void {
    const localState = createPermissionState();
    const stateFor = (ctx: ExtensionContext): PermissionState => {
        if (options.state) return options.state;
        if (ctx.sessionManager) return getPermissionState(ctx.sessionManager);
        return localState;
    };

    pi.on("session_start", (_event, ctx) => {
        if (options.restoreSession !== false) {
            restoreSessionFolders(ctx, operation, stateFor(ctx).fileFolders[operation]);
        }
    });

    pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
        if (!isGuardedTool(event.toolName, operation)) {
            return { block: false };
        }

        const input = event.input as ReadToolInput | WriteToolInput;
        const filePath = input.path?.trim() || ".";
        const cwd = ctx.cwd ?? process.cwd();
        const state = stateFor(ctx);
        const confinement =
            options.confinement ?? sandboxConfig.current?.heuristics?.cwdConfinement;
        const scratchpadPath = getScratchpadPath(ctx.sessionManager);
        const scratchpadRoots = scratchpadPath ? [scratchpadPath] : [];
        // A child borrows the parent's *read* declarations and none of its write ones: its writable surface is
        // what its definition granted, and `files.writeRoots` is a statement about the user's own session. The
        // read hook is unchanged here because `additionalReadRoots` already carries the child's declared roots.
        const declaredRoots =
            operation === "write" && options.childAccess
                ? []
                : fileRootsForOperation(sandboxConfig.current, operation);
        const additionalRoots = [
            ...scratchpadRoots,
            ...declaredRoots,
            ...(operation === "read" ? (options.additionalReadRoots?.(ctx) ?? []) : []),
        ];

        const pathOptions: PathConfinementOptions = {
            cwd,
            config: confinement,
            access: operation,
            additionalRoots,
            // Stated rather than left to the "unset means exempt" default: the agent gets leeway inside its
            // own scratchpad, while a declared host root keeps sensitive-name filtering.
            sensitiveAdditionalRoots: scratchpadRoots,
        };

        const assessment = getPathConfinementAssessment(filePath, pathOptions);
        if (isSafeHeuristic(assessment.classification)) {
            return { block: false };
        }

        if (options.childAccess && !isOutsideEveryRoot(assessment)) {
            return {
                block: true,
                reason: `Child ${operation} access blocked: path is outside the working directory or is sensitive.`,
            };
        }

        const approvedFolder = getApprovedFileFolder(filePath, cwd, {
            operation,
            state,
            confinement,
        });
        if (approvedFolder !== undefined) {
            approvedToolCalls.add(event);
            return { block: false };
        }

        const access: OutsideRootAccess = {
            operation,
            cwd,
            requestedPath: filePath,
            path: resolveTargetPath(filePath, cwd),
            folder: sessionFolderFor(filePath, cwd),
            reasons: assessment.reasons,
            state,
        };

        if (options.decision !== undefined && isOutsideEveryRoot(assessment)) {
            const allowed = await consultModel(access, event, ctx, options);
            if (allowed) {
                return { block: false };
            }
        }

        return askUser(pi, access, event, ctx, options);
    });

    // Preserve an optional note from the permission dialog in the tool result,
    // matching the bash hook's behavior.
    pi.on("tool_result", async (event) => {
        const isMatchingTool =
            operation === "read" ? isReadToolResult(event) : isWriteToolResult(event);
        if (!isMatchingTool) return;

        const userMessage = userNote(event.input as Record<string, unknown>);
        if (!userMessage) return;

        const trimmed = userMessage.trim();
        const note = trimmed.includes("\n")
            ? `<user_note>\nThe user has made a note: ${trimmed}\n</user_note>\n`
            : `<user_note>The user has made a note: ${trimmed}</user_note>\n`;
        return {
            content: [{ type: "text", text: note }, ...event.content],
        };
    });
}

/** The tools each file gate claims: reads cover pi's four read-only path tools, writes the two mutators. */
function isGuardedTool(toolName: string, operation: FileOperation): boolean {
    if (operation === "read") {
        return (
            toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls"
        );
    }

    return toolName === "write" || toolName === "edit";
}

/**
 * Ask the model about one access outside every root, and return whether it licensed the access.
 *
 * A grant approves this one call — never the folder, which stays a human's standing decision — and writes its
 * own log line. A withheld verdict is not discarded: it stays on `access` so the log line the prompt path
 * writes carries what the model said and why the human was asked anyway.
 */
async function consultModel(
    access: OutsideRootAccess,
    event: object,
    ctx: ExtensionContext,
    options: FilePermissionHookOptions,
): Promise<boolean> {
    const wiring = options.decision;
    if (wiring === undefined) {
        return false;
    }

    const config = decisionConfig.load(ctx.cwd);
    const notifyContext = options.promptContext ?? ctx;
    const consulted = await consultFileAccessForGate({
        ctx,
        config,
        surface: wiring.surface,
        operation: access.operation,
        path: access.path,
        label: `that ${access.operation}`,
        notify: (message, level) => notifyContext.ui.notify(message, level),
        ...(wiring.runner === undefined ? {} : { runner: wiring.runner }),
        ...(wiring.isolation === undefined ? {} : { isolation: wiring.isolation }),
        ...(wiring.registry === undefined ? {} : { registry: wiring.registry }),
        ...(wiring.events === undefined ? {} : { events: wiring.events }),
    });

    if (consulted === undefined) {
        return false;
    }

    access.classifier = consulted.record;

    if (consulted.permission !== "allow") {
        return false;
    }

    approvedToolCalls.add(event);
    logFileAccessDecision({
        surface: surfaceForLog(wiring.surface),
        ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
        cwd: access.cwd,
        operation: access.operation,
        path: access.path,
        folder: access.folder,
        reasons: access.reasons,
        resolvedBy: "classifier",
        decision: "allow",
        blocked: false,
        ...(consulted.record === undefined ? {} : { classifier: consulted.record }),
    });

    return true;
}

/**
 * Ask the human, apply the answer, and record the decision.
 *
 * The approval semantics are the ones this hook has always had; what the model changed is only that some
 * accesses never get here.
 */
async function askUser(
    pi: ExtensionAPI,
    access: OutsideRootAccess,
    event: { input?: unknown },
    ctx: ExtensionContext,
    options: FilePermissionHookOptions,
): Promise<ToolCallEventResult> {
    const uiContext = options.promptContext ?? ctx;
    const input = event.input as ReadToolInput | WriteToolInput;
    let result: SelectWithMessageResult<PromptChoice> | undefined;

    options.permissionPending?.(
        true,
        `Waiting for permission to ${access.operation} ${access.requestedPath}`,
    );
    try {
        result = await promptForFileAccess(
            access.operation,
            access.requestedPath,
            access.folder,
            uiContext,
            ctx.signal,
            pi.events,
            options.promptTitle,
        );
    } finally {
        options.permissionPending?.(false, "Working");
    }

    const choice = result?.value;
    if (result?.message && input) {
        (input as Record<string, unknown>)._userMessage = result.message;
    }

    const resolution: FileDecisionResolution = result === undefined ? "unavailable" : "prompt";
    const outcome = promptOutcome(result, choice);
    const note = result?.message;

    if (choice?.kind === "remember") {
        rememberSessionFolder(access, pi, ctx, options, choice.folder);
        logPrompted(access, options, resolution, outcome, "allow", false, note);
        approvedToolCalls.add(event);
        return { block: false };
    }

    if (choice?.kind === "yes") {
        logPrompted(access, options, resolution, outcome, "allow", false, note);
        approvedToolCalls.add(event);
        return { block: false };
    }

    const mode = ctx.hasUI ? "user" : "non-interactive mode";
    const baseReason = `File ${access.operation} blocked by ${mode}; path is outside the allowed working directory.`;
    logPrompted(access, options, resolution, outcome, "deny", true, note);

    return {
        block: true,
        reason: note ? `${baseReason} User message: ${note}` : baseReason,
    };
}

function promptOutcome(
    result: SelectWithMessageResult<PromptChoice> | undefined,
    choice: PromptChoice | undefined,
): PromptOutcome | undefined {
    if (result === undefined) {
        return undefined;
    }

    if (choice === undefined) {
        return "dismissed";
    }

    return choice.kind;
}

function logPrompted(
    access: OutsideRootAccess,
    options: FilePermissionHookOptions,
    resolution: FileDecisionResolution,
    outcome: PromptOutcome | undefined,
    decision: "allow" | "deny",
    blocked: boolean,
    note: string | undefined,
): void {
    logFileAccessDecision({
        surface: surfaceForLog(options.decision?.surface),
        ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
        cwd: access.cwd,
        operation: access.operation,
        path: access.path,
        folder: access.folder,
        reasons: access.reasons,
        resolvedBy: resolution,
        ...(outcome === undefined ? {} : { prompt: { outcome } }),
        ...(access.classifier === undefined ? {} : { classifier: access.classifier }),
        decision,
        blocked,
        ...(note === undefined ? {} : { note }),
    });
}

function rememberSessionFolder(
    access: OutsideRootAccess,
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    options: FilePermissionHookOptions,
    folder: string,
): void {
    access.state.fileFolders[access.operation].add(folder);
    if (options.persistSession !== false) {
        pi.appendEntry<AllowedFileEntry>(ALLOWED_FILE_ENTRY_TYPE, {
            operation: access.operation,
            folder,
        });
    }

    const uiContext = options.promptContext ?? ctx;
    uiContext.ui.notify(
        `pi-${access.operation}-sandbox: session folder allowed: "${folder}" (this session only)`,
        "info",
    );
}

/** The log's surface: the wiring names the runner, and the log has one field for it. */
function surfaceForLog(surface: DecisionSurface | undefined): "parent" | "child" {
    return surface === "child" ? "child" : "parent";
}

export type { FileOperation };
