import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    getPermissionState,
    type PermissionState,
} from "../../../../modules/sandbox/permission-state";
import { hasAgentAuthority } from "../../definitions/types";
import { reportProgress } from "../progress";
import type { ChildProgressTracker } from "../progress";
import type { ChildExtensionOptions } from "../extension";
import { scratchpadRoots } from "../roots";
import { createBashOutputLedger, type BashOutputLedger } from "./bash-output";

const MAX_RECENT_ACTIVITY = 8;

/**
 * Everything a gate may need about the child it is installed into.
 *
 * The gates of one child share three things, and sharing them here is the point: the Bash full-output
 * ledger (written by the bash-output gate, read when confinement computes roots), the permission state
 * (resolved once from isolation, consumed by the file-access and command gates), and
 * `reportPermissionPending` (the widget signal both gates raise). Each of those used to be closure
 * state in `registerChildExtension`, reachable from handlers written two hundred lines apart.
 */
export interface ChildGateRuntime {
    pi: ExtensionAPI;
    /** The grant-resolved facts about this child: rung, isolation, interaction, roots, callbacks. */
    options: ChildExtensionOptions;
    parentContext: ExtensionContext;
    cwd: string;
    tracker: ChildProgressTracker;
    bashOutputs: BashOutputLedger;
    /**
     * Approval state shared with the parent, defined for exactly one case: a *non-isolated* child whose
     * parent has a session to hold rules and which sits at the `command` rung or above. Gates therefore
     * test this field rather than re-testing isolation, which is what it already encodes.
     */
    permissionState?: PermissionState;
    /**
     * The parent's own state, kept separate because it is resolved without regard to isolation: an
     * explicitly remembered rule from an isolated child is written back here.
     */
    parentPermissionState?: PermissionState;
    /** How a permission prompt identifies this run to the end user. */
    runLabel: string;
    /** Read roots to check a path against: definition paths, scratchpad, and live Bash output files. */
    readRoots(ctx: ExtensionContext): readonly string[];
    /** Raises the widget's waiting state and reports the frame that carries it. */
    reportPermissionPending(pending: boolean, activity: string): void;
}

/** Assembles the shared gate state. Must be called once per child extension registration. */
export function createChildGateRuntime(input: {
    pi: ExtensionAPI;
    parentContext: ExtensionContext;
    cwd: string;
    tracker: ChildProgressTracker;
    options: ChildExtensionOptions;
}): ChildGateRuntime {
    const { pi, parentContext, cwd, tracker, options } = input;
    const {
        authority,
        isolated,
        runId,
        runTitle,
        additionalPaths = [],
        onProgress,
        onTrace,
    } = options;

    const bashOutputs = createBashOutputLedger();

    const parentSessionManager = parentContext.sessionManager;
    // Deliberately independent of isolation: when the end user explicitly remembers a command for an
    // *isolated* child, that rule is also recorded in the parent session for later parent and
    // non-isolated calls, which needs the parent's state object even though the child may not read it.
    const parentPermissionState =
        parentSessionManager && hasAgentAuthority(authority, "command")
            ? getPermissionState(parentSessionManager)
            : undefined;
    // Only a child that shares the checkout borrows those rules; an isolated child starts from a fresh
    // state created inside its own command gate.
    const permissionState = isolated ? undefined : parentPermissionState;

    const reportPermissionPending = (pending: boolean, activity: string): void => {
        tracker.progress.permissionPending = pending;
        tracker.progress.recentActivity.push(activity);
        tracker.progress.recentActivity =
            tracker.progress.recentActivity.slice(-MAX_RECENT_ACTIVITY);
        onTrace?.("mutation.permission", { pending, activity });
        // `permissionPending` is already stored above, so the shared frame projection carries the
        // same value this callback used to spell out by hand.
        reportProgress(tracker, onProgress);
    };

    return {
        pi,
        options,
        parentContext,
        cwd,
        tracker,
        bashOutputs,
        permissionState,
        parentPermissionState,
        runLabel: runTitle ? `${runTitle} · ${runId}` : runId,
        readRoots: (ctx: ExtensionContext) => [
            ...additionalPaths,
            ...scratchpadRoots(ctx),
            ...bashOutputs.active(),
        ],
        reportPermissionPending,
    };
}
