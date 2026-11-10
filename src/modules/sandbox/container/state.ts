import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PI_CODER_STATE_DIR } from "../../../common/constants";
import type { ContainerSession } from "./client";

/**
 * Whether this runtime's bash and file tools run inside the sandbox container.
 *
 * One mutable flag shared by the backend and the bash hook, because the two cannot ask each other: the
 * backend installs the container's `bash` tool, while the hook decides whether a sandboxed verdict still
 * needs a `bwrap` wrapper and whether a missing `bwrap` binary is fatal at all. Reading the environment
 * (`PI_SANDBOX_BACKEND`) for that answer is what made the backend a process-wide fact instead of a
 * per-session one — and what once left a delegated child's command unwrapped on the host.
 *
 * A child runtime gets its own state object, so its answer never leaks into the parent's.
 */
export interface ContainerState {
    active: boolean;
    /**
     * Resolve this runtime's container session.
     *
     * Set by the backend that owns the state, so a tool that needs the same filesystem view as `bash` and
     * `read` can ask for it without importing the backend or reading a process-wide flag. Undefined until a
     * backend is registered, and never used when `active` is false.
     */
    sessionFor?: (ctx: ExtensionContext) => Promise<ContainerSession>;
}

export function createContainerState(): ContainerState {
    return { active: false };
}

/**
 * The few things a container needs on disk, shared by every session on this machine.
 *
 * Shared rather than per session, and deliberately so. The home is where a session's package caches land, so
 * a fresh one per session threw away everything the last session downloaded and left a directory behind that
 * nothing ever removed. The Containerfile is byte-identical for every session at the same recipe, so
 * per-session copies could only accumulate; the dispatcher is not stored here at all, because it is mounted
 * from the extension that is running.
 */
export interface ContainerStatePaths {
    /** `stateDir/container`: everything below belongs to this backend. */
    root: string;
    /** Host directory mounted at the real home path, so `~` means the same in and out. */
    home: string;
    /** The effective Containerfile of the last build; only ever written when a build runs. */
    containerfile: string;
}

export function containerStatePaths(stateDir: string = PI_CODER_STATE_DIR): ContainerStatePaths {
    const root = path.join(stateDir, "container");

    return {
        root,
        home: path.join(root, "home"),
        containerfile: path.join(root, "Containerfile"),
    };
}
